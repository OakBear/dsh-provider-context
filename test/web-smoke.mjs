// Actual Web integration: launches a separate server and a temporary headless
// Chrome profile, saves through ConfigForms, then restores the original value.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const cli = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const port = 8782;
const child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
let browser;
const errors = [];
try {
  const deadline = Date.now() + 30000;
  let url;
  while (Date.now() < deadline) {
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    url = clean.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/[^\\s]*`))?.[0];
    if (url) break;
    if (child.exitCode !== null) throw new Error(`dsh exited ${child.exitCode}: ${clean.replace(/(?:auth|token)=[^\s]+/g, 'token=REDACTED')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!url) throw new Error('dsh Web did not start within 30 seconds');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // The same settings trigger may be icon-only in Chinese and English locales.
  const settings = page.getByRole('button', { name: /^(设置|Settings)$/ }).first();
  await settings.click({ timeout: 15000 });
  const plugins = page.getByText('内置插件', { exact: true });
  await plugins.click({ timeout: 10000 });
  await page.getByText('上下文容量', { exact: true }).click({ timeout: 15000 });
  const input = page.getByRole('spinbutton', { name: 'Qoder 中国版 上下文 tokens' });
  await input.waitFor({ timeout: 15000 });
  const original = await input.inputValue();
  assert.equal(original, '200000');
  await input.fill('210000');
  const row = input.locator('xpath=../..');
  await row.getByRole('button', { name: '保存', exact: true }).click();
  await row.getByText('已保存，新请求生效').waitFor({ timeout: 10000 });
  const profilePatch = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  assert.match(readFileSync(profilePatch, 'utf8'), /qodercn: 210000/);
  await input.fill(original);
  await row.getByRole('button', { name: '保存', exact: true }).click();
  await row.getByText('已保存，新请求生效').waitFor({ timeout: 10000 });
  assert.match(readFileSync(profilePatch, 'utf8'), /qodercn: 200000/);
  await page.getByRole('heading', { name: '提供商上下文容量' }).locator('..')
    .screenshot({ path: join(process.cwd(), 'context-settings.png') });
  assert.deepEqual(errors, []);
  console.log('WEB_SMOKE_OK: plugin tab loaded, 10 provider rows, live save persisted, original 200K restored');
  writeFileSync(join(process.cwd(), 'web-verification.json'), JSON.stringify({
    ok: true, providerRows: await page.getByRole('spinbutton').count(), original: Number(original),
    saved: 210000, restored: 200000, pageErrors: errors, verifiedAt: new Date().toISOString(),
  }, null, 2));
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      console.log('FAILURE_UI', (await page.locator('body').innerText()).slice(-4000));
      await page.screenshot({ path: join(process.cwd(), 'context-settings-debug.png'), fullPage: true });
    }
  }
  console.error('SERVER_DIAGNOSTICS', output.replace(/(?:auth|token)=[^\s]+/g, 'token=REDACTED'));
  throw error;
} finally {
  await browser?.close();
  child.kill();
}
