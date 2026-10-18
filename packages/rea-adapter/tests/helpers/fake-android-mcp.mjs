import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const bundle = JSON.parse(readFileSync(process.env.FAKE_REA_FIXTURE, 'utf8'));
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  const send = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
  if (m.method === 'initialize') send({});
  else if (m.method === 'tools/call') {
    const {name, arguments:a} = m.params;
    let value = bundle[name];
    if (name === 'inspect_android_class' || name === 'trace_android_references') value = value[a.class_name];
    if (name === 'inspect_android_method') value = value[`${a.class_name}#${a.method_name}#${a.overload_index}`];
    send({isError:!!value?.error,content:[{type:'text',text:JSON.stringify(value)}]});
  }
}
