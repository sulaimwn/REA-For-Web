// Native programs (T021): collects the bundle `adaptNativeBundle` reads, from REA's Ghidra
// provider driven over REA's own MCP server (`rea --mcp`, stdio), so one Ghidra import serves
// every query (each plain CLI command would re-run Ghidra, ~35 s each). Node-only.
// REA only reads the program; it is never run.
//
// The MCP stdio transport is newline-delimited JSON-RPC 2.0; the few messages needed here are
// spoken directly so the adapter (and the worker image that ships it) needs no MCP dependency.
import { spawn } from 'node:child_process';
import { interestingNativeStrings, nativeProcedureAddresses } from './native.js';

export interface NativeSessionOptions {
  /** Path to rea-agents' `scripts/rea.mjs`. */
  reaScript: string;
  /** The program to analyze. */
  program: string;
  onProgress?: (message: string) => void;
  /** Extra Node arguments for REA's process (e.g. a heap limit). */
  nodeArgs?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Largest single MCP message accepted from REA. */
  maxMessageBytes?: number;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

/** Ghidra must be configured for REA: an extracted Ghidra 12.1.x release and a JDK 21. */
export function ghidraConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['GHIDRA_INSTALL_DIR']);
}

export async function collectNativeBundle(options: NativeSessionOptions): Promise<Record<string, unknown>> {
  const { onProgress = () => {}, maxMessageBytes = 256 * 1024 * 1024 } = options;
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), options.reaScript, '--mcp'], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: options.env ?? process.env,
    ...(options.signal ? { signal: options.signal, killSignal: 'SIGKILL' as const } : {}),
  });
  const pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
    child.kill('SIGKILL');
  };
  child.once('error', fail);
  child.once('close', (code) => fail(new Error(`REA's MCP server exited (${code ?? 'signal'}).`)));
  child.stdin.on('error', () => {}); // EPIPE after REA exits; reported through 'close'
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  let chunks: Buffer[] = [];
  let buffered = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    for (;;) {
      const newline = chunk.indexOf(10);
      if (newline === -1) break;
      const line = Buffer.concat([...chunks, chunk.subarray(0, newline)]).toString('utf8');
      chunks = [];
      buffered = 0;
      chunk = chunk.subarray(newline + 1);
      if (line.trim()) receive(line);
    }
    chunks.push(chunk);
    buffered += chunk.length;
    if (buffered > maxMessageBytes) fail(new Error('A REA MCP message exceeded its size limit.'));
  });
  const receive = (line: string) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return fail(new Error('REA wrote a non-JSON line to its MCP channel.'));
    }
    if (message.method !== undefined) {
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
    else waiter.resolve(message);
  };

  let nextId = 1;
  const request = (method: string, params: object) => new Promise<RpcMessage>((resolve, reject) => {
    if (failure) return reject(failure);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const { result } = await request('tools/call', { name, arguments: args });
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? 'null';
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`REA ${name} returned non-JSON text: ${text.slice(0, 300)}`);
    }
    if (result?.isError) {
      const message = value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message) : text.slice(0, 300);
      throw new Error(`REA ${name} failed: ${message}`);
    }
    return value;
  };

  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rea-for-web', version: '0.1.0' } });
    send({ method: 'notifications/initialized' });
    const bundle: Record<string, unknown> = {};
    await call('open_binary', { path: options.program });
    onProgress('Ghidra is analyzing the program (this can take a while)');
    bundle['binary_overview'] = await call('binary_overview');
    bundle['list_procedures'] = await call('list_procedures');
    bundle['list_strings'] = await call('list_strings');
    const callees: Record<string, unknown> = {};
    const addresses = nativeProcedureAddresses(bundle['list_procedures']);
    for (const [i, address] of addresses.entries()) {
      callees[address] = await call('procedure_callees', { procedure: address });
      if (i % 200 === 199) onProgress(`call graph: ${i + 1}/${addresses.length} functions`);
    }
    bundle['procedure_callees'] = callees;
    const xrefs: Record<string, unknown> = {};
    const containing: Record<string, unknown> = {};
    for (const address of interestingNativeStrings(bundle['list_strings'])) {
      const refs = (await call('xrefs', { address })) as { normalized_result?: unknown };
      xrefs[address] = refs;
      for (const ref of Array.isArray(refs?.normalized_result) ? refs.normalized_result : []) {
        if (typeof ref === 'string' && !(ref in containing)) containing[ref] = await call('resolve_containing_procedure', { address: ref });
      }
    }
    bundle['xrefs'] = xrefs;
    bundle['containing'] = containing;
    await call('close_binary');
    return bundle;
  } finally {
    child.removeAllListeners('close');
    child.stdin.end();
    // REA shuts Ghidra down when its stdin closes; don't wait on a stuck JVM forever.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
  }
}
