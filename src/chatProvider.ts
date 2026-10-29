import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { MuseHost, type ModelEntry, type PermissionProfile, type ReasoningEffort, type UserInputAnswer } from './msp/host';
import { RpcError, uuidv7, type RpcExit } from './msp/rpc';
import { ViewReducer, type UiEvent } from './view';
import { SessionStore, appendEvent, type ChatSession } from './sessions';
import * as path from 'node:path';
import { openDiff, openFile, openSnapshotDiff } from './diff';
import { changedSince, diffSnapshots, repoRoot, restore, snapshot } from './changes';
import { buildContext, parseMentions, searchPaths, type EditorContext } from './context';
import type { TurnInputPart } from './msp/host';
import { INSTALL_COMMAND, checkSetup, looksLikeAuthError, type SetupStatus } from './setup';

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageAttachment[]; includeEditor?: boolean }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'changeDiff'; id: string; path: string }
  | { type: 'undoChanges'; id: string; paths?: string[] }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'history' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openDiff'; path: string }
  | { type: 'openSettings' }
  | { type: 'checkSetup' }
  | { type: 'install' }
  | { type: 'signIn' }
  | { type: 'apiKey' }
  | { type: 'choosePath' }
  | { type: 'decide'; approvalId: string; choiceId: string; feedback?: string }
  | { type: 'answer'; userInputId: string; answers: UserInputAnswer[] }
  | { type: 'cancelQuestion'; userInputId: string }
  | { type: 'setModel'; modelId: string }
  | { type: 'setEffort'; effort: string }
  | { type: 'setProfile'; profileId: string };

export const EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Muse's built-in permission profiles, in the order the picker shows them. */
export const PROFILES = [':ask-me', ':auto-review', ':read-only', ':unrestricted'];

interface ImageAttachment {
  mediaType: string;
  base64: string;
  width?: number;
  height?: number;
  thumb?: string;
  name?: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const FILE_INDEX_LIMIT = 20_000;
const FILE_EXCLUDES = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.venv/**,**/__pycache__/**}';

interface Settings {
  path: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  permissionProfile: string;
  preset: string;
  extraArgs: string[];
  sendEditorContext: boolean;
  trackChanges: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'muse.chat';

  private view?: vscode.WebviewView;
  private session: ChatSession = newSession();
  private reducer = new ViewReducer();
  private pendingInsert?: string;

  // Connection to `muse serve`.
  private host?: MuseHost;
  private hostKey = '';
  /** Muse session ids loaded in the current host process. */
  private loaded = new Set<string>();
  private busy = false;
  private activeTurnId?: string;
  /** commandIds of messages already shown locally, so Muse's echo isn't shown twice. */
  private localEchoes = new Set<string>();
  /** Snapshot taken when Muse started working, for the "changed files" card. */
  private run?: { root: string; before: string };
  private finishingRun?: Promise<void>;
  private editor?: EditorContext & { cwd: string };
  private fileIndex?: Promise<string[]>;

  // Controls shown in the panel.
  private models: ModelEntry[] = [];
  private modelId?: string | null;
  private profiles: PermissionProfile[] = [];
  private profile: string;
  private effort: string;

