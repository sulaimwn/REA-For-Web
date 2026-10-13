import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { toStudioProject } from '@rea-studio/rea-adapter';
import { projectForUpload } from '../lib/upload-project.ts';

it('uses each job filename for missing package metadata without changing the cached project', () => {
  const cached = { target: { name: 'target.asar' }, nodes: [] };
  assert.equal(projectForUpload(cached, 'my-app.asar').target.name, 'my-app.asar');
  assert.equal(projectForUpload(cached, 'another-name.asar').target.name, 'another-name.asar');
  assert.equal(cached.target.name, 'target.asar');
  assert.equal(projectForUpload(cached), cached);
});

it('preserves the package name from real REA facts when available', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../fixtures/samples/tiny-electron.rea-6.4.0.json', import.meta.url), 'utf8'));
  const project = toStudioProject(raw, { reaVersion: '6.4.0' });
  assert.equal(projectForUpload(project, 'renamed.asar'), project);
  assert.equal(projectForUpload(project, 'renamed.asar').target.name, 'tiny-electron');
});
