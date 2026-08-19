/**
 * credential-store.js — 通用业务凭证库（设置页「其他」等 tab 的底层）。
 *
 * 边界：core 不定义任何具体业务凭证字段。应用（内容层）通过 registerSchema
 * 注册自己的凭证项（如某数据 API 的 Token、某平台 Cookie），core 提供统一的
 * 存取 / 状态回显 / 附加动作框架：
 *
 *  - 值只落盘在 store 文件（<dataRoot>/.pi-electron-core/credentials.json），
 *    渲染层永远拿不到明文，只拿 { configured, source, updatedAt, ... }。
 *  - schema 可声明 envName：默认环境变量存在时视为「环境托管」；若同时声明
 *    storeOverridesEnv，则应用存储优先，清除后回退到环境变量。
 *  - schema 可声明 onSave / onClear / onAction 钩子做落盘之外的副作用
 *    （如把值写进某 .env / 配置文件、打开登录窗口），业务细节由注册方实现。
 *
 * 存储格式：
 *   { "version": 1, "credentials": { "<id>": { "value": "...", "updatedAt": 123 } } }
 */
const fs = require('node:fs');
const path = require('node:path');

/** 标准状态形状（渲染层可见，永不包含明文） */
function emptyStatus(schema) {
  return {
    id: schema.id,
    label: schema.label,
    description: schema.description || '',
    input: schema.input || 'password',
    placeholder: schema.placeholder || '',
    revealable: schema.revealable === true,
    envName: schema.envName || '',
    storeOverridesEnv: schema.storeOverridesEnv === true,
    // 渲染层按这些 id 生成/更新卡片元素（可缺省，渲染器有默认推导）
    cardId: schema.cardId || '',
    inputId: schema.inputId || '',
    tagId: schema.tagId || '',
    statusId: schema.statusId || '',
    saveId: schema.saveId || '',
    clearId: schema.clearId || '',
    configured: false,
    source: 'none', // 'environment' | 'store' | 'none'
    managed: true, // false = 由环境变量托管，本 store 无法修改
    updatedAt: null,
    actions: Array.isArray(schema.actions)
      ? schema.actions.map((a) => ({
        id: a.id,
        label: a.label,
        buttonId: a.buttonId || '',
        useInput: a.useInput === true,
      }))
      : [],
  };
}

class CredentialStore {
  /**
   * @param {object} opts
   * @param {string} opts.file 存储文件路径（建议 <dataRoot>/.pi-electron-core/credentials.json）
   */
  constructor({ file }) {
    this.file = file;
    this.schemas = new Map();
  }

  /** 注册一个凭证项 schema；同一 id 重复注册抛错 */
  registerSchema(schema) {
    if (!schema || typeof schema.id !== 'string' || !schema.id.trim()) {
      throw new Error('凭证 schema 缺少 id');
    }
    if (!schema.label) throw new Error(`凭证 schema(${schema.id}) 缺少 label`);
    if (this.schemas.has(schema.id)) throw new Error(`凭证 schema 重复注册：${schema.id}`);
    this.schemas.set(schema.id, schema);
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return (data && data.credentials) || {};
    } catch {
      return {};
    }
  }

  _save(credentials) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`, 'utf8');
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows 不支持 POSIX 权限位 */ }
  }

  /** 取某凭证的明文（仅供主进程内部/钩子使用，绝不通过 IPC 发给渲染层） */
  get(id) {
    const record = this._load()[id];
    return record ? record.value : undefined;
  }

  /** 环境变量是否提供了该凭证 */
  _envValue(schema) {
    if (!schema.envName) return undefined;
    const v = process.env[schema.envName];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  /** 主进程内部读取最终生效值；默认环境变量优先，schema 可声明应用存储优先。 */
  getEffective(id) {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`未注册的凭证：${id}`);
    const record = this._load()[id];
    const storedValue = record && typeof record.value === 'string' && record.value.trim()
      ? record.value.trim()
      : undefined;
    const envValue = this._envValue(schema);
    return schema.storeOverridesEnv ? (storedValue ?? envValue) : (envValue ?? storedValue);
  }

  /** 单条状态 */
  statusOf(id) {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`未注册的凭证：${id}`);
    const status = emptyStatus(schema);
    const envValue = this._envValue(schema);
    const record = this._load()[id];
    const hasStoredValue = !!(record && typeof record.value === 'string' && record.value.trim());
    if (schema.storeOverridesEnv && hasStoredValue) {
      status.configured = true;
      status.source = 'store';
      status.updatedAt = record.updatedAt || null;
    } else if (envValue !== undefined) {
      status.configured = true;
      status.source = 'environment';
      status.managed = schema.storeOverridesEnv === true;
    } else if (hasStoredValue) {
      status.configured = true;
      status.source = 'store';
      status.updatedAt = record.updatedAt || null;
    }
    if (typeof schema.statusExtra === 'function') {
      const extra = schema.statusExtra(status, { store: this });
      if (extra && typeof extra === 'object') Object.assign(status, extra);
    }
    return status;
  }

  /** 全部注册项的状态列表 */
  status() {
    return Array.from(this.schemas.keys()).map((id) => this.statusOf(id));
  }

  /** 保存凭证：写 store + 触发注册方的 onSave 副作用 */
  async set(id, value) {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`未注册的凭证：${id}`);
    if (!schema.storeOverridesEnv && this._envValue(schema) !== undefined) {
      throw new Error(`${schema.label} 当前由环境变量 ${schema.envName} 管理，无法在应用中修改。`);
    }
    const credentials = this._load();
    credentials[id] = { value: String(value ?? ''), updatedAt: Date.now() };
    this._save(credentials);
    if (typeof schema.onSave === 'function') await schema.onSave(credentials[id].value, { store: this });
    return this.statusOf(id);
  }

  /** 清除凭证：移除 store 记录 + 触发注册方的 onClear 副作用 */
  async clear(id) {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`未注册的凭证：${id}`);
    if (!schema.storeOverridesEnv && this._envValue(schema) !== undefined) {
      throw new Error(`${schema.label} 当前由环境变量 ${schema.envName} 管理，无法在应用中清除。`);
    }
    const credentials = this._load();
    delete credentials[id];
    this._save(credentials);
    if (typeof schema.onClear === 'function') await schema.onClear({ store: this });
    return this.statusOf(id);
  }

  /** 触发附加动作（如连接测试 / 打开登录窗口）；返回值默认不跨 IPC 暴露。 */
  async runAction(id, actionId, value) {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`未注册的凭证：${id}`);
    if (typeof schema.onAction !== 'function') throw new Error(`凭证 ${id} 不支持动作 ${actionId}`);
    const result = await schema.onAction(actionId, { store: this, value });
    let actionResult = null;
    if (schema.exposeActionResult === true && result && typeof result === 'object') {
      actionResult = {
        ok: result.ok !== false,
        pending: result.pending === true,
        message: typeof result.message === 'string' ? result.message.slice(0, 1000) : '',
      };
    }
    return { ...this.statusOf(id), actionResult };
  }
}

module.exports = { CredentialStore };
