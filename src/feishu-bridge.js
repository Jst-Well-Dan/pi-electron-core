/**
 * feishu-bridge.js — 飞书 / Lark 机器人 ↔ pi 会话桥接管理（通用版）。
 *
 * 能力：
 *  - 凭证默认保存在 <projectRoot>/.pi/feishu/config.json（按项目隔离），
 *    环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 存在时视为「环境托管」。
 *  - 内置加载 pi-electron-core/pi-packages/pi-feishu-lark 里的 Pi 扩展，
 *    调用方项目不再需要单独安装 npm:pi-feishu-lark。
 *  - 「扫码创建应用」走 @larksuiteoapi/node-sdk 的 registerApp（优先从 core
 *    依赖解析，兼容从 <projectRoot>/.pi/npm/node_modules 解析）。
 *  - start / stop / restart / status / reset 命令通过一个独立的 pi RPC 子进程
 *    调用内置 pi-feishu-lark 扩展；该子进程与桌面聊天会话相互隔离。
 *
 * 不包含任何具体项目的业务逻辑；调用方（独立 core app 或内容层）传入 projectRoot。
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PiRpcClient } = require('./pi-rpc');

const CORE_ROOT = path.resolve(__dirname, '..');
const FEISHU_PACKAGE_ROOT = path.join(CORE_ROOT, 'pi-packages', 'pi-feishu-lark');
const FEISHU_EXTENSION_PATH = path.join(FEISHU_PACKAGE_ROOT, '.pi', 'extensions', 'feishu', 'index.ts');

const DEFAULTS = {
  domain: 'feishu',
  groupPolicy: 'mention',
  cardActionMode: 'ws',
  language: 'zh',
  reactEmoji: 'THUMBSUP',
  autoStart: true,
  promptNotifySec: 180,
  promptTimeoutSec: 0,
};
const COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'reset']);

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function mask(value) {
  if (!value || value.length <= 8) return value ? '****' : '';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

class FeishuManager extends EventEmitter {
  constructor({ projectRoot, ClientClass = PiRpcClient, configPath, rootDir, extensionPath, registerApp } = {}) {
    super();
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.ClientClass = ClientClass;
    this.registerApp = registerApp || this.loadRegisterApp.bind(this);
    this.rootDir = rootDir || path.join(this.projectRoot, '.pi', 'feishu');
    this.configPath = configPath || path.join(this.rootDir, 'config.json');
    this.extensionPath = extensionPath || FEISHU_EXTENSION_PATH;
    this.client = null;
    this.busy = false;
    this.currentCommand = null;
  }

  getStatus() {
    const envConfigured = Boolean(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim());
    const config = envConfigured
      ? { ...DEFAULTS, domain: process.env.FEISHU_DOMAIN || 'feishu', appId: process.env.FEISHU_APP_ID, groupPolicy: process.env.FEISHU_GROUP_POLICY || 'mention' }
      : readJson(this.configPath);
    const configured = Boolean(config.appId && (envConfigured || config.appSecret));
    return {
      configured,
      source: envConfigured ? 'environment' : configured ? 'file' : 'none',
      appId: configured ? mask(config.appId) : '',
      domain: configured ? config.domain || DEFAULTS.domain : DEFAULTS.domain,
      groupPolicy: configured ? config.groupPolicy || DEFAULTS.groupPolicy : DEFAULTS.groupPolicy,
      cardActionMode: configured
        ? envConfigured
          ? process.env.FEISHU_CARD_ACTION_MODE || DEFAULTS.cardActionMode
          : config.cardActionMode || DEFAULTS.cardActionMode
        : DEFAULTS.cardActionMode,
      autoStart: configured ? config.autoStart !== false : DEFAULTS.autoStart,
      rootDir: this.rootDir,
      configPath: this.configPath,
      extensionPath: this.extensionPath,
      busy: this.busy,
    };
  }

  saveConfig(input = {}) {
    if (process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim()) {
      throw new Error('飞书凭证由环境变量管理，无法在应用中修改。');
    }
    const existing = readJson(this.configPath);
    const appId = String(input.appId || '').trim() || existing.appId;
    const appSecret = String(input.appSecret || '').trim() || existing.appSecret;
    if (!appId || !appSecret) throw new Error('请填写 App ID 和 App Secret。');
    if (!['feishu', 'lark'].includes(input.domain)) throw new Error('无效的应用区域。');
    if (!['mention', 'open'].includes(input.groupPolicy)) throw new Error('无效的群聊策略。');

    const config = {
      ...existing,
      ...DEFAULTS,
      appId,
      appSecret,
      domain: input.domain,
      groupPolicy: input.groupPolicy,
      autoStart: input.autoStart !== false,
      // 上游包默认是无鉴权的 0.0.0.0 webhook；Electron 只写 WebSocket 回调模式。
      cardActionMode: 'ws',
    };
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.configPath, 0o600); } catch { /* Windows 不支持 POSIX 权限位 */ }
    this.emit('event', { type: 'config-saved', status: this.getStatus() });
    return this.getStatus();
  }

  async setupByQr(input = {}) {
    if (process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim()) {
      throw new Error('飞书凭证由环境变量管理，无法重新配置。');
    }
    if (this.busy) throw new Error('飞书操作正在进行，请稍候。');
    if (!['mention', 'open'].includes(input.groupPolicy)) throw new Error('无效的群聊策略。');

    this.busy = true;
    this.emit('event', { type: 'qr-start', status: this.getStatus() });
    try {
      const result = await this.registerApp({
        source: 'pi-electron-core',
        onQRCodeReady: (info) => {
          if (typeof info?.url === 'string' && /^https:\/\//.test(info.url)) {
            this.emit('event', { type: 'qr-url', url: info.url });
          }
        },
      });
      if (!result?.client_id || !result?.client_secret) throw new Error('飞书未返回应用凭证。');
      const domain = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
      return this.saveConfig({
        appId: result.client_id,
        appSecret: result.client_secret,
        domain,
        groupPolicy: input.groupPolicy,
        autoStart: input.autoStart !== false,
      });
    } finally {
      this.busy = false;
    }
  }

  loadRegisterApp(options) {
    const modulePath = require.resolve('@larksuiteoapi/node-sdk', {
      paths: [
        path.join(FEISHU_PACKAGE_ROOT, 'node_modules'),
        path.join(CORE_ROOT, 'node_modules'),
        path.join(this.projectRoot, '.pi', 'npm', 'node_modules'),
      ],
    });
    return require(modulePath).registerApp(options);
  }

  async command(name) {
    if (!COMMANDS.has(name)) throw new Error('不支持的飞书命令。');
    if (this.busy) throw new Error('飞书操作正在进行，请稍候。');
    if (name !== 'status' && name !== 'reset' && !this.getStatus().configured) {
      throw new Error('请先保存飞书应用配置。');
    }

    const client = await this.ensureClient();
    this.busy = true;
    this.currentCommand = name;
    this.emit('event', { type: 'command-start', command: name, status: this.getStatus() });
    try {
      await client.send({ type: 'prompt', message: `/feishu ${name}` }, 15_000);
      // `/feishu ...` is handled entirely by the extension command and usually
      // does not emit agent_settled. Wait briefly so UI notifications can flush,
      // but do not block the Electron settings page for a full model turn timeout.
      const settled = await client.waitForSettled(name === 'status' ? 1_500 : 5_000);
      this.emit('event', { type: 'command-end', command: name, settled, status: this.getStatus() });
      return { ok: true, settled, status: this.getStatus() };
    } finally {
      this.busy = false;
      this.currentCommand = null;
    }
  }

  async ensureClient() {
    if (this.client?.running) return this.client;
    this.hardenTransport();
    this.assertBundledExtension();
    const client = new this.ClientClass({
      cwd: this.projectRoot,
      name: 'feishu-control',
      args: ['--approve', '--no-session', '--no-extensions', '-e', this.extensionPath],
      env: { PI_FEISHU_ROOT: this.rootDir },
    });
    client.on('extension_ui_request', (request) => this.handleUiRequest(request));
    client.on('error', (error) => this.emit('event', { type: 'error', message: error.message }));
    client.on('exit', () => this.emit('event', { type: 'offline', status: this.getStatus() }));
    client.spawn();
    this.client = client;

    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await client.send({ type: 'get_state' }, 10_000);
        const { commands = [] } = await client.send({ type: 'get_commands' }, 10_000);
        if (!commands.some((item) => item.name === 'feishu')) {
          throw new Error(`未加载内置 pi-feishu-lark 扩展：${this.extensionPath}`);
        }
        return client;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    client.kill();
    this.client = null;
    throw lastError || new Error('飞书控制进程启动失败。');
  }

  assertBundledExtension() {
    if (!fs.existsSync(this.extensionPath)) {
      throw new Error(`未找到内置 pi-feishu-lark 扩展：${this.extensionPath}`);
    }
  }

  hardenTransport() {
    const envConfigured = Boolean(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim());
    if (envConfigured) {
      if (process.env.FEISHU_CARD_ACTION_MODE !== 'ws') {
        throw new Error('为安全起见，请将 FEISHU_CARD_ACTION_MODE 设为 ws 后再从 Electron 管理飞书。');
      }
      return;
    }
    const config = readJson(this.configPath);
    if (!config.appId || !config.appSecret || config.cardActionMode === 'ws') return;
    fs.writeFileSync(this.configPath, `${JSON.stringify({ ...config, cardActionMode: 'ws' }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.configPath, 0o600); } catch { /* Windows 不支持 POSIX 权限位 */ }
    this.emit('event', { type: 'notice', message: '已将飞书卡片回调切换为安全的 WebSocket 模式。', level: 'info' });
  }

  handleUiRequest(request) {
    if (request.method === 'notify') {
      this.emit('event', { type: 'notice', message: String(request.message || ''), level: request.notifyType || 'info' });
      return;
    }
    if (request.method === 'setStatus') {
      this.emit('event', { type: 'status', message: request.statusText || '', status: this.getStatus() });
      return;
    }
    // Reset 已在应用内确认；其余交互式 setup 提示一律取消：应用独占凭证录入，
    // 密钥绝不经过 RPC UI 通道。
    if (request.id && this.client) {
      if (request.method === 'confirm' && this.currentCommand === 'reset') {
        this.client.sendRaw({ type: 'extension_ui_response', id: request.id, confirmed: true });
      } else {
        this.client.sendRaw({ type: 'extension_ui_response', id: request.id, cancelled: true });
      }
    }
  }

  dispose() {
    this.client?.kill();
    this.client = null;
  }
}

module.exports = { FeishuManager, DEFAULTS, mask };
