import test from 'node:test';
import assert from 'node:assert/strict';
import { networkIdentity } from '../src/admission.js';
import { configFromEnv } from '../src/server.js';

const secret = 'private-network-hmac-test-secret-32-characters';
test('equivalent addresses and IPv6 host changes share a private network quota', () => {
  const identity = networkIdentity('2001:db8:1234:abcd::1', secret);
  assert.equal(identity, networkIdentity('2001:0db8:1234:abcd:0000:0000:0000:0001', secret));
  assert.equal(identity, networkIdentity('2001:db8:1234:abcd:ffff:ffff:ffff:ffff', secret));
  assert.notEqual(identity, networkIdentity('2001:db8:1234:abce::1', secret));
  assert.equal(networkIdentity('192.0.2.123', secret), networkIdentity('::ffff:192.0.2.123', secret));
  assert.equal(networkIdentity('192.0.2.123', secret), networkIdentity('0:0:0:0:0:ffff:c000:027b', secret));
  assert.equal(networkIdentity('2001:db8::192.0.2.123', secret), networkIdentity('2001:db8::c000:27b', secret));
  assert.match(identity, /^[a-f0-9]{64}$/u);
  assert.notEqual(identity, networkIdentity('2001:db8:1234:abcd::1', secret + '-another'));
});

test('missing, forwarded, malformed or scoped addresses cannot become quota identities', () => {
  for (const address of [null, '', 'garbage', '192.0.2.1, 192.0.2.2', '[::1]', '127.0.0.1:1234', 'fe80::1%eth0'])
    assert.throws(() => networkIdentity(address, secret));
  assert.throws(() => networkIdentity('192.0.2.1', 'short'));
});

const env = {
  PIPELINE_STORAGE: 'r2', PIPELINE_PUBLIC_ORIGIN: 'https://uploads.example.com',
  PIPELINE_WORK_ROOT: 'unused', REDIS_URL: 'redis://localhost:6380',
  PIPELINE_ACCESS_KEY: 'a'.repeat(64), R2_ACCOUNT_ID: 'b'.repeat(32),
  R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test-not-a-secret', R2_BUCKET: 'test',
};
test('visitor limiting is opt-in and refuses incomplete proxy/secret configuration', () => {
  assert.equal(configFromEnv(env).visitorSecret, undefined);
  assert.throws(() => configFromEnv({ ...env, PIPELINE_VISITOR_LIMITS: 'true' }));
  assert.throws(() => configFromEnv({ ...env, PIPELINE_VISITOR_LIMITS: '1' }));
  assert.throws(() => configFromEnv({ ...env, PIPELINE_VISITOR_LIMITS: '1', PIPELINE_VISITOR_SECRET: secret }));
  assert.throws(() => configFromEnv({ ...env, PIPELINE_VISITOR_LIMITS: '1', PIPELINE_VISITOR_SECRET: 'short', PIPELINE_TRUST_PROXY: '1' }));
  const config = configFromEnv({ ...env, PIPELINE_VISITOR_LIMITS: '1', PIPELINE_VISITOR_SECRET: secret, PIPELINE_TRUST_PROXY: '1' });
  assert.equal(config.visitorSecret, secret);
});
