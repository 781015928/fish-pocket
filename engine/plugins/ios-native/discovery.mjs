import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withActionCaller } from '../../runtime/action-command.mjs';

const MAX_ACTIVE = 4;
const PAGE_SIZE = 5;
const browserDefinitions = new WeakSet();
const browserCalls = new WeakMap();

function terms(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function find(entries, query) {
  const exact = entries.find(entry => entry.definition.name === query);
  if (exact) return [exact];
  const words = terms(query);
  if (!words.length) return [];
  return entries.filter(({ definition, keywords }) => {
    const searchable = (definition.name + ' ' + keywords + ' ' + definition.description).toLowerCase();
    const aliases = terms(keywords).filter(word => /\p{Script=Han}/u.test(word));
    return words.every(word => searchable.includes(word) || aliases.some(alias => word.includes(alias)));
  });
}

/** Register Fish Pocket's device tools using DSH's per-step activation option. */
export function registerDeviceTools(ctx, entries) {
  if (!entries.length) return;
  const tools = ctx.tools;
  const active = new WeakMap();

  for (const { definition } of entries) {
    ctx.effect(() => {
      const off = tools.register(definition, {
        when: step => browserCalls.get(step) === definition || active.get(step.agent)?.has(definition) === true,
      });
      if (definition.name !== 'browser') return off;
      browserDefinitions.add(definition);
      return () => {
        browserDefinitions.delete(definition);
        return off();
      };
    }, 'ios-native ' + definition.name + ' tool');
  }

  tools.register(defineTool({
    name: 'connector_search',
    description: 'Find and enable a Fish Pocket device tool by task or name, such as calendar, photos or browser. Use an exact name when several match.',
    parameters: {
      query: { type: 'string', required: true, description: 'Task keywords or exact device tool name.' },
      offset: { type: 'integer', description: 'Offset for the next page of matches.' },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: ({ query, offset = 0 }, { agent }) => {
      if (!agent) throw new Error('Device discovery needs a conversation.');
      if (typeof query !== 'string' || !query.trim()) throw new Error('Enter a device action or task.');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
      const visible = entries.filter(({ definition }) => tools.get(definition.name, agent) === definition);
      const matches = find(visible, query.trim());
      if (!matches.length) return 'No matching device tool is available in this conversation.';
      if (matches.length === 1) {
        const [{ definition }] = matches;
        const selected = active.get(agent) ?? new Set();
        selected.delete(definition);
        selected.add(definition);
        if (selected.size > MAX_ACTIVE) selected.delete(selected.values().next().value);
        active.set(agent, selected);
        return 'Enabled ' + definition.name + ' for the next step in this conversation.';
      }
      const page = matches.slice(offset, offset + PAGE_SIZE);
      if (!page.length) return 'No more matches.';
      const lines = page.map(({ definition }) => definition.name + ' — ' + definition.description.replace(/\s+/g, ' ').slice(0, 110));
      if (offset + page.length < matches.length) lines.push('More matches: offset ' + (offset + page.length));
      return lines.join('\n');
    },
  }));

  if (entries.some(({ definition }) => definition.name === 'browser')) {
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'bash' || !exec.agent) return next();
      return withActionCaller({ agent: exec.agent, agents: ctx.get('agents'), tools, signal: exec.signal }, next);
    });
  }
}

/** Invoke the existing browser from the CLI through DSH's scoped execution pipeline. */
export async function invokeBrowserTool(tools, agent, args, signal) {
  const browser = tools.get('browser', agent);
  if (!browserDefinitions.has(browser)) throw new Error('The browser is unavailable in this conversation.');
  const modelSelection = agent.model.current();
  if (!modelSelection) throw new Error('Select a model for this conversation first.');
  const step = { agent, modelSelection, signal };
  browserCalls.set(step, browser);
  let toolSet;
  try {
    toolSet = await tools.resolve(step);
    if (toolSet.view(agent).get('browser') !== browser) throw new Error('The browser is unavailable in this conversation.');
    const batch = await tools.execute({ agent, signal, toolSet, calls: [
      { type: 'tool-call', id: randomUUID(), name: 'browser', arguments: JSON.stringify(args) },
    ] });
    return batch.results[0].result;
  } finally {
    toolSet?.dispose();
    browserCalls.delete(step);
  }
}
