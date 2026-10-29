// Turns MSP notifications and server requests into the events the chat panel renders.
// Kept free of the vscode API so it can be tested against captured traffic.

export interface ItemView {
  itemId: string;
  kind: string;
  status: string;
  revision: number;
  text?: string;
  summary?: string[];
  messagePhase?: string;
  commandId?: string;
  tool?: string;
  args?: string;
  label?: { active?: string; done?: string; neutral?: string };
  output?: string;
  failureReason?: string;
  patchSummary?: { files: number; added: number; removed: number };
  approvalId?: string;
  fallbackText?: string;
  objective?: string;
  role?: string;
  statusLine?: string;
  held?: boolean;
  cutOff?: boolean;
}

export interface ChoiceView {
  choiceId: string;
  label: string;
  decision: string;
  scope?: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

export interface ApprovalView {
  approvalId: string;
  itemId?: string;
  toolName?: string;
  subject: {
    kind?: string;
    command?: string;
    path?: string;
    host?: string;
    port?: number;
    protocol?: string;
    target?: string;
    access?: string;
    toolName?: string;
  };
  rawArgs?: string;
  choices: ChoiceView[];
  requirementId: unknown;
  reviewerReason?: string;
  judgeEscalated?: boolean;
  protectedWrite?: boolean;
}

export interface QuestionView {
  userInputId: string;
  toolName?: string;
  questions: {
    id: string;
    header: string;
    question: string;
    mode: string;
    min?: number;
    max?: number;
    options: { label: string; description?: string }[];
  }[];
}

export interface ChangeView {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
  binary?: boolean;
}

export type UiEvent =
  | {
      type: 'user';
      text: string;
      commandId?: string;
      /** Small previews of attached images. */
      images?: { thumb: string; name?: string }[];
      /** Files, folders and editor context sent along with the message. */
      attached?: string[];
    }
  | { type: 'changes'; id: string; root: string; before: string; after: string; files: ChangeView[]; reverted: string[] }
  | { type: 'changes-updated'; id: string; reverted: string[] }
  | { type: 'item'; item: ItemView }
  | { type: 'delta'; itemId: string; field: string; delta: string }
  | { type: 'approval-reviewing'; approval: ApprovalView }
  | { type: 'approval'; approval: ApprovalView }
  | { type: 'approval-resolved'; approvalId: string; decision: string; resolvedBy: string; summary: string }
  | { type: 'question'; question: QuestionView }
  | { type: 'question-settled'; userInputId: string; outcome?: string }
  | { type: 'turn'; phase: 'started' | 'completed'; turnId: string; terminal?: string; error?: { kind: string; message: string } }
  | { type: 'busy'; on: boolean }
  | { type: 'session'; modelId?: string | null; approvalMode?: string }
  | { type: 'context'; used: number; window?: number; pressure?: string }
  | { type: 'usage'; windowPct?: number; weeklyPct?: number; resetsAtMs?: number }
  | { type: 'todos'; items: { text: string; status: string; activeForm?: string }[] }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };

/** Internal item kinds that only add noise to a chat transcript. */
const HIDDEN_KINDS = new Set(['reminderChild', 'earlierHistory', 'damagedRange']);
const MAX_OUTPUT = 20_000;

export function toItemView(it: any): ItemView | undefined {
  if (!it || typeof it.itemId !== 'string' || HIDDEN_KINDS.has(it.kind)) return undefined;
  const out = typeof it.visibleOutput === 'string' ? it.visibleOutput : undefined;
  return {
    itemId: it.itemId,
    kind: String(it.kind),
    status: String(it.status ?? 'inProgress'),
    revision: Number(it.revision ?? 0),
    text: it.text,
    summary: Array.isArray(it.summary) ? it.summary : undefined,
    messagePhase: it.messagePhase,
    commandId: it.commandId,
    tool: it.tool,
    args: typeof it.args === 'string' ? it.args.slice(0, MAX_OUTPUT) : undefined,
    label: it.displayLabel,
    output: out && out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n…(truncated)' : out,
    failureReason: it.failureReason,
    patchSummary: it.patchSummary,
    approvalId: it.approvalId,
    fallbackText: it.fallbackText,
    objective: it.objective,
    role: it.role,
    statusLine: it.statusLine,
    held: it.held,
    cutOff: it.cutOff,
  };
}

function approvalView(p: any): ApprovalView {
  return {
    approvalId: p.approvalId,
    itemId: p.itemId,
    toolName: p.toolName,
    subject: p.subject ?? {},
    rawArgs: typeof p.rawArgs === 'string' ? p.rawArgs.slice(0, 4000) : undefined,
    choices: Array.isArray(p.availableChoices) ? p.availableChoices : [],
    requirementId: p.currentRequirementId,
    reviewerReason: p.reviewerReason,
    judgeEscalated: p.judgeEscalated,
    protectedWrite: p.protectedWrite,
  };
}

/** One line describing what an approval is for, e.g. the shell command or file path. */
export function approvalSummary(a: Pick<ApprovalView, 'subject' | 'toolName' | 'rawArgs'>): string {
  const s = a.subject ?? {};
  if (s.command) return s.command;
  if (s.path) return `${s.access ? s.access + ' ' : ''}${s.path}`;
  if (s.host) return `${s.protocol ?? 'connect to'} ${s.host}${s.port ? ':' + s.port : ''}`.trim();
  if (s.target) return s.target;
  return a.toolName ?? s.toolName ?? s.kind ?? 'action';
}

