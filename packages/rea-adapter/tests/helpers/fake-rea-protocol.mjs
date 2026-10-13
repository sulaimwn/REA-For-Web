import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
  } else if (request.method === 'tools/call') {
    switch (process.env.FAKE_REA_MODE) {
      case 'oversize-line': process.stdout.write(`${' '.repeat(1024)}\n`); break;
      case 'oversize-fragment': process.stdout.write(' '.repeat(1024)); break;
      case 'null': process.stdout.write('null\n'); break;
      case 'bad-utf8': process.stdout.write(Buffer.from([0xff, 10])); break;
      case 'invalid-result': process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: {} } })}\n`); break;
      // Keep the request pending until the client closes stdin or aborts the process.
      case 'pending': break;
      default: process.exit(4);
    }
  }
}
