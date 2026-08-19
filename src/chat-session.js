/**
 * chat-session.js — 常驻 pi 会话（自由讨论 / 其它同进程消费者共用）
 *
 * 启动一个常驻 `pi --mode rpc --session-dir <dir>` 子进程，并显式恢复目录中
 * 最近的安全会话（cwd = 项目根目录，.pi/skills/* 自动发现）。项目移动后会
 * 以非破坏性兼容副本恢复，不直接修改原始 JSONL。
 *
 * 与按钮任务的一次性子进程完全独立，互不共享会话。
 *
 * 事件双 sink：每次内部状态变化会同时 (1) 调用 opts.emitToRenderer（给 Electron
 * 渲染进程用）(2) 通过自身 EventEmitter 的 emit() 广播（给同进程内其它消费者用，
 * 它们和聊天页共享同一个 ChatSessionManager 实例，靠这条口子拿到同样的
 * message_update/agent_settled 事件流，不需要另开一个 pi 子进程）。
 * emitToRenderer 是可选的：无 Electron 窗口时（纯后台场景）传省略即可。
 */
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PiRpcClient } = require('./pi-rpc');
const { SessionCatalog } = require('./session-catalog');

class ChatSessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {string} opts.sessionDir 会话持久化目录
   * @param {string} [opts.name] 可选的 Pi 会话显示名
   * @param {(channel: string, payload: any) => void} [opts.emitToRenderer] 可选，缺省为 no-op
   */
  constructor(opts) {
    super();
    this.projectRoot = opts.projectRoot;
    this.sessionDir = opts.sessionDir;
    this.name = opts.name || '';
    this.emitToRenderer = opts.emitToRenderer || (() => {});
    this.client = null;
    this._history = [];
    this._starting = null;
    this._activeSessionId = null;
    this._operation = Promise.resolve();
    this.catalog = new SessionCatalog({ sessionDir: this.sessionDir, projectRoot: this.projectRoot });
  }

  /** 双 sink：Electron 渲染进程 + 同进程内其它订阅者 */
  _emit(channel, payload) {
    this.emitToRenderer(channel, payload);
    this.emit(channel, payload);
  }

  get running() {
    return !!this.client && this.client.running;
  }

  ensureStarted() {
    if (this._starting) return this._starting;
    if (this.running) return Promise.resolve();
    const resume = this.catalog.continueTarget();
    const args = ['--session-dir', this.sessionDir];
    if (resume) args.push('--session', resume.sessionPath);
    const client = new PiRpcClient({
      args,
      cwd: this.projectRoot,
      name: this.name,
    });
    this.client = client;
    this._forward(client);
    client.spawn();
    this._starting = new Promise((resolve, reject) => {
      client.once('error', reject);
      // 等待子进程就绪：get_state 成功即认为可用
      const tryState = (attempt) => {
        if (!client.running) { reject(new Error('pi 子进程已退出')); return; }
        client.send({ type: 'get_state' }, 10000)
          .then(async (state) => {
            client.removeListener('error', reject);
            this._activeSessionId = state.sessionId || null;
            this._history = await this._loadHistory();
            this._emit('chat:history', { messages: this._history, sessionId: this._activeSessionId });
            this._emitSessionList();
            resolve();
          })
          .catch(() => {
            if (attempt < 5) setTimeout(() => tryState(attempt + 1), 1500);
            else reject(new Error('pi 会话就绪超时'));
          });
      };
      setTimeout(() => tryState(1), 1500);
    }).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  _emitSessionList() {
    try {
      this._emit('chat:sessions', { sessions: this.catalog.list(this._activeSessionId) });
    } catch (error) {
      this._emit('chat:event', { kind: 'error', text: `会话索引更新失败：${error.message}` });
    }
  }

  _runExclusive(operation) {
    const run = this._operation.then(operation, operation);
    this._operation = run.catch(() => {});
    return run;
  }

  async _loadHistory() {
    try {
      const data = await this.client.send({ type: 'get_messages' }, 15000);
      return normalizeMessages((data && data.messages) || []);
    } catch {
      return [];
    }
  }

  _forward(client) {
    client.on('event', (ev) => {
      if (client !== this.client) return;
      const t = ev.type;
      switch (t) {
        case 'message_update': {
          const d = ev.assistantMessageEvent;
          if (!d) return;
          if (['text_delta', 'thinking_delta'].includes(d.type)) {
            this._emit('chat:event', { kind: 'delta', deltaType: d.type, delta: d.delta || '', contentIndex: d.contentIndex });
          } else if (d.type === 'done') {
            this._emit('chat:event', { kind: 'message_done' });
          } else if (d.type === 'error') {
            this._emit('chat:event', { kind: 'message_error', reason: d.reason });
          }
          break;
        }
        case 'message_end': {
          const msg = ev.message || {};
          if (msg.role === 'user') {
            this._emit('chat:event', { kind: 'user_message', text: textOf(msg.content) });
          }
          break;
        }
        case 'tool_execution_start':
          this._emit('chat:event', {
            kind: 'tool_start', toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args,
          });
          break;
        case 'tool_execution_update':
          this._emit('chat:event', {
            kind: 'tool_update', toolCallId: ev.toolCallId, text: extractText(ev.partialResult),
          });
          break;
        case 'tool_execution_end':
          this._emit('chat:event', {
            kind: 'tool_end', toolCallId: ev.toolCallId, isError: ev.isError, text: extractText(ev.result),
          });
          break;
        case 'bash_execution_update':
          // bash 的 stdout/stderr 可能在工具结束前持续流出；同时转发给事件订阅者。
          this._emit('chat:event', {
            kind: 'bash', toolCallId: ev.toolCallId, text: ev.delta || '',
          });
          break;
        case 'agent_start':
          this._emit('chat:event', { kind: 'agent_start' });
          break;
        case 'agent_end':
          if (ev.willRetry) this._emit('chat:event', { kind: 'status', text: '自动重试中…' });
          break;
        case 'agent_settled':
          this._emit('chat:event', { kind: 'agent_settled' });
          this._emitSessionList();
          break;
        case 'compaction_start':
          this._emit('chat:event', { kind: 'status', text: '上下文压缩中…' });
          break;
        case 'auto_retry_start':
          this._emit('chat:event', { kind: 'status', text: `自动重试 (${ev.attempt}/${ev.maxAttempts})…` });
          break;
        default:
          break;
      }
    });

    client.on('error', (err) => {
      if (client !== this.client) return;
      this._emit('chat:event', { kind: 'error', text: err.message });
    });
    client.on('exit', (info) => {
      if (client !== this.client) return;
      this._emit('chat:event', { kind: 'error', text: `pi 会话进程退出 (code=${info.code})，请重启应用` });
    });
  }

  async send(text) {
    if (!text || !text.trim()) return;
    return this._runExclusive(async () => {
      await this.ensureStarted();
      return this.client.send({ type: 'prompt', message: text });
    });
  }

  async newSession() {
    return this._runExclusive(async () => {
      await this.ensureStarted();
      const state = await this.client.send({ type: 'get_state' }, 10000);
      if (state.isStreaming) throw new Error('Agent 工作中，无法开启新对话');
      const res = await this.client.send({ type: 'new_session' }, 15000);
      if (res && res.cancelled) return res;
      const nextState = await this.client.send({ type: 'get_state' }, 10000);
      this._activeSessionId = nextState.sessionId || null;
      this._history = [];
      this._emit('chat:history', { messages: [], sessionId: this._activeSessionId });
      this._emitSessionList();
      return { ...(res || {}), sessionId: this._activeSessionId };
    });
  }

  async listSessions() {
    await this.ensureStarted();
    const state = await this.client.send({ type: 'get_state' }, 10000);
    this._activeSessionId = state.sessionId || null;
    return { sessions: this.catalog.list(this._activeSessionId) };
  }

  async switchSession(sessionId) {
    return this._runExclusive(async () => {
      await this.ensureStarted();
      const state = await this.client.send({ type: 'get_state' }, 10000);
      if (state.isStreaming) throw new Error('Agent 工作中，无法切换历史会话');
      const target = this.catalog.switchTarget(sessionId);
      if (!target) throw new Error('历史会话不存在或已被移除');
      const res = await this.client.send({ type: 'switch_session', sessionPath: target.sessionPath }, 15000);
      if (res && res.cancelled) return { cancelled: true };
      const nextState = await this.client.send({ type: 'get_state' }, 10000);
      this._activeSessionId = nextState.sessionId || target.id;
      this._history = await this._loadHistory();
      const history = { messages: this._history, sessionId: this._activeSessionId };
      this._emit('chat:history', history);
      this._emitSessionList();
      return { cancelled: false, ...history };
    });
  }

  async getState() {
    await this.ensureStarted();
    const state = await this.client.send({ type: 'get_state' }, 10000);
    this._activeSessionId = state.sessionId || null;
    return {
      isStreaming: !!state.isStreaming,
      sessionId: this._activeSessionId,
      sessionName: state.sessionName || '',
    };
  }

  async _abortUnlocked() {
    if (!this.client) return;
    try {
      await this.client.send({ type: 'abort' }, 5000);
    } catch { /* ignore */ }
  }

  async abort() {
    return this._runExclusive(() => this._abortUnlocked());
  }

  /** 保留最近会话历史，但重启 Pi 进程以重新读取 auth.json / models.json。 */
  async restart() {
    return this._runExclusive(async () => {
      await this._abortUnlocked();
      this.dispose();
      await this.ensureStarted();
      return { ok: true };
    });
  }

  /** 查询当前会话的最新消息（归一化后返回） */
  async getHistory() {
    return this._runExclusive(async () => {
      try {
        await this.ensureStarted();
        if (this.client && this.client.running) {
          const data = await this.client.send({ type: 'get_messages' }, 15000);
          const state = await this.client.send({ type: 'get_state' }, 10000);
          const msgs = normalizeMessages((data && data.messages) || []);
          this._history = msgs;
          this._activeSessionId = state.sessionId || null;
          return { messages: msgs, sessionId: this._activeSessionId };
        }
      } catch { /* fallthrough */ }
      return { messages: this._history, sessionId: this._activeSessionId };
    });
  }

  dispose() {
    if (this.client) this.client.kill();
    this.client = null;
    this._starting = null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function extractText(result) {
  if (!result) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b.text || b.thinking || ''))
      .join('');
  }
  return '';
}

