import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatViewProvider } from './chatProvider';
import { SessionStore } from './sessions';
import { GitHeadContentProvider, HEAD_SCHEME, SNAP_SCHEME, SnapshotContentProvider } from './diff';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Muse');
  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  const provider = new ChatViewProvider(
    context.extensionUri,
    new SessionStore(context.workspaceState),
    context.workspaceState,
    context.globalState,
    log,
    version,
  );

  let selectionTimer: NodeJS.Timeout | undefined;
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);

  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, new GitHeadContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(SNAP_SCHEME, new SnapshotContentProvider()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.updateEditorContext()),
    vscode.window.onDidChangeTextEditorSelection(() => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => provider.updateEditorContext(), 150);
    }),
    fileWatcher,
    fileWatcher.onDidCreate(() => provider.invalidateFileIndex()),
    fileWatcher.onDidDelete(() => provider.invalidateFileIndex()),
    vscode.commands.registerCommand('muse.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('muse.focus', () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
    vscode.window.onDidCloseTerminal((t) => provider.onTerminalClosed(t)),
    vscode.window.onDidChangeWindowState((w) => w.focused && provider.refreshSetupIfNeeded()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('muse')) provider.onSettingsChanged();
    }),
    vscode.commands.registerCommand('muse.checkSetup', () => provider.refreshSetup()),
    vscode.commands.registerCommand('muse.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('muse.history', () => provider.showHistory()),
    vscode.commands.registerCommand('muse.stop', () => provider.stop()),
    vscode.commands.registerCommand('muse.showLog', () => log.show()),
    vscode.commands.registerCommand('muse.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rupeshdevasam.muse-studio'),
    ),
    vscode.commands.registerCommand('muse.addSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const doc = editor.document;
      const sel = editor.selection;
      const rel = vscode.workspace.asRelativePath(doc.uri, false) || path.basename(doc.uri.fsPath);
      const start = sel.start.line + 1;
      const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const lines = start === end ? `line ${start}` : `lines ${start}-${end}`;
      const fence = doc.getText(sel).includes('```') ? '````' : '```';
      provider.insert(`In ${rel} (${lines}):\n${fence}${doc.languageId}\n${doc.getText(sel)}\n${fence}\n`);
    }),
  );
}

export function deactivate(): void {}
