const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

async function main() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer-smoke-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await window.loadFile(path.join(__dirname, 'renderer-smoke.html'));

  const initial = await window.webContents.executeJavaScript(`(() => ({
    historyButton: !!document.querySelector('#btn-chat-history'),
    legacyAbort: !!document.querySelector('#btn-chat-abort'),
    sendDisabled: document.querySelector('#btn-chat-send').disabled,
    sendLabel: document.querySelector('#btn-chat-send').getAttribute('aria-label')
  }))()`);
  assert.equal(initial.historyButton, true);
  assert.equal(initial.legacyAbort, false);
  assert.equal(initial.sendDisabled, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const bootstrapLive = await window.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('#chat-messages').textContent,
    label: document.querySelector('#btn-chat-send').getAttribute('aria-label')
  }))()`);
  assert.match(bootstrapLive.text, /Live bootstrap reply/);
  assert.doesNotMatch(bootstrapLive.text, /Ready/);
  assert.equal(bootstrapLive.label, '中止当前回复');
  await window.webContents.executeJavaScript(`window.workbench.__emitChat({ kind: 'agent_settled' })`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const running = await window.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#chat-input');
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btn-chat-send').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      isStop: document.querySelector('#btn-chat-send').classList.contains('is-stop'),
      label: document.querySelector('#btn-chat-send').getAttribute('aria-label'),
      sent: window.workbench.__rendererSmokeState().sent
    };
  })()`);
  assert.deepEqual(running, { isStop: true, label: '中止当前回复', sent: 1 });

  const queuedStop = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-chat-send').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      aborted: window.workbench.__rendererSmokeState().aborted,
      label: document.querySelector('#btn-chat-send').getAttribute('aria-label')
    };
  })()`);
  assert.deepEqual(queuedStop, { aborted: 0, label: '正在中止' });

  await new Promise((resolve) => setTimeout(resolve, 100));
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-chat-history').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  })()`);
  const history = await window.webContents.executeJavaScript(`(() => ({
    aborted: window.workbench.__rendererSmokeState().aborted,
    panelHidden: document.querySelector('#chat-history-panel').hidden,
    itemCount: document.querySelectorAll('.agent-history-item').length,
    activeCount: document.querySelectorAll('.agent-history-item.active').length,
    focusId: document.activeElement.id,
    status: document.querySelector('#chat-session-tag').textContent
  }))()`);
  assert.deepEqual(history, { aborted: 1, panelHidden: false, itemCount: 2, activeCount: 1, focusId: 'btn-chat-history-close', status: '已就绪' });

  const escaped = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#btn-chat-history').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return document.querySelector('#chat-history-panel').hidden;
  })()`);
  assert.equal(escaped, true);
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-chat-history').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  })()`);

  const switched = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-session-id="archived"]').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      panelHidden: document.querySelector('#chat-history-panel').hidden,
      text: document.querySelector('#chat-messages').textContent,
      tools: document.querySelectorAll('.tool-call-card').length,
      meta: document.querySelector('.message-run-meta')?.textContent || ''
    };
  })()`);
  assert.equal(switched.panelHidden, true);
  assert.match(switched.text, /Archived answer/);
  assert.equal(switched.tools, 1);
  assert.match(switched.meta, /gpt-old/);

  const newSessionPending = await window.webContents.executeJavaScript(`(async () => {
    window.confirm = () => true;
    const button = document.querySelector('#btn-chat-new');
    button.click();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { disabled: button.disabled, count: window.workbench.__rendererSmokeState().newSessions };
  })()`);
  assert.deepEqual(newSessionPending, { disabled: true, count: 1 });
  await new Promise((resolve) => setTimeout(resolve, 90));
  const newSessionDone = await window.webContents.executeJavaScript(`(() => ({
    disabled: document.querySelector('#btn-chat-new').disabled,
    count: window.workbench.__rendererSmokeState().newSessions
  }))()`);
  assert.deepEqual(newSessionDone, { disabled: false, count: 1 });

  const productionWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer-smoke-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await productionWindow.loadFile(path.join(__dirname, '..', 'electron', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const production = await productionWindow.webContents.executeJavaScript(`(() => ({
    historyButton: !!document.querySelector('#btn-chat-history[aria-controls="chat-history-panel"]'),
    historyPanel: !!document.querySelector('#chat-history-panel[role="dialog"]'),
    legacyAbort: !!document.querySelector('#btn-chat-abort'),
    contextualButton: document.querySelector('#btn-chat-send').classList.contains('agent-send-button')
  }))()`);
  assert.deepEqual(production, { historyButton: true, historyPanel: true, legacyAbort: false, contextualButton: true });
  productionWindow.destroy();
  window.destroy();
  console.log('renderer smoke passed');
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });
