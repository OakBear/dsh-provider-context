// No provider credentials or HTTP requests are handled by this module.
import { AsyncLocalStorage } from 'node:async_hooks';
const CAPTURED_WINDOW = Symbol('provider-context:prepared-window');

export function validateWindows(windows) {
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) {
    throw new TypeError('provider-context: windows must be a provider-to-token-count object');
  }
  for (const [provider, tokens] of Object.entries(windows)) {
    if (!provider || !Number.isSafeInteger(tokens) || tokens < 0) {
      throw new TypeError(`provider-context: invalid context window for ${provider}; use a non-negative integer (0 restores the provider default)`);
    }
  }
  return windows;
}

export function overrideModel(info, tokens) {
  if (tokens === undefined || tokens === 0) return info;
  return { ...info, context: { ...info.context, contextWindow: tokens } };
}

/** Shadow only Qoder's request metadata, without mutating its shared model table.
 * A separate Map per dispatch prevents concurrent calls or live edits from
 * changing the capacity captured by an already prepared call.
 */
function qoderReceiver(adapter, tokens) {
  if (!tokens) return adapter;
  const index = new Map([...adapter.fallbackIndex].map(([id, model]) => [
    id, { ...model, contextWindow: tokens },
  ]));
  return new Proxy(adapter, {
    get(target, key, receiver) {
      return key === 'fallbackIndex' ? index : Reflect.get(target, key, receiver);
    },
  });
}

export function decorateAdapter(adapter, windowFor) {
  const preparation = new AsyncLocalStorage();
  const descriptors = new Map();
  const installed = new Map();
  const originalResolve = adapter.resolveModel;
  const originalPrepare = adapter.prepareCall;
  const originalStream = adapter.stream;
  if (typeof originalResolve !== 'function' || typeof originalPrepare !== 'function') {
    throw new Error('provider-context: adapter is missing resolveModel/prepareCall');
  }
  const isQoder = ['qoder', 'qodercn'].includes(adapter.product?.id);
  if (isQoder && !(adapter.fallbackIndex instanceof Map)) {
    throw new Error('provider-context: Qoder adapter layout changed; fallbackIndex is unavailable');
  }
  function install(key, method) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(adapter, key));
    installed.set(key, method);
    Object.defineProperty(adapter, key, { value: method, writable: true, configurable: true });
  }
  install('resolveModel', async function(provider, model, signal) {
    const captured = preparation.getStore();
    const tokens = captured?.provider === provider ? captured.tokens : windowFor(provider);
    return overrideModel(await originalResolve.call(this, provider, model, signal), tokens);
  });
  install('prepareCall', async function(provider, model, signal) {
    const tokens = windowFor(provider);
    const prepared = await preparation.run({ provider, tokens },
      () => originalPrepare.call(this, provider, model, signal));
    return {
      ...prepared,
      model: overrideModel(prepared.model, tokens),
      // Preserve the adapter's prepared dispatch and all its request controls.
      stream: options => prepared.stream(isQoder
        ? { ...options, [CAPTURED_WINDOW]: tokens }
        : options),
    };
  });
  if (isQoder) {
    install('stream', function(options) {
      const tokens = Object.hasOwn(options, CAPTURED_WINDOW)
        ? options[CAPTURED_WINDOW]
        : windowFor(options.provider ?? this.product.id);
      return originalStream.call(qoderReceiver(this, tokens), options);
    });
  }
  return () => {
    for (const [key, wrapper] of installed) {
      if (adapter[key] !== wrapper) continue;
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(adapter, key, descriptor);
      else delete adapter[key];
    }
  };
}

/** Registration lookup is an internal seam of dsh-llm 0.1.7-rc.2.
 * Check it explicitly, decorate each adapter once, and restore on unload.
 * The adapters-updated event covers later logins, reloads and new providers.
 */
export function installOverrides(llm, windowFor) {
  if (typeof llm.listProviders !== 'function' || typeof llm.registration !== 'function') {
    throw new Error('provider-context requires the dsh-llm 0.1.7-rc.2 registration API');
  }
  const adapters = new Map();
  function sync() {
    const active = new Set(llm.listProviders().map(provider => llm.registration(provider.id).adapter));
    for (const [adapter, undo] of adapters) {
      if (!active.has(adapter)) { undo(); adapters.delete(adapter); }
    }
    for (const adapter of active) {
      if (!adapters.has(adapter)) adapters.set(adapter, decorateAdapter(adapter, windowFor));
    }
  }
  return {
    sync,
    dispose() { for (const undo of adapters.values()) undo(); adapters.clear(); },
  };
}
