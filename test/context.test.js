import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { updateVolatile } from '@deepseek-ai/cosmokit';
import { decorateAdapter, installOverrides, validateWindows } from '../lib/core.js';
import { Config, apply } from '../lib/index.js';

class Adapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 },
      defaultMaxTokens: 16000, reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] } };
  }
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) };
  }
  async *stream(options) { yield { options }; }
}

test('uniform provider overrides preserve other metadata and output controls', async () => {
  const adapter = new Adapter();
  const undo = decorateAdapter(adapter, provider => provider === 'buddy' ? 200000 : undefined);
  for (const model of ['a', 'b', 'unknown']) {
    const info = await adapter.resolveModel('buddy', model);
    assert.equal(info.context.contextWindow, 200000);
    assert.equal(info.defaultMaxTokens, 16000);
    assert.equal(info.reasoning.efforts[0].id, 'medium');
    const call = await adapter.prepareCall('buddy', model);
    assert.equal(call.model.context.contextWindow, 200000);
    const options = { provider: 'buddy', model, maxTokens: 12000 };
    const [chunk] = await Array.fromAsync(call.stream(options));
    assert.equal(chunk.options, options);
  }
  assert.equal((await adapter.resolveModel('unconfigured', 'a')).context.contextWindow, 1000000);
  undo();
  assert.equal((await adapter.resolveModel('buddy', 'a')).context.contextWindow, 1000000);
  assert.equal(Object.hasOwn(adapter, 'prepareCall'), false);
});

test('live values, zero/disabled, late registration and adapter reload', async () => {
  let windows = { buddy: 200000 };
  const registrations = new Map();
  const llm = { listProviders: () => [...registrations.keys()].map(id => ({ id })),
    registration: id => registrations.get(id) };
  const controller = installOverrides(llm, provider => windows[provider] || undefined);
  controller.sync();
  const first = new Adapter();
  registrations.set('buddy', { adapter: first }); controller.sync(); controller.sync();
  assert.equal((await first.resolveModel('buddy', 'a')).context.contextWindow, 200000);
  windows = { buddy: 300000 };
  assert.equal((await first.prepareCall('buddy', 'b')).model.context.contextWindow, 300000);
  windows = { buddy: 0 };
  assert.equal((await first.resolveModel('buddy', 'a')).context.contextWindow, 1000000);
  windows = { buddy: 280000 };
  const replacement = new Adapter();
  registrations.set('buddy', { adapter: replacement }); controller.sync();
  assert.equal(Object.hasOwn(first, 'resolveModel'), false);
  assert.equal((await replacement.resolveModel('buddy', 'a')).context.contextWindow, 280000);
  controller.dispose();
  assert.equal(Object.hasOwn(replacement, 'resolveModel'), false);
});

test('invalid values are refused by schema and runtime validation', () => {
  for (const bad of [-1, 1.5, '200000', Infinity, NaN]) {
    assert.throws(() => validateWindows({ qodercn: bad }));
  }
  assert.throws(() => Config({ windows: { qodercn: -1 } }));
  assert.equal(Config({ windows: { qodercn: 200000 } }).windows.get().qodercn, 200000);
});

test('a live edit during async preparation preserves the captured enabled/disabled state', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  class SlowAdapter extends Adapter {
    async prepareCall(provider, model) { await gate; return super.prepareCall(provider, model); }
  }
  let tokens;
  const adapter = new SlowAdapter();
  const undo = decorateAdapter(adapter, () => tokens);
  const pending = adapter.prepareCall('qodercn', 'a');
  tokens = 200000; release();
  assert.equal((await pending).model.context.contextWindow, 1000000);
  assert.equal((await adapter.prepareCall('qodercn', 'a')).model.context.contextWindow, 200000);
  undo();
});

const profilePackage = join(process.env.DSH_TEST_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web'), 'package.json');
test('real CodeBuddy/WorkBuddy adapters override remote capacity for every model',
  { skip: !existsSync(profilePackage) }, async () => {
    const require = createRequire(profilePackage);
    const root = dirname(require.resolve('dsh-codearts-auth'));
    const load = file => import(pathToFileURL(join(root, file)).href);
    const { BuddyAdapter } = await load('buddy-adapter.js');
    const { CODEBUDDY, WORKBUDDY } = await load('product.js');
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      const adapter = new BuddyAdapter({ product, fetchImpl: async () => { throw new Error('network forbidden'); } });
      // Simulate a refreshed remote catalog with capacities above and below the override.
      adapter.ensureRemoteModels = async () => {};
      adapter.remoteContextWindows = new Map([['remote-large', 1000000], ['remote-small', 128000]]);
      const undo = decorateAdapter(adapter, provider => provider === product.id ? 200000 : undefined);
      const models = [...(product.fallbackModels ?? []).map(model => model.id), 'remote-large', 'remote-small'];
      for (const id of models) {
        assert.equal((await adapter.resolveModel(product.id, id)).context.contextWindow, 200000);
        assert.equal((await adapter.prepareCall(product.id, id)).model.context.contextWindow, 200000);
      }
      assert.equal(adapter.remoteContextWindows.get('remote-small'), 128000);
      undo();
      assert.equal((await adapter.resolveModel(product.id, 'remote-large')).context.contextWindow, 1000000);
    }
  });

