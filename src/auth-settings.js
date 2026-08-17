/**
 * auth-settings.js — 读写 pi 自己的 provider API Key（~/.pi/agent/auth.json）。
 *
 * 跟 pi-settings.js（这个工作台实例私有的 provider/model 偏好）不同：这里存的是
 * 用户主动选择"和终端里日常用的 pi 共享"的凭证——写的就是 pi 自己认的那份
 * auth.json，格式已用真实文件验证：{ [providerId]: { type: 'api_key', key } }
 *（OAuth 凭证是 { type: 'oauth', access, ... }，这里只新增/删除 api_key 条目，
 * 不碰其他 provider 已有的 OAuth 登录状态）。
 *
 * pi 包本身不对外导出它的 AuthStorage 类（不在 package.json 的 exports 里），
 * 所以这里按已验证格式自己做读-改-写；用 proper-lockfile 做同步锁并手动重试
 *（pi 自己的 auth-storage.js 也是这个模式：lockSync 不内置重试，ELOCKED 时
 * 自己 sleep 后重试），避免跟终端里另一个 pi 进程同时写导致互相覆盖或截断。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lockfile = require('proper-lockfile');

function assertProviderId(providerId) {
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId)) {
    throw new Error('Provider ID 只能包含字母、数字、点、下划线和连字符。');
  }
}

function getAuthPath() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir ? path.resolve(envDir) : path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'auth.json');
}

function readAuthFile(authPath) {
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return {};
  }
}

function acquireLockSyncWithRetry(authPath) {
  const maxAttempts = 10;
  const delayMs = 20;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(authPath, { realpath: false });
    } catch (error) {
      if (error.code !== 'ELOCKED' || attempt === maxAttempts) throw error;
      lastError = error;
      const start = Date.now();
      while (Date.now() - start < delayMs) { /* 同步忙等，跟 pi 自己的实现一致 */ }
    }
  }
  throw lastError;
}

function withLock(authPath, fn) {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  if (!fs.existsSync(authPath)) fs.writeFileSync(authPath, '{}', { encoding: 'utf8', mode: 0o600 });
  const release = acquireLockSyncWithRetry(authPath);
  try {
    fn();
  } finally {
    release();
  }
}

function writeAuthFile(authPath, data) {
  fs.writeFileSync(authPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 列出各 provider 的凭证配置状态，不回显 key/access 内容 */
function readCredentialStatus(providerIds, authPath = getAuthPath()) {
  const data = readAuthFile(authPath);
  const result = {};
  for (const id of providerIds) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
    const entry = data[id];
    result[id] = entry ? { configured: true, type: entry.type } : { configured: false, type: null };
  }
  return result;
}

/** 写入/更新一个 provider 的 API Key，格式跟 pi 自己写的一致 */
function writeApiKey(providerId, key, authPath = getAuthPath()) {
  assertProviderId(providerId);
  if (typeof key !== 'string' || !key.trim()) throw new Error('API Key 不能为空。');
  withLock(authPath, () => {
    const data = readAuthFile(authPath);
    data[providerId] = { type: 'api_key', key };
    writeAuthFile(authPath, data);
  });
}

/** 删除一个 provider 的凭证条目（不区分 api_key/oauth，用户主动清除） */
function deleteApiKey(providerId, authPath = getAuthPath()) {
  assertProviderId(providerId);
  withLock(authPath, () => {
    const data = readAuthFile(authPath);
    if (providerId in data) {
      delete data[providerId];
      writeAuthFile(authPath, data);
    }
  });
}

module.exports = { getAuthPath, readCredentialStatus, writeApiKey, deleteApiKey };
