import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal, retrySeconds, originUrl, readJson } from '../src/security.ts';
import { buildFields, validateEvents, validateFields } from '../src/telemetry.ts';

test('tokens are authenticated, randomized ciphertext; wrong keys and tampering fail', async () => {
  const key = randomBytes(32).toString('base64');
  const token = { access_token: 'secret-access', refresh_token: 'secret-refresh' };
  const a = await seal(token, key), b = await seal(token, key);
  assert.notEqual(a, b);
  assert.ok(!a.includes('secret'));
  assert.deepEqual(await unseal(a, key), token);
  await assert.rejects(unseal(a, randomBytes(32).toString('base64')));
  const parts = a.split('.'); const data = Buffer.from(parts[2], 'base64'); data[0] ^= 1; parts[2] = data.toString('base64');
  await assert.rejects(unseal(parts.join('.'), key));
  await assert.rejects(seal(token, 'invalid'));
});

test('rate limit backoff supports seconds, HTTP dates, and Tesla reset headers', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.equal(retrySeconds(new Headers({ 'Retry-After': '180' }), now), 180);
  assert.equal(retrySeconds(new Headers({ 'Retry-After': 'Sat, 12 Sep 2026 12:02:00 GMT' }), now), 120);
  assert.equal(retrySeconds(new Headers({ 'RateLimit-device_data-Reset': String(now / 1000 + 90) }), now), 90);
  assert.equal(retrySeconds(new Headers(), now), 60);
});

test('only HTTPS deployment origins and localhost development origins are accepted', () => {
  assert.equal(originUrl('https://car.example.com').origin, 'https://car.example.com');
  assert.equal(originUrl('http://localhost:8787').port, '8787');
  for (const invalid of ['http://car.example.com', 'https://user:secret@car.example.com', 'https://car.example.com/auth', 'https://car.example.com?x=1', 'garbage']) assert.throws(() => originUrl(invalid));
});

test('stream bodies are bounded even without a Content-Length header', async () => {
  const request = new Request('https://app.example.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(1000) }) });
  await assert.rejects(readJson(request, 100), /too large/);
});

test('complete presets cover 200+ documented passenger signals; location opt-out works', () => {
  const complete = buildFields('complete');
  assert.ok(Object.keys(complete).length > 200);
  assert.ok(Object.keys(buildFields('essentials')).length < 40);
  assert.equal(buildFields('high-detail').VehicleSpeed.interval_seconds, 1);
  assert.ok(!('Location' in buildFields('complete', false)));
  assert.ok(!Object.keys(complete).some(f => f.startsWith('Semitruck') || f.startsWith('Deprecated')));
  assert.deepEqual(validateFields(complete), complete);
  assert.throws(() => validateFields({ VehicleSpeed: { interval_seconds: 0 } }));
  assert.throws(() => validateFields({ UnknownInventedField: { interval_seconds: 10 } }));
  assert.throws(() => validateFields({ Soc: { interval_seconds: 10, minimum_delta: -1 } }));
});

test('event ingestion accepts false, zero, and invalid/null readings; rejects bad envelopes', () => {
  const event = { id: 'test-1', vin: '5YJ3E1EA7KF000001', kind: 'signal', field: 'Soc', value: 0, timestamp: Date.now(), timestampSource: 'receiver' };
  assert.equal(validateEvents({ events: [event] })[0].value, 0);
  assert.equal(validateEvents({ events: [{ ...event, value: false }] })[0].value, false);
  assert.equal(validateEvents({ events: [{ ...event, value: null }] })[0].value, null);
  for (const change of [{ vin: 'bad' }, { timestamp: Date.now() + 3600000 }, { kind: 'command' }, { timestampSource: 'guessed' }]) assert.throws(() => validateEvents({ events: [{ ...event, ...change }] }));
});

 test('self-driving mileage obeys Tesla minimum delta requirement in presets and custom fields', () => {
  for (const preset of ['complete', 'high-detail']) {
    assert.equal(buildFields(preset).SelfDrivingMilesSinceReset.minimum_delta, 1);
    assert.doesNotThrow(() => validateFields(buildFields(preset)));
  }
  for (const minimum_delta of [undefined, 0, 0.5]) {
    assert.throws(() => validateFields({ SelfDrivingMilesSinceReset: { interval_seconds: 300, minimum_delta } }), /minimum_delta of at least 1/);
  }
  assert.doesNotThrow(() => validateFields({ SelfDrivingMilesSinceReset: { interval_seconds: 300, minimum_delta: 2 } }));
});