test('real Qoder adapters: every model, prepared capacity, request body, captured live values',
  { skip: !existsSync(profilePackage) }, async () => {
    const require = createRequire(profilePackage);
    const root = dirname(require.resolve('dsh-codearts-auth'));
    const load = file => import(pathToFileURL(join(root, file)).href);
    const { QoderAdapter } = await load('qoder-adapter.js');
    const { QODER, QODER_CN } = await load('qoder-product.js');
    const { QoderEncryptedInfer, buildQoderInferPayload } = await load('qoder-wasm.js');
    const originalCreate = QoderEncryptedInfer.create;
    const captured = [];
    const stop = new Error('TEST_STOP_BEFORE_HTTP');
    QoderEncryptedInfer.create = async () => ({ prepareInfer(ask) {
      captured.push({ ask, body: buildQoderInferPayload(ask) });
      throw stop;
    } });
    try {
      for (const product of [QODER, QODER_CN]) {
        let tokens = 200000;
        const adapter = new QoderAdapter({ product,
          resolveCredential: async () => ({ access_token: 'test-only', uid: 'test-only' }),
          refresh: async () => { throw new Error('unexpected refresh'); },
          fetchImpl: async () => { throw new Error('network forbidden'); },
        });
        const originals = product.fallbackModels.map(model => model.contextWindow);
        const undo = decorateAdapter(adapter, provider => provider === product.id ? tokens : undefined);
        for (const model of product.fallbackModels) {
          assert.equal((await adapter.resolveModel(product.id, model.id)).context.contextWindow, 200000);
        }
        const prepared = await adapter.prepareCall(product.id, 'qfmodel');
        assert.equal(prepared.model.context.contextWindow, 200000);
        tokens = 300000;
        const options = { provider: product.id, model: 'qfmodel', messages: [
          { role: 'user', content: 'test', id: 'test' },
        ], maxTokens: 12000, reasoningEffort: 'medium' };
        await assert.rejects(async () => { for await (const chunk of prepared.stream(options)) {} }, error => error === stop);
        assert.equal(captured.at(-1).ask.maxInputTokens, 200000);
        assert.equal(captured.at(-1).body.model_config.max_input_tokens, 200000);
        assert.equal(captured.at(-1).ask.maxTokens, 12000);
        const next = await adapter.prepareCall(product.id, 'qfmodel');
        assert.equal(next.model.context.contextWindow, 300000);
        await assert.rejects(async () => { for await (const chunk of next.stream(options)) {} }, error => error === stop);
        assert.equal(captured.at(-1).body.model_config.max_input_tokens, 300000);
        assert.deepEqual(product.fallbackModels.map(model => model.contextWindow), originals);
        undo();
        assert.equal((await adapter.resolveModel(product.id, 'qfmodel')).context.contextWindow, 1000000);
      }
    } finally { QoderEncryptedInfer.create = originalCreate; }
  });

test('real Cordis/dsh-llm integration and live volatile Config', { skip: !existsSync(profilePackage) }, async () => {
  const require = createRequire(profilePackage);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { LlmRuntime, LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  class RealAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider }; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 } }; }
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  const registration = llm.registerAdapter(['qodercn'], new RealAdapter());
  const config = Config({ enabled: true, windows: { qodercn: 200000, buddy: 200000 } });
  // Use Cordis plugin lifecycle, not a fake ctx.effect/ctx.on implementation.
  const fiber = ctx.plugin({ name: 'test-context', inject: ['llm'], apply: child => apply(child, config) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await llm.resolveModelInfo('qodercn', 'any')).context.contextWindow, 200000);
  assert.equal((await llm.prepareCall({ provider: 'qodercn', model: 'other' })).context.contextWindow, 200000);
  const laterRegistration = llm.registerAdapter(['buddy'], new RealAdapter());
  assert.equal((await llm.resolveModelInfo('buddy', 'late-model')).context.contextWindow, 200000);
  updateVolatile(config.windows, Config({ windows: { qodercn: 320000 } }).windows);
  assert.equal((await llm.resolveModelInfo('qodercn', 'any')).context.contextWindow, 320000);
  updateVolatile(config.enabled, Config({ enabled: false }).enabled);
  assert.equal((await llm.resolveModelInfo('qodercn', 'any')).context.contextWindow, 1000000);
  await fiber.dispose(); registration(); laterRegistration();
});
