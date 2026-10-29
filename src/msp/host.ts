// A connection to one `muse serve` process, speaking the Muse Session Protocol (MSP).
// Field names follow the schema exported by `muse schema generate-ts` (MSP v1).

import { EventEmitter } from 'node:events';
import { RpcProcess, uuidv7, type RpcExit } from './rpc';

export type ApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface HostOptions {
  bin: string;
  cwd: string;
  provider?: string;
  model?: string;
  extraArgs?: string[];
  clientVersion: string;
  env?: NodeJS.ProcessEnv;
}

export interface SessionInfo {
  sessionId: string;
  modelId?: string | null;
  providerId?: string | null;
  status?: string;
  activeTurnId?: string | null;
  approvalMode?: { mode: ApprovalMode } | null;
  workspaceRoot?: string;
}

export interface ModelEntry {
  modelId: string;
  displayLabel: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  contextLimit: number | null;
  providerId: string;
  profileId: string | null;
  defaultReasoningEffort?: ReasoningEffort;
  variants?: unknown;
}

/** One part of a message: text, or an inline image. */
export type TurnInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64Data: string; mediaType: string; width?: number; height?: number };

export interface PermissionProfile {
  profileId: string;
  label: string;
  description: string;
  reviewerAuthority: string;
  available: boolean;
  unavailableReasons?: string[];
}

export interface UserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

export function buildServeArgs(o: Pick<HostOptions, 'provider' | 'model' | 'extraArgs'>): string[] {
  const args = ['serve'];
  if (o.provider) args.push('--provider', o.provider);
  if (o.model) args.push('--model', o.model);
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

/**
 * Events:
 * - `notification` (method, params)
 * - `serverRequest` (method, params): `approval/request` or `userInput/request`, already acknowledged
 * - `log` (text)
 * - `exit` (RpcExit)
 */
export class MuseHost extends EventEmitter {
  private rpc?: RpcProcess;
  private starting?: Promise<void>;
  initializeResult?: any;

  constructor(readonly options: HostOptions) {
    super();
  }

  get running(): boolean {
    return !!this.rpc?.running;
  }

  /** Starts `muse serve` and completes the handshake, once. */
  ensureStarted(): Promise<void> {
    if (this.running && this.initializeResult) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<void> {
    const o = this.options;
    const rpc = new RpcProcess(o.bin, buildServeArgs(o), o.cwd, o.env);
    this.rpc = rpc;
    rpc.on('log', (t: string) => this.emit('log', t));
    rpc.on('notification', (method: string, params: any) => this.emit('notification', method, params));
    rpc.on('request', (method: string, params: any, id: number | string) => {
      // MSP: the response is only a presentation receipt; decisions travel as commands.
      if (method === 'approval/request' || method === 'userInput/request') {
        rpc.respond(id, {});
        this.emit('serverRequest', method, params);
      } else {
        rpc.respondError(id, -32601, `method not supported by this client: ${method}`);
      }
    });
    rpc.on('exit', (exit: RpcExit) => {
      if (this.rpc === rpc) {
        this.rpc = undefined;
        this.initializeResult = undefined;
      }
      this.emit('exit', exit);
    });
    rpc.start();
    this.initializeResult = await rpc.request('initialize', {
      clientInfo: { name: 'muse_studio_vscode', title: 'Muse Studio for VS Code', version: o.clientVersion },
      // Experimental API is needed for permission profiles (`:ask-me` etc.).
      capabilities: { userInputDialogs: true, experimentalApi: true },
    });
    rpc.notify('initialized');
  }

  stop(): void {
    this.rpc?.stop();
  }

  private async call<T = any>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    await this.ensureStarted();
    return this.rpc!.request<T>(method, params, timeoutMs);
  }

  async startSession(p: {
    workspaceRoot: string;
    approvalMode?: ApprovalMode;
    permissionProfile?: string;
    modelId?: string;
  }): Promise<SessionInfo> {
    const r = await this.call('session/start', {
      commandId: uuidv7(),
      workspaceRoot: p.workspaceRoot,
      ...(p.permissionProfile ? { permissionProfile: p.permissionProfile } : {}),
      ...(p.approvalMode ? { approvalMode: p.approvalMode } : {}),
      ...(p.modelId ? { modelId: p.modelId } : {}),
    });
    return r.session;
  }

  /** Loads an earlier session so new turns continue it. Pending approvals are re-sent after this returns. */
  async resumeSession(sessionId: string): Promise<SessionInfo> {
    const r = await this.call('session/resume', { commandId: uuidv7(), sessionId, excludeItems: true });
    return r.session;
  }

  /** Sends a message. If a turn is already running, it's queued behind it. */
  startTurn(
    sessionId: string,
    input: TurnInputPart[],
    opts: { effort?: ReasoningEffort; commandId?: string; displayText?: string } = {},
  ): Promise<{ turnId: string; disposition: string }> {
    return this.call('turn/start', {
      commandId: opts.commandId ?? uuidv7(),
      sessionId,
      input,
      ifBusy: 'queue',
      ...(opts.displayText ? { displayText: opts.displayText } : {}),
      ...(opts.effort ? { reasoningEffort: opts.effort } : {}),
    });
  }

  interrupt(sessionId: string, turnId?: string): Promise<unknown> {
    return this.call('turn/interrupt', { commandId: uuidv7(), sessionId, ...(turnId ? { turnId } : {}) }, 15_000);
  }

  decideApproval(p: {
    sessionId: string;
    approvalId: string;
    requirementId: unknown;
    choiceId: string;
    feedback?: string;
  }): Promise<{ terminal: boolean }> {
    return this.call('approval/decide', {
      commandId: uuidv7(),
      sessionId: p.sessionId,
      approvalId: p.approvalId,
      requirementId: p.requirementId,
      choiceId: p.choiceId,
      ...(p.feedback ? { feedback: p.feedback } : {}),
    });
  }

  answerUserInput(sessionId: string, userInputId: string, answers: UserInputAnswer[]): Promise<unknown> {
    return this.call('userInput/answer', { commandId: uuidv7(), sessionId, userInputId, answers });
  }

  cancelUserInput(sessionId: string, userInputId: string): Promise<unknown> {
    return this.call('userInput/cancel', { commandId: uuidv7(), sessionId, userInputId });
  }

  setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<unknown> {
    return this.call('session/setApprovalMode', { commandId: uuidv7(), sessionId, mode });
  }

  setModel(sessionId: string, model: ModelEntry): Promise<unknown> {
    return this.call('session/setModel', {
      commandId: uuidv7(),
      sessionId,
      model: { modelId: model.modelId, providerId: model.providerId, profileId: model.profileId, displayLabel: model.displayLabel },
    });
  }

  async listModels(sessionId?: string): Promise<ModelEntry[]> {
    const r = await this.call('model/list', sessionId ? { sessionId } : {});
    return r.models ?? [];
  }

  /** Built-in profiles: `:ask-me`, `:auto-review`, `:read-only`, `:unrestricted` (experimental API). */
  async listPermissionProfiles(sessionId?: string): Promise<PermissionProfile[]> {
    const r = await this.call('permissionProfile/list', sessionId ? { sessionId } : {});
    return r.profiles ?? [];
  }

  setPermissionProfile(sessionId: string, profileId: string): Promise<{ permissionState?: { profileId?: string } }> {
    return this.call('session/setPermissionProfile', { commandId: uuidv7(), sessionId, profileId });
  }

  readUsage(): Promise<any> {
    return this.call('usage/read', {});
  }
}
