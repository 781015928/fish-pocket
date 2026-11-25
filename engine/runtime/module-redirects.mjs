// Native-addon entry points that cannot load on iOS, redirected to JavaScript
// stand-ins in shims/ at module resolution, so engine files stay untouched.
//
// Built-in plugins (plugins/ios-host/pins.json `builtin`) ship in the engine's own
// node_modules. Resolve their components from the installation, including for users
// with an older profile-local copy. Settings and credentials stay with the profile.
// DSH's own packages retry from the engine after stale-official.mjs removes an old copy.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isOfficial } from './stale-official.mjs';

export const REDIRECTS = {
  '@deepseek-ai/node-addon-system/flock': new URL('../shims/flock.mjs', import.meta.url).href,
  '@vscode/ripgrep': new URL('../shims/ripgrep.mjs', import.meta.url).href,
  sharp: new URL('../shims/sharp.mjs', import.meta.url).href,
};

const pins = JSON.parse(readFileSync(new URL('../plugins/ios-host/pins.json', import.meta.url), 'utf8'));
export const BUILTIN_PACKAGES = new Set(Object.entries(pins).filter(([, pin]) => pin.builtin === true).map(([name]) => name));
/** Where the engine's own dependencies resolve from. */
export const ENGINE_PARENT = new URL('../package.json', import.meta.url).href;

/** `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`; relative and URL specifiers → undefined. */
export function packageOf(specifier) {
  if (/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

let installed = false;
export function installModuleRedirects() {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = REDIRECTS[specifier];
      if (url) return { url, format: 'module', shortCircuit: true };
      const name = packageOf(specifier);
      if (BUILTIN_PACKAGES.has(name)) {
        return nextResolve(specifier, { ...context, parentURL: ENGINE_PARENT });
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !name || !isOfficial(name) || context.parentURL === ENGINE_PARENT) throw error;
        return nextResolve(specifier, { ...context, parentURL: ENGINE_PARENT });
      }
    },
  });
}
