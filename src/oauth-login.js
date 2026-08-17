/* oauth-login.js — 以 Pi 官方 ModelRuntime 完成 OAuth 登录，不经由终端或 Pi RPC prompt。 */
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { resolvePiCommand } = require('./pi-rpc');

function loadModelRuntime() {
  const resolved = resolvePiCommand();
  if (!resolved) throw new Error('未找到 Pi。请先在设置中安装 Pi。');
  const packageRoot = path.dirname(path.dirname(resolved.script));
  const { ModelRuntime } = require(packageRoot);
  if (!ModelRuntime?.create) throw new Error('当前 Pi 版本不支持桌面 OAuth 登录。请升级 Pi 后重试。');
  return ModelRuntime;
}

function token(provider) {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

class OAuthLoginManager extends EventEmitter {
  constructor({ getRuntime } = {}) {
    super();
    this.getRuntime = getRuntime || (async () => (await loadModelRuntime().create()));
    this.active = new Map();
  }

  async listProviders() {
    const runtime = await this.getRuntime();
    const credentials = await runtime.listCredentials();
    const configured = new Set(credentials.filter((item) => item.type === 'oauth').map((item) => item.providerId));
    return runtime.getProviders()
      .filter((provider) => provider.auth?.oauth)
      .map((provider) => ({ id: provider.id, name: provider.name, configured: configured.has(provider.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async start(providerId) {
    if (this.active.has(providerId)) throw new Error('该 Provider 的登录已在进行中。');
    const runtime = await this.getRuntime();
    if (!runtime.getProvider(providerId)?.auth?.oauth) throw new Error(`不支持 ${providerId} 的 OAuth 登录。`);

    const controller = new AbortController();
    const pending = new Map();
    const ask = (request) => {
      const id = token(providerId);
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const payload = {
        type: request.type === 'select' ? 'select' : 'input',
        providerId,
        token: id,
        message: request.message,
        placeholder: request.placeholder || '',
        secret: request.type === 'secret',
        ...(request.type === 'select' ? { options: request.options.map(({ id: optionId, label }) => ({ id: optionId, label })) } : {}),
      };
      this.emit('event', payload);
      if (request.signal) {
        const abort = () => {
          if (pending.delete(id)) reject(new Error('登录已取消。'));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      }
      return promise;
    };

    const login = runtime.login(providerId, 'oauth', {
      signal: controller.signal,
      notify: (event) => {
        if (event.type === 'auth_url') this.emit('event', { type: 'auth-url', providerId, url: event.url, instructions: event.instructions || '' });
        else if (event.type === 'device_code') this.emit('event', { type: 'device-code', providerId, userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds || null });
        else if (event.type === 'progress' || event.type === 'info') this.emit('event', { type: 'progress', providerId, message: event.message || '', links: event.links || [] });
      },
      prompt: ask,
    }).then(
      () => this.emit('event', { type: 'success', providerId }),
      (error) => this.emit('event', { type: controller.signal.aborted ? 'cancelled' : 'error', providerId, message: error.message || String(error) }),
    ).finally(() => {
      for (const { reject } of pending.values()) reject(new Error('登录已结束。'));
      this.active.delete(providerId);
    });

    this.active.set(providerId, { controller, pending, login });
    this.emit('event', { type: 'started', providerId });
    return { started: true };
  }

  submit(providerId, requestToken, value) {
    const active = this.active.get(providerId);
    const pending = active?.pending.get(requestToken);
    if (!pending || !requestToken.startsWith(`${providerId}-`)) throw new Error('登录请求已失效，请重新开始。');
    active.pending.delete(requestToken);
    pending.resolve(String(value || '').trim());
    return { ok: true };
  }

  cancel(providerId) {
    const active = this.active.get(providerId);
    if (!active) return { ok: true };
    active.controller.abort();
    for (const { reject } of active.pending.values()) reject(new Error('登录已取消。'));
    active.pending.clear();
    return { ok: true };
  }
}

module.exports = { OAuthLoginManager, loadModelRuntime };
