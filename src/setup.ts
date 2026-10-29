// Checks whether the muse CLI is installed and signed in, before the user sends anything.
// Kept free of the vscode API so it can be tested with plain Node.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export const INSTALL_COMMAND = 'curl -fsSL https://dev.meta.ai/install.sh | bash';

export type SetupStatus =
  | { state: 'missing'; configured: string }
  | { state: 'signed-out'; bin: string; version?: string }
  | { state: 'ready'; bin: string; version?: string };

type Env = NodeJS.ProcessEnv;

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Places the installer and package managers put muse, for when VS Code's PATH doesn't include them. */
export function fallbackLocations(env: Env = process.env): string[] {
  const home = env.HOME || os.homedir();
  const dirs = [
    env.MUSE_INSTALL_DIR,
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((d): d is string => !!d);
  return dirs.map((d) => path.join(d, 'muse'));
}

/** Finds the muse binary: the configured path, then PATH, then the usual install folders. */
export function resolveMuseBinary(configured: string, env: Env = process.env): string | undefined {
  const name = configured.trim() || 'muse';
  if (name.startsWith('~')) return resolveMuseBinary(path.join(env.HOME || os.homedir(), name.slice(1)), env);
  if (path.isAbsolute(name) || name.includes(path.sep)) {
    // An explicit path is used as-is; if it's wrong, report missing rather than guessing.
    return isExecutable(name) ? name : undefined;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  if (name !== 'muse') return undefined;
  return fallbackLocations(env).find(isExecutable);
}

/** Same rule the CLI uses: META_API_KEY wins, then a saved login with at least one provider. */
export function credentialsPresent(env: Env = process.env): boolean {
  if (env.META_API_KEY?.trim()) return true;
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(base, 'muse', 'auth.json'), 'utf8');
  } catch {
    return false;
  }
  try {
    const providers = JSON.parse(raw)?.providers;
    // `muse logout` leaves the file with an empty providers map.
    return !!providers && typeof providers === 'object' && Object.keys(providers).length > 0;
  } catch {
    return true; // A newer file format we can't read; let the CLI decide.
  }
}

export function museVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim().split('\n')[0] || undefined);
    });
  });
}

export async function checkSetup(configuredPath: string, provider: string, env: Env = process.env): Promise<SetupStatus> {
  const bin = resolveMuseBinary(configuredPath, env);
  if (!bin) return { state: 'missing', configured: configuredPath || 'muse' };
  const version = await museVersion(bin);
  // The echo provider makes no model calls, so it works without signing in.
  if (provider === 'echo' || credentialsPresent(env)) return { state: 'ready', bin, version };
  return { state: 'signed-out', bin, version };
}

/** True when a failed run's error output points at missing or rejected credentials. */
export function looksLikeAuthError(stderr: string): boolean {
  return /missing meta credentials|run `?muse login`?|not (logged|signed) in|unauthori[sz]ed|\b401\b|invalid api key|token (has )?expired/i.test(stderr);
}

/** Quotes a path for a POSIX shell command line. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
