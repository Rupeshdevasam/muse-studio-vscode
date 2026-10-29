import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ViewReducer, approvalSummary, type UiEvent } from '../src/view';
import { appendEvent } from '../src/sessions';

const REAL = path.join(__dirname, '..', '..', 'test', 'fixtures', 'real');

/** Replays captured `muse serve` traffic (notifications only) through the reducer. */
function replay(file: string): UiEvent[] {
  const r = new ViewReducer();
  const out: UiEvent[] = [];
  for (const line of fs.readFileSync(path.join(REAL, file), 'utf8').split('\n').filter(Boolean)) {
    const m = JSON.parse(line);
    if (!r.sessionId && m.params?.sessionId) r.sessionId = m.params.sessionId;
    out.push(...(m.id !== undefined ? r.serverRequest(m.method, m.params) : r.notification(m.method, m.params)));
  }
  return out;
}

test('real capture: echo turn', () => {
  const ev = replay('msp-1.4.14-echo.jsonl');
  const text = ev.filter((e) => e.type === 'delta').map((e: any) => e.delta).join('');
  assert.equal(text, 'echo: say hi');
  assert.ok(!ev.some((e) => e.type === 'item' && e.item.kind === 'reminderChild'), 'reminder items are hidden');
});

test('real capture: write_file tool call and streamed answer', () => {
  const ev = replay('msp-1.4.14-write-file.jsonl');
  const tools = ev.filter((e) => e.type === 'item' && e.item.kind === 'toolCall') as any[];
  assert.ok(tools.length >= 2);
  const done = tools.at(-1).item;
  assert.equal(done.tool, 'write_file');
  assert.equal(done.status, 'completed');
  assert.equal(JSON.parse(done.args).path, 'hello.txt');
  assert.match(done.output, /wrote 5 bytes/);
  assert.ok(ev.some((e) => e.type === 'usage' && e.windowPct === 9));
  assert.ok(ev.some((e) => e.type === 'context' && e.used > 0));
  const turn = ev.find((e) => e.type === 'turn' && e.phase === 'completed') as any;
  assert.equal(turn.terminal, 'completed');
});

test("real capture: Muse's reviewer approves a shell command on its own", () => {
  const ev = replay('msp-1.4.14-reviewer-approval.jsonl');
  const reviewing = ev.find((e) => e.type === 'approval-reviewing') as any;
  assert.equal(reviewing.approval.subject.command, 'echo probe > ../outside-probe.txt');
  assert.deepEqual(reviewing.approval.choices.map((c: any) => c.label), ['Allow once', 'Reject']);
  // The reviewer decided, so no card is shown to the person.
  assert.ok(!ev.some((e) => e.type === 'approval'));
  const resolved = ev.find((e) => e.type === 'approval-resolved') as any;
  assert.equal(resolved.resolvedBy, 'llmJudge');
  assert.equal(resolved.decision, 'approved');
  assert.equal(resolved.summary, 'echo probe > ../outside-probe.txt');
});

test('events for other sessions are ignored', () => {
  const r = new ViewReducer('mine');
  assert.deepEqual(r.notification('item/delta', { sessionId: 'other', itemId: 'x', field: 'text', delta: 'hi' }), []);
  assert.equal(r.notification('item/delta', { sessionId: 'mine', itemId: 'x', field: 'text', delta: 'hi' }).length, 1);
});

test('approvalSummary picks the most useful line', () => {
  assert.equal(approvalSummary({ subject: { command: 'ls' } }), 'ls');
  assert.equal(approvalSummary({ subject: { path: '/etc/hosts', access: 'write' } }), 'write /etc/hosts');
  assert.equal(approvalSummary({ subject: { kind: 'mcp' }, toolName: 'fetch' }), 'fetch');
});

test('stored transcripts keep one copy of each item, with streamed text folded in', () => {
  const ev = replay('msp-1.4.14-write-file.jsonl');
  const stored: UiEvent[] = [];
  for (const e of ev) appendEvent(stored, e);
  const ids = stored.filter((e) => e.type === 'item').map((e: any) => e.item.itemId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate items');
  assert.ok(!stored.some((e) => e.type === 'delta' || e.type === 'usage' || e.type === 'context'));
  const answer = stored.find((e) => e.type === 'item' && e.item.kind === 'agentMessage') as any;
  assert.match(answer.item.text, /^I'm done\. Created \[hello\.txt\]/);
});

test('a delta that arrives before the final item text is kept', () => {
  const stored: UiEvent[] = [];
  appendEvent(stored, { type: 'item', item: { itemId: 'a', kind: 'agentMessage', status: 'inProgress', revision: 1, text: '' } });
  appendEvent(stored, { type: 'delta', itemId: 'a', field: 'text', delta: 'partial' });
  appendEvent(stored, { type: 'item', item: { itemId: 'a', kind: 'agentMessage', status: 'cancelled', revision: 2 } });
  assert.equal((stored[0] as any).item.text, 'partial');
  assert.equal((stored[0] as any).item.status, 'cancelled');
});
