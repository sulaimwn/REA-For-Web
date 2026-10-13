import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { adaptReaResult } from '@rea-studio/rea-adapter';
import { parseStudioProject } from '../lib/open-project.ts';

const raw = JSON.parse(readFileSync(new URL('../../../fixtures/samples/tiny-electron.rea-6.4.0.json', import.meta.url), 'utf8'));
const { project } = adaptReaResult(raw, { reaVersion: '6.4.0' });

it('opens a real normalized project', () => {
  assert.equal(parseStudioProject(JSON.stringify(project)).target.name, 'tiny-electron');
});

it('rejects JSON with the right version but incomplete metadata', () => {
  assert.throws(() => parseStudioProject(JSON.stringify({ ...project, target: {}, analysis: {} })), /missing or invalid details/);
  assert.throws(() => parseStudioProject(JSON.stringify({ ...project, findings: [null] })), /missing or invalid details/);
});

const dotnetRaw = JSON.parse(readFileSync(new URL('../../../fixtures/samples/tiny-dotnet.rea-6.4.0.json', import.meta.url), 'utf8'));

it('opens a .NET project (T021)', () => {
  const dotnet = adaptReaResult(dotnetRaw, { reaVersion: '6.4.0' }).project;
  const opened = parseStudioProject(JSON.stringify(dotnet));
  assert.equal(opened.target.appKind, 'dotnet');
  assert.equal(opened.target.name, 'TinyNotes');
});

it('explains raw REA, invalid JSON and unsupported versions', () => {
  assert.throws(() => parseStudioProject(JSON.stringify(raw)), /raw REA/);
  assert.throws(() => parseStudioProject(JSON.stringify(dotnetRaw)), /raw REA/);
  assert.throws(() => parseStudioProject('{'), /valid JSON/);
  assert.throws(() => parseStudioProject(JSON.stringify({ ...project, schemaVersion: '9.0.0' })), /Unsupported project version/);
});
