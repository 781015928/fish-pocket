// Keep DSH's scoped definitions, guards and executors. Only admission to a model step changes.
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill';
import { scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { withActionCaller } from '../../runtime/action-command.mjs';
import { IMAGE_TOOLS, CANVAS_TOOLS } from '../ios-host/image-gen-notes.mjs';
import { DEVICE_ACTION } from '../ios-native/tools.mjs';

const RESOURCES = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const MAX_MATCHES = 5;
const MAX_ACTIVE = 4;
const GUIDE_CHARS = 1200;
const registration = Symbol('catalog registration');

function guidePage(text, server, offset = 0) {
  const chars = Array.from(text);
  const end = offset + GUIDE_CHARS;
  const page = chars.slice(offset, end).join('');
  return end < chars.length ? page + '\nMore service instructions: connector_search query=' + JSON.stringify('guide:' + server) + ', offset=' + end : page;
}

function searchTerms(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function matches(query, candidates) {
  const exact = candidates.find(item => item.name === query);
  if (exact) return [exact];
  const terms = searchTerms(query);
  if (!terms.length) return [];
  return candidates.map(item => {
    const key = (item.name + ' ' + item.keywords).toLowerCase();
    const text = item.description.toLowerCase();
    const aliases = searchTerms(item.keywords).filter(word => /\p{Script=Han}/u.test(word));
    const scores = terms.map(term => key.includes(term) || aliases.some(alias => term.includes(alias)) ? 2 : text.includes(term) ? 1 : 0);
    return { item, score: scores.includes(0) ? 0 : scores.reduce((sum, score) => sum + score, 0) };
  }).filter(hit => hit.score).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).map(hit => hit.item);
}

function searchTool(tools) {
  return defineTool({
    name: 'connector_search',
    description: 'Find a device action or a connected service by task, service or tool name. A unique match enables its original tool for this conversation. Choose an exact name from ambiguous matches.',
    parameters: {
      query: { type: 'string', required: true, description: 'Task keywords or the exact action name.' },
      offset: { type: 'integer', description: 'Next candidate offset, when the result has more matches.' },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: ({ query, offset }, { agent, signal }) => tools.discover(query, agent, offset, signal),
  });
}

export default class IosTools extends ToolsService {
  entries = new WeakMap();
  sessions = new WeakMap();
  resourceScopes = new Map();
  connectorPolicies = new Set();
  directCalls = new WeakMap();
  stepResources = new WeakMap();

  constructor(ctx, config) {
    super(ctx, config);
    this.register(searchTool(this));
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'bash' || !exec.agent) return next();
      return withActionCaller({ agent: exec.agent, agents: ctx.get('agents'), tools: this, signal: exec.signal }, next);
    });
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent && exec.name === 'skill' && !result.isError && typeof result.value?.name === 'string') {
        this.state(exec.agent).pending.set(result.value.name, 'model');
      }
    });
    // The slash Skill body is normally injected in agent/pre-step, AFTER tools.resolve.
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message.source.kind !== 'user') return;
      for (const block of message.content) {
        if (block.type !== 'text') continue;
        for (const match of block.text.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)) {
          this.state(agent).pending.set(match[1], 'user');
        }
      }
    });
    ctx.on('system-prompt/assemble', async (_assembly, subject, next) => {
      const assembly = await next();
      if (!subject.agent || !subject.toolSet) return assembly;
      const servers = new Set();
      for (const def of subject.toolSet.view(subject.agent).values()) {
        const entry = this.entryFor(def, subject.agent);
        if (entry?.server) servers.add(entry.server);
      }
      const selected = this.resourceFor(subject.agent, subject.toolSet);
      if (selected) servers.add(selected);
      const guides = this.state(subject.agent).guides;
      guides.clear();
      assembly.sections = assembly.sections.flatMap(section => {
        if (section.name.startsWith('mcp:')) {
          const server = section.name.slice(4);
          if (!servers.has(server)) return [];
          const resource = this.servers(subject.agent).get(server);
          if (resource && section.text.length > GUIDE_CHARS) {
            guides.set(server, { resource, text: section.text });
            return [{ ...section, text: guidePage(section.text, server) }];
          }
          return [section];
        }
        if (section.name !== 'mcp-resource-servers') return [section];
        return selected ? [{ ...section, text: 'MCP resource server for this task: ' + JSON.stringify(selected) }] : [];
      });
      return assembly;
    });
    this.guard(exec => {
      if (RESOURCES.has(exec.name) && (!exec.arguments?.server || !exec.agent || !exec.toolSet
        || this.resourceFor(exec.agent, exec.toolSet) !== exec.arguments.server)) {
        return 'Discover resources:<server> for this conversation before calling its resource tools.';
      }
      const entry = exec.agent && this.entryFor(this.get(exec.name, exec.agent), exec.agent);
      if (entry?.server && !this.serverAllowed(exec.agent, entry.server)) return 'This connector is no longer available to this agent.';
      if (exec.name === 'edit_image' && exec.arguments?.source === 'canvas_selection' && !exec.toolSet?.view(exec.agent).has('canvas_state')) {
        return 'Load the web-canvas skill before editing a canvas selection.';
      }
    });
  }

  // Opt-in for new host tools: register(definition, { discovery: { keywords, skill? }, when? }).
  // Remote servers and the bundled media plugin already register original DSH definitions.
  register(definition, options = {}) {
    let entry = options.discovery;
    const fiber = this.ctx.fiber;
    if (!entry && fiber.name === 'mcp-client' && typeof fiber.config?.serverName === 'string' && definition.name.startsWith('mcp__')) {
      entry = { server: fiber.config.serverName };
    }
    if (!entry && fiber.name === 'dsh-image-gen') {
      if (IMAGE_TOOLS.includes(definition.name)) entry = { connection: 'dsh-image-gen', skill: 'image-tools' };
      if (CANVAS_TOOLS.includes(definition.name)) entry = { connection: 'dsh-image-gen', skill: 'web-canvas' };
      if (definition.name === 'find_inspiration') entry = { connection: 'dsh-image-gen', keywords: 'inspiration prompts 灵感 提示词' };
    }
    if (!entry && RESOURCES.has(definition.name)) entry = { resourceTool: true };
    const record = entry && { connection: entry.server ? 'mcp:' + entry.server : fiber.name, ...entry,
      definition, originalWhen: options.when, fixed: options[DEVICE_ACTION] === true ||
        (fiber.name === 'dsh-image-gen' && (IMAGE_TOOLS.includes(definition.name) || CANVAS_TOOLS.includes(definition.name) || definition.name === 'find_inspiration')) };
    const ctx = this.ctx;
    const scope = scopeOf(ctx);
    const register = () => super.register(definition, record ? { ...options, when: lookup =>
      this.admitted(record, lookup) && (!options.when || options.when(lookup)) } : options);
    const entries = this.entries;
    return ctx.effect(() => {
      // A preset can reuse the very same definition in several scopes with different options.
      // tools/change fires inside register(). Subscribers must already see this record.
      const scopes = entries.get(definition) ?? new Map();
      const previous = scopes.get(scope);
      const slot = { record };
      entries.set(definition, scopes);
      scopes.set(scope, slot);
      const restore = () => {
        if (scopes.get(scope) !== slot) return;
        if (previous) scopes.set(scope, previous);
        else scopes.delete(scope);
        if (!scopes.size) entries.delete(definition);
      };
      try {
        const off = register();
        return () => {
          restore();
          return off();
        };
      } catch (error) {
        restore();
        throw error;
      }
    }, 'action directory registration');
  }

  entryFor(definition, agent) {
    const scopes = this.entries.get(definition);
    if (!scopes) return undefined;
    for (const scope of scopeChainOf(agent)) if (scopes.has(scope)) return scopes.get(scope).record;
    return scopes.get(undefined)?.record;
  }

  state(agent) {
    let state = this.sessions.get(agent);
    if (state) return state;
    state = { actions: new Set(), skills: new Map(), pending: new Map(), guides: new Map(), resource: undefined };
    this.sessions.set(agent, state);
    // Never mistake a pre-upgrade header (all tools) for user intent. Restore only
    // matching declarations from a previous on-demand step; live scopes/policies still apply.
    const previous = agent.session?.requestHeader?.()?.tools;
    if (previous?.some(tool => tool.name === 'connector_search')) {
      for (const tool of previous) {
        const def = this.get(tool.name, agent);
        const entry = this.entryFor(def, agent);
        // A saved remote schema carries no connection generation. Rediscovery uses the
        // current connection with its existing grant. For local actions restore only
        // the definitions actually exposed, even if they belong to a larger Skill.
        if (!entry?.fixed || tool.description !== def.description || !isDeepStrictEqual(tool.parameters, def.parameters)) continue;
        state.actions.add(entry);
      }
    }
    return state;
  }

  select(state, entry) {
    state.actions.delete(entry);
    state.actions.add(entry);
    while (state.actions.size > MAX_ACTIVE) state.actions.delete(state.actions.values().next().value);
  }

  async resolve(lookup) {
    const { agent, signal } = lookup;
    const state = this.state(agent);
    if (state.pending.size) {
      const skills = this.ctx.get('skills');
      const cwd = await this.ctx.get('workingDirectory')?.ensure(agent, signal);
      for (const [name, source] of [...state.pending]) {
        const skill = await skills?.get(name, { scope: agent, cwd, signal });
        signal.throwIfAborted();
        state.pending.delete(name);
        if (!skill || !(source === 'user' ? isUserInvocable(skill) : isModelInvocable(skill))) continue;
        // An extension can compose existing actions using standard Skill frontmatter.
        const uses = skill.metadata?.['fish-pocket']?.uses;
        const entries = Array.isArray(uses) ? uses.filter(id => typeof id === 'string')
          .map(id => this.entryFor(this.get(id, agent), agent)).filter(Boolean) : [];
        state.skills.delete(name);
        state.skills.set(name, new Set(entries));
        if (state.skills.size > MAX_ACTIVE) state.skills.delete(state.skills.keys().next().value);
      }
    }
    // Pin the target as well as the shared resource functions for this model step.
    const resource = this.directCalls.get(lookup)?.resource ?? state.resource;
    const toolSet = await super.resolve(lookup);
    if (resource) this.stepResources.set(toolSet, resource);
    return toolSet;
  }

  admitted(entry, lookup) {
    const { agent } = lookup;
    const state = this.state(agent);
    const direct = this.directCalls.get(lookup);
    if (entry.resourceTool) return direct?.resource
      ? this.servers(agent).get(direct.resource.server) === direct.resource : Boolean(this.resourceFor(agent));
    if (entry.server && !this.serverAllowed(agent, entry.server)) return false;
    if (direct?.entry === entry) return true;
    if (state.actions.has(entry)) return true;
    if (state.skills.has(entry.skill)) return true;
    for (const uses of state.skills.values()) if (uses.has(entry)) return true;
    return false;
  }

  async listActions(connection, { agent, signal = new AbortController().signal, includeResources = true }) {
    if (!agent) return [];
    const candidates = [];
    const lookup = { agent, signal, modelSelection: agent.model?.current() };
    const servers = includeResources ? this.servers(agent) : undefined;
    for (const def of this.definitions(agent)) {
      const entry = this.entryFor(def, agent);
      if (!entry) continue;
      if (entry.originalWhen && !await entry.originalWhen(lookup)) continue;
      if (entry.resourceTool) {
        for (const server of servers?.keys() ?? []) {
          const id = 'mcp:' + server;
          if (!connection || connection === id) candidates.push({ name: def.name, connection: id, description: def.description, keywords: server, [registration]: entry });
        }
        continue;
      }
      if (connection && connection !== entry.connection) continue;
      if (entry.server && !this.serverAllowed(agent, entry.server)) continue;
      candidates.push({ name: def.name, connection: entry.connection, description: def.description ?? '',
        keywords: [entry.server, entry.skill, entry.keywords].filter(Boolean).join(' '), [registration]: entry });
    }
    signal.throwIfAborted();
    // Some original conditions are async. Recheck the live scope once, not once per tool.
    const live = new Set(this.definitions(agent));
    const currentServers = servers?.size ? this.servers(agent) : undefined;
    return candidates.filter(item => {
      const entry = item[registration];
      if (!live.has(entry.definition) || this.entryFor(entry.definition, agent) !== entry) return false;
      if (entry.resourceTool) {
        const server = item.connection.slice(4);
        return currentServers?.has(server) && currentServers.get(server) === servers.get(server);
      }
      return !entry.server || this.serverAllowed(agent, entry.server);
    });
  }

  async describe(connection, name, { agent, signal = new AbortController().signal }) {
    const definition = this.get(name, agent);
    const entry = this.entryFor(definition, agent);
    if (!agent || !entry || !this.owns(entry, connection, agent)) return undefined;
    if (entry.originalWhen && !await entry.originalWhen({ agent, signal, modelSelection: agent.model?.current() })) return undefined;
    signal.throwIfAborted();
    if (this.get(name, agent) !== definition || this.entryFor(definition, agent) !== entry) return undefined;
    return { name, connection, description: definition.description,
      inputSchema: structuredClone(definition.parameters), outputSchema: structuredClone(definition.output.schema) };
  }

  // Optional host-provider interface for a package with a manifest of actions. Each item
  // supplies the usual defineTool spec (including output.render), plus optional discovery
  // metadata. Cordis owns the registrations and rolls back the group on a failed install.
  async registerProvider(connection, provider) {
    const ctx = this.ctx;
    const controller = new AbortController();
    const registrations = [];
    const dispose = ctx.effect(() => () => {
      controller.abort();
      for (const off of registrations.splice(0).reverse()) off();
    }, 'action provider ' + connection);
    try {
      const actions = await provider.listActions(connection, { scope: scopeOf(ctx), signal: controller.signal });
      controller.signal.throwIfAborted();
      for (const { discovery, when, ...spec } of actions) {
        const definition = defineTool({ ...spec, execute: (args, exec) => provider.invoke(connection, spec.name, args, exec) });
        registrations.push(this.register(definition, { when, discovery: { ...discovery, connection } }));
      }
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async discover(query, agent, offset = 0, signal) {
    if (!agent) throw new Error('Connector discovery needs a conversation.');
    if (typeof query !== 'string' || !query.trim()) throw new Error('Enter an action, service or task to search for.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
    query = query.trim();
    if (query.startsWith('guide:')) {
      const server = query.slice(6);
      const guide = this.state(agent).guides.get(server);
      if (guide && this.servers(agent).get(server) === guide.resource) return guidePage(guide.text, server, offset) || 'No more service instructions.';
      return 'No additional service instructions are available.';
    }
    const candidates = await this.listActions(undefined, { agent, signal, includeResources: false });
    for (const [server, resource] of this.servers(agent)) {
      candidates.push({ name: 'resources:' + server, keywords: server, description: 'List or read MCP resources on ' + server,
        server, [registration]: resource });
    }
    const found = matches(query, candidates);
    if (!found.length) return 'No matching action is available in this conversation.';
    if (found.length > 1) {
      const page = found.slice(offset, offset + MAX_MATCHES);
      if (!page.length) return 'No more matches.';
      const lines = page.map(item => item.name + ' — ' + item.description.replace(/\s+/g, ' ').slice(0, 110));
      if (offset + page.length < found.length) lines.push('More matches: offset ' + (offset + page.length));
      return lines.join('\n');
    }
    const [item] = found;
    const state = this.state(agent);
    if (item.server) {
      if (this.servers(agent).get(item.server) !== item[registration]) return 'Connection changed. Search again.';
      state.resource = item[registration];
      return 'Enabled MCP resource tools for server ' + item.server + '.';
    }
    if (this.entryFor(this.get(item.name, agent), agent) !== item[registration]) return 'Action changed. Search again.';
    this.select(state, item[registration]);
    return 'Enabled ' + item.name + ' for the next step in this conversation.';
  }

  // Keep the connection owner and generation, never the OAuth token, URL or headers.
  trackResource(server) {
    const scope = scopeOf(this.ctx);
    return this.ctx.effect(() => {
      const map = this.resourceScopes.get(scope) ?? new Map();
      if (map.has(server)) throw new Error('MCP resource server already registered in this scope: ' + server);
      this.resourceScopes.set(scope, map);
      const entry = { server };
      map.set(server, entry);
      return () => {
        if (map.get(server) === entry) map.delete(server);
        if (!map.size) this.resourceScopes.delete(scope);
      };
    }, 'action catalog MCP resource');
  }

  registerConnectorAccess(allowed) {
    return this.ctx.effect(() => {
      this.connectorPolicies.add(allowed);
      return () => this.connectorPolicies.delete(allowed);
    }, 'action catalog connector access');
  }

  serverAllowed(agent, server) {
    for (const scope of scopeChainOf(agent)) {
      if (scope !== agent && !('session' in scope)) continue;
      for (const allowed of this.connectorPolicies) if (!allowed(scope, server)) return false;
    }
    return true;
  }

  servers(agent) {
    const visible = new Map(this.resourceScopes.get(undefined));
    for (const scope of [...scopeChainOf(agent)].reverse()) {
      for (const [name, resource] of this.resourceScopes.get(scope) ?? []) visible.set(name, resource);
    }
    for (const name of visible.keys()) if (!this.serverAllowed(agent, name)) visible.delete(name);
    return visible;
  }

  resourceFor(agent, toolSet) {
    const entry = toolSet ? this.stepResources.get(toolSet) : this.sessions.get(agent)?.resource;
    return entry && this.servers(agent).get(entry.server) === entry ? entry.server : undefined;
  }

  owns(entry, connection, agent) {
    if (entry.resourceTool) return typeof connection === 'string' && connection.startsWith('mcp:') && this.servers(agent).has(connection.slice(4));
    return entry.connection === connection && (!entry.server || this.serverAllowed(agent, entry.server));
  }

  // A host entry point (such as the browser CLI) names an existing action. Resolve
  // a fresh, scoped set, including the action's original condition, and run the same
  // executor, approvals, guards and result rendering used by the typed tool.
  async invoke(connection, name, args, { agent, signal }) {
    const definition = this.get(name, agent);
    const entry = this.entryFor(definition, agent);
    if (!agent || !entry || !this.owns(entry, connection, agent)) throw new Error(name + ' is unavailable in this conversation.');
    const resource = entry.resourceTool ? this.servers(agent).get(connection.slice(4)) : undefined;
    if (resource) {
      if (args.server !== undefined && args.server !== resource.server) throw new Error('Resource server does not match the selected connection.');
      args = { ...args, server: resource.server };
    }
    const modelSelection = agent.model.current();
    if (!modelSelection) throw new Error('Select a model for this conversation first.');
    const lookup = { agent, signal, modelSelection };
    this.directCalls.set(lookup, { entry, resource });
    let toolSet;
    try {
      toolSet = await this.resolve(lookup);
      if (toolSet.view(agent).get(name) !== definition) throw new Error(name + ' is unavailable in this conversation.');
      const batch = await this.execute({ agent, signal, toolSet,
        calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }] });
      return batch.results[0].result;
    } finally {
      toolSet?.dispose();
      this.directCalls.delete(lookup);
    }
  }
}
