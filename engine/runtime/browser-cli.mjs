import path from 'node:path';
import { describe } from '../plugins/ios-native/binding.mjs';
import { actionCaller } from './action-command.mjs';

const commands = new Set(['open', 'read', 'click', 'type', 'select', 'scroll', 'back', 'forward', 'reload',
  'tabs', 'new_tab', 'select_tab', 'close_tab', 'screenshot']);

export function browserAvailable() {
  return describe('browser') !== null;
}

function argumentValue(raw, schema, name) {
  if (schema.type === 'integer' || schema.type === 'number') {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
      throw new Error(name + ' needs ' + schema.type);
    }
    return value;
  }
  if (schema.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new Error(name + ' needs true or false');
    return raw === 'true';
  }
  if (schema.enum && !schema.enum.includes(raw)) throw new Error(name + ' must be one of ' + schema.enum.join(', '));
  return raw;
}

// BrowserCatalog supplies the actual actions, required positional arguments, flag names and types.
export function parseBrowserCommand(argv, catalog) {
  const actions = catalog.actions.filter(item => commands.has(item.name));
  const [op, ...rest] = argv;
  if (!op || op === '--help' || (op === 'help' && !rest.length)) {
    return { help: 'browser <action> [arguments]\n' + actions.map(item => item.name).join(', ')
      + '\nUse browser help <action> for parameters. For advanced operations discover the browser tool.' };
  }
  const actionName = op === 'help' ? rest[0] : op;
  const action = actions.find(item => item.name === actionName);
  if (!action) throw new Error('Unknown browser command. Run browser --help. Discover the browser tool for advanced operations.');
  const specs = new Map(catalog.params.map(param => [param.name, param.schema]));
  const takes = action.takes ?? [], needs = action.needs ?? [];
  if (op === 'help' || rest[0] === '--help') {
    return { help: [action.does, 'browser ' + [action.name, ...needs.map(key => '<' + key + '>')].join(' '),
      ...takes.map(key => '--' + key + '  ' + (specs.get(key)?.description ?? key)),
      ...(action.image ? ['--out  Write the screenshot to a file for read_image.'] : [])].join('\n') };
  }
  const params = {};
  let out;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i].startsWith('--');
    const key = flag ? rest[i].slice(2) : needs.find(key => !Object.hasOwn(params, key));
    if (flag && key === 'out' && action.image) {
      if (out !== undefined || !rest[i + 1]) throw new Error('--out needs one file path');
      out = rest[++i];
      continue;
    }
    const spec = specs.get(key);
    if (!spec || !takes.includes(key) || Object.hasOwn(params, key)) throw new Error('Unexpected argument ' + rest[i] + '. Use browser help ' + action.name);
    let value = rest[i];
    if (flag) value = spec.type === 'boolean' && !['true', 'false'].includes(rest[i + 1]) ? 'true' : rest[++i];
    if (value === undefined) throw new Error('--' + key + ' needs a value');
    params[key] = argumentValue(value, spec, key);
  }
  for (const key of needs) if (!Object.hasOwn(params, key)) throw new Error(action.name + ' needs ' + key);
  return { args: { action: action.name, ...params }, out };
}

async function dispatch({ args, out }, shell) {
  const owner = actionCaller();
  const signal = shell.signal ?? owner.signal;
  signal.throwIfAborted();
  const result = await owner.tools.invoke('device', 'browser', args, { agent: owner.agent, signal });
  if (result.isError) throw new Error(result.error.message);
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const image = result.content.find(block => block.type === 'image')?.attachment;
  if (!image) return text;
  const attachments = owner.agent.ctx.get('attachments');
  let file = attachments.imageHostPath(image);
  if (out) {
    const stored = await attachments.readImage(image, signal);
    signal.throwIfAborted();
    file = path.posix.resolve('/', shell.cwd, out);
    await shell.fs.writeFile(file, stored.data);
  }
  if (!file) throw new Error('Use browser screenshot --out <file> to save the picture.');
  return text + '\nImage file: ' + file + '\nUse read_image to view it.';
}

export function browserCommand(defineCommand, catalog = () => describe('browser')) {
  return defineCommand('browser', async (argv, shell) => {
    try {
      const parsed = parseBrowserCommand(argv, catalog());
      const output = parsed.help ?? await dispatch(parsed, shell);
      return { stdout: output + '\n', stderr: '', exitCode: 0 };
    } catch (error) {
      return { stdout: '', stderr: 'browser: ' + error.message + '\n', exitCode: 1 };
    }
  });
}
