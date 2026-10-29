// Shows a file Muse edited as a diff against the last git commit.
// Muse doesn't report the file's previous contents, so git HEAD is the baseline.

import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { readFromSnapshot } from './changes';

export const HEAD_SCHEME = 'muse-head';

export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const file = uri.fsPath;
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', path.dirname(file), 'show', `HEAD:./${path.basename(file)}`],
        { maxBuffer: 20 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : stdout),
      );
    });
  }
}

export function resolvePath(p: string, cwd: string): vscode.Uri {
  return vscode.Uri.file(path.isAbsolute(p) ? p : path.join(cwd, p));
}

export async function openDiff(p: string, cwd: string): Promise<void> {
  const fileUri = resolvePath(p, cwd);
  const headUri = fileUri.with({ scheme: HEAD_SCHEME });
  const name = path.basename(fileUri.fsPath);
  await vscode.commands.executeCommand('vscode.diff', headUri, fileUri, `${name} (last commit ↔ now)`);
}

export async function openFile(p: string, cwd: string, line?: number): Promise<void> {
  const uri = resolvePath(p, cwd);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
    await vscode.window.showTextDocument(doc, {
      preview: true,
      selection: pos ? new vscode.Range(pos, pos) : undefined,
    });
  } catch {
    vscode.window.showWarningMessage(`Muse: couldn't open ${p}`);
  }
}

// ---------- diffs against a run's "before" snapshot ----------

export const SNAP_SCHEME = 'muse-snap';

/** Serves a file's contents from a git snapshot tree; empty when it didn't exist there. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { root, tree, rel } = JSON.parse(uri.query) as { root: string; tree: string; rel: string };
      if (!tree) return '';
      return (await readFromSnapshot(root, tree, rel))?.toString('utf8') ?? '';
    } catch {
      return '';
    }
  }
}

function snapUri(root: string, tree: string, rel: string): vscode.Uri {
  // The path only drives the tab label and language; the query says what to read.
  return vscode.Uri.from({ scheme: SNAP_SCHEME, path: '/' + rel, query: JSON.stringify({ root, tree, rel }) });
}

/** Opens "before Muse ↔ now" for one file changed during a run. */
export async function openSnapshotDiff(root: string, before: string, rel: string): Promise<void> {
  const abs = path.join(root, rel);
  const right = fs.existsSync(abs) ? vscode.Uri.file(abs) : snapUri(root, '', rel);
  await vscode.commands.executeCommand('vscode.diff', snapUri(root, before, rel), right, `${path.basename(rel)} (before Muse ↔ now)`);
}
