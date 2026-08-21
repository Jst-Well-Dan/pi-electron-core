const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { SessionCatalog, summarizeSessionFile } = require('../src/session-catalog');
const { ChatSessionManager, normalizeMessages } = require('../src/chat-session');
const { registerCoreIpc, registerCoreSettingsIpc } = require('../electron/main-app');

function writeSession(dir, fileName, entries) {
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return file;
}

test('both production shells expose the shared history and contextual composer controls', () => {
  const coreHtml = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'index.html'), 'utf8');
  const appHtmlPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  const htmls = [coreHtml];
  if (fs.existsSync(appHtmlPath)) htmls.push(fs.readFileSync(appHtmlPath, 'utf8'));
  for (const html of htmls) {
    assert.match(html, /id="btn-chat-history"[^>]*aria-controls="chat-history-panel"/);
    assert.match(html, /id="btn-chat-send"[^>]*aria-label="发送"/);
    assert.doesNotMatch(html, /id="btn-chat-abort"/);
  }
});

test('SessionCatalog builds a JSON index and exposes safe session summaries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);

  writeSession(sessionDir, 'older.jsonl', [
    { type: 'session', version: 3, id: 'older-id', timestamp: '2026-01-01T00:00:00.000Z', cwd: root },
    { type: 'session_info', id: 'a1', parentId: null, timestamp: '2026-01-01T00:00:00.100Z', name: 'pi agent 会话' },
    { type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'First useful prompt' } },
    { type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-test', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } },
  ]);
  writeSession(sessionDir, 'newer.jsonl', [
    { type: 'session', version: 3, id: 'newer-id', timestamp: '2026-01-02T00:00:00.000Z', cwd: root },
    { type: 'session_info', id: 'b1', parentId: null, timestamp: '2026-01-02T00:00:01.000Z', name: 'Named session' },
    { type: 'message', id: 'b2', parentId: 'b1', timestamp: '2026-01-02T00:00:02.000Z', message: { role: 'user', content: 'Second prompt' } },
  ]);

  const indexPath = path.join(root, 'sessions-index.json');
  const catalog = new SessionCatalog({ sessionDir, indexPath, projectRoot: root });
  const sessions = catalog.list('older-id');

  assert.deepEqual(sessions.map((session) => session.id), ['newer-id', 'older-id']);
  assert.equal(sessions[0].title, 'Named session');
  assert.equal(sessions[1].title, 'First useful prompt');
  assert.equal(sessions[1].active, true);
  assert.equal(sessions[1].model.id, 'gpt-test');
  assert.equal('fileName' in sessions[0], false);
  assert.equal('sessionPath' in sessions[0], false);

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.version, 1);
  assert.equal(index.sessions.length, 2);
  catalog.list('older-id');
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).generatedAt, index.generatedAt);
  assert.equal(catalog.find('newer-id').sessionPath, path.join(sessionDir, 'newer.jsonl'));
  assert.equal(catalog.find('../outside'), null);
});

test('summarizeSessionFile ignores an incomplete trailing JSONL record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'partial.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id: 'partial-id', timestamp: '2026-02-01T00:00:00.000Z', cwd: root }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-02-01T00:00:01.000Z', message: { role: 'user', content: 'Readable title' } }),
    '{"type":"message"',
  ].join('\n'), 'utf8');

  const summary = summarizeSessionFile(file);
  assert.equal(summary.id, 'partial-id');
  assert.equal(summary.title, 'Readable title');
  assert.equal(summary.messageCount, 1);
});

test('normalizeMessages correlates tool results and keeps assistant run metadata', () => {
  const messages = normalizeMessages([
    { role: 'user', content: 'Run it', timestamp: 1 },
    {
      role: 'assistant',
      timestamp: 2,
      provider: 'openai',
      model: 'gpt-test',
      stopReason: 'toolUse',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      content: [
        { type: 'thinking', thinking: 'Need a tool' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
      ],
    },
    {
      role: 'toolResult',
      timestamp: 3,
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text: '/tmp/project' }],
    },
    {
      role: 'assistant',
      timestamp: 4,
      provider: 'openai',
      model: 'gpt-test',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Finished' }],
    },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[1].thinking, 'Need a tool');
  assert.equal(messages[1].toolCalls[0].output, '/tmp/project');
  assert.equal(messages[1].toolCalls[0].stateClass, 'done');
  assert.equal(messages[1].meta.model, 'gpt-test');
  assert.equal(messages[2].text, 'Finished');
});

