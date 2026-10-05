# dsh-provider-context

为 dsh 0.1.7-rc.2 提供按提供商统一的上下文容量设置。默认覆盖
codearts / buddy / workbuddy / lobsterai / qoder / qodercn / trae / cline /
loomy / raccoon 为 200,000 tokens；同一提供商的所有模型使用同一个值。
未配置的提供商保留原始容量。值为 0 或关闭插件开关时恢复原始容量。

## 修改配置

Web 设置 → 插件 → 上下文容量。每个提供商单独输入 token 数并保存。
保存由 dsh 自带 ConfigForms/settings.mutate 写入 profile 的 cordis.patch.yml，
新请求立即生效；已经准备好的 Qoder 请求保留它准备时的容量。

也可以编辑 `C:\Users\qq\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- id: provider-context
  name: dsh-provider-context
  config:
    enabled: true
    windows:
      qodercn: 200000
      qoder: 200000
      buddy: 200000
      workbuddy: 200000
      codearts: 200000
      lobsterai: 200000
      trae: 200000
      cline: 200000
      loomy: 200000
      raccoon: 200000
```

手工编辑后重启 `dsh web`。可在 windows 中添加其他提供商 ID。
如加入 deepseek-official，则会覆盖 dsh 自带 DeepSeek；默认不覆盖它。
不要同时再插入第二个 id 相同的条目，应修改已有条目。

## 实现

- `lib/index.js`：Cordis 插件入口、带 `.volatile()` 的 Config schema、生命周期。
- `lib/core.js`：装饰当前及后来注册的适配器，覆盖 `resolveModel` 与
  `prepareCall` 返回的 contextWindow，供 dsh 的日志、压力判断及自动压缩读取。
- Qoder 两个站点的请求还读取私有 fallbackIndex；按请求构造影子 Map，
  把同一个容量传到 model_config.max_input_tokens。认证插件的磁盘文件和共享
  模型表均不修改。其他提供商的 HTTP 参数及计费规则由其原始适配器负责。
- `client.js`：dsh 浏览器模块，注册 Plugins 下的设置页，使用官方表单写入 API。
- 禁用/卸载时恢复原来的适配器方法；适配器重新注册时重新装饰。

DSH 没有公开的模型元数据覆盖钩子，因此本插件使用 0.1.7-rc.2 的内部
`llm.registration()`，Qoder 请求适配使用当前认证插件的 `fallbackIndex`。
这两个接口有启动检查；升级 dsh 或认证插件后需要重新验证兼容性。
不扩大服务端真实上限、不保证任意模型能接受你设置的数值。

## 安装与验证

```powershell
npm install --ignore-scripts
npm test
dsh plugin --profile web add "link:C:/Users/qq/Documents/merchant/dsh-provider-context"
dsh web
```

无需编译，无模型请求或额度消耗。测试覆盖 metadata、prepared call、Qoder
请求参数、热修改、卸载恢复及真实认证插件适配器。
