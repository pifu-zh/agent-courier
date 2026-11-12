import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../../src/cache.mjs';

test('bounds entries and evicts the oldest', async () => {
  const cache = new BoundedCache({ maxEntries: 3 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.set('c', 3);
  await cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(await cache.get('a'), undefined);
  assert.equal(await cache.get('d'), 4);
});

test('supports namespaces and symbol keys', async () => {
  const cache = new BoundedCache({ maxEntries: 10 });
  const symbol = Symbol('token');
  await cache.set(symbol, 'value', undefined, { namespace: 'ns' });
  assert.equal(await cache.get(symbol, { namespace: 'ns' }), 'value');
  assert.equal(await cache.get(symbol, { namespace: 'other' }), undefined);
});

test('expires entries and sweeps them', async () => {
  let time = 1000;
  const cache = new BoundedCache({ maxEntries: 10, now: () => time });
  await cache.set('k', 'v', 1500);
  assert.equal(await cache.get('k'), 'v');
  time = 2000;
  assert.equal(await cache.get('k'), undefined);
  await cache.set('k2', 'v2', 2500);
  time = 3000;
  cache.sweep();
  assert.equal(cache.size, 0);
});

test('stays bounded after 50k inserts', async () => {
  const cache = new BoundedCache({ maxEntries: 10_000 });
  for (let i = 0; i < 50_000; i += 1) {
    await cache.set(`k-${i}`, i);
  }
  assert.equal(cache.size, 10_000);
  assert.equal(await cache.get('k-0'), undefined);
  assert.equal(await cache.get('k-49999'), 49_999);
});

test('validates maxEntries', () => {
  assert.throws(() => new BoundedCache({ maxEntries: 0 }), /maxEntries/);
});
