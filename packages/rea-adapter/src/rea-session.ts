// A session with REA's own MCP server (`rea --mcp`, stdio), so a provider started for one target
// (Ghidra, JADX) answers many queries. Node-only. REA only reads the target; it is never run.
//
// The MCP stdio transport is newline-delimited JSON-RPC 2.0; the few messages needed here are
// spoken directly so the adapter (and the worker image that ships it) needs no MCP dependency.
import { spawn } from 'node:child_process';

export interface ReaSessionOptions {
  /** Path to rea-agents' `scripts/rea.mjs`. */
  reaScript: string;
  /** Extra Node arguments for REA's process (e.g. a heap limit). */
  nodeArgs?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Largest single MCP message accepted from REA. */
  maxMessageBytes?: number;
}

export interface ReaSession {
  /** Calls one REA tool and returns its parsed JSON result; throws with REA's message if the tool failed. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

/** A parsed upstream MCP tool failure, kept intact for narrowly scoped partial-result handling. */
export class ReaToolError extends Error {
  constructor(readonly tool: string, readonly result: unknown) {
    const value = result as { message?: unknown; error?: { message?: unknown } } | null;
    const message = value?.error?.message ?? value?.message ?? 'Tool returned an error';
    super(`REA ${tool} failed: ${String(message).slice(0, 300)}`);
    this.name = 'ReaToolError';
  }
}

export async function openReaSession(options: ReaSessionOptions): Promise<ReaSession> {
  const maxMessageBytes = options.maxMessageBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new Error('maxMessageBytes must be a positive safe integer.');
  }
  options.signal?.throwIfAborted();
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), options.reaScript, '--mcp'], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: options.env ?? process.env,
    ...(options.signal ? { signal: options.signal, killSignal: 'SIGKILL' as const } : {}),
  });
  const pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  let failure: Error | undefined;
  let closed = false;
  let finish: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const fail = (error: Error) => {
    failure ??= error;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
    if (!closed) child.kill('SIGKILL');
  };
  child.once('error', (error) => { fail(error); finish(); });
  child.once('close', (code) => {
    closed = true;
    fail(new Error(`REA's MCP server exited (${code ?? 'signal'}).`));
    finish();
  });
  child.stdin.on('error', fail);
  const send = (message: object) => {
    if (!failure) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const receive = (line: string) => {
    let message: RpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !('jsonrpc' in parsed) || parsed.jsonrpc !== '2.0') {
        return fail(new Error('REA wrote an invalid JSON-RPC message.'));
      }
      message = parsed as RpcMessage;
    } catch {
      return fail(new Error('REA wrote a non-JSON line to its MCP channel.'));
    }
    if (message.method !== undefined) {
      if (typeof message.method !== 'string') return fail(new Error('REA wrote an invalid JSON-RPC method.'));
      // A request from the server: answer pings; refuse anything else. Notifications need no reply.
      if (message.id !== undefined) {
        send(message.method === 'ping' ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (message.error) waiter.reject(new Error(`REA MCP error ${message.error.code}: ${message.error.message}`));
    else if ('result' in message) waiter.resolve(message);
    else waiter.reject(new Error('REA wrote a JSON-RPC response without a result or error.'));
  };
  let chunks: Buffer[] = [];
  let buffered = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure) return;
    for (;;) {
      const newline = chunk.indexOf(10);
      if (newline === -1) break;
      if (buffered + newline > maxMessageBytes) return fail(new Error('A REA MCP message exceeded its size limit.'));
      let line: string;
      try { line = decoder.decode(Buffer.concat([...chunks, chunk.subarray(0, newline)], buffered + newline)); }
      catch { return fail(new Error('REA wrote invalid UTF-8 to its MCP channel.')); }
      chunks = [];
      buffered = 0;
      chunk = chunk.subarray(newline + 1);
      if (line.trim()) receive(line);
      if (failure) return;
    }
    if (buffered + chunk.length > maxMessageBytes) return fail(new Error('A REA MCP message exceeded its size limit.'));
    if (chunk.length) chunks.push(chunk);
    buffered += chunk.length;
  });

  let nextId = 1;
  const request = (method: string, params: object) => new Promise<RpcMessage>((resolve, reject) => {
    if (failure) return reject(failure);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    failure ??= new Error('REA session is closed.');
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
    child.stdin.end();
    // REA shuts its providers down when its stdin closes; don't wait on a stuck JVM forever.
    if (!closed) {
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 10_000);
      await finished;
      clearTimeout(timer);
    }
  })();

  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rea-for-web', version: '0.1.0' } });
  } catch (error) {
    await close();
    throw error;
  }
  send({ method: 'notifications/initialized' });
  return {
    async call(name, args = {}) {
      const { result } = await request('tools/call', { name, arguments: args });
      if (!result || !Array.isArray(result.content) || result.content.some((c) => !c || typeof c.type !== 'string')) {
        throw new Error(`REA ${name} returned an invalid MCP tool result.`);
      }
      const text = result?.content?.find((c) => c.type === 'text')?.text ?? 'null';
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(`REA ${name} returned non-JSON text: ${text.slice(0, 300)}`);
      }
      if (result?.isError) {
        throw new ReaToolError(name, value);
      }
      return value;
    },
    close,
  };
}