test('normalizeMessages preserves failed tool results and semantic summaries', () => {
  const messages = normalizeMessages([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'bad-call', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'bad-call', toolName: 'read', isError: true, content: [{ type: 'text', text: 'denied' }] },
    { role: 'compactionSummary', summary: 'Earlier context summary', timestamp: 5 },
  ]);

  assert.equal(messages[0].toolCalls[0].stateClass, 'error');
  assert.equal(messages[0].toolCalls[0].stateLabel, '失败');
  assert.equal(messages[1].kind, 'summary');
  assert.equal(messages[1].text, 'Earlier context summary');
});

test('SessionCatalog rejects headerless and duplicate-header JSONL files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const headerless = path.join(root, 'headerless.jsonl');
  fs.writeFileSync(headerless, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'unsafe' } })}\n`);
  assert.throws(() => summarizeSessionFile(headerless), /会话头/);

  const duplicate = path.join(root, 'duplicate.jsonl');
  fs.writeFileSync(duplicate, [
    JSON.stringify({ type: 'session', version: 3, id: 'one', timestamp: '2026-01-01T00:00:00.000Z', cwd: root }),
    JSON.stringify({ type: 'session', version: 3, id: 'two', timestamp: '2026-01-01T00:00:01.000Z', cwd: root }),
  ].join('\n'));
  assert.throws(() => summarizeSessionFile(duplicate), /只能位于第一条/);
});

test('SessionCatalog migrates a session from a missing cwd without modifying the source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const missingCwd = path.join(root, 'removed-project');
  const source = writeSession(sessionDir, 'legacy.jsonl', [
    { type: 'session', version: 3, id: 'legacy-id', timestamp: '2026-01-01T00:00:00.000Z', cwd: missingCwd },
    { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'Move me' } },
  ]);
  const original = fs.readFileSync(source, 'utf8');
  const catalog = new SessionCatalog({ sessionDir, projectRoot: root });
  assert.equal(catalog.list(null)[0].needsMigration, true);

  const migrated = catalog.switchTarget('legacy-id');
  assert.notEqual(migrated.id, 'legacy-id');
  assert.equal(path.resolve(migrated.cwd), path.resolve(root));
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  const visible = catalog.list(migrated.id);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, migrated.id);
  assert.equal(visible[0].available, true);
});

test('migration drops an incomplete trailing fragment before future appends', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-truncated-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const source = path.join(sessionDir, 'legacy.jsonl');
  fs.writeFileSync(source, [
    JSON.stringify({ type: 'session', version: 3, id: 'legacy', timestamp: '2026-01-01T00:00:00.000Z', cwd: path.join(root, 'missing') }),
    JSON.stringify({ type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'before' } }),
    '{"type":"message"',
  ].join('\n'));
  const catalog = new SessionCatalog({ sessionDir, projectRoot: root });
  const migrated = catalog.switchTarget('legacy');
  fs.appendFileSync(migrated.sessionPath, `${JSON.stringify({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'after' } })}\n`);
  const summary = summarizeSessionFile(migrated.sessionPath);
  assert.equal(summary.userMessages, 2);
  assert.doesNotMatch(fs.readFileSync(migrated.sessionPath, 'utf8'), /\{"type":"message"\{"type"/);
});

test('continueTarget skips a newer foreign project and resumes the newest eligible local session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-continue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'sessions');
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(foreign);
  const localFile = writeSession(sessionDir, 'local.jsonl', [
    { type: 'session', version: 3, id: 'local-id', timestamp: '2026-01-01T00:00:00.000Z', cwd: root },
    { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'local' } },
  ]);
  const foreignFile = writeSession(sessionDir, 'foreign.jsonl', [
    { type: 'session', version: 3, id: 'foreign-id', timestamp: '2026-01-02T00:00:00.000Z', cwd: foreign },
    { type: 'message', id: 'b1c2d3e4', parentId: null, timestamp: '2026-01-02T00:00:01.000Z', message: { role: 'user', content: 'foreign' } },
  ]);
  fs.utimesSync(localFile, new Date('2026-01-01'), new Date('2026-01-01'));
  fs.utimesSync(foreignFile, new Date('2026-01-02'), new Date('2026-01-02'));
  const catalog = new SessionCatalog({ sessionDir, projectRoot: root });
  assert.equal(catalog.continueTarget().id, 'local-id');
});

test('chat:new IPC preserves a manager cancellation result', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const oauthLoginManager = new EventEmitter();
  const chatSession = {
    newSession: async () => ({ cancelled: true }),
    send: async () => {}, abort: async () => {}, restart: async () => {}, getHistory: async () => ({}),
    getState: async () => ({}), listSessions: async () => ({}), switchSession: async () => ({}), ensureStarted: async () => {},
  };
  registerCoreIpc({ ipcMain, chatSession, piSettingsPath: 'unused.json', oauthLoginManager, piInstaller: {} });
  assert.equal(handlers.has('shell:openExternal'), true);
  await assert.rejects(() => handlers.get('shell:openExternal')(null, 'file:///tmp/nope'), /只允许打开/);
  assert.deepEqual(await handlers.get('chat:new')(), { ok: false, cancelled: true });
});

test('feishu QR setup restarts the gateway before returning', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const calls = [];
  const feishuManager = {
    on: () => {},
    getStatus: () => ({ configured: false }),
    setupByQr: async (input) => { calls.push(['setupByQr', input]); return { configured: true, appId: 'masked' }; },
    command: async (command) => { calls.push(['command', command]); return { ok: true, status: { configured: true, connected: true } }; },
    saveConfig: async () => ({}),
  };
  registerCoreSettingsIpc({ ipcMain, services: { feishuManager } });
  const result = await handlers.get('feishu:setupByQr')(null, { groupPolicy: 'mention' });
  assert.deepEqual(calls, [['setupByQr', { groupPolicy: 'mention' }], ['command', 'restart']]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.status, { configured: true, connected: true });
});

test('ChatSessionManager serializes prompt acceptance before a session switch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new ChatSessionManager({ projectRoot: root, sessionDir: path.join(root, 'sessions') });
  let streaming = false;
  const commands = [];
  manager.ensureStarted = async () => {};
  manager.catalog.switchTarget = () => ({ id: 'target', sessionPath: path.join(root, 'sessions', 'target.jsonl') });
  manager.client = {
    running: true,
    send: async (command) => {
      commands.push(command.type);
      if (command.type === 'prompt') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        streaming = true;
        return { accepted: true };
      }
      if (command.type === 'get_state') return { isStreaming: streaming, sessionId: 'current' };
      if (command.type === 'switch_session') return { cancelled: false };
      return {};
    },
  };

  const prompt = manager.send('hello');
  const sessionSwitch = manager.switchSession('target');
  await prompt;
  await assert.rejects(sessionSwitch, /Agent 工作中/);
  assert.equal(commands.includes('switch_session'), false);
});

test('ChatSessionManager serializes abort completion before a new session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-abort-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new ChatSessionManager({ projectRoot: root, sessionDir: path.join(root, 'sessions') });
  const order = [];
  manager.ensureStarted = async () => {};
  manager.client = {
    running: true,
    send: async (command) => {
      if (command.type === 'abort') {
        order.push('abort:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('abort:end');
        return {};
      }
      if (command.type === 'get_state') return { isStreaming: false, sessionId: 'new-id' };
      if (command.type === 'new_session') { order.push('new'); return { cancelled: false }; }
      return {};
    },
  };
  const abort = manager.abort();
  const newSession = manager.newSession();
  await Promise.all([abort, newSession]);
  assert.deepEqual(order, ['abort:start', 'abort:end', 'new']);
});

test('ChatSessionManager ignores events from a disposed RPC client', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-stale-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new ChatSessionManager({ projectRoot: root, sessionDir: path.join(root, 'sessions') });
  const oldClient = new EventEmitter();
  oldClient.running = true;
  const events = [];
  manager.on('chat:event', (event) => events.push(event));
  manager.client = oldClient;
  manager._forward(oldClient);
  manager.client = { running: true };
  oldClient.emit('event', { type: 'agent_start' });
  oldClient.emit('error', new Error('stale error'));
  oldClient.emit('exit', { code: 0 });
  assert.deepEqual(events, []);
});

test('normalizeMessages does not report orphaned tool calls as completed', () => {
  const [normal] = normalizeMessages([
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending', name: 'bash', arguments: {} }] },
  ]);
  const [aborted] = normalizeMessages([
    { role: 'assistant', stopReason: 'aborted', content: [{ type: 'toolCall', id: 'aborted', name: 'bash', arguments: {} }] },
  ]);
  assert.equal(normal.toolCalls[0].stateClass, 'pending');
  assert.equal(normal.toolCalls[0].stateLabel, '未完成');
  assert.equal(aborted.toolCalls[0].stateClass, 'error');
  assert.equal(aborted.toolCalls[0].stateLabel, '已中止');

  const [cancelledBash] = normalizeMessages([
    { role: 'bashExecution', command: 'sleep 10', output: '', cancelled: true, exitCode: undefined },
  ]);
  assert.equal(cancelledBash.toolCalls[0].stateClass, 'error');
  assert.equal(cancelledBash.toolCalls[0].stateLabel, '已中止');
});
