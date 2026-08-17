/**
 * main-app.js — 主进程可复用组装件：chat/settings 的常驻会话创建 + IPC handler 注册。
 *
 * 独立运行的 core app（electron/main.js）和内容层消费者（如 xiya-content）共用
 * 同一份实现，避免两处维护同样的 ipcMain.handle 逻辑。
 *
 * registerCoreSettingsIpc 提供「设置体系」的通用 IPC：业务凭证（credential:*）、
 * 飞书 / Lark（feishu:*）、数据目录（dataRoot:*）。这些 handler 都依赖调用方
 * 注入的服务实例（services），core 本身不内置任何具体业务的凭证/字段。
 */
const {
  ChatSessionManager,
  readSettings,
  writeSettings,
  getAvailableModels,
  setModel,
  getCurrentModel,
  readCredentialStatus,
  writeApiKey,
  deleteApiKey,
  PiInstaller,
} = require('../index.js');
const { OAuthLoginManager } = require('../src/oauth-login.js');
const { listProviderCredentials } = require('../src/pi-providers.js');

/** 创建常驻聊天会话 + 后台预热 + 恢复已保存的模型偏好 */
function createChatSessionWithSettings({ projectRoot, sessionDir, piSettingsPath, emitToRenderer, name }) {
  const savedSettings = readSettings(piSettingsPath);
  const chatSession = new ChatSessionManager({ projectRoot, sessionDir, emitToRenderer, name });
  chatSession.ensureStarted()
    .then(async () => {
      if (savedSettings.provider && savedSettings.model) {
        try {
          await setModel(chatSession.client, { provider: savedSettings.provider, modelId: savedSettings.model });
        } catch (e) {
          console.error('恢复模型偏好失败:', e.message);
        }
      }
    })
    .catch((e) => {
      console.error('聊天会话预热失败:', e.message);
      emitToRenderer('chat:event', { kind: 'error', text: `会话启动失败：${e.message}` });
    });
  return chatSession;
}

function registerCoreIpc({ ipcMain, chatSession, piSettingsPath, emitToRenderer = () => {}, piInstaller = new PiInstaller(), oauthLoginManager = new OAuthLoginManager() }) {
  oauthLoginManager.on('event', (event) => emitToRenderer('auth:oauthEvent', event));
  // ---- 自由讨论 ----
  ipcMain.handle('chat:send', async (_e, text) => {
    await chatSession.send(text);
    return { ok: true };
  });
  ipcMain.handle('chat:new', async () => {
    await chatSession.newSession();
    return { ok: true };
  });
  ipcMain.handle('chat:abort', async () => {
    await chatSession.abort();
    return { ok: true };
  });
  ipcMain.handle('chat:restart', () => chatSession.restart());
  ipcMain.handle('chat:getHistory', () => chatSession.getHistory());

  // ---- Pi 运行环境：状态检测与经用户确认后的安装 ----
  ipcMain.handle('pi:runtimeStatus', () => piInstaller.getStatus());
  ipcMain.handle('pi:install', async () => piInstaller.install({
    onProgress: (event) => emitToRenderer('pi:installProgress', event),
  }));

  // ---- pi 设置：provider/model ----
  ipcMain.handle('settings:get', () => readSettings(piSettingsPath));
  ipcMain.handle('settings:listModels', async () => {
    await chatSession.ensureStarted();
    return getAvailableModels(chatSession.client);
  });
  ipcMain.handle('settings:getCurrentModel', async () => {
    await chatSession.ensureStarted();
    return getCurrentModel(chatSession.client);
  });
  ipcMain.handle('settings:setModel', async (_e, { provider, modelId }) => {
    await chatSession.ensureStarted();
    const model = await setModel(chatSession.client, { provider, modelId });
    writeSettings(piSettingsPath, { provider: model.provider, model: model.id });
    return model;
  });

  // ---- API Key：直接写 pi 自己的 ~/.pi/agent/auth.json，跟终端共享 ----
  ipcMain.handle('auth:getStatus', (_e, providerIds) => readCredentialStatus(providerIds || []));
  ipcMain.handle('auth:setKey', (_e, { providerId, key }) => {
    writeApiKey(providerId, key);
    return { ok: true };
  });
  ipcMain.handle('auth:deleteKey', (_e, { providerId }) => {
    deleteApiKey(providerId);
    return { ok: true };
  });

  // ---- OAuth：直接复用 Pi ModelRuntime 的官方登录流程，事件回传给桌面 UI ----
  ipcMain.handle('auth:listOAuthProviders', () => oauthLoginManager.listProviders());
  ipcMain.handle('auth:oauthStart', (_e, { providerId }) => oauthLoginManager.start(providerId));
  ipcMain.handle('auth:oauthSubmit', (_e, { providerId, token, value }) => oauthLoginManager.submit(providerId, token, value));
  ipcMain.handle('auth:oauthCancel', (_e, { providerId }) => oauthLoginManager.cancel(providerId));

  // ---- 动态 Provider 目录与凭证状态：全部来自 Pi ModelRuntime，与 TUI 一致 ----
  ipcMain.handle('auth:listProviders', () => listProviderCredentials());

}

/**
 * 注册「设置体系」通用 IPC。services 全部可选，缺省时不注册对应 handler：
 *   - credentialStore: CredentialStore 实例（业务凭证由调用方 registerSchema）
 *   - feishuManager:   FeishuManager 实例（通用飞书桥接管理）
 *   - dataRoot:        { get(), choose?(), set?(dir) } 数据根服务（choose/set 可选，
 *                      缺省时渲染层隐藏选择/保存按钮）
 */
function registerCoreSettingsIpc({ ipcMain, emitToRenderer = () => {}, services = {} }) {
  const { credentialStore, feishuManager, dataRoot } = services;

  if (credentialStore) {
    ipcMain.handle('credential:status', () => credentialStore.status());
    ipcMain.handle('credential:set', async (_e, { id, value }) => {
      await credentialStore.set(id, value);
      return credentialStore.statusOf(id);
    });
    ipcMain.handle('credential:clear', async (_e, { id }) => {
      await credentialStore.clear(id);
      return credentialStore.statusOf(id);
    });
    ipcMain.handle('credential:action', async (_e, { id, actionId }) => {
      await credentialStore.runAction(id, actionId);
      return credentialStore.statusOf(id);
    });
  }

  if (feishuManager) {
    feishuManager.on('event', (event) => emitToRenderer('feishu:event', event));
    ipcMain.handle('feishu:status', () => feishuManager.getStatus());
    ipcMain.handle('feishu:setupByQr', (_e, input) => feishuManager.setupByQr(input));
    ipcMain.handle('feishu:saveConfig', (_e, input) => feishuManager.saveConfig(input));
    ipcMain.handle('feishu:command', (_e, command) => feishuManager.command(command));
  }

  if (dataRoot) {
    ipcMain.handle('dataRoot:get', () => dataRoot.get());
    ipcMain.handle('dataRoot:choose', async () => (typeof dataRoot.choose === 'function' ? dataRoot.choose() : null));
    ipcMain.handle('dataRoot:set', async (_e, dir) => {
      if (typeof dataRoot.set !== 'function') return { ok: false, error: '当前环境不支持修改数据目录' };
      try {
        const resolved = dataRoot.set(dir);
        return { ok: true, dataRoot: resolved, requiresRestart: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  }
}

module.exports = { registerCoreIpc, registerCoreSettingsIpc, createChatSessionWithSettings };
