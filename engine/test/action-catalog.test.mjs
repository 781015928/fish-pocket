import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { defineTool } from '@deepseek-ai/dsh-tools';
import IosTools from '../plugins/action-catalog/index.mjs';
import { DEVICE_ACTION } from '../plugins/ios-native/tools.mjs';

const sample = (name, description = 'Look up a record') => defineTool({
  name, description, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
  execute: () => 'ok',
});

async function setup(t) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(IosTools, {});
  const agent = {};
  const other = {};
  const scope = createScope(ctx, agent);
  t.after(() => scope.rawDispose());
  const tools = ctx.tools;
  const resolve = (who = agent) => tools.resolve({ agent: who, signal: new AbortController().signal, modelSelection: {} });
  const search = (query, who = agent) => tools.get('connector_search', who).execute({ query }, { agent: who });
  return { ctx, tools, agent, other, scope, resolve, search };
}

test('discovery is scoped and preserves upstream conditions and exact registration identity', async (t) => {
  const { tools, scope, agent, other, resolve, search } = await setup(t);
  let allowed = true;
  const def = sample('sample_list');
  const off = tools.register(def, { discovery: { keywords: 'sample records' }, when: () => allowed });
  const first = await resolve();
  assert.equal(tools.executable(def.name, agent, first), undefined);
  assert.equal(tools.get(def.name, agent), def);
  assert.match(await search('sample_list'), /sample_list/);
  assert.equal(tools.executable(def.name, agent, first), undefined);
  const admitted = await resolve();
  assert.equal(tools.executable(def.name, agent, admitted), def);
  assert.equal(tools.executable(def.name, other, await resolve(other)), undefined);
  allowed = false;
  assert.doesNotMatch(await search('sample_list'), /sample_list/);
  assert.equal(tools.executable(def.name, agent, await resolve()), undefined);
  allowed = true;
  const lift = scope.ctx.get('tools').restrict({ deny: [def.name] });
  assert.doesNotMatch(await search('sample_list'), /sample_list/);
  assert.equal(tools.executable(def.name, agent, admitted), undefined);
  lift();
  off();
  tools.register(sample('sample_list'), { discovery: {} });
  assert.equal(tools.executable(def.name, agent, admitted), undefined);
  assert.equal(tools.executable(def.name, agent, await resolve()), undefined);
});

test('search returns bounded pages and only an exact or unique selection activates a tool', async (t) => {
  const { tools, agent, resolve } = await setup(t);
  for (let i = 0; i < 8; i++) tools.register(sample('lookup_' + i), { discovery: { connection: 'records' } });
  const first = await tools.discover('lookup', agent);
  assert.match(first, /More matches: offset 5/);
  assert.doesNotMatch(first, /lookup_7/);
  assert.match(await tools.discover('lookup', agent, 5), /lookup_7/);
  assert.equal(tools.executable('lookup_7', agent, await resolve()), undefined);
  assert.equal((await tools.listActions('records', { agent })).length, 8);
  assert.equal(await tools.describe('other', 'lookup_7', { agent }), undefined);
  assert.match((await tools.describe('records', 'lookup_7', { agent })).description, /Look up/);
  await tools.discover('lookup_7', agent);
  assert.ok(tools.executable('lookup_7', agent, await resolve()));
});

test('the same definition can have different discoverability in two scopes', async (t) => {
  const { tools, agent, other, scope, resolve } = await setup(t);
  const def = sample('shared');
  scope.ctx.get('tools').register(def);
  tools.register(def, { discovery: { connection: 'global' } });
  assert.equal(tools.executable(def.name, agent, await resolve()), def);
  assert.equal(tools.executable(def.name, other, await resolve(other)), undefined);
  assert.deepEqual(await tools.listActions('global', { agent }), []);
});

