import { actionCaller } from './action-command.mjs';

const help = 'inspiration search [keywords]  |  inspiration show <source> <id>';

export function inspirationCommand(defineCommand) {
  return defineCommand('inspiration', async ([op, ...words], shell) => {
    try {
      if (!op || op === '--help' || op === 'help') return { stdout: help + '\n', stderr: '', exitCode: 0 };
      if (op !== 'search' && (op !== 'show' || words.length !== 2)) throw new Error(help);
      const owner = actionCaller();
      const args = op === 'search' ? { query: words.join(' '), limit: 5 } : { source: words[0], id: words[1], limit: 1 };
      const result = await owner.tools.invoke('dsh-image-gen', 'find_inspiration', args, {
        agent: owner.agent, signal: shell.signal ?? owner.signal,
      });
      if (result.isError) throw new Error(result.error.message);
      const { hits, total } = result.value;
      if (op === 'show' && !hits.length) throw new Error('No inspiration case with that source and id.');
      const text = op === 'show' ? hits[0].prompt : [
        hits.length + ' of ' + total + ' matches. Use inspiration show <source> <id> for the full prompt.',
        ...hits.map(hit => [hit.sourceId, hit.id, hit.title, hit.category].join('\t')),
      ].join('\n');
      return { stdout: text + '\n', stderr: '', exitCode: 0 };
    } catch (error) {
      return { stdout: '', stderr: 'inspiration: ' + error.message + '\n', exitCode: 1 };
    }
  });
}
