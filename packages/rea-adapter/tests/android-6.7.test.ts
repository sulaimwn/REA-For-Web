import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { adaptReaResult } from '../src/index.js';
import { collectAndroidBundle } from '../src/android-session.js';
import { isKnownAndroidBodyGap } from '../src/android-method-gap.js';
import { openReaSession, ReaToolError } from '../src/rea-session.js';

const fixture = fileURLToPath(new URL('../../../../fixtures/samples/tiny-android.rea-6.7.0.json', import.meta.url));
const raw = JSON.parse(readFileSync(fixture, 'utf8'));
const className = 'com.reaforweb.tinynotes.SyncService';
const key = `${className}#<init>#0`;
const failed = raw.inspect_android_method[key];
const sha = raw.inspect_android_package.subject.digest.sha256 as string;
const method = raw.inspect_android_class[className].normalized_result.methods[0];
const reaScript = fileURLToPath(new URL('../../tests/helpers/fake-android-mcp.mjs', import.meta.url));

describe('REA 6.7 Android body representations and partial observations', () => {
  it('preserves real metadata and answer-key facts with a connected visible body gap', () => {
    const { project:p } = adaptReaResult(raw, {reaVersion:'6.7.0'});
    assert.equal(p.analysis.coverage.status, 'partial');
    assert.equal(p.nodes.filter(n=>n.kind==='android-component').length, 4);
    assert.equal(p.nodes.filter(n=>n.kind==='android-permission').length, 2);
    assert.ok(p.nodes.some(n=>n.kind==='bridge-api' && n.apiKey==='notesBridge'));
    assert.ok(p.nodes.some(n=>n.kind==='storage' && n.name==='notes.db'));
    assert.ok(p.edges.some(e=>e.relation==='references'));
    const gap = p.nodes.find(n=>n.kind==='analysis-gap');
    assert.ok(gap && gap.kind==='analysis-gap');
    assert.equal(gap.failure?.code, 'execution_failure');
    assert.equal(gap.operation, 'inspect_android_method');
    assert.ok(!JSON.stringify(gap).includes('<TARGET_APK>'));
    const link = p.edges.find(e=>e.target===gap.id);
    const owner = p.nodes.find(n=>n.id===link?.source);
    assert.ok(owner?.kind==='managed-method' && owner.declaringType===className && owner.name==='<init>');
    assert.ok(p.analysis.limitations.some(l=>l.includes('smali bytecode')));
    assert.equal(p.analysis.statistics.parseFailures, 1);
  });

  it('never applies Java heuristics or empty-initializer suppression to bytecode or incomplete Java', () => {
    for (const representation of ['smali','java',undefined]) {
      const changed = structuredClone(raw);
      const result = changed.inspect_android_method['com.reaforweb.tinynotes.MainActivity#onCreate#0'].normalized_result;
      result.representation = representation;
      if (representation==='java') result.source.status='truncated';
      const p = adaptReaResult(changed, {reaVersion:'6.7.0'}).project;
      assert.equal(p.analysis.coverage.status, 'partial');
      assert.ok(!p.nodes.some(n=>n.kind==='bridge-api'));
      assert.ok(p.nodes.some(n=>n.kind==='managed-method' && n.name==='onCreate'));
    }
    const changed = structuredClone(raw);
    const init = changed.inspect_android_method['com.reaforweb.tinynotes.BootReceiver#<init>#0'].normalized_result;
    init.source.text='public BootReceiver() {}'; // Java-looking text is insufficient without the Java/complete contract.
    const p = adaptReaResult(changed, {reaVersion:'6.7.0'}).project;
    assert.ok(p.nodes.some(n=>n.kind==='managed-method' && n.declaringType.endsWith('BootReceiver') && n.name==='<init>'));
  });

  it('makes bytecode and incomplete Java coverage partial even when every requested body is available', () => {
    const base=structuredClone(raw);
    const name='com.reaforweb.tinynotes.MainActivity';
    const bodyKey=`${name}#onCreate#0`;
    const env=base.inspect_android_class[name];
    env.normalized_result.methods=env.normalized_result.methods.filter((m:{name:string})=>m.name==='onCreate');
    base.inspect_android_class={[name]:env};
    base.inspect_android_method={[bodyKey]:base.inspect_android_method[bodyKey]};
    base.search_android_classes.normalized_result.matches=[name];
    base.trace_android_references={};
    assert.equal(adaptReaResult(base,{reaVersion:'6.7.0'}).project.analysis.coverage.status,'complete');
    for(const kind of ['smali','truncated']) {
      const changed=structuredClone(base);
      const body=changed.inspect_android_method[bodyKey].normalized_result;
      if(kind==='smali') body.representation='smali';
      else body.source.status='truncated';
      const p=adaptReaResult(changed,{reaVersion:'6.7.0'}).project;
      assert.equal(p.analysis.coverage.status,'partial');
      assert.ok(p.analysis.limitations.some(l=>l.includes(kind==='smali'?'smali bytecode':'incomplete Java')));
    }
  });

  it('accepts only the captured error with matching method, descriptor, request and APK identity', () => {
    assert.equal(isKnownAndroidBodyGap(failed,sha,className,method), true);
    const mutations = [
      (e:any)=>{e.normalized_result={body_status:'available',representation:'java',source:{status:'complete',text:'public SyncService() {}'}};},
      (e:any)=>{e.error.code='resource_constraint';},
      (e:any)=>{e.error.code='cleanup_incomplete';},
      (e:any)=>{e.error.category='timeout';},
      (e:any)=>{e.error.retryable=true;},
      (e:any)=>{e.error.details.provider_id='ghidra';},
      (e:any)=>{e.error.details.operation='inspect_android_class';},
      (e:any)=>{e.error.details.diagnostics.upstream_operation='shutdown';},
      (e:any)=>{e.error.details.diagnostics.reason+=' (timeout)';},
      (e:any)=>{delete e.error.details.diagnostics.target_sha256;},
      (e:any)=>{e.error.details.diagnostics.target_sha256='a'.repeat(64);},
      (e:any)=>{e.error.details.partial_observation.target.sha256='a'.repeat(64);},
      (e:any)=>{e.error.details.partial_observation.operation='shutdown';},
      (e:any)=>{e.error.details.partial_observation.calls[2].input.class_name='another.Class';},
      (e:any)=>{e.error.details.partial_observation.calls[2].input.method_name='onCreate';},
      (e:any)=>{e.error.details.partial_observation.calls[2].input.overload_index=1;},
      (e:any)=>{e.error.details.partial_observation.calls[2].response.isError=false;},
    ];
    for (const mutate of mutations) {
      const e = structuredClone(failed); mutate(e);
      assert.equal(isKnownAndroidBodyGap(e,sha,className,method), false);
    }
    for(const patch of [{name:'push'},{dex_descriptor:'(I)V'},{is_constructor:false},{overload_index:1}]) {
      assert.equal(isKnownAndroidBodyGap(failed,sha,className,{...method,...patch}), false);
    }
  });

  it('retains the original structured tool failure and collects the remaining methods', {timeout:10000}, async () => {
    const env={...process.env,FAKE_REA_FIXTURE:fixture};
    const session=await openReaSession({reaScript,env});
    try {
      await assert.rejects(session.call('inspect_android_method',{class_name:className,method_name:'<init>',overload_index:0}), error=> {
        assert.ok(error instanceof ReaToolError);
        assert.deepEqual(error.result,failed);
        assert.match(error.message,/Analysis could not complete/);
        return true;
      });
    } finally {await session.close();}
    const collected = await collectAndroidBundle({reaScript,env,apk:'sample.apk'});
    assert.deepEqual(collected.inspect_android_method,raw.inspect_android_method);
    assert.deepEqual(collected.trace_android_references,raw.trace_android_references);
    assert.equal(adaptReaResult(collected,{reaVersion:'6.7.0'}).project.analysis.coverage.status,'partial');
  });

  it('refuses similar errors in the collector and adapter rather than turning them into partial success', {timeout:10000}, async () => {
    const dir=await mkdtemp(join(tmpdir(),'rea-android-identity-'));
    try {
      for (const mutation of ['sha','reason','descriptor','contradictory-body']) {
        const changed = structuredClone(raw);
        if(mutation==='sha') delete changed.inspect_android_method[key].error.details.diagnostics.target_sha256;
        if(mutation==='reason') changed.inspect_android_method[key].error.details.diagnostics.reason='Provider timed out';
        if(mutation==='descriptor') changed.inspect_android_class[className].normalized_result.methods[0].dex_descriptor='(I)V';
        if(mutation==='contradictory-body') changed.inspect_android_method[key].normalized_result={body_status:'available',representation:'java',source:{status:'complete',text:'getSharedPreferences("INJECTED",0);'}};
        const path=join(dir,`${mutation}.json`);
        await writeFile(path,JSON.stringify(changed));
        await assert.rejects(collectAndroidBundle({reaScript,env:{...process.env,FAKE_REA_FIXTURE:path},apk:'sample.apk'}),ReaToolError);
        assert.throws(()=>adaptReaResult(changed,{reaVersion:'6.7.0'}),/outside the supported partial-result boundary/);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