test('tools/change sees the committed directory, including after a duplicate registration fails', async (t) => {
  const { ctx, tools, agent } = await setup(t);
  const snapshots = [];
  ctx.on('tools/change', () => { snapshots.push(tools.listActions('records', { agent })); });
  const def = sample('records_list');
  const off = tools.register(def, { discovery: { connection: 'records' } });
  assert.deepEqual((await snapshots.at(-1)).map(item => item.name), ['records_list']);
  assert.throws(() => tools.register(def, { discovery: { connection: 'wrong' } }), /already registered/);
  assert.equal((await tools.listActions('records', { agent })).length, 1);
  off();
  assert.deepEqual(await snapshots.at(-1), []);
});

test('Skill activation honors genuine user gestures, invocation policy and declared dependencies', async (t) => {
  const { ctx, tools, agent, other, resolve } = await setup(t);
  const policy = { userInvocable: true, modelInvocable: false };
  await ctx.plugin(SkillRegistry, {});
  ctx.get('skills').register({ name: 'my-flow', description: 'Use the phone record', content: 'Find records.',
    source: 'runtime', invocation: policy, metadata: { 'fish-pocket': { uses: ['phone_record'] } } });
  const def = sample('phone_record');
  tools.register(def, { discovery: { keywords: '日历 日程' } });
  const available = async who => tools.executable(def.name, who, await resolve(who));
  const gesture = kind => ctx.emit('agent/inbox/claimed', { agent, message: {
    source: { kind }, content: [{ type: 'text', text: '请用 /my-flow 完成' }],
  } });
  gesture('plugin');
  assert.equal(await available(agent), undefined);
  ctx.emit('tools/result', { name: 'skill', agent }, { isError: false, value: { name: 'my-flow' } });
  assert.equal(await available(agent), undefined);
  gesture('user');
  assert.equal(await available(agent), def);
  assert.equal(await available(other), undefined);
  assert.match(await tools.discover('帮我查今天的日程', other), /phone_record/);
});

test('legacy eager history grants no selection; new history restores a matching schema only', async (t) => {
  const { tools, resolve } = await setup(t);
  const def = sample('stored'), search = tools.get('connector_search');
  tools.register(def, { discovery: { connection: 'device' }, [DEVICE_ACTION]: true });
  const agent = entries => ({ session: { requestHeader: () => ({ tools: entries }) } });
  const legacy = agent([def]), resumed = agent([def, search]);
  const changed = agent([{ ...def, description: 'An older operation' }, search]);
  assert.equal(tools.executable(def.name, legacy, await resolve(legacy)), undefined);
  assert.equal(tools.executable(def.name, resumed, await resolve(resumed)), def);
  assert.equal(tools.executable(def.name, changed, await resolve(changed)), undefined);
  const external = sample('same_schema_other_account');
  tools.register(external, { discovery: { connection: 'new-account' } });
  const switched = agent([external, search]);
  assert.equal(tools.executable(external.name, switched, await resolve(switched)), undefined);
});

test('resource-only servers follow scope, connection revocation, host generation and the Bot policy', async (t) => {
  const { tools, agent, other, scope, resolve, search } = await setup(t);
  const off = tools.trackResource('alpha__beta');
  scope.ctx.get('tools').trackResource('only_here');
  tools.trackResource('second');
  const list = sample('list_mcp_resources');
  tools.register(list);
  assert.equal((await tools.listActions('mcp:only_here', { agent }))[0].name, list.name);
  assert.ok(await tools.describe('mcp:only_here', list.name, { agent }));
  assert.equal(await tools.describe('mcp:only_here', list.name, { agent: other }), undefined);
  let allowed = true;
  tools.registerConnectorAccess((who, name) => name !== 'alpha__beta' || (who === agent && allowed));
  assert.doesNotMatch(await search('alpha__beta', other), /alpha__beta/);
  assert.doesNotMatch(await search('only_here', other), /only_here/);
  assert.equal(tools.executable(list.name, agent, await resolve()), undefined);
  await search('resources:alpha__beta');
  const step = await resolve();
  assert.equal(tools.executable(list.name, agent, step), list);
  const check = server => tools.checkGuards({ name: list.name, arguments: { server }, agent, toolSet: step });
  assert.equal(check('alpha__beta'), undefined);
  assert.ok(check('second'));
  allowed = false;
  assert.ok(check('alpha__beta'));
  allowed = true;
  await search('resources:second');
  assert.ok(check('second'));
  assert.equal(check('alpha__beta'), undefined);
  await search('resources:alpha__beta');
  off();
  tools.trackResource('alpha__beta');
  assert.equal(tools.executable(list.name, agent, await resolve()), undefined);
});

