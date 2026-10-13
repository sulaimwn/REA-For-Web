// Stands in for `rea --mcp` in tests: answers MCP tool calls from a committed native fixture
// (FAKE_REA_FIXTURE), and sends the client a ping and log notifications along the way, as a real
// server may. Usage: node fake-rea-mcp.mjs --mcp
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fixture = JSON.parse(readFileSync(process.env.FAKE_REA_FIXTURE, 'utf8'));
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const tools = {
  open_binary: () => ({ status: 'ok' }),
  binary_overview: () => fixture.binary_overview,
  list_procedures: () => fixture.list_procedures,
  list_strings: () => fixture.list_strings,
  procedure_callees: ({ procedure }) => fixture.procedure_callees[procedure],
  xrefs: ({ address }) => fixture.xrefs[address],
  resolve_containing_procedure: ({ address }) => fixture.containing[address],
  close_binary: () => ({ status: 'ok' }),
};

let pinged = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-rea', version: '0' } } });
  else if (m.method === 'tools/call') {
    if (!pinged) {
      pinged = true;
      send({ id: 'ping-1', method: 'ping' });
    }
    send({ method: 'notifications/message', params: { level: 'info', data: m.params.name } });
    const tool = tools[m.params.name];
    if (process.env.FAKE_REA_FAIL === m.params.name) {
      send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'provider_unavailable' }) }] } });
    } else send({ id: m.id, result: tool ? ok(tool(m.params.arguments ?? {})) : { isError: true, content: [{ type: 'text', text: '"unknown tool"' }] } });
  } else if (m.id === 'ping-1' && !('result' in m)) process.exit(3); // the client must answer pings
}