/** 把 get_messages 的 AgentMessage 归一化成渲染层用的结构。 */
function normalizeMessages(messages) {
  const out = [];
  const toolCalls = new Map();

  for (const wrapped of messages) {
    const msg = wrapped.message || wrapped;
    const ts = wrapped.timestamp || msg.timestamp || null;
    const content = msg.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];

    if (msg.role === 'user' || msg.role === 'assistant') {
      const item = {
        role: msg.role,
        ts,
        text: blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n'),
        thinking: blocks.filter((block) => block.type === 'thinking').map((block) => block.thinking || '').join('\n'),
        toolCalls: blocks
          .filter((block) => block.type === 'toolCall')
          .map((block) => ({
            id: block.id,
            name: block.name,
            args: block.arguments || {},
            output: '',
            stateClass: msg.stopReason === 'aborted' ? 'error' : 'pending',
            stateLabel: msg.stopReason === 'aborted' ? '已中止' : '未完成',
          })),
        meta: msg.role === 'assistant' ? {
          provider: msg.provider || '',
          model: msg.model || '',
          usage: msg.usage || null,
          stopReason: msg.stopReason || '',
          errorMessage: msg.errorMessage || '',
        } : null,
      };
      if (!item.text && item.meta && item.meta.errorMessage) item.text = item.meta.errorMessage;
      for (const toolCall of item.toolCalls) toolCalls.set(toolCall.id, toolCall);
      if (item.text || item.thinking || item.toolCalls.length) out.push(item);
      continue;
    }

    if (msg.role === 'toolResult') {
      const toolCall = toolCalls.get(msg.toolCallId);
      if (toolCall) {
        toolCall.output = extractText(msg);
        toolCall.stateClass = msg.isError ? 'error' : 'done';
        toolCall.stateLabel = msg.isError ? '失败' : '完成';
      }
      continue;
    }

    if (msg.role === 'bashExecution') {
      out.push({
        role: 'assistant',
        ts,
        text: '',
        thinking: '',
        toolCalls: [{
          id: `bash-${ts || out.length}`,
          name: 'bash',
          args: { command: msg.command || '' },
          output: msg.output || '',
          stateClass: msg.cancelled || (msg.exitCode && msg.exitCode !== 0) ? 'error' : 'done',
          stateLabel: msg.cancelled ? '已中止' : (msg.exitCode && msg.exitCode !== 0 ? '失败' : '完成'),
        }],
      });
      continue;
    }

    if (msg.role === 'custom' && msg.display) {
      const text = textOf(msg.content);
      if (text) out.push({ role: 'assistant', ts, text, thinking: '', toolCalls: [], kind: 'custom' });
      continue;
    }

    if (msg.role === 'compactionSummary' || msg.role === 'branchSummary') {
      const summary = msg.summary || '';
      if (summary) out.push({ role: 'assistant', ts, text: summary, thinking: '', toolCalls: [], kind: 'summary' });
    }
  }
  return out;
}

module.exports = { ChatSessionManager, normalizeMessages };
