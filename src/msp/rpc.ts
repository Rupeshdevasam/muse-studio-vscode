// JSON-RPC 2.0 over a child process's stdin/stdout, one JSON message per line.
// This is the transport `muse serve` uses. Kept free of the vscode API for testing.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    /** MSP error kind, e.g. `sessionNotFound`, `invalidParams`. */
    readonly kind?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
  stderrTail: string;
}

/** A UUIDv7, which MSP requires for every `commandId`. */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Pending = { resolve(v: any): void; reject(e: Error): void; method: string; timer?: NodeJS.Timeout };

/**
 * Events:
 * - `notification` (method, params)
 * - `request` (method, params, id): a server-to-client request; answer with respond()/respondError()
 * - `log` (text): stderr and non-JSON stdout
 * - `exit` (RpcExit)
 */
export class RpcProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderrTail = '';
  private exited = false;
  private spawnError?: NodeJS.ErrnoException;

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Run through a shell (needed for `.cmd` launchers on Windows). */
    private readonly shell = false,
  ) {
    super();
  }

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  start(): void {
    const child = spawn(this.bin, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: this.shell });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      this.emit('log', chunk);
    });
    child.stdin.on('error', () => {}); // EPIPE after exit is reported via 'exit'
    child.on('error', (err) => {
      this.spawnError = err;
    });
    child.on('close', (code, signal) => {
      this.exited = true;
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      const exit: RpcExit = { code, signal, spawnError: this.spawnError, stderrTail: this.stderrTail };
      const err = this.spawnError ?? new Error(`muse serve exited (${signal ?? `code ${code}`})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.emit('exit', exit);
    });
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (!this.running) return Promise.reject(new Error('muse serve is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Asks the process to exit, then forces it after a grace period. */
  stop(graceMs = 3000): void {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.end();
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      if (!this.exited) child.kill('SIGKILL');
    }, graceMs);
    t.unref();
  }

  private write(msg: unknown): void {
    if (!this.running) return;
    this.child!.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', line + '\n');
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Response to one of our requests.
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error;
        p.reject(new RpcError(`${p.method}: ${e.message ?? 'error'}`, e.code ?? -32000, e.data?.kind, e.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) this.emit('request', msg.method, msg.params ?? {}, msg.id);
      else this.emit('notification', msg.method, msg.params ?? {});
    }
  }
}
