const { contextBridge } = require('electron');

let chatEvent = () => {};
let chatHistory = () => {};
let chatSessions = () => {};
let sent = 0;
let aborted = 0;
let newSessions = 0;

const sessions = [
  { id: 'current', title: 'Current session', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 2, active: true, available: true, model: { id: 'gpt-test' } },
  { id: 'archived', title: 'Archived session', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2, active: false, available: true, model: { id: 'gpt-old' } },
];

contextBridge.exposeInMainWorld('workbench', {
  onChatEvent: (callback) => { chatEvent = callback; },
  onChatHistory: (callback) => { chatHistory = callback; },
  onChatSessions: (callback) => { chatSessions = callback; },
  chatGetHistory: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    chatEvent({ kind: 'agent_start' });
    chatEvent({ kind: 'delta', deltaType: 'text_delta', delta: 'Live bootstrap reply' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { messages: [{ role: 'assistant', text: 'Ready', toolCalls: [], ts: 1 }], sessionId: 'current' };
  },
  chatGetState: async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { isStreaming: false, sessionId: 'current' };
  },
  chatListSessions: async () => ({ sessions }),
  chatSend: async () => {
    sent += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    chatEvent({ kind: 'agent_start' });
    return { ok: true };
  },
  chatAbort: async () => {
    aborted += 1;
    chatEvent({ kind: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  },
  chatNewSession: async () => {
    newSessions += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    chatHistory({ messages: [], sessionId: 'new' });
    return { ok: true, sessionId: 'new' };
  },
  chatSwitchSession: async (sessionId) => ({
    cancelled: false,
    sessionId,
    messages: [{ role: 'assistant', text: 'Archived answer', thinking: 'Archived thinking', toolCalls: [{ id: 'tool-1', name: 'read', args: { path: 'file.md' }, output: 'contents', stateClass: 'done', stateLabel: '完成' }], meta: { model: 'gpt-old', usage: { input: 2, output: 3 } }, ts: 2 }],
  }),
  chatRestart: async () => ({ ok: true }),
  piRuntimeStatus: async () => ({ available: true, message: 'ready' }),
  piInstall: async () => ({ ok: true }),
  onPiInstallProgress: () => {},
  settingsGet: async () => ({}),
  settingsListModels: async () => ({ models: [] }),
  settingsGetCurrentModel: async () => ({ model: null }),
  settingsSetModel: async () => ({}),
  authListProviders: async () => [],
  authListOAuthProviders: async () => [],
  authGetStatus: async () => ({}),
  authSetKey: async () => ({}),
  authDeleteKey: async () => ({}),
  authOAuthStart: async () => ({}),
  authOAuthSubmit: async () => ({}),
  authOAuthCancel: async () => ({}),
  onAuthOAuthEvent: () => {},
  credentialStatus: async () => [],
  credentialSet: async () => ({}),
  credentialClear: async () => ({}),
  credentialAction: async () => ({}),
  onCredentialEvent: () => {},
  feishuStatus: async () => ({}),
  feishuSetupByQr: async () => ({}),
  feishuSaveConfig: async () => ({}),
  feishuCommand: async () => ({}),
  onFeishuEvent: () => {},
  dataRootGet: async () => ({ dataRoot: '', configurable: false }),
  dataRootChoose: async () => null,
  dataRootSet: async () => ({}),
  openExternal: async () => {},
  __emitChat: (event) => chatEvent(event),
  __rendererSmokeState: () => ({ sent, aborted, newSessions }),
});
