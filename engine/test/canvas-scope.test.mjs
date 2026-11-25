import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { apply, CANVAS_STATE_ROUTE } from 'dsh-image-gen';

test('the shipped web canvas routes, image tools and exact inspiration lookup use the selected source', async (t) => {
  const tools = new Map(), routes = new Map(), cleanups = [];
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    attachments: { imageLimits: { maxImageBytes: 1024 * 1024 } },
    inject(names, fn) { if (names.length === 1 && names[0] === 'webServer') fn(this); },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') cleanups.push(stop); },
    on() {}, get() {}, logger: { info() {}, warn() {}, debug() {} },
  };
  apply(ctx, { requestCacheEnabled: false });
  t.after(() => Promise.all(cleanups.map(stop => stop())));
  const route = routes.get(CANVAS_STATE_ROUTE);
  const server = createServer((req, res) => route.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const url = 'http://127.0.0.1:' + server.address().port + CANVAS_STATE_ROUTE;
  async function push(sessionId, nodeCount, connected = true) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientInstance: 'one-editor', sessionId, connected, nodeCount, updatedAt: Date.now() }) });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
  const state = id => tools.get('canvas_state').execute({}, { agent: { session: { id } } });
  await push('first', 2);
  await push('second', 5);
  await push(undefined, 9);
  assert.equal((await state('first')).nodeCount, 2);
  assert.equal((await state('second')).nodeCount, 5);
  assert.equal((await state('legacy')).connected, false);
  await push('first', 0, false);
  assert.equal((await state('first')).connected, false);
  assert.equal((await state('second')).nodeCount, 5);
  const search = args => tools.get('find_inspiration').execute(args);
  const [example] = (await search({ query: 'poster', limit: 1 })).hits;
  const exact = await search({ source: example.sourceId, id: example.id, limit: 1 });
  assert.equal(exact.total, 1);
  assert.equal(exact.hits[0].prompt, example.prompt);
  assert.equal((await search({ source: example.sourceId, id: 'nonexistent-case' })).total, 0);
});
