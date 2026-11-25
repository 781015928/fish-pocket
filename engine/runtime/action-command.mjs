import { AsyncLocalStorage } from 'node:async_hooks';

// Capture the host's Agent before running the shell. Commands share an interpreter and
// may run concurrently; exported shell variables are never an authorization decision.
const owners = new AsyncLocalStorage();

export function withActionCaller(owner, run) {
  return owners.run(owner, run);
}

export function actionCaller() {
  const owner = owners.getStore();
  if (!owner?.agent || !owner.tools || owner.agents?.get(owner.agent.id) !== owner.agent) {
    throw new Error('This command needs an active Fish Pocket conversation.');
  }
  return owner;
}
