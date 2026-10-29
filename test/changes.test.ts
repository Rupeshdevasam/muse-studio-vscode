import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { changedSince, diffSnapshots, readFromSnapshot, repoRoot, restore, snapshot } from '../src/changes';

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-changes-')));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return dir;
}

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

test('repoRoot finds the work tree, and nothing outside one', async () => {
  const dir = makeRepo();
  assert.equal(await repoRoot(path.join(dir, 'src')), dir);
  assert.equal(await repoRoot(fs.realpathSync(os.tmpdir())), undefined);
});

test('snapshots see edits, new files, deletions and shell changes; ignored files are skipped', async () => {
  const dir = makeRepo();
  // The user has their own uncommitted and staged work before the run.
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\nmine\n');
  git(dir, 'add', 'keep.txt');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'untracked before\n');
  const indexBefore = git(dir, 'diff', '--cached', '--name-only');

  const before = await snapshot(dir);

  // "Muse" edits a file, creates one, deletes one, and a shell command writes another.
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'new\n');
  fs.rmSync(path.join(dir, 'notes.md'));
  execFileSync('/bin/sh', ['-c', 'echo built > out.txt'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'ignored'));
  fs.writeFileSync(path.join(dir, 'ignored', 'x.log'), 'noise\n');

  const after = await snapshot(dir);
  const changes = await diffSnapshots(dir, before, after);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), ['notes.md', 'out.txt', 'src/a.js', 'src/b.js']);
  assert.equal(byPath['src/a.js'].status, 'modified');
  assert.equal(byPath['src/a.js'].added, 2);
  assert.equal(byPath['src/a.js'].removed, 1);
  assert.equal(byPath['src/b.js'].status, 'added');
  assert.equal(byPath['notes.md'].status, 'deleted');

  // The user's real index and branch are untouched.
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), indexBefore);
  assert.equal(git(dir, 'log', '--oneline').trim().split('\n').length, 1);
  assert.equal(git(dir, 'stash', 'list'), '');

  assert.equal((await readFromSnapshot(dir, before, 'src/a.js'))?.toString(), 'one\ntwo\n');
  assert.equal(await readFromSnapshot(dir, before, 'src/b.js'), undefined);
});

test("restore puts everything back, including the user's own uncommitted work", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\nmine\n'); // uncommitted user change
  const before = await snapshot(dir);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'clobbered\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'new\n');
  fs.rmSync(path.join(dir, 'src', 'a.js'));
  const after = await snapshot(dir);
  const changes = await diffSnapshots(dir, before, after);

  const restored = await restore(dir, before, changes.map((c) => c.path));
  assert.equal(restored.length, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep\nmine\n');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'one\ntwo\n');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'b.js')));
  assert.deepEqual(await diffSnapshots(dir, before, await snapshot(dir)), []);
});

test('changedSince spots files edited again after the run', async () => {
  const dir = makeRepo();
  const before = await snapshot(dir);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'muse\n');
  const after = await snapshot(dir);
  assert.deepEqual(await changedSince(dir, after, ['src/a.js']), []);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'muse\nand the user\n');
  assert.deepEqual(await changedSince(dir, after, ['src/a.js']), ['src/a.js']);
  void before;
});

test('restore refuses paths that escape the repository', async () => {
  const dir = makeRepo();
  const before = await snapshot(dir);
  assert.deepEqual(await restore(dir, before, ['../outside.txt']), []);
});

test('works in a repository with no commits yet', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-empty-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const before = await snapshot(dir);
  fs.writeFileSync(path.join(dir, 'first.txt'), 'hi\n');
  const changes = await diffSnapshots(dir, before, await snapshot(dir));
  assert.deepEqual(changes.map((c) => [c.path, c.status]), [['first.txt', 'added']]);
});
