// Native programs (T021): REA with its Ghidra provider, driven over REA's own MCP server so one
// Ghidra analysis serves every query (each plain CLI command would re-run Ghidra, ~35 s each).
// Collects the bundle `adaptNativeBundle` reads. REA only reads the program; it is never run.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { interestingNativeStrings, nativeProcedureAddresses } from '@rea-studio/rea-adapter';

/** Ghidra must be configured for REA: an extracted Ghidra 12.1.x release and a JDK 21. */
export function ghidraConfigured(): boolean {
  return Boolean(process.env['GHIDRA_INSTALL_DIR']);
}

export async function collectNative(reaScript: string, program: string, onProgress: (message: string) => void = () => {}): Promise<Record<string, unknown>> {
  const client = new Client({ name: 'rea-studio', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [reaScript, '--mcp'],
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
    stderr: 'ignore',
  }));
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60 * 1000 });
    const text = (r.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? 'null';
    const value = JSON.parse(text) as unknown;
    if (r.isError) throw new Error(`REA ${name} failed: ${typeof value === 'object' && value && 'message' in value ? String((value as { message: unknown }).message) : text.slice(0, 300)}`);
    return value;
  };
  try {
    const bundle: Record<string, unknown> = {};
    await call('open_binary', { path: program });
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
    await client.close();
  }
}
