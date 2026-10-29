import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MuseHost, buildServeArgs } from '../src/msp/host';
import { RpcError, uuidv7 } from '../src/msp/rpc';
import { ViewReducer, type UiEvent } from '../src/view';

const FAKE = path.join(__dirname, '..', '..', 'test', 'fake-muse-serve.js');
fs.chmodSync(FAKE, 0o755);

/** Starts a host against the fake server and collects UI events through a reducer. */
async function setup() {
  const host = new MuseHost({ bin: FAKE, cwd: os.tmpdir(), clientVersion: '0.0.0-test' });
  const reducer = new ViewReducer();
  const events: UiEvent[] = [];
  let stderr = '';
  const waiters: { pred: (e: UiEvent) => boolean; resolve: (e: UiEvent) => void }[] = [];
  const push = (e: UiEvent) => {
    events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  };
  host.on('notification', (m: string, p: any) => reducer.notification(m, p).forEach(push));
  host.on('serverRequest', (m: string, p: any) => reducer.serverRequest(m, p).forEach(push));
  host.on('log', (t: string) => (stderr += t));
  const until = (pred: (e: UiEvent) => boolean, ms = 5000) =>
    new Promise<UiEvent>((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timed out waiting for event; got: ' + events.map((e) => e.type).join(','))), ms).unref();
    });
  await host.ensureStarted();
  const session = await host.startSession({ workspaceRoot: os.tmpdir(), approvalMode: 'promptUnmatched' });
  reducer.sessionId = session.sessionId;
  return { host, reducer, events, until, session, stderr: () => stderr };
}

const turnDone = (e: UiEvent) => e.type === 'turn' && e.phase === 'completed';

test('uuidv7 has the version-7 shape and sorts by time', () => {
  const a = uuidv7();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a.slice(0, 13) <= uuidv7().slice(0, 13));
});

test('buildServeArgs', () => {
  assert.deepEqual(buildServeArgs({}), ['serve']);
  assert.deepEqual(buildServeArgs({ provider: 'echo', model: 'm', extraArgs: ['--preset', 'p'] }), ['serve', '--provider', 'echo', '--model', 'm', '--preset', 'p']);
});

test('a plain turn streams a reply, todos, context and usage', async () => {
  const { host, session, events, until } = await setup();
  try {
    const r = await host.startTurn(session.sessionId, [{ type: 'text', text: 'hello' }]);
    assert.equal(r.disposition, 'started');
    await until(turnDone);
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.delta).join('');
    assert.equal(text, 'echo: hello');
    const final = events.filter((e) => e.type === 'item' && e.item.kind === 'agentMessage').at(-1) as any;
    assert.equal(final.item.text, 'echo: hello');
    assert.ok(events.some((e) => e.type === 'todos' && e.items[0].text === 'Say hi'));
    assert.ok(events.some((e) => e.type === 'context' && e.used === 1200));
    assert.ok(events.some((e) => e.type === 'usage' && e.windowPct === 12));
    assert.deepEqual(events.filter((e) => e.type === 'busy').map((e: any) => e.on), [true, false]);
  } finally {
    host.stop();
  }
});

test('approval: reviewing, then a person decides, then resolved', async () => {
  const { host, reducer, session, events, until, stderr } = await setup();
  try {
    await host.startTurn(session.sessionId, [{ type: 'text', text: 'please approve this' }]);
    const req = (await until((e) => e.type === 'approval')) as Extract<UiEvent, { type: 'approval' }>;
    assert.ok(events.some((e) => e.type === 'approval-reviewing'));
    assert.equal(req.approval.subject.command, 'rm -rf build');
    assert.equal(req.approval.reviewerReason, 'Deletes files.');
    assert.deepEqual(req.approval.choices.map((c) => c.label), ['Allow once', 'Reject']);

    const a = reducer.getApproval(req.approval.approvalId)!;
    await host.decideApproval({ sessionId: session.sessionId, approvalId: a.approvalId, requirementId: a.requirementId, choiceId: 'allow_once' });
    const resolved = (await until((e) => e.type === 'approval-resolved')) as any;
    assert.equal(resolved.decision, 'approved');
    assert.equal(resolved.resolvedBy, 'user');
    assert.equal(resolved.summary, 'rm -rf build');
    await until(turnDone);
    assert.ok(events.some((e) => e.type === 'item' && e.item.kind === 'toolCall' && e.item.status === 'completed'));
    assert.doesNotMatch(stderr(), /NOT ACKED/, 'the approval request must be acknowledged');
  } finally {
    host.stop();
  }
});

