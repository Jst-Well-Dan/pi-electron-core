/**
 * pi-settings.js — provider/model 偏好：本地存储 + 生效方式
 *
 * 不碰 pi 自身的配置文件（全局 ~/.pi/agent/settings.json、项目级 .pi/settings.json）——
 * 那两个文件是"这台机器/这个项目用 pi 时"的全局默认，改了会影响用户在终端里
 * 交互式使用 pi 的行为。这里管理的是"这一个工作台实例"自己的偏好，只通过两种
 * 方式生效，都不落盘到 pi 的配置里：
 *   1. 一次性子进程（按钮任务）：拼进 spawn 参数 `--provider`/`--model`
 *   2. 常驻会话（聊天页等）：调用运行时命令 `set_model`，不重启进程
 *
 * 字段形状已用真实 `pi --mode rpc` 进程验证（见开发对话记录），不是照文档猜的：
 *   get_available_models → { models: [{ id, provider, name, cost, contextWindow, ... }] }
 *   set_model 请求参数    → { type: 'set_model', provider, modelId }，返回新的 model 对象
 *   get_state().model     → 当前生效模型，同样是 { id, provider, name, ... } 形状
 */
const fs = require('node:fs');
const path = require('node:path');

/** 读取本地偏好；文件不存在或损坏时返回空值，不抛错 */
function readSettings(settingsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { provider: data.provider || null, model: data.model || null };
  } catch {
    return { provider: null, model: null };
  }
}

function writeSettings(settingsPath, { provider, model } = {}) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ provider: provider || null, model: model || null }, null, 2)
  );
}

/** 转成一次性子进程的 spawn 参数；未设置的字段不追加，跟随 pi 自身默认 */
function toSpawnArgs(settings) {
  const args = [];
  if (settings && settings.provider) args.push('--provider', settings.provider);
  if (settings && settings.model) args.push('--model', settings.model);
  return args;
}

/** 运行时查询可用模型列表（需要一个已连接的 PiRpcClient） */
async function getAvailableModels(client) {
  const res = await client.send({ type: 'get_available_models' }, 15000);
  return (res && res.models) || [];
}

/** 运行时切换模型，返回切换后的 model 对象 */
async function setModel(client, { provider, modelId }) {
  return client.send({ type: 'set_model', provider, modelId }, 15000);
}

/** 查询当前会话正在使用的模型 */
async function getCurrentModel(client) {
  const state = await client.send({ type: 'get_state' }, 15000);
  return (state && state.model) || null;
}

module.exports = {
  readSettings,
  writeSettings,
  toSpawnArgs,
  getAvailableModels,
  setModel,
  getCurrentModel,
};
