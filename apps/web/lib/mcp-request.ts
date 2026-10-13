// Bound public MCP input before the SDK parses JSON. Public demos permit any
// syntactically valid HTTP(S) Origin; opaque/malformed origins are rejected.
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;

export class McpRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function checkMcpOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin === null) return; // Native MCP clients have no Origin header.
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
      throw new Error('Invalid origin');
  } catch {
    throw new McpRequestError('Invalid request origin.', 403);
  }
}

export async function boundedMcpRequest(request: Request): Promise<Request> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_MCP_REQUEST_BYTES))
    throw new McpRequestError('MCP request is too large.', 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MCP_REQUEST_BYTES) {
          await reader.cancel();
          throw new McpRequestError('MCP request is too large.', 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new Request(request, { body });
}
