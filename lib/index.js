import Schema from '@deepseek-ai/schemastery';
import { installOverrides, validateWindows } from './core.js';

export const name = 'dsh-provider-context';
export const inject = ['llm'];
export const DEFAULT_WINDOWS = {
  codearts: 200000, buddy: 200000, workbuddy: 200000, lobsterai: 200000,
  qoder: 200000, qodercn: 200000, trae: 200000, cline: 200000,
  loomy: 200000, raccoon: 200000,
};
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用提供商上下文覆盖').volatile(),
  windows: Schema.dict(Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER))
    .default(DEFAULT_WINDOWS)
    .description('提供商 ID → 上下文 tokens。同一提供商的所有模型使用同一个值；0 恢复原始容量。')
    .volatile(),
});

const valueOf = value => typeof value?.get === 'function' ? value.get() : value;
export function apply(ctx, config) {
  const windows = () => validateWindows(valueOf(config.windows) ?? DEFAULT_WINDOWS);
  windows();
  const windowFor = provider => {
    if (valueOf(config.enabled) === false) return undefined;
    const tokens = windows()[provider];
    return tokens === 0 ? undefined : tokens;
  };
  const controller = installOverrides(ctx.llm, windowFor);
  // Cleanup is registered before activation, including failed startup.
  ctx.effect(() => () => controller.dispose(), 'provider-context: restore adapter methods');
  ctx.on('llm/adapters-updated', () => controller.sync());
  controller.sync();
  // This plugin owns a custom Web tab, with persisted live ConfigForm writes.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  ctx.logger.info('provider-context: active; per-provider windows are editable in Plugins → 上下文容量');
}
