// Tracks what Muse changed in a git workspace during a run, and can undo it.
//
// A snapshot is a git tree object of the whole working tree (tracked and untracked files,
// respecting .gitignore). It's built with a temporary index file, so the user's real index,
// branches and stash are never touched. Comparing the tree from before a run with the tree
// after it gives every added, modified and deleted file, including ones changed by shell
// commands. Kept free of the vscode API so it can be tested with plain Node.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FileChange {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
  binary?: boolean;
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr?.toString().trim() || err.message}`));
        else resolve({ stdout, stderr: stderr.toString() });
      },
    );
  });
}

/** The repository root containing `dir`, or undefined when it isn't in a git work tree. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    const r = await git(dir, ['rev-parse', '--show-toplevel']);
    const top = r.stdout.toString().trim();
    // git prints forward slashes on Windows; normalize so path comparisons work.
    return top ? path.resolve(top) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the current working tree into the object store and returns its tree id. */
export async function snapshot(root: string): Promise<string> {
  const realIndex = (await git(root, ['rev-parse', '--git-path', 'index'])).stdout.toString().trim();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-snap-'));
  const tmpIndex = path.join(tmpDir, 'index');
  try {
    // Starting from a copy of the real index lets git reuse its file-stat cache, which keeps
    // this fast in large repositories. A repo with no commits yet has no index; that's fine.
    const src = path.isAbsolute(realIndex) ? realIndex : path.join(root, realIndex);
    if (fs.existsSync(src)) fs.copyFileSync(src, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ['add', '-A', '--', '.'], env, 60_000);
    return (await git(root, ['write-tree'], env)).stdout.toString().trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Files that differ between two snapshots, with line counts where git can count them. */
export async function diffSnapshots(root: string, before: string, after: string): Promise<FileChange[]> {
  if (before === after) return [];
  const status = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', before, after])).stdout.toString();
  const numstat = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', before, after])).stdout.toString();

  const counts = new Map<string, { added?: number; removed?: number; binary?: boolean }>();
  // -z numstat: "<added>\t<removed>\t<path>\0"
  for (const rec of numstat.split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    counts.set(m[3], m[1] === '-' ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
  }

  const out: FileChange[] = [];
  // -z name-status: "<status>\0<path>\0"
  const parts = status.split('\0').filter((p) => p.length);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    const p = parts[i + 1];
    const st = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    out.push({ path: p, status: st, ...counts.get(p) });
  }
  return out;
}

/** A file's contents in a snapshot, or undefined when it didn't exist there. */
export async function readFromSnapshot(root: string, tree: string, relPath: string): Promise<Buffer | undefined> {
  try {
    return (await git(root, ['cat-file', 'blob', `${tree}:${relPath}`])).stdout;
  } catch {
    return undefined;
  }
}

/**
 * Puts files back the way they were in `before`. Files that didn't exist then are deleted
 * (via `remove`, so the caller can send them to the trash). Returns the paths it changed.
 * A file that was changed again after the run is restored too; callers should warn first.
 */
export async function restore(
  root: string,
  before: string,
  paths: string[],
  remove: (absPath: string) => Promise<void> = async (p) => fs.rmSync(p, { force: true }),
): Promise<string[]> {
  const done: string[] = [];
  const rootAbs = path.resolve(root);
  for (const rel of paths) {
    const abs = path.resolve(rootAbs, rel);
    if (!abs.startsWith(rootAbs + path.sep)) continue; // never write outside the repository
    const content = await readFromSnapshot(root, before, rel);
    if (content === undefined) {
      if (fs.existsSync(abs)) await remove(abs);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    done.push(rel);
  }
  return done;
}

/** Which of `paths` differ now from how they were in `after`, i.e. were edited again since. */
export async function changedSince(root: string, after: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of paths) {
    const then = await readFromSnapshot(root, after, rel);
    const abs = path.join(root, rel);
    const now = fs.existsSync(abs) ? fs.readFileSync(abs) : undefined;
    if ((then === undefined) !== (now === undefined) || (then && now && !then.equals(now))) out.push(rel);
  }
  return out;
}

export interface SnapshotLimits {
  /** Untracked files above this many are too slow to hash on every run. */
  maxUntrackedFiles: number;
  maxUntrackedBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxUntrackedFiles: 20_000,
  maxUntrackedBytes: 200 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
};

/**
 * Whether snapshotting this repository is cheap enough to do on every run. Tracked files are
 * already in git's object store, so only untracked (non-ignored) files add real cost.
 * Returns a reason when it's too big, so the caller can tell the user why Undo is unavailable.
 */
export async function snapshotTooBig(root: string, limits: SnapshotLimits = DEFAULT_LIMITS): Promise<string | undefined> {
  const out = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], undefined, 20_000)).stdout.toString();
  const files = out.split('\0').filter(Boolean);
  if (files.length > limits.maxUntrackedFiles) {
    return `${files.length.toLocaleString('en-US')} untracked files (limit ${limits.maxUntrackedFiles.toLocaleString('en-US')}); add build or dependency folders to .gitignore`;
  }
  let total = 0;
  for (const rel of files) {
    let size = 0;
    try {
      size = fs.statSync(path.join(root, rel)).size;
    } catch {
      continue;
    }
    if (size > limits.maxFileBytes) return `${rel} is ${Math.round(size / 1024 / 1024)} MB and isn't ignored by git`;
    total += size;
    if (total > limits.maxUntrackedBytes) return `untracked files add up to more than ${Math.round(limits.maxUntrackedBytes / 1024 / 1024)} MB`;
  }
  return undefined;
}
