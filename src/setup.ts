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

/** Meta's Muse Code page, for platforms where we can't run the installer for the user. */
export const INSTALL_PAGE = 'https://dev.meta.ai/ai/lp/muse-code/';

/** On Windows, `.cmd` and `.bat` launchers have to run through a shell. */
export function needsShell(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

function isRunnable(p: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Windows has no execute bit; a file with a runnable extension is enough.
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate file names for a command: on Windows, with each PATHEXT extension. */
function candidates(name: string, env: Env, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || path.extname(name)) return [name];
  const exts = (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [...exts.map((e) => name + e.toLowerCase()), ...exts.map((e) => name + e.toUpperCase()), name];
}

function homeDir(env: Env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Places the installer and package managers put muse, for when VS Code's PATH doesn't include them. */
export function fallbackLocations(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = homeDir(env);
  const dirs =
    platform === 'win32'
      ? [env.MUSE_INSTALL_DIR, path.join(home, '.local', 'bin'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'muse'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'muse', 'bin')]
      : [env.MUSE_INSTALL_DIR, path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.filter((d): d is string => !!d).flatMap((d) => candidates(path.join(d, 'muse'), env, platform));
}

/** Finds the muse binary: the configured path, then PATH, then the usual install folders. */
export function resolveMuseBinary(configured: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const name = configured.trim() || 'muse';
  if (name.startsWith('~')) return resolveMuseBinary(path.join(homeDir(env), name.slice(1)), env, platform);
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    // An explicit path is used as-is; if it's wrong, report missing rather than guessing.
    return candidates(name, env, platform).find((c) => isRunnable(c, platform));
  }
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const hit = candidates(path.join(dir, name), env, platform).find((c) => isRunnable(c, platform));
    if (hit) return hit;
  }
  if (name !== 'muse') return undefined;
  return fallbackLocations(env, platform).find((c) => isRunnable(c, platform));
}

/**
 * Same rule the CLI uses: META_API_KEY wins, then a saved login with at least one provider.
 * Returns undefined when we can't tell (e.g. Windows, where the credential location isn't
 * documented); callers then let the CLI decide and react to its sign-in errors.
 */
export function credentialsPresent(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean | undefined {
  if (env.META_API_KEY?.trim()) return true;
  const files = [path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config'), 'muse', 'auth.json')];
  if (platform === 'win32' && env.APPDATA) files.push(path.join(env.APPDATA, 'muse', 'auth.json'));
  for (const f of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    try {
      const providers = JSON.parse(raw)?.providers;
      // `muse logout` leaves the file with an empty providers map.
      return !!providers && typeof providers === 'object' && Object.keys(providers).length > 0;
    } catch {
      return true; // A newer file format we can't read; let the CLI decide.
    }
  }
  return platform === 'win32' ? undefined : false;
}

export function museVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000, shell: needsShell(bin) }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim().split(/\r?\n/)[0] || undefined);
    });
  });
}

export async function checkSetup(
  configuredPath: string,
  provider: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SetupStatus> {
  const bin = resolveMuseBinary(configuredPath, env, platform);
  if (!bin) return { state: 'missing', configured: configuredPath || 'muse' };
  const version = await museVersion(bin);
  // The echo provider makes no model calls, so it works without signing in.
  if (provider === 'echo' || credentialsPresent(env, platform) !== false) return { state: 'ready', bin, version };
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
