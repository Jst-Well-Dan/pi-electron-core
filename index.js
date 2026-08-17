/**
 * pi-electron-core — 纯 pi coding agent × Electron 复用层
 * 不含任何具体项目的技能触发 prompt / 产出文件解析逻辑。
 */
const { PiRpcClient, resolvePiCommand, childEnv } = require('./src/pi-rpc');
const { ChatSessionManager } = require('./src/chat-session');
const { CredentialStore } = require('./src/credential-store');
const { FeishuManager } = require('./src/feishu-bridge');
const dataRoot = require('./src/data-root');
const piInstaller = require('./src/pi-installer');
const piSettings = require('./src/pi-settings');
const authSettings = require('./src/auth-settings');
const { listProviderCredentials } = require('./src/pi-providers');

module.exports = {
  PiRpcClient,
  resolvePiCommand,
  childEnv,
  ChatSessionManager,
  CredentialStore,
  FeishuManager,
  ...dataRoot,
  ...piInstaller,
  ...piSettings,
  ...authSettings,
  listProviderCredentials,
};
