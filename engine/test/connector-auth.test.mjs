// Exercise the packaged connector's actual legacy state and OAuth dispatch, with an in-memory
// vault. npm test applies the pinned host patches before loading the installed packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = new URL('./src/host/connectors/', pathToFileURL(createRequire(import.meta.url).resolve('ds-bot/package.json')));
const { install } = await import(new URL('index.js', root));
const { discover } = await import(new URL('oauth.js', root));

test('a new OAuth address cannot adopt or erase older credentials with the same display name', async () => {
  const secrets = new Map([['CONNECTOR_RECORDS_TOKEN', 'old-header']]);
  const state = {};
  let allowed;
  const rt = { state, config: {}, teamTools: [], ctx: {
    tools: { registerConnectorAccess: policy => { allowed = policy; } },
    effect() {}, // No background bootstrap. The endpoint below drives connection state.
  }, loadSecrets: async () => {}, save: async () => {}, selfOf: id => id,
  secretValue: key => secrets.get(key), secretEndpoint: async (method, { name }) => {
    if (method === 'secret-delete') secrets.delete(name);
  } };
  install(rt);
  const add = await rt.connectorEndpoint('connector-add', { name: 'Records', url: 'https://example.invalid/mcp', auth: { kind: 'oauth' } });
  const id = add.addedId;
  const stored = state.connectors[id];
  assert.equal(add.connectors.find(row => row.id === id).state, 'off');
  assert.equal(rt.connectorsInternals.upstreamOf(id), undefined);
  assert.ok(stored.custom.auth.vaultId);
  stored.offFor = ['restricted'];
  assert.equal(allowed({ session: { id: 'restricted' } }, id), false);
  await rt.connectorEndpoint('connector-disconnect', { id });
  assert.notEqual(state.connectors[id].custom.auth.vaultId, stored.custom.auth.vaultId);
  assert.deepEqual(state.connectors[id].offFor, ['restricted']);
  await rt.connectorEndpoint('connector-remove', { id });
  assert.equal(state.connectors[id], undefined);
  assert.equal(secrets.get('CONNECTOR_RECORDS_TOKEN'), 'old-header');

  state.connectors.legacy = { custom: { name: 'Old connection', url: 'https://old.example/mcp',
    headers: { Authorization: 'Bearer $DSH_SECRET_CONNECTOR_RECORDS_TOKEN' } }, readOnly: true };
  assert.equal(rt.connectorsInternals.upstreamOf('legacy').headers.Authorization, 'Bearer old-header');
});

test('a custom OAuth server must advertise the resource the user chose', async () => {
  const source = 'https://example.invalid/mcp';
  const fake = async url => String(url) === source
    ? new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.invalid/resource"' } })
    : Response.json({ resource: 'https://other.invalid/mcp', authorization_servers: ['https://issuer.invalid'] });
  await assert.rejects(discover(source, { fetch: fake, strictIssuer: true }), /resource|match/i);
});
