// Websites (T021): REA's analyze_web_bundle result for this site's own landing page (dev build).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NODE_KINDS, RELATIONS, type StudioNode } from '@rea-studio/schema';
import { adaptReaResult, isWebBundle, ReaOutputError, toStudioProject } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('reaforweb-dev-landing.web-bundle.rea-6.4.0.json', samples), 'utf8')) as Record<string, unknown>;
const { project } = adaptReaResult(raw, { reaVersion: '6.4.0' });
const of = <K extends StudioNode['kind']>(kind: K) => project.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
const byId = new Map(project.nodes.map((n) => [n.id, n]));

describe('website (analyze_web_bundle) adapter', () => {
  it('identifies a website by its page URL', () => {
    assert.equal(isWebBundle(raw), true);
    assert.equal(project.target.appKind, 'web');
    assert.equal(project.target.format, 'url');
    assert.equal(project.target.name, 'localhost:3100');
    assert.match(project.id, /^[a-f0-9]{64}$/);
    assert.equal(project.analysis.coverage.status, 'complete');
  });

  it('draws every captured script under the page, named by its path on the site', () => {
    const files = of('file');
    const root = files.find((f) => f.path === '');
    assert.equal(root?.label, 'http://localhost:3100/');
    const scripts = files.filter((f) => f.path !== '');
    assert.equal(scripts.length, 24);
    assert.ok(scripts.every((s) => s.fileKind === 'javascript'));
    // 21 loaded from /_next/static, 3 inline <script> blocks in the page itself.
    assert.equal(scripts.filter((s) => s.path.startsWith('_next/static/')).length, 21);
    assert.deepEqual(scripts.filter((s) => s.path.startsWith('(inline')).map((s) => s.path), ['(inline script 1)', '(inline script 2)', '(inline script 3)']);
    assert.equal(project.edges.filter((e) => e.relation === 'contains' && e.source === root?.id).length, 24);
  });

  it('turns framework fingerprints into inferred imports with REA confidence', () => {
    const frameworks = of('external-module').map((m) => m.specifier).sort();
    assert.deepEqual(frameworks, ['Next.js', 'React', 'webpack']);
    const next = of('external-module').find((m) => m.specifier === 'Next.js');
    assert.ok(next?.evidence.every((e) => e.state === 'inferred' && e.confidence === 'high'));
    for (const e of project.edges.filter((x) => x.relation === 'imports')) assert.equal(byId.get(e.source)?.kind, 'file');
  });

  it('keeps routes and endpoint candidates on the script they were found in', () => {
    const endpoints = of('endpoint');
    assert.equal(endpoints.filter((e) => e.endpointKind === 'route').length, 4);
    assert.equal(endpoints.filter((e) => e.endpointKind === 'network').length, 57);
    for (const ep of endpoints) {
      const edge = project.edges.find((e) => e.target === ep.id && e.relation === 'calls');
      assert.equal(byId.get(edge?.source ?? '')?.kind, 'file');
      assert.equal(ep.evidence[0]?.location?.kind, 'source-range');
    }
  });

  it('uses only schema kinds and relations, with no dangling edges', () => {
    for (const n of project.nodes) assert.ok((NODE_KINDS as readonly string[]).includes(n.kind), n.kind);
    for (const e of project.edges) {
      assert.ok((RELATIONS as readonly string[]).includes(e.relation));
      assert.ok(byId.has(e.source) && byId.has(e.target), e.id);
    }
    assert.equal(new Set(project.edges.map((e) => e.id)).size, project.edges.length);
    assert.deepEqual(project.findings.map((f) => [f.category, f.count]), [['imports', 3], ['endpoints', 61]]);
  });

  it('rejects a capture with no target URL', () => {
    const broken = structuredClone(raw) as { normalized_result: { capture: { target_url?: string } } };
    delete broken.normalized_result.capture.target_url;
    assert.throws(() => toStudioProject(broken, { reaVersion: '6.4.0' }), ReaOutputError);
  });
});
