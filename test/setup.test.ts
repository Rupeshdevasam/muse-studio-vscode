import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSetup, credentialsPresent, looksLikeAuthError, resolveMuseBinary, shellQuote } from '../src/setup';

function tmpHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-home-')));
}

function fakeMuse(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'muse');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Muse Code 9.9.9 (test)"\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function saveAuth(home: string, providers: object | string) {
  const dir = path.join(home, '.config', 'muse');
  fs.mkdirSync(dir, { recursive: true });
  const body = typeof providers === 'string' ? providers : JSON.stringify({ schema_version: 1, providers });
  fs.writeFileSync(path.join(dir, 'auth.json'), body);
}

test('finds muse in ~/.local/bin when it is not on PATH', () => {
  const home = tmpHome();
  const bin = fakeMuse(path.join(home, '.local', 'bin'));
  assert.equal(resolveMuseBinary('muse', { HOME: home, PATH: '/usr/bin:/bin' }), bin);
});

test('prefers PATH over the fallback folders', () => {
  const home = tmpHome();
  fakeMuse(path.join(home, '.local', 'bin'));
  const onPath = fakeMuse(path.join(home, 'onpath'));
  assert.equal(resolveMuseBinary('muse', { HOME: home, PATH: path.join(home, 'onpath') }), onPath);
});

test('an explicit path is used as-is and never guessed', () => {
  const home = tmpHome();
  const bin = fakeMuse(path.join(home, 'custom'));
  fakeMuse(path.join(home, '.local', 'bin'));
  assert.equal(resolveMuseBinary(bin, { HOME: home, PATH: '' }), bin);
  assert.equal(resolveMuseBinary('~/custom/muse', { HOME: home, PATH: '' }), bin);
  assert.equal(resolveMuseBinary(path.join(home, 'nope', 'muse'), { HOME: home, PATH: '' }), undefined);
});

test('reports missing when muse is nowhere', () => {
  const home = tmpHome();
  assert.equal(resolveMuseBinary('muse', { HOME: home, PATH: home }), undefined);
});

test('credentials: none, API key, saved login, logged out, unreadable file', () => {
  const home = tmpHome();
  assert.equal(credentialsPresent({ HOME: home }), false);
  assert.equal(credentialsPresent({ HOME: home, META_API_KEY: '  ' }), false);
  assert.equal(credentialsPresent({ HOME: home, META_API_KEY: 'k' }), true);
  saveAuth(home, { meta: { api_key: 'x' } });
  assert.equal(credentialsPresent({ HOME: home }), true);
  saveAuth(home, {}); // what `muse logout` leaves behind
  assert.equal(credentialsPresent({ HOME: home }), false);
  saveAuth(home, '{not json');
  assert.equal(credentialsPresent({ HOME: home }), true);
});

test('credentials honor XDG_CONFIG_HOME', () => {
  const home = tmpHome();
  const xdg = path.join(home, 'xdg');
  fs.mkdirSync(path.join(xdg, 'muse'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'muse', 'auth.json'), JSON.stringify({ providers: { meta: {} } }));
  assert.equal(credentialsPresent({ HOME: home, XDG_CONFIG_HOME: xdg }), true);
});

test('checkSetup walks missing -> signed-out -> ready', async () => {
  const home = tmpHome();
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  assert.deepEqual(await checkSetup('muse', '', env), { state: 'missing', configured: 'muse' });

  const bin = fakeMuse(path.join(home, '.local', 'bin'));
  assert.deepEqual(await checkSetup('muse', '', env), { state: 'signed-out', bin, version: 'Muse Code 9.9.9 (test)' });
  // Echo mode makes no model calls, so it doesn't need a login.
  assert.equal((await checkSetup('muse', 'echo', env)).state, 'ready');

  saveAuth(home, { meta: { api_key: 'x' } });
  assert.deepEqual(await checkSetup('muse', '', env), { state: 'ready', bin, version: 'Muse Code 9.9.9 (test)' });
});

test('recognizes the CLI sign-in error', () => {
  // Real stderr from Muse Code 1.4.14 when signed out.
  assert.ok(looksLikeAuthError('missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /Users/x/.config/muse/auth.json'));
  assert.ok(looksLikeAuthError('HTTP 401 Unauthorized'));
  assert.ok(!looksLikeAuthError('error: unexpected argument --foo'));
});

test('shellQuote keeps simple paths and quotes the rest', () => {
  assert.equal(shellQuote('/Users/a/.local/bin/muse'), '/Users/a/.local/bin/muse');
  assert.equal(shellQuote("/My Apps/it's/muse"), `'/My Apps/it'\\''s/muse'`);
});

test('Windows: finds muse.cmd / muse.exe via PATHEXT, and an unknown sign-in state counts as ready', async () => {
  const home = tmpHome();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'muse.cmd'), '@echo Muse Code 9.9.9\r\n');
  const env = { HOME: home, PATH: bin, PATHEXT: '.EXE;.CMD' };
  assert.equal(resolveMuseBinary('muse', env, 'win32'), path.join(bin, 'muse.cmd'));
  // Without a known credentials file, Windows doesn't claim "signed out"; the CLI decides.
  assert.equal(credentialsPresent(env, 'win32'), undefined);
  assert.equal(credentialsPresent(env, 'darwin'), false);
  assert.equal(credentialsPresent({ ...env, META_API_KEY: 'k' }, 'win32'), true);
});

test('needsShell only for .cmd/.bat on Windows', async () => {
  const { needsShell } = await import('../src/setup');
  assert.equal(needsShell('C:\\muse\\muse.cmd', 'win32'), true);
  assert.equal(needsShell('C:\\muse\\muse.exe', 'win32'), false);
  assert.equal(needsShell('/usr/local/bin/muse.cmd', 'darwin'), false);
});
