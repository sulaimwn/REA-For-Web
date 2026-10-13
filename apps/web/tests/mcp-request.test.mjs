import assert from 'node:assert/strict';
import { it } from 'node:test';
import { boundedMcpRequest, checkMcpOrigin, MAX_MCP_REQUEST_BYTES } from '../lib/mcp-request.ts';

const request = (body, headers = {}) => new Request('https://example.test/api/mcp', { method: 'POST', body, headers });
it('passes an actual MCP JSON body without changing it', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(await (await boundedMcpRequest(request(body))).text(), body);
});
it('rejects oversized input with or without a declared Content-Length', async () => {
  await assert.rejects(boundedMcpRequest(request('{}', { 'Content-Length': String(MAX_MCP_REQUEST_BYTES + 1) })), { status: 413 });
  await assert.rejects(boundedMcpRequest(request('x'.repeat(MAX_MCP_REQUEST_BYTES + 1))), { status: 413 });
});
it('supports public HTTP origins and native clients while rejecting malformed origins', () => {
  checkMcpOrigin(request('{}'));
  checkMcpOrigin(request('{}', { Origin: 'https://client.example' }));
  for (const origin of ['null', 'file:///secret', 'https://client.example/path', 'garbage'])
    assert.throws(() => checkMcpOrigin(request('{}', { Origin: origin })), { status: 403 });
});
