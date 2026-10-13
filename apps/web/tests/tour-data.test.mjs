import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { projectFingerprint, publishTourFile } from '../scripts/tour-data.mjs';

it('removes published tours after the graph changes even when the app id stays the same', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-studio-tours-'));
  try {
    const source = join(dir, 'tour.json');
    const destination = join(dir, 'published.json');
    const project = { id: 'same-app', schemaVersion: '0.1.0', nodes: [{ id: 'n1' }], edges: [] };
    writeFileSync(source, JSON.stringify({ projectId: project.id, schemaVersion: project.schemaVersion, projectFingerprint: projectFingerprint(project),
      tours: [{ question: 'Test only', answer: 'Test only', model: 'test', steps: [], citedNodeIds: ['n1'] }] }));
    assert.equal(publishTourFile('test', project, source, destination), 1);
    assert.ok(existsSync(destination));
    const changed = { ...project, edges: [{ id: 'new-link' }] };
    assert.equal(publishTourFile('test', changed, source, destination, () => {}), 0);
    assert.ok(!existsSync(destination));
    assert.equal(publishTourFile('test', project, source, destination), 1);
    rmSync(source);
    assert.equal(publishTourFile('test', project, source, destination), 0);
    assert.ok(!existsSync(destination));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
