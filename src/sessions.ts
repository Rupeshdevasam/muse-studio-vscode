import type { Memento } from 'vscode';
import type { UiEvent } from './view';

export interface ChatSession {
  /** Local id for the chat. */
  id: string;
  /** Muse's session id, set once the first message starts a session. */
  museSessionId?: string;
  title: string;
  updatedAt: number;
  /** Folder the chat runs in; set on the first message. */
  cwd?: string;
  events: UiEvent[];
}

const KEY = 'muse.chats.v2';
const MAX_SESSIONS = 30;
const MAX_EVENTS = 2000;

/** Chat transcripts stored per workspace, so old chats can be shown and resumed. */
export class SessionStore {
  constructor(private readonly state: Memento) {}

  list(): ChatSession[] {
    return [...this.state.get<ChatSession[]>(KEY, [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ChatSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  async save(session: ChatSession): Promise<void> {
    if (!session.events.length) return;
    const others = this.list().filter((s) => s.id !== session.id);
    await this.state.update(KEY, [session, ...others].slice(0, MAX_SESSIONS));
  }

  async remove(id: string): Promise<void> {
    await this.state.update(KEY, this.list().filter((s) => s.id !== id));
  }
}

const TRANSIENT = new Set<UiEvent['type']>([
  'approval-reviewing',
  'approval',
  'question',
  'question-settled',
  'busy',
  'context',
  'usage',
  'todos',
  'session',
  'turn',
]);

/**
 * Records an event in a stored transcript. Items are kept once, at their latest revision,
 * with streamed text folded in, so a transcript replays without the delta stream.
 */
export function appendEvent(events: UiEvent[], ev: UiEvent): void {
  if (ev.type === 'turn' && ev.phase === 'completed' && (ev.error || (ev.terminal && ev.terminal !== 'completed'))) {
    events.push(ev);
    return;
  }
  if (TRANSIENT.has(ev.type)) return;
  if (ev.type === 'changes-updated') {
    const target = events.find((e) => e.type === 'changes' && e.id === ev.id);
    if (target && target.type === 'changes') target.reverted = [...ev.reverted];
    return;
  }

  if (ev.type === 'item') {
    const idx = findItem(events, ev.item.itemId);
    if (idx < 0) events.push({ type: 'item', item: { ...ev.item } });
    else {
      const prev = (events[idx] as Extract<UiEvent, { type: 'item' }>).item;
      if (ev.item.revision >= prev.revision) {
        // A later revision may omit text that only arrived as deltas.
        events[idx] = { type: 'item', item: { ...ev.item, text: ev.item.text || prev.text, summary: ev.item.summary ?? prev.summary } };
      }
    }
  } else if (ev.type === 'delta') {
    const idx = findItem(events, ev.itemId);
    if (idx < 0) return;
    const item = (events[idx] as Extract<UiEvent, { type: 'item' }>).item;
    if (ev.field === 'text') item.text = (item.text ?? '') + ev.delta;
    else if (ev.field.startsWith('summary.')) {
      const n = Number(ev.field.slice('summary.'.length));
      if (Number.isInteger(n) && n >= 0) {
        item.summary = [...(item.summary ?? [])];
        item.summary[n] = (item.summary[n] ?? '') + ev.delta;
      }
    }
    return;
  } else {
    events.push(ev);
  }
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function findItem(events: UiEvent[], itemId: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'item' && e.item.itemId === itemId) return i;
  }
  return -1;
}