test('a provider owns its native definitions and rolls back a partially failed registration', async (t) => {
  const { tools, agent, search, resolve } = await setup(t);
  const spec = name => ({ name, description: 'Inspect a sample', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] } });
  const provider = {
    listActions: async () => [spec('media_inspect')],
    invoke: async (connection, name) => connection + '/' + name,
  };
  const off = await tools.registerProvider('media', provider);
  await search('media_inspect');
  const def = tools.executable('media_inspect', agent, await resolve());
  assert.equal(await def.execute({}, { agent }), 'media/media_inspect');
  await assert.rejects(tools.registerProvider('broken', {
    ...provider, listActions: () => [spec('temp'), spec('media_inspect')],
  }), /already registered/);
  assert.equal(tools.get('temp', agent), undefined);
  off();
  assert.equal(tools.get('media_inspect', agent), undefined);
});

test('MCP instructions and resource names are scoped, paged and invalidated on unmount', async (t) => {
  const { ctx, tools, agent, other, resolve, search } = await setup(t);
  await ctx.plugin(nativeExecutor);
  const unregister = tools.trackResource('example');
  tools.register(sample('mcp__example__read'), { discovery: { server: 'example' } });
  const prompt = ctx.get('systemPrompt');
  prompt.section({ name: 'mcp:example', order: 1, text: 'x'.repeat(1800) + 'end-of-guide' });
  prompt.section({ name: 'mcp-resource-servers', order: 2, text: 'all server names' });
  const assemble = async who => (await prompt.assemble({ agent: who, scope: who, toolSet: await resolve(who) })).sections;
  assert.ok(!(await assemble(agent)).some(section => section.name.startsWith('mcp')));
  await search('mcp__example__read');
  const active = await assemble(agent);
  assert.match(active.find(section => section.name === 'mcp:example').text, /guide:example/);
  assert.doesNotMatch(active.find(section => section.name === 'mcp:example').text, /end-of-guide/);
  assert.match(await tools.discover('guide:example', agent, 1200), /end-of-guide/);
  assert.doesNotMatch(await tools.discover('guide:example', other, 1200), /end-of-guide/);
  await search('resources:example');
  assert.match((await assemble(agent)).find(section => section.name === 'mcp-resource-servers').text, /"example"/);
  unregister();
  assert.doesNotMatch(await tools.discover('guide:example', agent, 1200), /end-of-guide/);
});

test('programmatic resource dispatch binds the connection and runs the original executor', async (t) => {
  const { ctx, tools, agent, scope } = await setup(t);
  Object.assign(agent, { id: 'local', session: { id: 'local' }, ctx: scope.ctx, model: { current: () => ({ provider: 'test', model: 'test' }) } });
  await ctx.plugin(nativeExecutor);
  tools.trackResource('documents');
  const def = defineTool({ name: 'read_mcp_resource', description: 'Read a resource',
    parameters: { server: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: ({ server }) => server });
  tools.register(def);
  const call = args => tools.invoke('mcp:documents', def.name, args, { agent, signal: new AbortController().signal });
  assert.equal((await call({})).value, 'documents');
  await assert.rejects(call({ server: 'another-account' }), /does not match/);
});
