/**
 * preload-bridge.js — chat/settings 的 contextBridge 绑定，供预加载脚本复用。
 * 独立 core app 和内容层消费者各自的 preload.js 都调用这个函数拼进自己的 window.workbench。
 */
function coreWorkbenchBridge(ipcRenderer) {
  return {
    /* 系统能力 */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    /* Pi 运行环境 */
    piRuntimeStatus: () => ipcRenderer.invoke('pi:runtimeStatus'),
    piInstall: () => ipcRenderer.invoke('pi:install'),
    onPiInstallProgress: (cb) => ipcRenderer.on('pi:installProgress', (_e, event) => cb(event)),

    /* 自由讨论 */
    onChatHistory: (cb) => ipcRenderer.on('chat:history', (_e, h) => cb(h)),
    onChatSessions: (cb) => ipcRenderer.on('chat:sessions', (_e, data) => cb(data)),
    onChatEvent: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
    chatSend: (text) => ipcRenderer.invoke('chat:send', text),
    chatNewSession: () => ipcRenderer.invoke('chat:new'),
    chatAbort: () => ipcRenderer.invoke('chat:abort'),
    chatRestart: () => ipcRenderer.invoke('chat:restart'),
    chatGetHistory: () => ipcRenderer.invoke('chat:getHistory'),
    chatGetState: () => ipcRenderer.invoke('chat:getState'),
    chatListSessions: () => ipcRenderer.invoke('chat:listSessions'),
    chatSwitchSession: (sessionId) => ipcRenderer.invoke('chat:switchSession', sessionId),

    /* pi 设置：provider/model */
    settingsGet: () => ipcRenderer.invoke('settings:get'),
    settingsListModels: () => ipcRenderer.invoke('settings:listModels'),
    settingsGetCurrentModel: () => ipcRenderer.invoke('settings:getCurrentModel'),
    settingsSetModel: (provider, modelId) => ipcRenderer.invoke('settings:setModel', { provider, modelId }),

    /* API Key（写 pi 自己的 auth.json，跟终端共享） */
    authGetStatus: (providerIds) => ipcRenderer.invoke('auth:getStatus', providerIds),
    authSetKey: (providerId, key) => ipcRenderer.invoke('auth:setKey', { providerId, key }),
    authDeleteKey: (providerId) => ipcRenderer.invoke('auth:deleteKey', { providerId }),
    /* 动态 Provider 目录与凭证状态（与 Pi TUI 同源，来自 ModelRuntime） */
    authListProviders: () => ipcRenderer.invoke('auth:listProviders'),
    authListOAuthProviders: () => ipcRenderer.invoke('auth:listOAuthProviders'),
    authOAuthStart: (providerId) => ipcRenderer.invoke('auth:oauthStart', { providerId }),
    authOAuthSubmit: (providerId, token, value) => ipcRenderer.invoke('auth:oauthSubmit', { providerId, token, value }),
    authOAuthCancel: (providerId) => ipcRenderer.invoke('auth:oauthCancel', { providerId }),
    onAuthOAuthEvent: (cb) => ipcRenderer.on('auth:oauthEvent', (_e, event) => cb(event)),

    /* 通用业务凭证（设置页「其他」等 tab；由内容层注册 schema，渲染层只见状态） */
    credentialStatus: () => ipcRenderer.invoke('credential:status'),
    credentialSet: (id, value) => ipcRenderer.invoke('credential:set', { id, value }),
    credentialClear: (id) => ipcRenderer.invoke('credential:clear', { id }),
    credentialAction: (id, actionId, value) => ipcRenderer.invoke('credential:action', { id, actionId, value }),
    onCredentialEvent: (cb) => ipcRenderer.on('credential:event', (_e, event) => cb(event)),

    /* 飞书 / Lark 桥接管理（通用） */
    feishuStatus: () => ipcRenderer.invoke('feishu:status'),
    feishuSetupByQr: (input) => ipcRenderer.invoke('feishu:setupByQr', input),
    feishuSaveConfig: (input) => ipcRenderer.invoke('feishu:saveConfig', input),
    feishuCommand: (command) => ipcRenderer.invoke('feishu:command', command),
    onFeishuEvent: (cb) => ipcRenderer.on('feishu:event', (_e, event) => cb(event)),

    /* 数据目录（通用数据根；choose/set 由内容层提供，缺失时渲染层隐藏对应按钮） */
    dataRootGet: () => ipcRenderer.invoke('dataRoot:get'),
    dataRootChoose: () => ipcRenderer.invoke('dataRoot:choose'),
    dataRootSet: (dir) => ipcRenderer.invoke('dataRoot:set', dir),

  };
}

module.exports = { coreWorkbenchBridge };
