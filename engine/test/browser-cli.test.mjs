import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand, parseBrowserCommand } from '../runtime/browser-cli.mjs';
import { withActionCaller } from '../runtime/action-command.mjs';

const catalog = {
  actions: [
    { name: 'read', does: 'Read the page', takes: ['tab'] },
    { name: 'click', does: 'Click an element', takes: ['index', 'tab'], needs: ['index'] },
    { name: 'type', does: 'Fill a field', takes: ['index', 'text', 'tab'], needs: ['index', 'text'] },
    { name: 'screenshot', does: 'Take a picture', takes: ['tab', 'fullPage'], image: true },
  ],
  params: ['index', 'tab', 'text', 'fullPage'].map(name => ({ name, schema: {
    type: name === 'index' ? 'integer' : name === 'fullPage' ? 'boolean' : 'string',
  } })),
};
const command = browserCommand((_name, run) => run, () => catalog);
const signal = new AbortController().signal;

test('browser CLI uses the installed catalog and accepts positional and named arguments', () => {
  assert.deepEqual(parseBrowserCommand(['type', '4', '--text', 'two words', '--tab', 't2'], catalog).args,
    { action: 'type', index: 4, text: 'two words', tab: 't2' });
  assert.equal(parseBrowserCommand(['screenshot', '--fullPage', 'false', '--out', 'shot.jpg'], catalog).args.fullPage, false);
  assert.match(parseBrowserCommand(['help', 'read'], catalog).help, /Read the page/);
  assert.throws(() => parseBrowserCommand(['click', 'n'], catalog), /needs integer/);
  assert.throws(() => parseBrowserCommand(['type', '1'], catalog), /needs text/);
  assert.throws(() => parseBrowserCommand(['read', '--session', 'someone'], catalog), /Unexpected argument/);
});

test('CLI retains the host-selected caller across concurrent commands and honors loss of the owning Agent', async () => {
  const owner = id => {
    const agent = { id }, agents = new Map([[id, agent]]);
    return { agent, agents, signal, tools: { async invoke(connection, name, args, exec) {
      assert.equal(connection, 'device'); assert.equal(name, 'browser'); assert.equal(exec.agent, agent);
      await new Promise(resolve => setImmediate(resolve));
      return { content: [{ type: 'text', text: exec.agent.id + ' ' + args.action }] };
    } } };
  };
  const a = owner('a'), b = owner('b');
  const shell = { signal, env: new Map([['DSH_SESSION_ID', 'unrelated']]) };
  const run = who => withActionCaller(who, () => command(['read'], shell));
  const results = await Promise.all([run(a), run(b)]);
  assert.deepEqual(results.map(r => r.stdout), ['a read\n', 'b read\n']);
  a.agents.delete('a');
  assert.equal((await run(a)).exitCode, 1);
  assert.equal((await command(['read'], shell)).exitCode, 1);
});

test('screenshots use the approved image result and write through the Shell filesystem', async () => {
  const ref = { attachmentId: 'shot' };
  const attachments = { imageHostPath: () => undefined,
    readImage: async reference => { assert.equal(reference, ref); return { data: Buffer.from('pixels') }; } };
  const agent = { id: 'a', ctx: { get: () => attachments } };
  const tools = { invoke: async () => ({ content: [{ type: 'image', attachment: ref }] }) };
  const owner = { agent, tools, signal, agents: new Map([['a', agent]]) };
  let saved;
  const shell = { cwd: '/work', signal, fs: { writeFile: async (p, data) => { saved = [p, data.toString()]; } } };
  const run = () => withActionCaller(owner, () => command(['screenshot', '--out', 'snapshot.jpg'], shell));
  assert.match((await run()).stdout, /\/work\/snapshot.jpg/);
  assert.deepEqual(saved, ['/work/snapshot.jpg', 'pixels']);
  shell.fs.writeFile = async () => { throw new Error('read-only filesystem'); };
  assert.match((await run()).stderr, /read-only/);
  tools.invoke = async () => ({ isError: true, error: { message: 'user refused' } });
  assert.match((await run()).stderr, /user refused/);
});
