/**
 * pages/chat.js — 常驻 Agent 聊天：消息气泡流 + 思考折叠 + 工具调用卡片。
 * 事件处理与历史快照逻辑不变，仅渲染结构对齐 checklist 组件。
 */
(function () {
  'use strict';
  const { $, el, truncate, autoscroll } = window.App;

  let messages = [];          // 渲染模型
  let current = null;         // 正在流式输出的 assistant 气泡
  let lastRenderAt = 0;
  let optSeq = 0;

  const container = () => $('#chat-messages');

  function scrollBottom() { autoscroll(container()); }

  /* ---------------- 渲染模型 ---------------- */

  function addMessage(msg) {
    if (!msg.toolCalls) msg.toolCalls = [];
    messages.push(msg);
    current = msg.role === 'assistant' ? msg : current;
    renderMessage(msg);
    scrollBottom();
  }

  function renderMessage(msg) {
    const row = el('div', `chat-message-row ${msg.role === 'assistant' ? 'agent' : 'user'}`);
    const bubble = el('div', msg.role === 'assistant' ? 'agent-bubble' : 'user-bubble');
    bubble.dataset.id = msg.id;

    if (msg.ts) {
      const meta = el('div', 'message-time-meta', window.App.fmtTime(msg.ts));
      row.appendChild(meta);
    }

    const body = el('div', 'markdown-body');
    bubble.appendChild(body);
    row.appendChild(bubble);
    container().appendChild(row);

    msg._el = { row, bubble, body };
    refreshBubbleBody(msg);
  }

  function refreshBubbleBody(msg) {
    if (!msg._el) return;
    const html = MD.render(msg.text);
    if (msg._el.body.innerHTML !== html) msg._el.body.innerHTML = html;
    msg._el.bubble.classList.toggle('streaming', !!msg.streaming);

    // 流式光标：流式输出时在正文末尾追加紫色光标
    let cursor = msg._el.body.querySelector('.stream-cursor');
    if (msg.streaming) {
      if (!cursor) {
        cursor = el('span', 'stream-cursor');
        msg._el.body.appendChild(cursor);
      }
    } else if (cursor) {
      cursor.remove();
    }

    renderThinking(msg);
    renderToolCalls(msg);
  }

  function renderThinking(msg) {
    if (!msg._el) return;
    const bubble = msg._el.bubble;
    let box = bubble.querySelector('.thinking-accordion');
    if (!msg.thinking) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = el('div', 'thinking-accordion');
      const header = el('div', 'thinking-header', '思考过程');
      const caret = el('span', '', '▸');
      header.appendChild(caret);
      const body = el('div', 'thinking-body');
      body.hidden = true;
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        caret.textContent = body.hidden ? '▸' : '▾';
      });
      box.append(header, body);
      // 放在正文之前
      bubble.insertBefore(box, msg._el.body);
    }
    const body = box.querySelector('.thinking-body');
    body.textContent = msg.thinking;
  }

  function renderToolCalls(msg) {
    if (!msg._el) return;
    const bubble = msg._el.bubble;
    bubble.querySelectorAll('.tool-call-card').forEach((n) => n.remove());
    for (const tc of msg.toolCalls || []) {
      const card = el('div', 'tool-call-card');
      const header = el('div', 'tool-call-header');
      const nameTag = el('span', 'tool-name-tag');
      const glyph = el('span', '', tc.stateClass === 'running' ? '●' : tc.stateClass === 'error' ? '✗' : '✓');
      nameTag.appendChild(glyph);
      nameTag.appendChild(document.createTextNode(tc.name || 'tool'));
      nameTag.appendChild(el('span', 't-args', truncate(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}), 120)));
      const state = el('span', `tool-status-tag ${tc.stateClass}`, tc.stateLabel);
      header.append(nameTag, state);
      const body = el('div', 'tool-call-body');
      body.textContent = truncate(tc.output || '(无输出)', 4000);
      body.hidden = !tc.expanded;
      header.addEventListener('click', () => {
        tc.expanded = !tc.expanded;
        body.hidden = !tc.expanded;
      });
      card.append(header, body);
      bubble.appendChild(card);
    }
  }

  /* ---------------- 事件处理 ---------------- */

  function handleEvent(ev) {
    switch (ev.kind) {
      case 'delta': {
        if (!current) {
          current = { id: 'm' + Date.now(), role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true, ts: Date.now() };
          messages.push(current);
          renderMessage(current);
        }
        if (ev.deltaType === 'text_delta') {
          current.text += ev.delta;
          current.streaming = true;
        } else if (ev.deltaType === 'thinking_delta') {
          current.thinking += ev.delta;
        }
        const now = Date.now();
        if (now - lastRenderAt > 60) {
          lastRenderAt = now;
          refreshBubbleBody(current);
          scrollBottom();
        }
        break;
      }
      case 'message_done': {
        if (current) {
          current.streaming = false;
          lastRenderAt = 0;
          refreshBubbleBody(current);
          scrollBottom();
        }
        break;
      }
      case 'user_message': {
        const pending = [...messages].reverse().find((m) => m.role === 'user' && m._unconfirmed);
        if (pending) {
          pending._unconfirmed = false;
          if (pending._el) pending._el.bubble.classList.remove('streaming');
        } else {
          addMessage({ id: 'u' + Date.now(), role: 'user', text: ev.text || '', ts: Date.now() });
        }
        break;
      }
      case 'tool_start': {
        if (!current) current = { id: 'm' + Date.now(), role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true, ts: Date.now() };
        current.toolCalls.push({
          id: ev.toolCallId, name: ev.toolName, args: ev.args || {},
          output: '', stateClass: 'running', stateLabel: '运行中', expanded: false,
        });
        refreshBubbleBody(current);
        scrollBottom();
        break;
      }
      case 'tool_update': {
        const tc = findTool(ev.toolCallId);
        if (tc && ev.text) tc.output = ev.text.slice(-3000);
        break;
      }
      case 'tool_end': {
        const tc = findTool(ev.toolCallId);
        if (tc) {
          tc.output = (ev.text || tc.output || '').slice(-3000);
          tc.stateClass = ev.isError ? 'error' : 'done';
          tc.stateLabel = ev.isError ? '失败' : '完成';
          refreshBubbleBody(current);
        }
        break;
      }
      case 'agent_start':
        setStatus('Agent 工作中…');
        break;
      case 'agent_settled':
        setStatus('已就绪');
        if (current) { current.streaming = false; refreshBubbleBody(current); }
        current = null;
        scrollBottom();
        break;
      case 'message_error':
        setStatus(`消息异常：${ev.reason || ''}`);
        if (current) { current.streaming = false; refreshBubbleBody(current); }
        break;
      case 'status':
        setStatus(ev.text || '…');
        break;
      case 'error':
        setStatus(`⚠ ${ev.text || '未知错误'}`);
        break;
      default:
        break;
    }
  }

  function findTool(id) {
    if (!current) return null;
    return current.toolCalls.find((tc) => tc.id === id);
  }

  function setStatus(text) {
    const badge = $('#chat-session-tag');
    if (badge) badge.textContent = text;
  }

  /* ---------------- 输入 ---------------- */

  async function send() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.focus();
    addMessage({ id: 'opt-' + (++optSeq), role: 'user', text, ts: Date.now(), _unconfirmed: true });
    current = null;
    try {
      await window.workbench.chatSend(text);
    } catch (e) {
      setStatus(`⚠ 发送失败：${e.message}`);
    }
  }

  function confirmNewSession() {
    return window.confirm('开启新对话？当前会话内容会保留在会话文件中，可在下次启动时继续。');
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    window.workbench.onChatEvent(handleEvent);

    let historyReceived = false;
    const rebuildHistory = (h) => {
      historyReceived = true;
      messages = [];
      current = null;
      container().innerHTML = '';
      if (h && Array.isArray(h.messages)) {
        h.messages.forEach((m) => {
          messages.push({
            id: 'h' + (++optSeq), role: m.role, text: m.text || '', thinking: m.thinking || '',
            toolCalls: (m.toolCalls || []).map((tc) => ({
              id: tc.id, name: tc.name, args: tc.args || {}, output: tc.output || '', stateClass: 'done', stateLabel: '', expanded: false,
            })),
            streaming: false, ts: m.ts || Date.now(),
          });
        });
        messages.forEach(renderMessage);
        scrollBottom();
      }
    };

    window.workbench.onChatHistory((h) => { if (!historyReceived) rebuildHistory(h); });
    window.workbench.chatGetHistory().then((h) => { if (!historyReceived) rebuildHistory(h); }).catch(() => {});

    const input = $('#chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    $('#btn-chat-send').addEventListener('click', send);
    $('#btn-chat-new').addEventListener('click', async () => {
      if (!confirmNewSession()) return;
      try {
        await window.workbench.chatNewSession();
        messages = [];
        current = null;
        container().innerHTML = '';
        setStatus('新对话已开启');
      } catch (e) {
        setStatus(`⚠ ${e.message}`);
      }
    });
    $('#btn-chat-abort').addEventListener('click', async () => {
      try { await window.workbench.chatAbort(); setStatus('已发送中止'); } catch { /* ignore */ }
    });
  }

  window.ChatPage = { init };
})();
