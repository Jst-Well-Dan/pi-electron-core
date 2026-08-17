/**
 * pi-providers.js — 动态 Provider 目录与凭证状态（与 Pi TUI 同源）。
 *
 * core 不维护静态 Provider 列表，也不实现自定义 Provider 编辑（那是 Pi TUI /
 * pi install / pi 自身 models.json 的职责）。Provider 目录与"是否已配置"统一
 * 来自 Pi 官方 ModelRuntime：
 *   - getProviders()          → 全部 provider 及其支持的认证方式（apiKey/oauth）
 *   - listCredentials()       → 当前 auth.json 中实际保存的凭证（与文件一致）
 *   - getProviderAuthStatus() → 运行时口径（含环境变量覆盖）的配置状态
 * 与用户终端里交互式使用的 pi 看到的状态完全一致，不会出现"设置页与 TUI 对不上"。
 */
const path = require('node:path');
const { resolvePiCommand } = require('./pi-rpc');

function loadModelRuntime() {
  const resolved = resolvePiCommand();
  if (!resolved) throw new Error('未找到 Pi。请先在设置中安装 Pi。');
  const packageRoot = path.dirname(path.dirname(resolved.script));
  const { ModelRuntime } = require(packageRoot);
  if (!ModelRuntime?.create) throw new Error('当前 Pi 版本不支持运行时查询。请升级 Pi 后重试。');
  return ModelRuntime;
}

/**
 * 列出全部 provider 及其认证能力与当前凭证状态（动态，与 Pi TUI 一致）。
 * 不返回任何明文密钥；type 为 'api_key' | 'oauth' | null。
 *
 * @returns {Promise<Array<{id,name,apiKeySupported,oauthSupported,configured,type,source}>>}
 */
async function listProviderCredentials() {
  const runtime = await loadModelRuntime().create();
  const creds = await runtime.listCredentials();
  const credMap = new Map(creds.map((c) => [c.providerId, c]));

  return runtime.getProviders()
    .map((provider) => {
      const cred = credMap.get(provider.id);
      let status = { configured: false };
      try {
        const s = runtime.getProviderAuthStatus(provider.id);
        if (s && typeof s === 'object') status = s;
      } catch { /* 未配置 provider 视为未配置 */ }
      return {
        id: provider.id,
        name: provider.name,
        apiKeySupported: !!provider.auth?.apiKey,
        oauthSupported: !!provider.auth?.oauth,
        configured: !!(cred && (cred.type === 'api_key' || cred.type === 'oauth')),
        type: cred?.type || null,
        source: status.source || null, // 'stored' | 'env' | null
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listProviderCredentials };