  // Setup state.
  private setup?: SetupStatus;
  private setupCheck?: Promise<SetupStatus>;
  private setupTerminals = new Set<vscode.Terminal>();
  private setupPoll?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: SessionStore,
    private readonly state: vscode.Memento,
    private readonly log: vscode.OutputChannel,
    private readonly version: string,
  ) {
    const s = readSettings();
    this.profile = state.get<string>('muse.profile') ?? s.permissionProfile;
    this.effort = state.get<string>('muse.effort') ?? s.reasoningEffort;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) =>
      this.onMessage(msg).catch((err) => this.emit({ type: 'error', message: errorText(err) })),
    );
    view.onDidDispose(() => (this.view = undefined));
  }

  // ---------- commands ----------

  async newChat(): Promise<void> {
    if (this.busy) {
      vscode.window.showInformationMessage('Muse is still working. Stop it first, or wait for it to finish.');
      return;
    }
    this.switchTo(newSession());
  }

  async showHistory(): Promise<void> {
    const chats = this.store.list();
    if (!chats.length) {
      vscode.window.showInformationMessage('No Muse chats yet in this workspace.');
      return;
    }
    const deleteButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete chat' };
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
    const toItems = (list: ChatSession[]) =>
      list.map((s) => ({ id: s.id, label: s.title, description: new Date(s.updatedAt).toLocaleString(), buttons: [deleteButton] }));
    qp.items = toItems(chats);
    qp.placeholder = 'Resume a Muse chat';
    qp.onDidTriggerItemButton(async (e) => {
      await this.store.remove(e.item.id);
      qp.items = toItems(this.store.list());
    });
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      qp.hide();
      if (!picked) return;
      if (this.busy) {
        vscode.window.showInformationMessage('Muse is still working. Stop it first, or wait for it to finish.');
        return;
      }
      const s = this.store.get(picked.id);
      if (s) this.switchTo(s);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async stop(): Promise<void> {
    const id = this.session.museSessionId;
    if (!this.host?.running || !id || !this.busy) return;
    try {
      await this.host.interrupt(id, this.activeTurnId);
    } catch (err) {
      this.log.appendLine(`Interrupt failed: ${errorText(err)}`);
    }
  }

  /** Puts text into the input box, e.g. an editor selection. */
  async insert(text: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    if (this.view) this.post({ type: 'insert', text });
    else this.pendingInsert = text;
  }

  /** Settings that change how `muse serve` starts take effect on the next message. */
  onSettingsChanged(): void {
    if (!this.busy && this.hostKey && this.hostKey !== hostKeyFor(readSettings(), this.setupBin() ?? '')) this.stopHost();
    void this.refreshSetup();
  }

  dispose(): void {
    this.stopSetupPoll();
    this.stopHost();
  }

  // ---------- webview messages ----------

  private async onMessage(msg: FromWebview): Promise<void> {
    const cwd = this.session.cwd ?? workspaceRoot();
    switch (msg.type) {
      case 'ready':
        this.resetWebview();
        this.postControls();
        this.updateEditorContext();
        if ((await this.refreshSetup()).state === 'ready') void this.loadModels();
        if (this.pendingInsert) {
          this.post({ type: 'insert', text: this.pendingInsert });
          this.pendingInsert = undefined;
        }
        break;
      case 'send':
        await this.send(msg.text, msg.images ?? [], msg.includeEditor !== false);
        break;
      case 'searchFiles':
        this.post({ type: 'fileResults', requestId: msg.requestId, paths: searchPaths(await this.files(), msg.query, 30) });
        break;
      case 'changeDiff': {
        const ev = this.findChanges(msg.id);
        if (ev) await openSnapshotDiff(ev.root, ev.before, msg.path);
        break;
      }
      case 'undoChanges':
        await this.undoChanges(msg.id, msg.paths);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'history':
        await this.showHistory();
        break;
      case 'openFile':
        if (cwd) await openFile(msg.path, cwd, msg.line);
        break;
      case 'openDiff':
        if (cwd) await this.diffForPath(msg.path, cwd);
        break;
      case 'decide':
        await this.decide(msg.approvalId, msg.choiceId, msg.feedback);
        break;
      case 'answer':
        if (this.session.museSessionId && this.host) await this.host.answerUserInput(this.session.museSessionId, msg.userInputId, msg.answers);
        break;
      case 'cancelQuestion':
        if (this.session.museSessionId && this.host) await this.host.cancelUserInput(this.session.museSessionId, msg.userInputId);
        break;
      case 'setModel':
        await this.setModel(msg.modelId);
        break;
      case 'setEffort':
        this.effort = msg.effort;
        await this.state.update('muse.effort', msg.effort);
        this.postControls();
        break;
      case 'setProfile':
        await this.setProfile(msg.profileId);
        break;
      case 'checkSetup':
        await this.refreshSetup();
        break;
      case 'install':
        this.openSetupTerminal('Install Muse Code', `set -o pipefail; ${INSTALL_COMMAND}`);
        break;
      case 'signIn':
        if (this.setup && this.setup.state !== 'missing') {
          // The binary path is passed as $0 so it never needs shell quoting.
          this.openSetupTerminal('Muse Login', '"$0" login', [this.setup.bin]);
        }
        break;
      case 'apiKey':
        await this.saveApiKey();
        break;
      case 'choosePath':
        await this.choosePath();
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'muse.');
        break;
    }
  }

  // ---------- talking to Muse ----------

  private async send(text: string, images: ImageAttachment[], includeEditor: boolean): Promise<void> {
    const prompt = text.trim();
    images = images.filter((i) => IMAGE_TYPES.has(i.mediaType) && i.base64 && i.base64.length * 0.75 <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES);
    if (!prompt && !images.length) return;
    const cwd = this.session.cwd ?? workspaceRoot();
    if (!cwd) {
      this.emit({ type: 'error', message: 'Open a folder first. Muse works inside your workspace folder.' });
      return;
    }
    const status = await this.refreshSetup();
    if (status.state !== 'ready') {
      this.post({ type: 'insert', text: prompt }); // the setup card is showing; keep the text
      return;
    }

    // Context: @-mentioned files and what's open in the editor.
    const editor = includeEditor && readSettings().sendEditorContext ? this.currentEditor(cwd) : undefined;
    const ctx = buildContext({ cwd, mentions: parseMentions(prompt), editor });
    const attached = [...ctx.attached];
    if (editor) attached.push(editor.selection ? `${editor.rel}:${editor.startLine}-${editor.endLine}` : editor.rel);

    const session = this.session;
    session.cwd = cwd;
    if (!session.events.length) session.title = (prompt || 'Image').split('\n')[0].slice(0, 80);
    const commandId = uuidv7();
    this.localEchoes.add(commandId);
    this.emit({
      type: 'user',
      text: prompt,
      commandId,
      ...(images.length ? { images: images.map((i) => ({ thumb: i.thumb ?? '', name: i.name })) } : {}),
      ...(attached.length ? { attached } : {}),
    });
    for (const sk of ctx.skipped) this.emit({ type: 'notice', message: `Didn't attach @${sk.path}: ${sk.reason}.` });

    const input: TurnInputPart[] = [{ type: 'text', text: prompt || 'See the attached image.' }];
    // Muse joins parts with no separator, so start each extra part on a new paragraph.
    if (ctx.text) input.push({ type: 'text', text: '\n\n' + ctx.text });
    if (images.length) input.push({ type: 'text', text: '\n\n' });
    for (const i of images) input.push({ type: 'image', base64Data: i.base64, mediaType: i.mediaType, width: i.width, height: i.height });

    try {
      const host = await this.ensureHost(status.bin, cwd);
      const sessionId = await this.ensureSession(host, cwd);
      if (!this.busy) await this.startRun(cwd);
      this.setBusy(true);
      const effort = EFFORTS.includes(this.effort as ReasoningEffort) ? (this.effort as ReasoningEffort) : undefined;
      const r = await host.startTurn(sessionId, input, { effort, commandId, displayText: prompt || undefined });
      this.activeTurnId ??= r.turnId;
      if (r.disposition === 'queued') this.emit({ type: 'notice', message: 'Queued. Muse will read this after the current step.' });
    } catch (err) {
      this.setBusy(false);
      this.reportError(err);
    }
    await this.store.save(session);
  }

  // ---------- change tracking ----------

  /** Takes the "before" snapshot for the changed-files card, when the folder is a git repo. */
  private async startRun(cwd: string): Promise<void> {
    this.run = undefined;
    if (!readSettings().trackChanges) return;
    await this.finishingRun; // a previous run's "after" snapshot must land first
    try {
      const root = await repoRoot(cwd);
      if (!root) return;
      this.run = { root, before: await snapshot(root) };
    } catch (err) {
      this.log.appendLine(`Change tracking unavailable: ${errorText(err)}`);
    }
  }

  /** Compares against the "before" snapshot and shows what Muse changed. */
  private finishRun(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    this.finishingRun = (async () => {
      try {
        const after = await snapshot(run.root);
        const files = await diffSnapshots(run.root, run.before, after);
        if (files.length) this.emit({ type: 'changes', id: randomUUID(), root: run.root, before: run.before, after, files, reverted: [] });
        await this.store.save(this.session);
      } catch (err) {
        this.log.appendLine(`Couldn't compare changes: ${errorText(err)}`);
      }
    })();
  }

  private findChanges(id: string): Extract<UiEvent, { type: 'changes' }> | undefined {
    const ev = this.session.events.find((e) => e.type === 'changes' && e.id === id);
    return ev?.type === 'changes' ? ev : undefined;
  }

  private async undoChanges(id: string, paths?: string[]): Promise<void> {
    const ev = this.findChanges(id);
    if (!ev) return;
    if (this.busy) {
      vscode.window.showInformationMessage('Wait for Muse to finish (or stop it) before undoing changes.');
      return;
    }
    const todo = (paths ?? ev.files.map((f) => f.path)).filter((p) => !ev.reverted.includes(p));
    if (!todo.length) return;
    const editedSince = await changedSince(ev.root, ev.after, todo);
    if (editedSince.length) {
      const pick = await vscode.window.showWarningMessage(
        `${editedSince.length === 1 ? editedSince[0] + ' was' : editedSince.length + ' files were'} changed again after Muse finished. Undo anyway? Those later changes will be lost.`,
        { modal: true },
        'Undo anyway',
      );
      if (pick !== 'Undo anyway') return;
    }
    // Close clean editors' worries: write via the file system so open editors reload.
    const done = await restore(ev.root, ev.before, todo, async (abs) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: true });
    });
    this.emit({ type: 'changes-updated', id, reverted: [...ev.reverted, ...done] });
    await this.store.save(this.session);
  }

  /** Tool-card "Show diff": against the run's snapshot when there is one, else the last commit. */
  private async diffForPath(p: string, cwd: string): Promise<void> {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    const runs = [
      ...(this.run ? [{ root: this.run.root, before: this.run.before }] : []),
      ...this.session.events.filter((e): e is Extract<UiEvent, { type: 'changes' }> => e.type === 'changes').reverse(),
    ];
    for (const r of runs) {
      const rel = path.relative(r.root, abs).split(path.sep).join('/');
      if (rel.startsWith('..')) continue;
      if ('files' in r && !r.files.some((f) => f.path === rel)) continue;
      return openSnapshotDiff(r.root, r.before, rel);
    }
    await openDiff(p, cwd);
  }

  // ---------- editor context and file search ----------

  /** Called when the active editor or its selection changes. */
  updateEditorContext(): void {
    const cwd = this.session.cwd ?? workspaceRoot();
    const e = cwd ? this.currentEditor(cwd) : undefined;
    this.post({
      type: 'editorContext',
      ctx: e && readSettings().sendEditorContext
        ? { rel: e.rel, name: path.basename(e.rel), startLine: e.startLine, endLine: e.endLine, hasSelection: !!e.selection }
        : null,
    });
  }

  private currentEditor(cwd: string): EditorContext | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return undefined;
    const rel = path.relative(cwd, ed.document.uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const sel = ed.selection;
    const selection = sel.isEmpty ? '' : ed.document.getText(sel);
    const endLine = !sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return {
      rel: rel.split(path.sep).join('/'),
      languageId: ed.document.languageId,
      startLine: sel.start.line + 1,
      endLine: sel.isEmpty ? sel.start.line + 1 : endLine,
      selection,
    };
  }

  /** Workspace files (and their folders) for @-mention search, cached until files change. */
  private files(): Promise<string[]> {
    this.fileIndex ??= (async () => {
      const root = this.session.cwd ?? workspaceRoot();
      if (!root) return [];
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), FILE_EXCLUDES, FILE_INDEX_LIMIT);
      const files = uris.map((u) => path.relative(root, u.fsPath).split(path.sep).join('/')).filter((r) => r && !r.startsWith('..'));
      const dirs = new Set<string>();
      for (const f of files) {
        let d = path.posix.dirname(f);
        while (d && d !== '.' && !dirs.has(d + '/')) {
          dirs.add(d + '/');
          d = path.posix.dirname(d);
        }
      }
      return [...files, ...dirs];
    })();
    return this.fileIndex;
  }

  invalidateFileIndex(): void {
    this.fileIndex = undefined;
  }


  private async ensureHost(bin: string, cwd: string): Promise<MuseHost> {
    const s = readSettings();
    const key = hostKeyFor(s, bin);
    if (this.host && this.hostKey !== key && !this.busy) this.stopHost();
    if (!this.host) {
      const extraArgs = [...(s.preset ? ['--preset', s.preset] : []), ...s.extraArgs];
      const host = new MuseHost({ bin, cwd, provider: s.provider || undefined, extraArgs, clientVersion: this.version });
      host.on('log', (t: string) => this.log.append(t.endsWith('\n') ? t : t + '\n'));
      host.on('notification', (method: string, params: any) => this.onNotification(method, params));
      host.on('serverRequest', (method: string, params: any) => this.onServerRequest(method, params));
      host.on('exit', (exit: RpcExit) => this.onHostExit(host, exit));
      this.host = host;
      this.hostKey = key;
      this.log.appendLine(`[${new Date().toISOString()}] starting ${bin} serve in ${cwd}`);
    }
    await this.host.ensureStarted();
    return this.host;
  }

  private async ensureSession(host: MuseHost, cwd: string): Promise<string> {
    const s = this.session;
    if (s.museSessionId && this.loaded.has(s.museSessionId)) return s.museSessionId;
    if (s.museSessionId) {
      // Point the reducer at it first: pending approvals are re-sent right after the resume.
      this.reducer.sessionId = s.museSessionId;
      try {
        const info = await host.resumeSession(s.museSessionId);
        this.loaded.add(info.sessionId);
        this.applySessionInfo(info);
        return info.sessionId;
      } catch (err) {
        if (!(err instanceof RpcError) || !/sessionNotFound|notFound/.test(err.kind ?? '')) throw err;
        this.emit({ type: 'notice', message: "Muse no longer has this chat's history, so a new session was started. Earlier messages are shown here but Muse won't remember them." });
      }
    }
    const modelId = this.modelId ?? (readSettings().model || undefined);
    let info;
    try {
      info = await host.startSession({ workspaceRoot: cwd, permissionProfile: this.profile || undefined, modelId });
    } catch (err) {
      // Older or restricted hosts may not allow choosing a profile; fall back to their default.
      if (!(err instanceof RpcError) || !/permission_profile|permissionProfile/i.test(err.message)) throw err;
      this.log.appendLine(`Couldn't use permission profile ${this.profile}: ${err.message}`);
      this.emit({ type: 'notice', message: `Muse couldn't use the "${profileLabel(this.profile)}" permission profile here, so it's using its default.` });
      info = await host.startSession({ workspaceRoot: cwd, modelId });
    }
    s.museSessionId = info.sessionId;
    this.reducer.sessionId = info.sessionId;
    this.loaded.add(info.sessionId);
    this.applySessionInfo(info);
    void this.loadModels();
    return info.sessionId;
  }

  private applySessionInfo(info: { modelId?: string | null; status?: string; activeTurnId?: string | null }) {
    if (info.modelId) this.modelId = info.modelId;
    if (info.status === 'running') {
      this.activeTurnId = info.activeTurnId ?? undefined;
      this.setBusy(true);
    }
    this.postControls();
  }

  private async loadModels(): Promise<void> {
    try {
      const status = this.setup;
      if (!status || status.state !== 'ready') return;
      const host = await this.ensureHost(status.bin, this.session.cwd ?? workspaceRoot() ?? homedir());
      this.models = await host.listModels(this.session.museSessionId);
      try {
        this.profiles = await host.listPermissionProfiles(this.session.museSessionId);
      } catch (err) {
        this.log.appendLine(`Couldn't list permission profiles: ${errorText(err)}`);
      }
      const active = this.models.find((m) => m.isActive) ?? (!this.modelId ? this.models.find((m) => m.isDefault) : undefined);
      if (active && !this.modelId) this.modelId = active.modelId;
      this.postControls();
    } catch (err) {
      this.log.appendLine(`Couldn't list models: ${errorText(err)}`);
    }
  }

  private async setModel(modelId: string): Promise<void> {
    const entry = this.models.find((m) => m.modelId === modelId);
    if (!entry) return;
    this.modelId = modelId;
    const id = this.session.museSessionId;
    if (id && this.host?.running && this.loaded.has(id)) await this.host.setModel(id, entry);
    this.postControls();
  }

  private async setProfile(profileId: string): Promise<void> {
    if (!profileId || profileId === this.profile) return;
    const previous = this.profile;
    this.profile = profileId;
    const id = this.session.museSessionId;
    try {
      if (id && this.host?.running && this.loaded.has(id)) await this.host.setPermissionProfile(id, profileId);
      await this.state.update('muse.profile', profileId);
      this.emit({ type: 'notice', message: `Permissions: ${profileLabel(profileId)}.` });
    } catch (err) {
      this.profile = previous;
      this.emit({ type: 'error', message: `Couldn't switch permissions: ${errorText(err)}` });
    }
    this.postControls();
  }

  private async decide(approvalId: string, choiceId: string, feedback?: string): Promise<void> {
    const id = this.session.museSessionId;
    const a = this.reducer.getApproval(approvalId);
    if (!id || !a || !this.host) return;
    try {
      await this.host.decideApproval({ sessionId: id, approvalId, requirementId: a.requirementId, choiceId, feedback: feedback?.trim() || undefined });
    } catch (err) {
      // Already decided elsewhere (e.g. by Muse's reviewer): the resolved event updates the card.
      if (err instanceof RpcError && /approvalAlreadyResolved|approvalNotFound/.test(err.kind ?? '')) return;
      throw err;
    }
  }

  private onNotification(method: string, params: any): void {
    for (const ev of this.reducer.notification(method, params)) {
      if (ev.type === 'item' && ev.item.kind === 'userMessage' && ev.item.commandId && this.localEchoes.has(ev.item.commandId)) continue;
      if (ev.type === 'busy') {
        this.setBusy(ev.on);
        continue;
      }
      if (ev.type === 'turn') {
        if (ev.phase === 'started') this.activeTurnId = ev.turnId;
        else {
          this.activeTurnId = undefined;
          if (ev.error?.kind === 'authRequired' || looksLikeAuthError(ev.error?.message ?? '')) {
            this.emit({ type: 'error', message: "Muse isn't signed in, or its sign-in expired. Use **Sign in** above, then send your message again." });
            void this.refreshSetup().then(() => {
              if (this.setup?.state !== 'missing' && this.setup) this.post({ type: 'setup', status: { ...this.setup, state: 'signed-out' } });
            });
            continue;
          }
          void this.store.save(this.session);
        }
      }
      if (ev.type === 'session') {
        if (ev.modelId) this.modelId = ev.modelId;
        this.postControls();
        continue;
      }
      this.emit(ev);
    }
  }

  private onServerRequest(method: string, params: any): void {
    for (const ev of this.reducer.serverRequest(method, params)) this.emit(ev);
    if (method === 'approval/request' && !this.view?.visible) {
      void vscode.window
        .showInformationMessage('Muse is waiting for your approval.', 'Show')
        .then((pick) => pick && vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));
    }
  }

  private onHostExit(host: MuseHost, exit: RpcExit): void {
    if (host !== this.host) return;
    this.host = undefined;
    this.hostKey = '';
    this.loaded.clear();
    const wasBusy = this.busy;
    this.setBusy(false);
    this.activeTurnId = undefined;
    if (exit.spawnError) {
      this.emit({
        type: 'error',
        message:
          exit.spawnError.code === 'ENOENT'
            ? "Couldn't start the muse CLI. Use **Check again** in the setup card, or set **muse.path**."
            : `Couldn't start muse: ${exit.spawnError.message}`,
      });
    } else if (wasBusy || (exit.code !== 0 && exit.signal !== 'SIGTERM')) {
      const detail = exit.stderrTail.trim().split('\n').slice(-6).join('\n');
      this.emit({
        type: 'error',
        message: `Muse stopped unexpectedly (${exit.signal ?? `exit code ${exit.code}`}).` + (detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : ' See **Muse: Show Log**.'),
      });
    }
  }

  private reportError(err: unknown): void {
    const text = errorText(err);
    if (looksLikeAuthError(text)) {
      this.emit({ type: 'error', message: "Muse isn't signed in, or its sign-in expired. Use **Sign in** above, then send your message again." });
      void this.refreshSetup();
      return;
    }
    this.emit({ type: 'error', message: text });
  }

  private stopHost(): void {
    this.host?.removeAllListeners();
    this.host?.stop();
    this.host = undefined;
    this.hostKey = '';
    this.loaded.clear();
  }

  private switchTo(s: ChatSession): void {
    this.session = s;
    this.reducer = new ViewReducer(s.museSessionId);
    this.activeTurnId = undefined;
    this.localEchoes.clear();
    for (const e of s.events) if (e.type === 'user' && e.commandId) this.localEchoes.add(e.commandId);
    this.resetWebview();
  }

  // ---------- setup ----------

  /** Re-checks the CLI and sign-in, and shows or hides the setup card. */
  refreshSetup(): Promise<SetupStatus> {
    // Coalesce overlapping checks (focus changes, terminal closes, settings edits).
    this.setupCheck ??= (async () => {
      const cfg = readSettings();
      const status = await checkSetup(cfg.path, cfg.provider);
      const changed = JSON.stringify(status) !== JSON.stringify(this.setup);
      this.setup = status;
      if (changed) {
        this.log.appendLine(
          `Setup: ${status.state}` + (status.state === 'missing' ? ` (looked for "${status.configured}")` : ` — ${status.bin}${status.version ? ` (${status.version})` : ''}`),
        );
      }
      this.post({ type: 'setup', status });
      return status;
    })().finally(() => (this.setupCheck = undefined));
    return this.setupCheck;
  }

  /** Re-check when the user may have just installed or signed in elsewhere. */
  refreshSetupIfNeeded(): void {
    if (this.setup && this.setup.state !== 'ready') void this.refreshSetup();
  }

  onTerminalClosed(t: vscode.Terminal): void {
    if (!this.setupTerminals.delete(t)) return;
    if (!this.setupTerminals.size) this.stopSetupPoll();
    void this.refreshSetup().then((s) => {
      if (s.state === 'ready') void this.loadModels();
    });
  }

  private setupBin(): string | undefined {
    return this.setup && this.setup.state !== 'missing' ? this.setup.bin : undefined;
  }

  private stopSetupPoll(): void {
    clearInterval(this.setupPoll);
    this.setupPoll = undefined;
  }

  /**
   * Runs a setup command in a visible terminal under a plain, non-interactive bash rather than
   * the user's own shell, so shell startup files can't swallow or garble the command. On success
   * the terminal closes by itself; on failure it waits for Enter so the error stays readable.
   */
  private openSetupTerminal(name: string, script: string, args: string[] = []): void {
    const wrapped =
      `${script}\nstatus=$?\n` +
      `if [ $status -ne 0 ]; then printf '\\n%s (exit %s). Press Enter to close this terminal.' ${JSON.stringify(name + ' did not finish')} $status; read -r _; fi\n` +
      `exit $status`;
    const term = vscode.window.createTerminal({
      name,
      shellPath: '/bin/bash',
      shellArgs: ['-c', wrapped, ...args],
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    this.setupTerminals.add(term);
    term.show();
    // Also poll, in case the terminal is kept open after success. Gives up after 15 minutes.
    this.stopSetupPoll();
    const started = Date.now();
    this.setupPoll = setInterval(async () => {
      if (Date.now() - started > 15 * 60_000) return this.stopSetupPoll();
      if ((await this.refreshSetup()).state === 'ready') {
        this.stopSetupPoll();
        void this.loadModels();
      }
    }, 3000);
  }

  private async saveApiKey(): Promise<void> {
    if (!this.setup || this.setup.state === 'missing') return;
    const bin = this.setup.bin;
    const key = await vscode.window.showInputBox({
      title: 'Muse API key',
      prompt: 'Saved by the muse CLI (muse auth set). The key is passed on stdin, never on a command line.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter an API key'),
    });
    if (!key) return;
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(bin, ['auth', 'set', '--provider', 'meta', '--api-key-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.stdout.on('data', () => {});
      child.on('error', (e) => resolve({ code: -1, err: e.message }));
      child.on('close', (code) => resolve({ code, err }));
      child.stdin.end(key.trim() + '\n');
    });
    if (result.code === 0) vscode.window.showInformationMessage('Muse API key saved.');
    else vscode.window.showErrorMessage(`Muse couldn't save the key: ${result.err.trim() || `exit code ${result.code}`}`);
    if ((await this.refreshSetup()).state === 'ready') void this.loadModels();
  }

  private async choosePath(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select the muse CLI',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(homedir()),
    });
    if (!picked?.[0]) return;
    await vscode.workspace.getConfiguration('muse').update('path', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await this.refreshSetup();
  }

  // ---------- webview plumbing ----------

  private emit(ev: UiEvent): void {
    appendEvent(this.session.events, ev);
    this.session.updatedAt = Date.now();
    this.post({ type: 'event', event: ev });
  }

  private setBusy(on: boolean): void {
    if (this.busy === on) return;
    this.busy = on;
    vscode.commands.executeCommand('setContext', 'muse.busy', on);
    this.post({ type: 'busy', on });
    if (!on) this.finishRun();
  }

  private postControls(): void {
    const current = this.models.find((m) => m.modelId === this.modelId);
    this.post({
      type: 'controls',
      models: this.models.map((m) => {
        const contributor = /contributor/i.test(m.modelId);
        const label = m.displayLabel || m.modelId;
        return {
          id: m.modelId,
          label: contributor && !/contributor/i.test(label) ? `${label} (contributor)` : label,
          description: contributor
            ? 'Contributor model: cheaper, but Meta may use your sessions to train its models.'
            : (m.description ?? ''),
        };
      }),
      modelId: this.modelId ?? '',
      modelLabel: current?.displayLabel ?? this.modelId ?? '',
      effort: this.effort,
      defaultEffort: current?.defaultReasoningEffort ?? '',
      efforts: EFFORTS,
      profiles: (this.profiles.length ? this.profiles : PROFILES.map((id) => ({ profileId: id, label: profileLabel(id), description: '', available: true })))
        .filter((p) => p.available || p.profileId === this.profile)
        .map((p) => ({ id: p.profileId, label: p.label, description: p.description })),
      profile: this.profile,
    });
  }

  private resetWebview(): void {
    this.post({ type: 'reset', events: this.session.events, busy: this.busy });
    this.postControls();
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Muse</title>
</head>
<body>
<div id="app">
  <div id="setup" hidden></div>
  <div id="messages" role="log" aria-live="polite"></div>
  <div id="todos" hidden></div>
  <form id="composer">
    <div id="mentions" role="listbox" aria-label="Files" hidden></div>
    <div class="input-box">
      <div id="attachments">
        <span id="editor-chip" class="chip" hidden></span>
        <span id="images"></span>
      </div>
      <textarea id="input" rows="1" placeholder="Ask Muse… (@ for files)" aria-label="Message Muse"></textarea>
      <input id="file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <div class="input-toolbar">
        <button type="button" id="attach" class="icon-button" title="Attach images (or paste / drop them)" aria-label="Attach images"></button>
        <button type="button" id="mention" class="icon-button" title="Mention a file (@)" aria-label="Mention a file"></button>
        <span class="pill"><select id="model" title="Model" aria-label="Model"></select></span>
        <span class="pill"><select id="effort" title="Reasoning effort" aria-label="Reasoning effort"></select></span>
        <span class="pill"><select id="mode" title="What Muse may do without asking" aria-label="Permissions"></select></span>
        <span class="spacer"></span>
        <span id="meter" class="muted"></span>
        <button type="submit" id="send" class="round-button" title="Send (Enter)" aria-label="Send"></button>
        <button type="button" id="stop" class="round-button stop" title="Stop (Esc)" aria-label="Stop" hidden></button>
      </div>
    </div>
  </form>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function newSession(): ChatSession {
  return { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), events: [] };
}

function workspaceRoot(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('muse');
  return {
    path: c.get<string>('path', 'muse') || 'muse',
    provider: c.get<string>('provider', ''),
    model: c.get<string>('model', ''),
    reasoningEffort: c.get<string>('reasoningEffort', ''),
    permissionProfile: c.get<string>('permissionProfile', ':ask-me') || ':ask-me',
    preset: c.get<string>('preset', ''),
    extraArgs: c.get<string[]>('extraArgs', []),
    sendEditorContext: c.get<boolean>('sendEditorContext', true),
    trackChanges: c.get<boolean>('trackChanges', true),
  };
}

function profileLabel(id: string): string {
  return { ':ask-me': 'Ask me', ':auto-review': 'Auto-review', ':read-only': 'Read only', ':unrestricted': 'Unrestricted' }[id] ?? id;
}

function hostKeyFor(s: Settings, bin: string): string {
  return JSON.stringify([bin, s.provider, s.preset, s.extraArgs]);
}

function errorText(err: unknown): string {
  if (err instanceof RpcError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
