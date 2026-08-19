/**
 * pages/chat.js — 常驻 Agent 聊天、历史会话、思考折叠与工具调用卡片。
 */
(function () {
  'use strict';
  const { $, el, truncate, autoscroll } = window.App;

  let messages = [];
  let current = null;
  let lastRenderAt = 0;
  let optSeq = 0;
  let running = false;
  let controlsReady = false;
  let promptPending = false;
  let stopRequested = false;
  let sessionPending = false;
  let runEpoch = 0;
  let sessions = [];
  let activeSessionId = null;
  let historyReturnFocus = null;

  const container = () => $('#chat-messages');
  const input = () => $('#chat-input');
  const sendButton = () => $('#btn-chat-send');

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
    if (msg.kind) row.classList.add(`message-${msg.kind}`);
    const bubble = el('div', msg.role === 'assistant' ? 'agent-bubble' : 'user-bubble');
    bubble.dataset.id = msg.id;

    if (msg.ts) row.appendChild(el('div', 'message-time-meta', window.App.fmtTime(msg.ts)));

    const body = el('div', 'markdown-body');
    bubble.appendChild(body);
    row.appendChild(bubble);
    container().appendChild(row);

    msg._el = { row, bubble, body };
    refreshBubbleBody(msg);
  }

  function refreshBubbleBody(msg) {
    if (!msg._el) return;
    const html = MD.render(msg.text || '');
    if (msg._el.body.innerHTML !== html) msg._el.body.innerHTML = html;
    msg._el.bubble.classList.toggle('streaming', !!msg.streaming);

    let cursor = msg._el.body.querySelector('.stream-cursor');
    if (msg.streaming) {
      if (!cursor) {
        cursor = el('span', 'stream-cursor');
        msg._el.body.appendChild(cursor);
      }
    } else if (cursor) cursor.remove();

    renderThinking(msg);
    renderToolCalls(msg);
    renderRunMeta(msg);
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
      const header = el('button', 'thinking-header', '思考过程');
      header.type = 'button';
      header.setAttribute('aria-expanded', 'false');
      const caret = el('span', '', '▸');
      header.appendChild(caret);
      const body = el('div', 'thinking-body');
      body.hidden = true;
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        caret.textContent = body.hidden ? '▸' : '▾';
        header.setAttribute('aria-expanded', String(!body.hidden));
      });
      box.append(header, body);
      bubble.insertBefore(box, msg._el.body);
    }
    box.querySelector('.thinking-body').textContent = msg.thinking;
  }

  function renderToolCalls(msg) {
    if (!msg._el) return;
    const bubble = msg._el.bubble;
    const focusedCard = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.tool-call-card')
      : null;
    const focusedToolId = focusedCard ? focusedCard.dataset.toolCallId : '';
    bubble.querySelectorAll('.tool-call-card').forEach((node) => node.remove());
    for (const tc of msg.toolCalls || []) {
      const card = el('div', 'tool-call-card');
      card.dataset.toolCallId = tc.id || '';
      const header = el('button', 'tool-call-header');
      header.type = 'button';
      header.setAttribute('aria-expanded', String(!!tc.expanded));
      const nameTag = el('span', 'tool-name-tag');
      const glyph = el('span', '', tc.stateClass === 'running' ? '●' : tc.stateClass === 'pending' ? '…' : tc.stateClass === 'error' ? '✗' : '✓');
      nameTag.appendChild(glyph);
      nameTag.appendChild(document.createTextNode(tc.name || 'tool'));
      nameTag.appendChild(el('span', 't-args', truncate(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}), 120)));
      const state = el('span', `tool-status-tag ${tc.stateClass || 'done'}`, tc.stateLabel || '完成');
      header.append(nameTag, state);
      const body = el('div', 'tool-call-body');
      body.textContent = truncate(tc.output || '(无输出)', 4000);
      body.hidden = !tc.expanded;
      header.addEventListener('click', () => {
        tc.expanded = !tc.expanded;
        body.hidden = !tc.expanded;
        header.setAttribute('aria-expanded', String(tc.expanded));
      });
      card.append(header, body);
      bubble.appendChild(card);
    }
    if (focusedToolId) {
      const replacement = Array.from(bubble.querySelectorAll('.tool-call-card'))
        .find((card) => card.dataset.toolCallId === focusedToolId);
      if (replacement) replacement.querySelector('.tool-call-header').focus({ preventScroll: true });
    }
  }

  function renderRunMeta(msg) {
    if (!msg._el) return;
    let node = msg._el.bubble.querySelector('.message-run-meta');
    const meta = msg.meta || {};
    const parts = [];
    if (meta.provider || meta.model) parts.push([meta.provider, meta.model].filter(Boolean).join('/'));
    const usage = meta.usage || {};
    const tokens = usage.totalTokens || ['input', 'output', 'cacheRead', 'cacheWrite']
      .map((key) => Number(usage[key]) || 0)
      .reduce((sum, value) => sum + value, 0);
    if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
    if (meta.stopReason && !['stop', 'toolUse'].includes(meta.stopReason)) parts.push(meta.stopReason);
    if (!parts.length) {
      if (node) node.remove();
      return;
    }
    if (!node) node = el('div', 'message-run-meta');
    node.textContent = parts.join(' · ');
    msg._el.bubble.appendChild(node);
  }

  /* ---------------- 历史会话 ---------------- */

  function fixedIcon(pathData) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathData}</svg>`;
  }

  function ensureHistoryUi() {
    const headerActions = $('.agent-header-actions');
    let button = $('#btn-chat-history');
    if (!button && headerActions) {
      button = el('button', 'icon-btn-sm');
      button.id = 'btn-chat-history';
      button.type = 'button';
      button.title = '历史会话';
      button.setAttribute('aria-label', '历史会话');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', 'chat-history-panel');
      button.innerHTML = fixedIcon('<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>');
      headerActions.insertBefore(button, $('#btn-chat-new'));
    }
    if (button) button.setAttribute('aria-controls', 'chat-history-panel');

    let panel = $('#chat-history-panel');
    if (!panel) {
      panel = el('section', 'agent-history-panel');
      panel.id = 'chat-history-panel';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '历史会话');
      const head = el('div', 'agent-history-head');
      const titleWrap = el('div');
      titleWrap.append(el('strong', '', '历史会话'), el('span', '', '选择会话后可继续交流'));
      const close = el('button', 'icon-btn-sm');
      close.id = 'btn-chat-history-close';
      close.type = 'button';
      close.title = '关闭历史会话';
      close.setAttribute('aria-label', '关闭历史会话');
      close.innerHTML = fixedIcon('<path d="M18 6 6 18M6 6l12 12"></path>');
      head.append(titleWrap, close);
      const list = el('div', 'agent-history-list');
      list.id = 'chat-history-list';
      panel.append(head, list);
      $('#agent-sidebar').appendChild(panel);
    }
    return { button, panel };
  }

  function setHistoryOpen(open) {
    const { button, panel } = ensureHistoryUi();
    if (open === !panel.hidden) return;
    if (open) historyReturnFocus = document.activeElement;
    panel.hidden = !open;
    if (button) button.setAttribute('aria-expanded', String(open));
    const messagesNode = container();
    const composer = $('.agent-input-container');
    if (messagesNode) messagesNode.inert = open;
    if (composer) composer.inert = open;
    const newButton = $('#btn-chat-new');
    if (newButton) newButton.disabled = open || running || !controlsReady;
    if (open) {
      loadSessions();
      $('#btn-chat-history-close').focus();
    } else if (historyReturnFocus && historyReturnFocus.focus) {
      historyReturnFocus.focus();
      historyReturnFocus = null;
    }
  }

  function renderSessions() {
    const list = $('#chat-history-list');
    if (!list) return;
    list.innerHTML = '';
    if (!sessions.length) {
      list.appendChild(el('div', 'agent-history-empty', '还没有历史会话'));
      return;
    }
    for (const session of sessions) {
      const item = el('button', `agent-history-item${session.active ? ' active' : ''}`);
      item.type = 'button';
      item.dataset.sessionId = session.id;
      item.disabled = running || (session.available === false && !session.needsMigration);
      const top = el('span', 'agent-history-item-top');
      top.append(el('strong', '', session.title || '新对话'));
      if (session.active) top.append(el('span', 'agent-history-active', '当前'));
      const details = [window.App.fmtTime(session.updatedAt), `${session.messageCount || 0} 条消息`];
      if (session.model && session.model.id) details.push(session.model.id);
      if (session.needsMigration) details.push('打开时迁移到当前项目');
      else if (session.unavailableReason) details.push(session.unavailableReason);
      item.append(top, el('span', 'agent-history-item-meta', details.join(' · ')));
      item.addEventListener('click', () => switchSession(session.id));
      list.appendChild(item);
    }
  }

  function applySessions(data) {
    sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
    const active = sessions.find((session) => session.active);
    if (active) activeSessionId = active.id;
    renderSessions();
  }

  async function loadSessions() {
    if (typeof window.workbench.chatListSessions !== 'function') return;
    const panel = $('#chat-history-panel');
    if (panel) panel.classList.add('loading');
    try {
      applySessions(await window.workbench.chatListSessions());
    } catch (error) {
      setStatus(`⚠ 历史会话读取失败：${error.message}`);
    } finally {
      if (panel) panel.classList.remove('loading');
    }
  }

  async function switchSession(sessionId) {
    if (running || sessionId === activeSessionId) {
      if (sessionId === activeSessionId) setHistoryOpen(false);
      return;
    }
    const panel = $('#chat-history-panel');
    if (panel) panel.classList.add('loading');
    try {
      const history = await window.workbench.chatSwitchSession(sessionId);
      if (history && !history.cancelled) {
        rebuildHistory(history);
        activeSessionId = history.sessionId || sessionId;
        setStatus('历史会话已载入');
        setHistoryOpen(false);
        await loadSessions();
      }
    } catch (error) {
      setStatus(`⚠ 无法切换会话：${error.message}`);
    } finally {
      if (panel) panel.classList.remove('loading');
    }
  }

  /* ---------------- 事件处理 ---------------- */

  function handleEvent(ev) {
    switch (ev.kind) {
      case 'delta': {
        if (!current) addMessage({ id: 'm' + Date.now(), role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true, ts: Date.now() });
        if (ev.deltaType === 'text_delta') {
          current.text += ev.delta;
          current.streaming = true;
        } else if (ev.deltaType === 'thinking_delta') current.thinking += ev.delta;
        const now = Date.now();
        if (now - lastRenderAt > 60) {
          lastRenderAt = now;
          refreshBubbleBody(current);
          scrollBottom();
        }
        break;
      }
      case 'message_done':
        if (current) {
          current.streaming = false;
          lastRenderAt = 0;
          refreshBubbleBody(current);
          scrollBottom();
        }
        break;
      case 'user_message': {
        const pending = [...messages].reverse().find((message) => message.role === 'user' && message._unconfirmed);
        if (pending) {
          pending._unconfirmed = false;
          if (pending._el) pending._el.bubble.classList.remove('streaming');
        } else addMessage({ id: 'u' + Date.now(), role: 'user', text: ev.text || '', ts: Date.now() });
        break;
      }
      case 'tool_start':
        if (!current) addMessage({ id: 'm' + Date.now(), role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true, ts: Date.now() });
        current.toolCalls.push({
          id: ev.toolCallId, name: ev.toolName, args: ev.args || {},
          output: '', stateClass: 'running', stateLabel: '运行中', expanded: false,
        });
        refreshBubbleBody(current);
        scrollBottom();
        break;
      case 'tool_update': {
        const tc = findTool(ev.toolCallId);
        if (tc && ev.text) {
          tc.output = ev.text.slice(-3000);
          refreshBubbleBody(current);
        }
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
        runEpoch += 1;
        setRunning(true);
        setStatus('Agent 工作中…');
        break;
      case 'agent_settled':
        runEpoch += 1;
        promptPending = false;
        stopRequested = false;
        setRunning(false);
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
        runEpoch += 1;
        promptPending = false;
        stopRequested = false;
        setRunning(false);
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

  function updateSendButton() {
    const button = sendButton();
    if (!button) return;
    const textarea = input();
    const canSend = !!(textarea && textarea.value.trim());
    button.classList.toggle('is-stop', running);
    button.disabled = !controlsReady || (running ? stopRequested : !canSend);
    button.title = running ? (stopRequested ? '正在中止' : '中止当前回复') : '发送';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = running
      ? fixedIcon('<rect x="7" y="7" width="10" height="10" rx="1"></rect>')
      : fixedIcon('<path d="M12 19V5M5 12l7-7 7 7"></path>');
    if (textarea) textarea.disabled = !controlsReady;
    const historyButton = $('#btn-chat-history');
    if (historyButton) historyButton.disabled = !controlsReady;
    const newButton = $('#btn-chat-new');
    if (newButton) newButton.disabled = !controlsReady || running || sessionPending || !$('#chat-history-panel').hidden;
    renderSessions();
  }

  function setRunning(value) {
    running = !!value;
    updateSendButton();
  }

  async function send() {
    const textarea = input();
    const text = textarea.value.trim();
    if (!controlsReady || !text || running) return;
    textarea.value = '';
    textarea.focus();
    updateSendButton();
    addMessage({ id: 'opt-' + (++optSeq), role: 'user', text, ts: Date.now(), _unconfirmed: true });
    current = null;
    runEpoch += 1;
    promptPending = true;
    stopRequested = false;
    setRunning(true);
    try {
      await window.workbench.chatSend(text);
      promptPending = false;
      if (stopRequested) {
        stopRequested = false;
        await performAbort();
      } else updateSendButton();
    } catch (error) {
      runEpoch += 1;
      promptPending = false;
      stopRequested = false;
      setRunning(false);
      setStatus(`⚠ 发送失败：${error.message}`);
    }
  }

  async function performAbort() {
    stopRequested = true;
    updateSendButton();
    setStatus('正在中止…');
    try {
      await window.workbench.chatAbort();
    } catch (error) {
      stopRequested = false;
      setStatus(`⚠ 中止失败：${error.message}`);
      updateSendButton();
    }
  }

  async function abort() {
    if (!running || stopRequested) return;
    if (promptPending) {
      stopRequested = true;
      setStatus('提示提交后将立即中止…');
      updateSendButton();
      return;
    }
    await performAbort();
  }

  function sendOrAbort() {
    return running ? abort() : send();
  }

  function confirmNewSession() {
    return window.confirm('开启新对话？当前会话会保留在历史记录中。');
  }

  function rebuildHistory(history) {
    messages = [];
    current = null;
    container().innerHTML = '';
    activeSessionId = history && history.sessionId ? history.sessionId : activeSessionId;
    if (history && Array.isArray(history.messages)) {
      history.messages.forEach((message) => {
        messages.push({
          id: 'h' + (++optSeq), role: message.role, text: message.text || '', thinking: message.thinking || '',
          kind: message.kind || '', meta: message.meta || null,
          toolCalls: (message.toolCalls || []).map((tc) => ({
            id: tc.id, name: tc.name, args: tc.args || {}, output: tc.output || '',
            stateClass: tc.stateClass || 'done', stateLabel: tc.stateLabel || '完成', expanded: false,
          })),
          streaming: false, ts: message.ts || Date.now(),
        });
      });
      messages.forEach(renderMessage);
      scrollBottom();
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    const historyUi = ensureHistoryUi();
    const legacyAbort = $('#btn-chat-abort');
    if (legacyAbort) legacyAbort.remove();
    const button = sendButton();
    if (button) button.className = 'agent-send-button';

    window.workbench.onChatEvent(handleEvent);
    if (typeof window.workbench.onChatSessions === 'function') window.workbench.onChatSessions(applySessions);

    const bootstrapEpoch = runEpoch;
    let initialHistoryReceived = false;
    window.workbench.onChatHistory((history) => {
      initialHistoryReceived = true;
      if ((!controlsReady && runEpoch !== bootstrapEpoch) || (controlsReady && running)) return;
      rebuildHistory(history);
    });

    const historyPromise = window.workbench.chatGetHistory()
      .then((history) => {
        if (!initialHistoryReceived && runEpoch === bootstrapEpoch) rebuildHistory(history);
      })
      .catch(() => {});
    const statePromise = typeof window.workbench.chatGetState === 'function'
      ? window.workbench.chatGetState().catch(() => null)
      : Promise.resolve(null);

    const textarea = input();
    textarea.addEventListener('input', updateSendButton);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendOrAbort();
      }
    });
    button.addEventListener('click', sendOrAbort);

    if (historyUi.button) historyUi.button.addEventListener('click', () => setHistoryOpen(historyUi.panel.hidden));
    $('#btn-chat-history-close').addEventListener('click', () => setHistoryOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !historyUi.panel.hidden) {
        event.preventDefault();
        setHistoryOpen(false);
      }
    });

    $('#btn-chat-new').addEventListener('click', async () => {
      if (running || sessionPending || !confirmNewSession()) return;
      sessionPending = true;
      updateSendButton();
      try {
        const result = await window.workbench.chatNewSession();
        if (result && result.cancelled) {
          setStatus('新对话已取消');
          return;
        }
        rebuildHistory({ messages: [], sessionId: result && result.sessionId });
        setStatus('新对话已开启');
        await loadSessions();
      } catch (error) {
        setStatus(`⚠ ${error.message}`);
      } finally {
        sessionPending = false;
        updateSendButton();
      }
    });

    updateSendButton();
    Promise.all([historyPromise, statePromise]).then(([, state]) => {
      if (state && runEpoch === bootstrapEpoch) {
        activeSessionId = state.sessionId || activeSessionId;
        running = !!state.isStreaming;
      }
      controlsReady = true;
      updateSendButton();
      loadSessions();
    });
  }

  window.ChatPage = { init };
})();
