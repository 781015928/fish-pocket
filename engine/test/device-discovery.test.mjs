import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { invokeBrowserTool, registerDeviceTools } from '../plugins/ios-native/discovery.mjs';

const fixture = name => defineTool({
  name, description: 'Read a ' + name + ' record.', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
  execute: (_args, { agent }) => agent.id,
});

async function setup(t) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolsService, {});
  await ctx.plugin(nativeExecutor);
  const modelSelection = { provider: 'local', model: 'fixture' };
  const makeAgent = id => {
    const agent = { id, model: { current: () => modelSelection } };
    const scope = createScope(ctx, agent);
    agent.ctx = scope.ctx;
    t.after(() => scope.rawDispose());
    return agent;
  };
  const a = makeAgent('a'), b = makeAgent('b');
  const signal = new AbortController().signal;
  const tools = ctx.get('tools');
  const query = (agent, value) => tools.get('connector_search', agent).execute({ query: value }, { agent, signal });
  const resolve = agent => tools.resolve({ agent, modelSelection, signal });
  return { a, b, ctx, tools, signal, query, resolve };
}

test('only Fish Pocket device tools use on-demand discovery, with per-conversation selection', async (t) => {
  const { a, b, ctx, tools, query, resolve } = await setup(t);
  const calendar = fixture('calendar');
  const upstream = ['bash', 'mcp__fixture__lookup', 'generate_image'].map(fixture);
  for (const def of upstream) tools.register(def);
  registerDeviceTools(ctx, [{ definition: calendar, keywords: '日程 日历' }]);

  const cold = await resolve(a);
  assert.equal(tools.executable('calendar', a, cold), undefined);
  for (const def of upstream) assert.equal(tools.executable(def.name, a, cold), def);
  assert.match(await query(a, '帮我查今天的日程'), /Enabled calendar/);
  assert.match(await query(a, 'generate_image'), /No matching/);
  assert.equal(tools.executable('calendar', a, cold), undefined);
  assert.equal(tools.executable('calendar', a, await resolve(a)), calendar);
  assert.equal(tools.executable('calendar', b, await resolve(b)), undefined);

  a.ctx.get('tools').restrict({ deny: ['calendar'] });
  assert.match(await query(a, 'calendar'), /No matching/);
  assert.equal(tools.executable('calendar', a, await resolve(a)), undefined);
});

test('browser CLI uses the original DSH executor and its scoped permissions', async (t) => {
  const { a, b, ctx, tools, signal, resolve } = await setup(t);
  const browser = fixture('browser');
  registerDeviceTools(ctx, [{ definition: browser, keywords: '网页' }]);
  assert.equal(tools.executable('browser', a, await resolve(a)), undefined);
  const call = agent => invokeBrowserTool(tools, agent, {}, signal);
  const results = await Promise.all([call(a), call(b)]);
  assert.deepEqual(results.map(result => result.value), ['a', 'b']);
  assert.equal(tools.executable('browser', a, await resolve(a)), undefined);

  a.ctx.get('tools').guard(({ name }) => name === 'browser' ? 'Browser blocked in this session' : undefined);
  assert.match((await call(a)).error.message, /Browser blocked/);
  b.ctx.get('tools').restrict({ deny: ['browser'] });
  await assert.rejects(call(b), /unavailable/);
});
