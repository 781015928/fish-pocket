import test from 'node:test';
import assert from 'node:assert/strict';
import { withActionCaller } from '../runtime/action-command.mjs';
import { inspirationCommand } from '../runtime/inspiration-cli.mjs';

test('search returns short references and show retrieves only the chosen prompt', async () => {
  const command = inspirationCommand((_name, run) => run);
  const agent = { id: 'local' }, signal = new AbortController().signal;
  const hit = { id: '42', sourceId: 'library', title: 'Poster', category: 'print', prompt: 'Full reference text' };
  const calls = [];
  const owner = { agent, agents: new Map([[agent.id, agent]]), signal, tools: {
    async invoke(connection, name, args, context) {
      assert.equal(connection, 'dsh-image-gen');
      assert.equal(name, 'find_inspiration');
      assert.equal(context.agent, agent);
      calls.push(args);
      return { value: { hits: args.id === 'missing' ? [] : [hit], total: 1 } };
    },
  } };
  const run = (...args) => withActionCaller(owner, () => command(args, { signal }));
  const found = await run('search', 'print', 'poster');
  assert.match(found.stdout, /library\t42\tPoster/);
  assert.ok(!found.stdout.includes(hit.prompt));
  assert.equal((await run('show', 'library', '42')).stdout.trim(), hit.prompt);
  assert.equal((await run('show', 'library', 'missing')).exitCode, 1);
  assert.deepEqual(calls[0], { query: 'print poster', limit: 5 });
  assert.deepEqual(calls[1], { source: 'library', id: '42', limit: 1 });
});
