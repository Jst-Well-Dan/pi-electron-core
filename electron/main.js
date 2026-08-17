/**
 * main.js — pi-electron-core 独立运行入口。
 *
 * `npm start -- --cwd <项目目录>`：把指定目录当作 pi 子进程的 cwd（技能/AGENTS.md
 * 自动发现该目录下的内容），弹出聊天 + 设置窗口。不带 --cwd 时默认当前目录。
 *
 * 会话/本地偏好落盘在 `<项目目录>/.pi-electron-core/`（sessions + pi-settings.json），
 * 按项目区分、不影响 pi 自身的全局/项目配置。
 */
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { registerCoreIpc, registerCoreSettingsIpc, createChatSessionWithSettings } = require('./main-app');
const { CredentialStore } = require('../src/credential-store');
const { FeishuManager } = require('../src/feishu-bridge');

function parseCwdArg() {
  const idx = process.argv.indexOf('--cwd');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return process.cwd();
}

const PROJECT_ROOT = parseCwdArg();
const DATA_DIR = path.join(PROJECT_ROOT, '.pi-electron-core');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const PI_SETTINGS_PATH = path.join(DATA_DIR, 'pi-settings.json');

let mainWindow = null;
let chatSession = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: `pi-electron-core · ${path.basename(PROJECT_ROOT)}`,
    backgroundColor: '#f5f4ed',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 独立冒烟测试：CORE_SMOKE=1 时驱动聊天往返 + 设置页加载，截图后自动退出。
  // 必须在 loadFile 之前注册监听，避免本地页面加载过快导致错过 did-finish-load。
  if (process.env.CORE_SMOKE) {
    const js = (code) => mainWindow.webContents.executeJavaScript(code).catch((e) => 'JSERR:' + e.message);
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
          console.log('[core-smoke] renderer errors:', JSON.stringify(await js(`
            window.__wbErrors = [];
            window.addEventListener('error', (e) => window.__wbErrors.push('ERR: ' + e.message));
            window.__wbErrors
          `)));

          await js(`window.workbench.chatSend('只回复四个字：冒烟通过'); 'sent'`);
          let chatOk = false;
          for (let i = 0; i < 60; i++) {
            await sleep(2000);
            const text = await js(`(() => { const els = document.querySelectorAll('.bubble.assistant .markdown-body'); return els.length ? els[els.length-1].textContent : ''; })()`);
            if (String(text).includes('冒烟通过')) { chatOk = true; break; }
          }
          console.log('[core-smoke] chat round-trip ok:', chatOk);

          await js(`document.querySelector('#settings-trigger').click()`);
          await sleep(3000);
          const settingsFacts = await js(`(() => {
            const select = document.querySelector('#auth-provider-id');
            return {
              optionCount: document.querySelectorAll('#settings-model-list .model-item').length,
              currentTag: document.querySelector('#settings-current-tag')?.textContent,
              apiProviderCount: select ? select.options.length : -1,
              apiKeyTag: document.querySelector('#auth-key-tag')?.textContent,
              oauthTag: document.querySelector('#oauth-status-tag')?.textContent,
            };
          })()`);
          console.log('[core-smoke] settings facts:', JSON.stringify(settingsFacts));

          fs.writeFileSync(path.join(DATA_DIR, 'smoke.png'), (await mainWindow.webContents.capturePage()).toPNG());
          console.log('[core-smoke] screenshot saved:', path.join(DATA_DIR, 'smoke.png'));
        } catch (e) {
          console.error('[core-smoke] failed:', e.message);
        }
        app.quit();
      }, 5000);
    });
  }
}

app.whenReady().then(async () => {
  if (!process.argv.includes('--dev')) {
    Menu.setApplicationMenu(null);
  }
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const credentialStore = new CredentialStore({ file: path.join(DATA_DIR, 'credentials.json') });
  const feishuManager = new FeishuManager({ projectRoot: PROJECT_ROOT });
  const dataRoot = {
    get: () => ({ dataRoot: PROJECT_ROOT, appRoot: PROJECT_ROOT, isPackaged: app.isPackaged, configurable: false }),
  };

  chatSession = createChatSessionWithSettings({
    projectRoot: PROJECT_ROOT,
    sessionDir: SESSION_DIR,
    piSettingsPath: PI_SETTINGS_PATH,
    emitToRenderer: sendToRenderer,
  });

  registerCoreIpc({
    ipcMain,
    chatSession,
    piSettingsPath: PI_SETTINGS_PATH,
    emitToRenderer: sendToRenderer,
  });

  // 通用设置体系：业务凭证（应用注册 schema）、飞书桥接、数据目录
  registerCoreSettingsIpc({
    ipcMain,
    emitToRenderer: sendToRenderer,
    services: { credentialStore, feishuManager, dataRoot },
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try {
    if (chatSession) chatSession.dispose();
  } catch { /* ignore */ }
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