test('approval: rejecting with feedback reaches Muse', async () => {
  const { host, reducer, session, events, until } = await setup();
  try {
    await host.startTurn(session.sessionId, [{ type: 'text', text: 'approve please' }]);
    const req = (await until((e) => e.type === 'approval')) as any;
    const a = reducer.getApproval(req.approval.approvalId)!;
    await host.decideApproval({ sessionId: session.sessionId, approvalId: a.approvalId, requirementId: a.requirementId, choiceId: 'abort', feedback: 'use git clean instead' });
    await until(turnDone);
    const reply = events.filter((e) => e.type === 'item' && e.item.kind === 'agentMessage').at(-1) as any;
    assert.equal(reply.item.text, 'Rejected. Feedback: use git clean instead');
  } finally {
    host.stop();
  }
});

test('questions from Muse can be answered', async () => {
  const { host, session, events, until } = await setup();
  try {
    await host.startTurn(session.sessionId, [{ type: 'text', text: 'ask me' }]);
    const q = (await until((e) => e.type === 'question')) as any;
    assert.equal(q.question.questions[0].question, 'Pick one');
    await host.answerUserInput(session.sessionId, q.question.userInputId, [{ questionId: 'color', selectedLabel: 'Blue' }]);
    await until(turnDone);
    assert.ok(events.some((e) => e.type === 'question-settled'));
    assert.equal((events.filter((e) => e.type === 'item' && e.item.kind === 'agentMessage').at(-1) as any).item.text, 'You picked Blue.');
  } finally {
    host.stop();
  }
});

test('interrupt stops a running turn; a second message while busy is queued', async () => {
  const { host, session, until } = await setup();
  try {
    await host.startTurn(session.sessionId, [{ type: 'text', text: 'hang' }]);
    await until((e) => e.type === 'turn' && e.phase === 'started');
    const queued = await host.startTurn(session.sessionId, [{ type: 'text', text: 'later' }]);
    assert.equal(queued.disposition, 'queued');
    await host.interrupt(session.sessionId);
    const done = (await until(turnDone)) as any;
    assert.equal(done.terminal, 'cancelled');
  } finally {
    host.stop();
  }
});

test('an auth failure surfaces as a turn error with kind authRequired', async () => {
  const { host, session, until } = await setup();
  try {
    await host.startTurn(session.sessionId, [{ type: 'text', text: 'auth please' }]);
    const done = (await until(turnDone)) as any;
    assert.equal(done.error.kind, 'authRequired');
  } finally {
    host.stop();
  }
});

test('models, model switch and approval mode changes', async () => {
  const { host, session, until } = await setup();
  try {
    const models = await host.listModels(session.sessionId);
    assert.deepEqual(models.map((m) => m.modelId), ['fake-model', 'fake-small']);
    await host.setModel(session.sessionId, models[1]);
    await until((e) => e.type === 'session' && e.modelId === 'fake-small');
    await host.setApprovalMode(session.sessionId, 'denyUnmatched');
    await until((e) => e.type === 'session' && e.approvalMode === 'denyUnmatched');
  } finally {
    host.stop();
  }
});

test('permission profiles can be listed, chosen at start, and switched', async () => {
  const { host, session } = await setup();
  try {
    const profiles = await host.listPermissionProfiles();
    assert.deepEqual(profiles.map((p) => p.profileId), [':read-only', ':ask-me', ':auto-review', ':unrestricted']);
    const s2 = await host.startSession({ workspaceRoot: os.tmpdir(), permissionProfile: ':ask-me' });
    assert.ok(s2.sessionId);
    const r = await host.setPermissionProfile(session.sessionId, ':auto-review');
    assert.equal(r.permissionState?.profileId, ':auto-review');
    await assert.rejects(host.startSession({ workspaceRoot: os.tmpdir(), permissionProfile: 'bogus' }), /permission_profile/);
  } finally {
    host.stop();
  }
});

test('resuming an unknown session fails with sessionNotFound', async () => {
  const { host } = await setup();
  try {
    await assert.rejects(host.resumeSession('nope'), (e: unknown) => e instanceof RpcError && e.kind === 'sessionNotFound');
  } finally {
    host.stop();
  }
});

test('a missing binary rejects ensureStarted instead of hanging', async () => {
  const host = new MuseHost({ bin: '/definitely/not/muse', cwd: os.tmpdir(), clientVersion: '0' });
  host.on('exit', () => {});
  await assert.rejects(host.ensureStarted());
});