function questionView(p: any): QuestionView {
  return {
    userInputId: p.userInputId,
    toolName: p.toolName,
    questions: (p.questions ?? []).map((q: any) => ({
      id: q.id,
      header: q.header ?? '',
      question: q.question ?? '',
      mode: q.selection?.mode ?? 'single',
      min: q.selection?.minSelections,
      max: q.selection?.maxSelections,
      options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description })),
    })),
  };
}

/**
 * Stateful because approvals arrive as several messages (reviewing, updated, request,
 * resolved) and the panel needs the subject text when it shows the outcome.
 */
export class ViewReducer {
  private approvals = new Map<string, ApprovalView>();
  /** Approvals Muse has asked a person about (as opposed to ones its reviewer is handling). */
  private shownToUser = new Set<string>();

  constructor(public sessionId?: string) {}

  /** A notification from `muse serve`. Events for other sessions are ignored. */
  notification(method: string, p: any): UiEvent[] {
    if (p?.sessionId && this.sessionId && p.sessionId !== this.sessionId) return [];
    switch (method) {
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = toItemView(p.item);
        return item ? [{ type: 'item', item }] : [];
      }
      case 'item/delta':
        return typeof p.delta === 'string' && p.delta
          ? [{ type: 'delta', itemId: p.itemId, field: p.field ?? 'text', delta: p.delta }]
          : [];
      case 'turn/started':
        return [{ type: 'turn', phase: 'started', turnId: p.turnId }];
      case 'turn/completed':
        return [
          {
            type: 'turn',
            phase: 'completed',
            turnId: p.turnId,
            terminal: p.terminal,
            error: p.error ? { kind: String(p.error.kind ?? 'error'), message: String(p.error.message ?? '') } : undefined,
          },
        ];
      case 'session/statusChanged':
        return p.status === 'running' ? [{ type: 'busy', on: true }] : p.status === 'idle' ? [{ type: 'busy', on: false }] : [];
      case 'session/modelChanged':
        return [{ type: 'session', modelId: p.model?.modelId ?? p.modelId ?? null }];
      case 'session/approvalModeChanged':
        return p.mode ? [{ type: 'session', approvalMode: p.mode }] : [];
      case 'session/contextUsage':
        return [{ type: 'context', used: p.usedTokens, window: p.windowTokens, pressure: p.pressure }];
      case 'usage/changed':
        return [{ type: 'usage', windowPct: p.window?.usedPercent, weeklyPct: p.weekly?.usedPercent, resetsAtMs: p.window?.resetsAtMs }];
      case 'session/todoListChanged':
        return [{ type: 'todos', items: (p.items ?? []).map((t: any) => ({ text: t.text, status: t.status, activeForm: t.activeForm })) }];
      case 'session/compact':
        return [];
      case 'approval/reviewing': {
        const a = this.mergeApproval(p);
        return [{ type: 'approval-reviewing', approval: a }];
      }
      case 'approval/updated': {
        const known = this.approvals.has(p.approvalId);
        const a = this.mergeApproval(p);
        // Refresh a card a person is already looking at.
        if (this.shownToUser.has(a.approvalId)) return a.choices.length ? [{ type: 'approval', approval: a }] : [];
        // A review we hadn't heard about yet (e.g. a missed `approval/reviewing`).
        if (!known && p.change?.kind === 'reviewStarted') return [{ type: 'approval-reviewing', approval: a }];
        return [];
      }
      case 'approval/resolved': {
        const a = this.approvals.get(p.approvalId);
        this.approvals.delete(p.approvalId);
        this.shownToUser.delete(p.approvalId);
        return [
          {
            type: 'approval-resolved',
            approvalId: p.approvalId,
            decision: String(p.decision),
            resolvedBy: String(p.resolvedBy ?? ''),
            summary: a ? approvalSummary(a) : '',
          },
        ];
      }
      case 'userInput/settled':
        return [{ type: 'question-settled', userInputId: p.userInputId, outcome: p.outcome ?? p.status }];
      default:
        return [];
    }
  }

  /** A server request that needs a person: an approval or a question. */
  serverRequest(method: string, p: any): UiEvent[] {
    if (p?.sessionId && this.sessionId && p.sessionId !== this.sessionId) return [];
    if (method === 'approval/request') {
      const a = this.mergeApproval(p);
      this.shownToUser.add(a.approvalId);
      return [{ type: 'approval', approval: a }];
    }
    if (method === 'userInput/request') return [{ type: 'question', question: questionView(p) }];
    return [];
  }

  getApproval(approvalId: string): ApprovalView | undefined {
    return this.approvals.get(approvalId);
  }

  private mergeApproval(p: any): ApprovalView {
    const prev = this.approvals.get(p.approvalId);
    const next = approvalView(p);
    const merged: ApprovalView = {
      ...prev,
      ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length && prev))),
    } as ApprovalView;
    if (!merged.subject || !Object.keys(merged.subject).length) merged.subject = prev?.subject ?? {};
    this.approvals.set(p.approvalId, merged);
    return merged;
  }
}

/** Turns a resumed session's stored items (e.g. a chat started in the Muse CLI) into events to show. */
export function historyToEvents(items: any[]): UiEvent[] {
  const out: UiEvent[] = [];
  for (const it of items ?? []) {
    if (it?.kind === 'userMessage') {
      const text = String(it.displayText ?? it.text ?? '');
      if (text) out.push({ type: 'user', text, commandId: it.commandId });
      continue;
    }
    const view = toItemView(it);
    if (view) out.push({ type: 'item', item: view });
  }
  return out;
}

/** Version fingerprints of the MSP schema this extension was tested against. */
export const TESTED_SCHEMA_FINGERPRINTS = new Set(['sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6']);
export const TESTED_MUSE_VERSION = '1.4.14';
