import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_FILE_BYTES, buildContext, parseMentions, scorePath, searchPaths } from '../src/context';

function ws(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ctx-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'has ``` fences\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([1, 2, 0, 3]));
  return dir;
}

test('parseMentions finds @paths and ignores emails and duplicates', () => {
  assert.deepEqual(parseMentions('look at @src/math.js, and @README.md. Also @src/math.js'), ['src/math.js', 'README.md']);
  assert.deepEqual(parseMentions('mail me at a@b.com'), []);
  assert.deepEqual(parseMentions('(@src/)'), ['src/']);
  assert.deepEqual(parseMentions('@first'), ['first']);
});

test('buildContext attaches files and folders, and explains what it skipped', () => {
  const dir = ws();
  const r = buildContext({ cwd: dir, mentions: ['src/math.js', 'src', 'big.txt', 'img.bin', 'nope.txt', '../etc/passwd', 'README.md'] });
  assert.deepEqual(r.attached, ['src/math.js', 'src/', 'README.md']);
  assert.match(r.text, /File src\/math\.js:\n```js\nfunction add/);
  assert.match(r.text, /Folder src\/ contains:\nmath\.js/);
  assert.match(r.text, /big\.txt is \d+ KB, too large/);
  // A file containing ``` gets a longer fence so it can't break out.
  assert.match(r.text, /File README\.md:\n````markdown\nhas ``` fences\n````/);
  assert.deepEqual(r.skipped.map((s) => [s.path, s.reason]), [
    ['big.txt', 'too large to attach'],
    ['img.bin', 'binary file'],
    ['../etc/passwd', 'outside the workspace'],
  ]);
  assert.ok(r.text.startsWith('<context>\n') && r.text.endsWith('\n</context>'));
});

test('editor context: selection or just the open file', () => {
  const dir = ws();
  const sel = buildContext({ cwd: dir, mentions: [], editor: { rel: 'src/math.js', languageId: 'javascript', startLine: 2, endLine: 2, selection: 'return a + b;' } });
  assert.match(sel.text, /src\/math\.js open with line 2 selected:\n```javascript\nreturn a \+ b;\n```/);
  const open = buildContext({ cwd: dir, mentions: [], editor: { rel: 'src/math.js', startLine: 7, endLine: 7, selection: '' } });
  assert.match(open.text, /has src\/math\.js open in the editor \(cursor on line 7\)/);
  assert.equal(buildContext({ cwd: dir, mentions: [] }).text, '');
});

test('file search favors file-name matches', () => {
  const paths = ['src/math.js', 'docs/mathematics/notes.md', 'test/math.test.js', 'src/main.ts', 'README.md'];
  assert.deepEqual(searchPaths(paths, 'math').slice(0, 2), ['src/math.js', 'test/math.test.js']);
  assert.ok(scorePath('mth', 'src/math.js') > 0);
  assert.equal(scorePath('zzz', 'src/math.js'), -1);
  assert.equal(searchPaths(paths, '').length, paths.length);
});
