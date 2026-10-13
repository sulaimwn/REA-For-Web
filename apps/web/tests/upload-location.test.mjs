import assert from 'node:assert/strict';
import { it } from 'node:test';
import { uploadLocation } from '../lib/upload-location.ts';

it('uses the local upload API when it is configured and otherwise links to the HTTPS analysis site', () => {
  assert.equal(uploadLocation({}), undefined);
  assert.equal(uploadLocation({ PIPELINE_STORAGE: 'r2', REA_UPLOAD_ORIGIN: 'https://analysis.example.com' }), '/upload');
  assert.equal(uploadLocation({ PIPELINE_STORAGE: 'local' }), '/upload');
  assert.equal(uploadLocation({ REA_UPLOAD_ORIGIN: 'https://analysis.example.com' }), 'https://analysis.example.com/upload');
});

it('never places URL credentials, query secrets, arbitrary schemes or paths in upload navigation', () => {
  for (const value of ['not a url', 'javascript:alert(1)', 'http://analysis.example.com', 'https://key@analysis.example.com', 'https://analysis.example.com/?key=secret', 'https://analysis.example.com/#secret', 'https://analysis.example.com/other']) {
    assert.equal(uploadLocation({ REA_UPLOAD_ORIGIN: value }), undefined);
  }
});
