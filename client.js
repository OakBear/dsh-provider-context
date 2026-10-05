window.__ModuleLoader__.load({
  id: 'dsh-provider-context',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const LABELS = {
      codearts: 'CodeArts', buddy: 'CodeBuddy', workbuddy: 'WorkBuddy',
      lobsterai: 'LobsterAI', qoder: 'Qoder 国际版', qodercn: 'Qoder 中国版',
      trae: 'TRAE', cline: 'Cline', loomy: 'Loomy', raccoon: 'Raccoon',
    };
    function WindowRow({ provider, tokens, form, writable }) {
      const [draft, setDraft] = React.useState(String(tokens));
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      React.useEffect(() => setDraft(String(tokens)), [tokens]);
      const save = async () => {
        const value = Number(draft);
        if (!/^\d+$/.test(draft) || !Number.isSafeInteger(value)) {
          setMessage('请输入非负整数'); return;
        }
        setSaving(true); setMessage('');
        try {
          const ok = await form.mutate([{ op: 'set', path: ['windows', provider], value }]);
          setMessage(ok ? '已保存，新请求生效' : '保存失败，请重试');
        } catch (error) { setMessage(error.message); }
        finally { setSaving(false); }
      };
      return h('div', { style: { padding: '12px 0', borderBottom: '1px solid var(--border-color, #8884)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('label', { htmlFor: `context-${provider}`, style: { minWidth: 170 } }, LABELS[provider] ?? provider,
            h('small', { style: { display: 'block', opacity: 0.65 } }, provider)),
          h('input', { id: `context-${provider}`, type: 'number', min: 0, step: 1,
            value: draft, disabled: !writable || saving, 'aria-label': `${LABELS[provider] ?? provider} 上下文 tokens`,
            onChange: event => { setDraft(event.target.value); setMessage(''); },
            style: { width: 150, padding: 7, color: 'inherit', background: 'transparent', border: '1px solid #8888', borderRadius: 4 } }),
          h('span', null, 'tokens'),
          h('button', { type: 'button', onClick: save, disabled: !writable || saving || draft === String(tokens) }, saving ? '保存中…' : '保存')),
        message && h('small', { role: 'status' }, message));
    }
    function ContextSettings({ form }) {
      const snapshot = React.useSyncExternalStore(
        listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot());
      const [error, setError] = React.useState('');
      const value = snapshot.value;
      if (!value) return h('p', { role: 'status' }, snapshot.error?.message ?? '正在读取上下文配置…');
      return h('div', { style: { padding: 20, maxWidth: 780 } },
        h('h2', null, '提供商上下文容量'),
        h('p', null, '每个提供商的所有模型使用同一个容量。保存到本地配置后，新请求立即生效。0 恢复提供商原始容量。'),
        h('p', { style: { opacity: 0.7 } }, '这里设置 dsh 的上下文预算，不会扩大服务端的实际模型上限。Qoder 的请求上下文参数也会同步。'),
        h('label', null, h('input', { type: 'checkbox', checked: value.enabled !== false,
          disabled: !snapshot.writable, onChange: async event => {
            setError('');
            try { if (!await form.set('enabled', event.target.checked)) setError('保存失败，请重试'); }
            catch (e) { setError(e.message); }
          } }), ' 启用上下文覆盖'),
        error && h('p', { role: 'alert' }, error),
        ...Object.entries(value.windows ?? {}).map(([provider, tokens]) =>
          h(WindowRow, { key: provider, provider, tokens, form, writable: snapshot.writable })));
    }
    return {
      name: 'provider-context-client',
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.configForms.whileServed(['provider-context'], () =>
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab', id: 'provider-context', order: 20,
            label: () => '上下文容量',
            inject: () => ({ form: ctx.configForms.get('provider-context') }),
          }, ContextSettings))), 'provider-context: settings tab');
      },
    };
  },
});
