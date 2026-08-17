/**
 * chat-session.js — 常驻 pi 会话（自由讨论 / 其它同进程消费者共用）
 *
 * 启动一个常驻 `pi --mode rpc --session-dir <dir> --continue` 子进程
 * （cwd = 项目根目录，.pi/skills/* 自动发现），关闭再打开会自动续接
 * 最近一次会话（--continue）。
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

class ChatSessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {string} opts.sessionDir 会话持久化目录
   * @param {string} [opts.name] RPC 子进程显示名（默认 "pi agent 会话"）
   * @param {(channel: string, payload: any) => void} [opts.emitToRenderer] 可选，缺省为 no-op
   */
  constructor(opts) {
    super();
    this.projectRoot = opts.projectRoot;
    this.sessionDir = opts.sessionDir;
    this.name = opts.name || 'pi agent 会话';
    this.emitToRenderer = opts.emitToRenderer || (() => {});
    this.client = null;
    this._history = [];
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
    if (this.running) return Promise.resolve();
    const client = new PiRpcClient({
      args: ['--session-dir', this.sessionDir, '--continue'],
      cwd: this.projectRoot,
      name: this.name,
    });
    this.client = client;
    this._forward(client);
    client.spawn();
    return new Promise((resolve, reject) => {
      client.once('error', reject);
      // 等待子进程就绪：get_state 成功即认为可用
      const tryState = (attempt) => {
        if (!client.running) { reject(new Error('pi 子进程已退出')); return; }
        client.send({ type: 'get_state' }, 10000)
          .then(async () => {
            client.removeListener('error', reject);
            this._history = await this._loadHistory();
            this._emit('chat:history', { messages: this._history });
            resolve();
          })
          .catch(() => {
            if (attempt < 5) setTimeout(() => tryState(attempt + 1), 1500);
            else reject(new Error('pi 会话就绪超时'));
          });
      };
      setTimeout(() => tryState(1), 1500);
    });
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
      this._emit('chat:event', { kind: 'error', text: err.message });
    });
    client.on('exit', (info) => {
      this._emit('chat:event', { kind: 'error', text: `pi 会话进程退出 (code=${info.code})，请重启应用` });
    });
  }

  async send(text) {
    if (!text || !text.trim()) return;
    await this.ensureStarted();
    const res = await this.client.send({ type: 'prompt', message: text });
    return res;
  }

  async newSession() {
    await this.ensureStarted();
    const res = await this.client.send({ type: 'new_session' }, 15000);
    this._history = [];
    this._emit('chat:history', { messages: [] });
    return res;
  }

  async abort() {
    if (!this.client) return;
    try {
      await this.client.send({ type: 'abort' }, 5000);
    } catch { /* ignore */ }
  }

  /** 保留 --continue 会话历史，但重启 Pi 进程以重新读取 auth.json / models.json。 */
  async restart() {
    await this.abort();
    this.dispose();
    await this.ensureStarted();
    return { ok: true };
  }

  /** 查询当前会话的最新消息（归一化后返回） */
  async getHistory() {
    try {
      if (this.client && this.client.running) {
        const data = await this.client.send({ type: 'get_messages' }, 15000);
        const msgs = normalizeMessages((data && data.messages) || []);
        this._history = msgs;
        return { messages: msgs };
      }
    } catch { /* fallthrough */ }
    return { messages: this._history };
  }

  dispose() {
    if (this.client) this.client.kill();
    this.client = null;
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

/** 把 get_messages 的 AgentMessage 归一化成渲染层用的结构 */
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const msg = m.message || m;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const content = msg.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
    const item = {
      role: msg.role,
      ts: m.timestamp || msg.timestamp || null,
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      thinking: blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'),
      toolCalls: blocks
        .filter((b) => b.type === 'toolCall')
        .map((b) => ({ id: b.id, name: b.name, args: b.arguments })),
    };
    if (item.text || item.thinking || item.toolCalls.length) out.push(item);
  }
  return out;
}

module.exports = { ChatSessionManager };
