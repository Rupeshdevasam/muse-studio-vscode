#!/usr/bin/env node
// A small stand-in for `muse serve` used by the tests. It speaks MSP's JSON-RPC over
// stdin/stdout and plays a short script chosen by keywords in the prompt:
//   "approve" -> the reviewer escalates and the client must decide an approval
//   "ask"     -> Muse asks the user a question
//   "hang"    -> the turn runs until turn/interrupt
//   "auth"    -> the turn fails with authRequired
//   anything else -> a plain streamed reply
// `--version` prints a version line, like the real CLI.
if (process.argv.includes('--version')) {
  console.log('Muse Code 9.9.9 (fake)');
  process.exit(0);
}
process.stderr.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\n');

const SESSION = '01900000-0000-7000-8000-000000000001';
let turnSeq = 0;
let serverReqSeq = 0;
const acked = new Set();
const waiters = new Map(); // method -> resolve(params)
let current; // { turnId, commandId }
let experimental = false;

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const notify = (method, params) => send({ method, params: { sessionId: SESSION, viewCursor: 'v', ...params } });
const item = (method, it) => notify(method, { item: { turnId: current?.turnId, revision: 1, ...it } });
const waitFor = (method) => new Promise((r) => waiters.set(method, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(terminal = 'completed', error) {
  notify('turn/completed', { turnId: current.turnId, terminal, ...(error ? { error } : {}) });
  notify('session/statusChanged', { status: 'idle' });
  current = undefined;
}

async function reply(text) {
  const id = `msg-${turnSeq}`;
  item('item/started', { itemId: id, kind: 'agentMessage', status: 'inProgress', text: '' });
  for (const part of text.match(/.{1,8}/g)) {
    notify('item/delta', { itemId: id, field: 'text', delta: part });
    await sleep(2);
  }
  item('item/completed', { itemId: id, kind: 'agentMessage', status: 'completed', revision: 2, text, messagePhase: 'finalAnswer' });
}

async function runTurn(p) {
  const text = p.input?.[0]?.text ?? '';
  notify('session/statusChanged', { status: 'running' });
  notify('turn/started', { turnId: current.turnId, commandId: p.commandId });
  item('item/completed', { itemId: `user-${turnSeq}`, kind: 'userMessage', status: 'completed', text, commandId: p.commandId });
  notify('session/contextUsage', { usedTokens: 1200, windowTokens: 100000, pressure: 'normal' });

  if (text.includes('auth')) {
    return finish('failed', { kind: 'authRequired', message: 'missing meta credentials', retryable: false });
  }
  if (text.includes('hang')) {
    await waitFor('turn/interrupt');
    return finish('cancelled');
  }
  if (text.includes('approve')) {
    const approvalId = '01900000-0000-7000-8000-0000000000a1';
    const base = {
      approvalId,
      itemId: 'tool-1',
      toolName: 'bash',
      subject: { kind: 'shell', command: 'rm -rf build' },
      currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: [
        { choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
        { choiceId: 'abort', label: 'Reject', decision: 'abort', scope: 'once', acceptsFeedback: true },
      ],
    };
    notify('approval/reviewing', { ...base, change: { kind: 'reviewStarted' } });
    const reqId = `srv-${++serverReqSeq}`;
    send({ id: reqId, method: 'approval/request', params: { ...base, sessionId: SESSION, judgeEscalated: true, reviewerReason: 'Deletes files.', protectedWrite: false, rawArgs: '{"command":"rm -rf build"}', taskId: 't', toolCallId: 'c', turnId: current.turnId, viewCursor: 'v' } });
    const d = await waitFor('approval/decide');
    if (!acked.has(reqId)) process.stderr.write('NOT ACKED\n');
    const allowed = d.choiceId === 'allow_once';
    notify('approval/resolved', { approvalId, itemId: 'tool-1', turnId: current.turnId, decision: allowed ? 'approved' : 'abort', policyResult: allowed ? 'allow' : 'deny', resolvedBy: 'user' });
    if (allowed) {
      item('item/started', { itemId: 'tool-1', kind: 'toolCall', status: 'inProgress', tool: 'bash', args: '{"command":"rm -rf build"}' });
      item('item/completed', { itemId: 'tool-1', kind: 'toolCall', status: 'completed', revision: 2, tool: 'bash', args: '{"command":"rm -rf build"}', visibleOutput: 'ok' });
    }
    await reply(allowed ? 'Deleted build.' : `Rejected. Feedback: ${d.feedback ?? ''}`);
    return finish();
  }
  if (text.includes('ask')) {
    const userInputId = 'q-1';
    send({ id: `srv-${++serverReqSeq}`, method: 'userInput/request', params: { sessionId: SESSION, userInputId, itemId: 'tool-q', toolName: 'ask_user', toolCallId: 'c', turnId: current.turnId, viewCursor: 'v', questions: [{ id: 'color', header: 'Color', question: 'Pick one', selection: { mode: 'single' }, options: [{ label: 'Red' }, { label: 'Blue' }] }] } });
    const a = await waitFor('userInput/answer');
    notify('userInput/settled', { userInputId, outcome: 'answered' });
    await reply(`You picked ${a.answers[0].selectedLabel ?? a.answers[0].freeText}.`);
    return finish();
  }
  notify('session/todoListChanged', { items: [{ text: 'Say hi', status: 'completed' }], revision: 1, sourceTool: 'todo' });
  notify('usage/changed', { window: { usedPercent: 12, resetsAtMs: 1 }, weekly: { usedPercent: 3 } });
  await reply(`echo: ${text}`);
  finish();
}

function handle(msg) {
  // Responses to our server requests (presentation receipts).
  if (msg.method === undefined) {
    if (msg.result !== undefined) acked.add(msg.id);
    return;
  }
  const { id, method, params: p = {} } = msg;
  const ok = (result) => send({ id, result });
  const fail = (code, message, kind) => send({ id, error: { code, message, data: { kind } } });

  switch (method) {
    case 'initialize':
      if (!/^[a-z0-9_]+$/.test(p.clientInfo?.name ?? '')) return fail(-32602, 'clientInfo.name must match ^[a-z0-9_]+$', 'invalidParams');
      experimental = !!p.capabilities?.experimentalApi;
      return ok({ serverInfo: { name: 'muse', version: '9.9.9' }, grantedCapabilities: [], experimentalApi: experimental, sessionDurability: 'durable' });
    case 'initialized':
      return;
    case 'session/start': {
      if (p.permissionProfile && !p.permissionProfile.startsWith(':')) return fail(-32030, 'rejected: permission_profile_unknown', 'commandRejected');
      const session = { sessionId: SESSION, status: 'idle', activeTurnId: null, modelId: p.modelId ?? 'fake-model', approvalMode: { mode: p.approvalMode ?? 'promptUnmatched' } };
      notify('session/started', { session });
      return ok({ session, viewCursor: 'v' });
    }
    case 'session/resume':
      if (p.sessionId !== SESSION) return fail(-32004, 'session not found', 'sessionNotFound');
      return ok({ session: { sessionId: SESSION, status: 'idle', activeTurnId: null, modelId: 'fake-model' }, history: {}, pendingRequests: [], viewCursor: 'v' });
    case 'permissionProfile/list':
      if (!experimental) return fail(-32601, 'experimental API required', 'experimentalRequired');
      return ok({ profiles: [':read-only', ':ask-me', ':auto-review', ':unrestricted'].map((id) => ({ profileId: id, label: id.slice(1), description: '', reviewerAuthority: 'human', available: true })) });
    case 'session/setPermissionProfile':
      if (!experimental) return fail(-32601, 'experimental API required', 'experimentalRequired');
      if (!p.profileId?.startsWith(':')) return fail(-32030, 'permission_profile_unknown', 'commandRejected');
      return ok({ commandId: p.commandId, status: 'accepted', applyOutcome: 'completed', permissionState: { profileId: p.profileId } });
    case 'model/list':
      return ok({ providerId: 'meta', profileId: null, source: 'catalog', models: [
        { modelId: 'fake-model', displayLabel: 'Fake Model', description: null, isActive: true, isDefault: true, contextLimit: 100000, outputLimit: null, cost: null, providerId: 'meta', profileId: null, releaseDate: null, defaultReasoningEffort: 'high' },
        { modelId: 'fake-small', displayLabel: 'Fake Small', description: null, isActive: false, isDefault: false, contextLimit: 50000, outputLimit: null, cost: null, providerId: 'meta', profileId: null, releaseDate: null },
      ] });
    case 'session/setModel':
      ok({ commandId: p.commandId, status: 'accepted' });
      return notify('session/modelChanged', { model: { modelId: p.model.modelId } });
    case 'session/setApprovalMode':
      ok({ commandId: p.commandId, status: 'accepted' });
      return notify('session/approvalModeChanged', { mode: p.mode, source: 'approvalReconfigure' });
    case 'turn/start': {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(p.commandId ?? '')) return fail(-32602, 'commandId must be a UUIDv7', 'invalidParams');
      if (current) return ok({ commandId: p.commandId, status: 'accepted', turnId: current.turnId, startedNewTurn: false, disposition: 'queued' });
      turnSeq++;
      current = { turnId: p.commandId, commandId: p.commandId };
      ok({ commandId: p.commandId, status: 'accepted', turnId: p.commandId, startedNewTurn: true, disposition: 'started' });
      runTurn(p);
      return;
    }
    case 'turn/interrupt':
    case 'approval/decide':
    case 'userInput/answer':
    case 'userInput/cancel': {
      ok({ commandId: p.commandId, status: 'accepted', terminal: true });
      const w = waiters.get(method === 'userInput/cancel' ? 'userInput/answer' : method);
      if (w) {
        waiters.delete(method);
        w(method === 'userInput/cancel' ? { answers: [{ freeText: '(skipped)' }] } : p);
      }
      return;
    }
    default:
      return fail(-32601, `method not found: ${method}`, 'methodNotFound');
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
