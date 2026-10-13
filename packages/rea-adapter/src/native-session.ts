// Native programs (T021): collects the bundle `adaptNativeBundle` reads, from REA's Ghidra provider
// in one REA MCP session, so one Ghidra import serves every query (each plain CLI command would
// re-run Ghidra, ~35 s each). Node-only. REA only reads the program; it is never run.
import { interestingNativeStrings, nativeProcedureAddresses } from './native.js';
import { openReaSession, type ReaSessionOptions } from './rea-session.js';

export interface NativeSessionOptions extends ReaSessionOptions {
  /** The program to analyze. */
  program: string;
  onProgress?: (message: string) => void;
}

/** Ghidra must be configured for REA: an extracted Ghidra 12.1.x release and a JDK 21. */
export function ghidraConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['GHIDRA_INSTALL_DIR']);
}

export async function collectNativeBundle(options: NativeSessionOptions): Promise<Record<string, unknown>> {
  const { onProgress = () => {} } = options;
  const session = await openReaSession(options);
  try {
    const bundle: Record<string, unknown> = {};
    await session.call('open_binary', { path: options.program });
    onProgress('Ghidra is analyzing the program (this can take a while)');
    bundle['binary_overview'] = await session.call('binary_overview');
    bundle['list_procedures'] = await session.call('list_procedures');
    bundle['list_strings'] = await session.call('list_strings');
    const callees: Record<string, unknown> = {};
    const addresses = nativeProcedureAddresses(bundle['list_procedures']);
    for (const [i, address] of addresses.entries()) {
      callees[address] = await session.call('procedure_callees', { procedure: address });
      if (i % 200 === 199) onProgress(`call graph: ${i + 1}/${addresses.length} functions`);
    }
    bundle['procedure_callees'] = callees;
    const xrefs: Record<string, unknown> = {};
    const containing: Record<string, unknown> = {};
    for (const address of interestingNativeStrings(bundle['list_strings'])) {
      const refs = (await session.call('xrefs', { address })) as { normalized_result?: unknown };
      xrefs[address] = refs;
      for (const ref of Array.isArray(refs?.normalized_result) ? refs.normalized_result : []) {
        if (typeof ref === 'string' && !(ref in containing)) containing[ref] = await session.call('resolve_containing_procedure', { address: ref });
      }
    }
    bundle['xrefs'] = xrefs;
    bundle['containing'] = containing;
    await session.call('close_binary');
    return bundle;
  } finally {
    await session.close();
  }
}
