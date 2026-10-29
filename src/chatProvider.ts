import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { MuseHost, type ModelEntry, type PermissionProfile, type ReasoningEffort, type UserInputAnswer } from './msp/host';
import { RpcError, uuidv7, type RpcExit } from './msp/rpc';
import { TESTED_MUSE_VERSION, TESTED_SCHEMA_FINGERPRINTS, ViewReducer, historyToEvents, type UiEvent } from './view';
import { SessionStore, appendEvent, type ChatSession } from './sessions';
import * as path from 'node:path';
import { openDiff, openFile, openSnapshotDiff } from './diff';
import { changedSince, diffSnapshots, repoRoot, restore, snapshot, snapshotTooBig } from './changes';
import { buildContext, parseMentions, searchPaths, type EditorContext } from './context';
import type { TurnInputPart } from './msp/host';
import { INSTALL_COMMAND, INSTALL_PAGE, checkSetup, looksLikeAuthError, needsShell, type SetupStatus } from './setup';

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageAttachment[]; includeEditor?: boolean }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'changeDiff'; id: string; path: string }
  | { type: 'undoChanges'; id: string; paths?: string[] }
  | { type: 'slash'; name: string }
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
  showStatusBar: boolean;
  notifyOnFinish: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'muse.chat';

  private view?: vscode.WebviewView;
  /** The chat opened in an editor tab, mirroring the sidebar. */
  private panel?: vscode.WebviewPanel;
  private webviews = new Set<vscode.Webview>();
  private statusItem: vscode.StatusBarItem;
  /** Approvals and questions waiting on the user. */
  private waitingOnUser = new Set<string>();
  private usage: { windowPct?: number; weeklyPct?: number } = {};
  private lastReply = '';
  /** Notices shown once per chat (e.g. why Undo is unavailable). */
  private shownNotices = new Set<string>();
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
    private readonly globalState: vscode.Memento,
    private readonly log: vscode.OutputChannel,
    private readonly version: string,
  ) {
    const s = readSettings();
    this.profile = state.get<string>('muse.profile') ?? s.permissionProfile;
    this.effort = state.get<string>('muse.effort') ?? s.reasoningEffort;
    this.statusItem = vscode.window.createStatusBarItem('muse.status', vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = 'Muse Studio';
    this.statusItem.command = 'muse.focus';
    this.updateStatusBar();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.attachWebview(view.webview, 'sidebar');
    view.onDidDispose(() => {
      this.webviews.delete(view.webview);
      this.view = undefined;
    });
  }

  /** Opens the chat in a full-width editor tab. It mirrors the sidebar: same chat, same state. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('muse.chatEditor', 'Muse Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    this.panel = panel;
    this.attachWebview(panel.webview, 'editor');
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      this.panel = undefined;
    });
  }

  private attachWebview(webview: vscode.Webview, where: 'sidebar' | 'editor'): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.html(webview, where);
    webview.onDidReceiveMessage((msg: FromWebview) =>
      this.onMessage(msg).catch((err) => this.emit({ type: 'error', message: errorText(err) })),
    );
    this.webviews.add(webview);
  }

  private isVisible(): boolean {
    return !!(this.view?.visible || this.panel?.visible);
  }

  private reveal(): void {
    if (this.panel) this.panel.reveal();
    else void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
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
    type Pick = vscode.QuickPickItem & { id?: string; museSessionId?: string; title?: string };
    const deleteButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete chat' };
    const qp = vscode.window.createQuickPick<Pick>();
    qp.placeholder = 'Resume a Muse chat';
    qp.matchOnDescription = true;
    let fromMuse: Pick[] = [];
    const build = () => {
      const chats = this.store.list();
      const known = new Set(chats.map((c) => c.museSessionId).filter(Boolean));
      const local: Pick[] = chats.map((s) => ({ id: s.id, label: s.title, description: new Date(s.updatedAt).toLocaleString(), buttons: [deleteButton] }));
      const cli = fromMuse.filter((p) => !known.has(p.museSessionId));
      qp.items = [
        ...local,
        ...(cli.length ? [{ label: 'Started outside this panel', kind: vscode.QuickPickItemKind.Separator } as Pick, ...cli] : []),
      ];
    };
    build();
    qp.busy = true;
    qp.show();
    // Chats started in the Muse CLI (or another client) for this folder.
    void this.museSessionsForWorkspace().then((list) => {
      fromMuse = list;
      qp.busy = false;
      build();
      if (!qp.items.length) qp.placeholder = 'No Muse chats yet in this workspace';
    });
    qp.onDidTriggerItemButton(async (e) => {
      if (e.item.id) await this.store.remove(e.item.id);
      build();
    });
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      qp.hide();
      if (!picked) return;
      if (this.busy) {
        vscode.window.showInformationMessage('Muse is still working. Stop it first, or wait for it to finish.');
        return;
      }
      if (picked.id) {
        const s = this.store.get(picked.id);
        if (s) this.switchTo(s);
      } else if (picked.museSessionId) {
        void this.openMuseSession(picked.museSessionId, picked.title ?? 'Chat');
      }
    });
    qp.onDidHide(() => qp.dispose());
  }

  private async museSessionsForWorkspace(): Promise<(vscode.QuickPickItem & { museSessionId: string; title: string })[]> {
    const cwd = this.session.cwd ?? workspaceRoot();
    const status = this.setup;
    if (!cwd || !status || status.state !== 'ready') return [];
    try {
      const host = await this.ensureHost(status.bin, cwd);
      const sessions = await host.listSessions(cwd);
      return sessions
        .filter((s) => (s.kind ?? 'root') === 'root' && (s.generatedName || s.firstUserPrompt))
        .map((s) => {
          const title = (s.generatedName || s.firstUserPrompt || 'Chat').split('\n')[0].slice(0, 80);
          return {
            museSessionId: s.sessionId,
            title,
            label: `$(terminal) ${title}`,
            description: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '',
            detail: 'From Muse (CLI or another app)',
          };
        });
    } catch (err) {
      this.log.appendLine(`Couldn't list Muse sessions: ${errorText(err)}`);
      return [];
    }
  }

  /** Opens a chat that exists in Muse but not in this panel, showing its history. */
  private async openMuseSession(museSessionId: string, title: string): Promise<void> {
    const cwd = this.session.cwd ?? workspaceRoot();
    const status = this.setup;
    if (!cwd || !status || status.state !== 'ready') return;
    const chat: ChatSession = { id: randomUUID(), museSessionId, title, cwd, updatedAt: Date.now(), events: [] };
    this.switchTo(chat);
    try {
      const host = await this.ensureHost(status.bin, cwd);
      const info = await host.resumeSession(museSessionId, true);
      this.loaded.add(museSessionId);
      for (const ev of historyToEvents(info.historyItems ?? [])) appendEvent(chat.events, ev);
      this.applySessionInfo(info);
      this.resetWebview();
      await this.store.save(chat);
    } catch (err) {
      this.emit({ type: 'error', message: `Couldn't open that chat: ${errorText(err)}` });
    }
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
    if (this.panel) this.panel.reveal();
    else await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    if (this.webviews.size) this.post({ type: 'insert', text });
    else this.pendingInsert = text;
  }

  /** Settings that change how `muse serve` starts take effect on the next message. */
  onSettingsChanged(): void {
    if (!this.busy && this.hostKey && this.hostKey !== hostKeyFor(readSettings(), this.setupBin() ?? '')) this.stopHost();
    this.updateStatusBar();
    void this.refreshSetup();
  }

  dispose(): void {
    this.statusItem.dispose();
    this.panel?.dispose();
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
        if (process.platform === 'win32') {
          // The installer is a bash script; on Windows, send people to Meta's page instead.
          await vscode.env.openExternal(vscode.Uri.parse(INSTALL_PAGE));
        } else {
          this.openSetupTerminal('Install Muse Code', `set -o pipefail; ${INSTALL_COMMAND}`);
        }
        break;
      case 'signIn':
        if (this.setup && this.setup.state !== 'missing') {
          if (process.platform === 'win32') this.openLoginTerminalWindows(this.setup.bin);
          // The binary path is passed as $0 so it never needs shell quoting.
          else this.openSetupTerminal('Muse Login', '"$0" login', [this.setup.bin]);
        }
        break;
      case 'apiKey':
        await this.saveApiKey();
        break;
      case 'choosePath':
        await this.choosePath();
        break;
      case 'slash':
        await this.runSlash(msg.name);
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
      const tooBig = await snapshotTooBig(root);
      if (tooBig) {
        this.noticeOnce('snapshot-too-big', `Review and undo are off for this folder: ${tooBig}.`);
        return;
      }
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
    this.checkMuseVersion(this.host);
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
          if (!ev.error && ev.terminal === 'completed') this.notifyFinished();
        }
      }
      if (ev.type === 'item' && ev.item.kind === 'agentMessage' && ev.item.text) this.lastReply = ev.item.text;
      if (ev.type === 'usage') {
        this.usage = { windowPct: ev.windowPct, weeklyPct: ev.weeklyPct };
        this.updateStatusBar();
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
    for (const ev of this.reducer.serverRequest(method, params)) {
      if (ev.type === 'approval') this.waitingOnUser.add(ev.approval.approvalId);
      if (ev.type === 'question') this.waitingOnUser.add(ev.question.userInputId);
      this.emit(ev);
    }
    this.updateStatusBar();
    if (!this.isVisible() || !vscode.window.state.focused) {
      const what = method === 'approval/request' ? 'your approval' : 'an answer from you';
      void vscode.window.showInformationMessage(`Muse is waiting for ${what}.`, 'Show').then((pick) => pick && this.reveal());
    }
  }

  private notifyFinished(): void {
    if (!readSettings().notifyOnFinish) return;
    if (this.isVisible() && vscode.window.state.focused) return;
    const summary = this.lastReply.replace(/[#*`>_\[\]]/g, '').trim().split('\n').find((l) => l.trim()) ?? '';
    const text = summary.length > 120 ? summary.slice(0, 119) + '…' : summary;
    void vscode.window.showInformationMessage(`Muse finished${text ? ': ' + text : '.'}`, 'Show').then((pick) => pick && this.reveal());
  }

  // ---------- slash commands ----------

  private async runSlash(name: string): Promise<void> {
    switch (name) {
      case 'new':
      case 'clear':
        return this.newChat();
      case 'history':
        return this.showHistory();
      case 'stop':
        return this.stop();
      case 'compact':
        return this.compact();
      case 'model': {
        if (!this.models.length) await this.loadModels();
        const pick = await vscode.window.showQuickPick(
          this.models.map((m) => ({
            label: m.displayLabel || m.modelId,
            description: m.modelId === this.modelId ? 'current' : /contributor/i.test(m.modelId) ? 'contributor: Meta may train on your sessions' : '',
            id: m.modelId,
          })),
          { placeHolder: 'Choose a model' },
        );
        if (pick) await this.setModel(pick.id);
        return;
      }
      case 'effort': {
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Default', id: '' }, ...EFFORTS.map((e) => ({ label: e[0].toUpperCase() + e.slice(1), id: e as string }))].map((p) => ({
            ...p,
            description: p.id === this.effort ? 'current' : '',
          })),
          { placeHolder: 'Reasoning effort for your next messages' },
        );
        if (pick) {
          this.effort = pick.id;
          await this.state.update('muse.effort', pick.id);
          this.postControls();
        }
        return;
      }
      case 'permissions': {
        const list = this.profiles.length ? this.profiles : PROFILES.map((id) => ({ profileId: id, label: profileLabel(id), description: '' }));
        const pick = await vscode.window.showQuickPick(
          list.map((p) => ({ label: p.label, detail: p.description, description: p.profileId === this.profile ? 'current' : '', id: p.profileId })),
          { placeHolder: 'What Muse may do without asking' },
        );
        if (pick) await this.setProfile(pick.id);
        return;
      }
    }
  }

  private async compact(): Promise<void> {
    const id = this.session.museSessionId;
    if (!id || !this.host?.running || !this.loaded.has(id)) {
      this.emit({ type: 'notice', message: 'Nothing to compact yet. Send a message first.' });
      return;
    }
    try {
      const r = await this.host.compact(id);
      if (r.status === 'noop') this.emit({ type: 'notice', message: `Nothing to compact${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}.` });
      else this.emit({ type: 'notice', message: 'Compacting earlier messages to free up context…' });
    } catch (err) {
      const msg = errorText(err);
      this.emit({
        type: 'notice',
        message: /compaction_unavailable/.test(msg) ? "Muse can't compact this chat right now." : `Couldn't compact: ${msg}`,
      });
    }
  }

  // ---------- status bar and one-time notices ----------

  updateStatusBar(): void {
    const item = this.statusItem;
    if (!readSettings().showStatusBar) {
      item.hide();
      return;
    }
    const waiting = this.waitingOnUser.size > 0;
    item.text = waiting ? '$(bell-dot) Muse needs you' : this.busy ? '$(loading~spin) Muse' : '$(sparkle) Muse';
    item.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const lines = [waiting ? '**Muse is waiting for you.** Click to open the chat.' : this.busy ? '**Muse is working.**' : '**Muse Studio**: click to open the chat.'];
    if (typeof this.usage.windowPct === 'number') lines.push(`5-hour allowance used: ${this.usage.windowPct}%`);
    if (typeof this.usage.weeklyPct === 'number') lines.push(`Weekly allowance used: ${this.usage.weeklyPct}%`);
    item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    item.show();
  }

  private noticeOnce(key: string, message: string): void {
    if (this.shownNotices.has(key)) return;
    this.shownNotices.add(key);
    this.emit({ type: 'notice', message });
  }

  /** Warns once per Muse build when its protocol differs from the one this version was tested with. */
  private checkMuseVersion(host: MuseHost): void {
    const init = host.initializeResult;
    const fp: string | undefined = init?.schema?.fingerprint;
    const version: string = init?.serverInfo?.version ?? '?';
    if (!fp || TESTED_SCHEMA_FINGERPRINTS.has(fp)) return;
    this.log.appendLine(`Muse ${version} uses protocol ${fp}; this extension was tested with Muse ${TESTED_MUSE_VERSION}.`);
    const seen = this.globalState.get<string[]>('muse.seenFingerprints', []);
    if (seen.includes(fp)) return;
    void this.globalState.update('muse.seenFingerprints', [...seen, fp]);
    this.emit({
      type: 'notice',
      message: `You're on Muse ${version}, which is newer than the version Muse Studio was tested with (${TESTED_MUSE_VERSION}). If something looks off, check for a Muse Studio update.`,
    });
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
    this.shownNotices.clear();
    this.waitingOnUser.clear();
    this.lastReply = '';
    this.updateStatusBar();
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
      this.post({ type: 'setup', status, platform: process.platform, remote: vscode.env.remoteName ?? '' });
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

  /** Windows has no /bin/bash; run `muse login` directly. The terminal stays open if it fails. */
  private openLoginTerminalWindows(bin: string): void {
    const term = vscode.window.createTerminal({ name: 'Muse Login', shellPath: bin, shellArgs: ['login'] });
    this.setupTerminals.add(term);
    term.show();
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
      const child = spawn(bin, ['auth', 'set', '--provider', 'meta', '--api-key-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell(bin) });
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
    if (ev.type === 'approval-resolved' || ev.type === 'question-settled') {
      const id = ev.type === 'approval-resolved' ? ev.approvalId : ev.userInputId;
      if (this.waitingOnUser.delete(id)) this.updateStatusBar();
    }
    appendEvent(this.session.events, ev);
    this.session.updatedAt = Date.now();
    this.post({ type: 'event', event: ev });
  }

  private setBusy(on: boolean): void {
    if (this.busy === on) return;
    this.busy = on;
    vscode.commands.executeCommand('setContext', 'muse.busy', on);
    this.post({ type: 'busy', on });
    if (!on) {
      this.waitingOnUser.clear();
      this.finishRun();
    }
    this.updateStatusBar();
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
    for (const w of this.webviews) void w.postMessage(msg);
  }

  private html(webview: vscode.Webview, where: 'sidebar' | 'editor' = 'sidebar'): string {
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
<body data-host="${where}">
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
    showStatusBar: c.get<boolean>('showStatusBar', true),
    notifyOnFinish: c.get<boolean>('notifyOnFinish', true),
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
