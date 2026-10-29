// Builds the extra context sent with a message: @-mentioned files and folders, and what the
// user is looking at in the editor. Kept free of the vscode API so it can be tested.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_FILES = 10;
export const MAX_SELECTION_CHARS = 50_000;
const MAX_DIR_ENTRIES = 200;

export interface EditorContext {
  /** Path relative to the workspace folder. */
  rel: string;
  languageId?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Selected text; empty when nothing is selected. */
  selection: string;
}

/** `@path` tokens in a message, in order, without duplicates. Trailing punctuation is dropped. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s(])@((?:[^\s@`'"<>|]+))/g)) {
    const p = m[1].replace(/[),.;:!?]+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function fence(text: string): string {
  let f = '```';
  while (text.includes(f)) f += '`';
  return f;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface BuiltContext {
  /** Text to send as an extra message part, or '' when there's nothing to add. */
  text: string;
  attached: string[];
  /** Mentions that couldn't be attached, with the reason. */
  skipped: { path: string; reason: string }[];
}

export function buildContext(opts: { cwd: string; mentions: string[]; editor?: EditorContext }): BuiltContext {
  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const root = path.resolve(opts.cwd);

  for (const m of opts.mentions) {
    if (attached.length >= MAX_FILES) {
      skipped.push({ path: m, reason: `only ${MAX_FILES} files can be attached per message` });
      continue;
    }
    const abs = path.resolve(root, m);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push({ path: m, reason: 'outside the workspace' });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // not a path (e.g. an @handle in prose); leave it as text
    }
    const rel = path.relative(root, abs).split(path.sep).join('/') || '.';
    if (st.isDirectory()) {
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      blocks.push(`Folder ${rel}/ contains:\n${entries.join('\n') || '(empty)'}`);
      attached.push(rel + '/');
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      blocks.push(`File ${rel} is ${Math.round(st.size / 1024)} KB, too large to attach; read it with your tools if needed.`);
      skipped.push({ path: m, reason: 'too large to attach' });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) {
      skipped.push({ path: m, reason: 'binary file' });
      continue;
    }
    const text = buf.toString('utf8');
    const f = fence(text);
    blocks.push(`File ${rel}:\n${f}${langFor(rel)}\n${text}${text.endsWith('\n') ? '' : '\n'}${f}`);
    attached.push(rel);
  }

  const e = opts.editor;
  if (e) {
    if (e.selection) {
      const sel = e.selection.length > MAX_SELECTION_CHARS ? e.selection.slice(0, MAX_SELECTION_CHARS) + '\n…(truncated)' : e.selection;
      const f = fence(sel);
      const lines = e.startLine === e.endLine ? `line ${e.startLine}` : `lines ${e.startLine}-${e.endLine}`;
      blocks.push(`The user has ${e.rel} open with ${lines} selected:\n${f}${e.languageId ?? ''}\n${sel}\n${f}`);
    } else {
      blocks.push(`The user has ${e.rel} open in the editor (cursor on line ${e.startLine}).`);
    }
  }

  return {
    text: blocks.length ? `<context>\n${blocks.join('\n\n')}\n</context>` : '',
    attached,
    skipped,
  };
}

function langFor(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  const map: Record<string, string> = { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', css: 'css', html: 'html', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php' };
  return map[ext] ?? '';
}

/**
 * Scores a path for a fuzzy query (higher is better), or -1 when it doesn't match.
 * Matches the query's characters in order; favors file-name matches, prefixes and runs.
 */
export function scorePath(query: string, p: string): number {
  if (!query) return 1000 - p.length;
  const q = query.toLowerCase();
  const s = p.toLowerCase();
  const base = s.slice(s.lastIndexOf('/', s.length - 2) + 1);
  if (base.startsWith(q)) return 10_000 - p.length;
  if (base.includes(q)) return 8_000 - p.length;
  if (s.includes(q)) return 6_000 - p.length;
  let score = 0;
  let si = 0;
  let run = 0;
  for (const ch of q) {
    const found = s.indexOf(ch, si);
    if (found < 0) return -1;
    run = found === si ? run + 1 : 0;
    score += 10 + run * 5 - Math.min(found - si, 10);
    si = found + 1;
  }
  return score;
}

export function searchPaths(paths: string[], query: string, limit = 30): string[] {
  const scored: [number, string][] = [];
  for (const p of paths) {
    const sc = scorePath(query, p);
    if (sc >= 0) scored.push([sc, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, p]) => p);
}
