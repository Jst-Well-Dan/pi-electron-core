/**
 * src/cli/init.js — 在目标应用生成 desktop/ 脚手架。
 * 模板动态取自 core 自身：侧栏逐字提取、exports/资产断言先行，漂移即报错。
 */
const fs = require('node:fs');
const path = require('node:path');
const { coreRoot, corePkg, parseArgs, fillMissing, assertCoreApi, assertRendererAssets, extractSidebar, coreSettingsTabs, parseCredentials } = require('./util');

function credSchemaLines(creds) {
  return creds.map((c) => [
    `  credentialStore.registerSchema({`,
    `    id: '${c.id}', label: '${c.label}', description: '',`,
    `    input: 'password', placeholder: '', envName: '${c.env}', storeOverridesEnv: true,`,
    `  });`,
  ].join('\n')).join('\n');
}

function mainJs({ title, creds }) {
  return `/**
 * ${title} — 主进程（由 pi-electron-core CLI 生成）。
 * 业务 IPC _auth_ 写在 registerWorkbenchIpc()；通用能力全部走 core。
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { resolveDataRoot, setDataRoot, CredentialStore, FeishuManager } = require('pi-electron-core');
const { registerCoreIpc, registerCoreSettingsIpc, createChatSessionWithSettings } = require('pi-electron-core/electron/main-app');

// --cwd 显式优先；否则向上找含 package.json 的目录（兼容 desktop/ 下启动）
function parseCwdArg() {
  const i = process.argv.indexOf('--cwd');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && path.basename(dir) !== 'desktop') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd());
}
const PROJECT_ROOT = parseCwdArg();
const DATA_ROOT = resolveDataRoot({ devRoot: PROJECT_ROOT });
const DATA_DIR = path.join(DATA_ROOT, '.pi-electron-core');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const PI_SETTINGS_PATH = path.join(DATA_DIR, 'pi-settings.json');
const APP_SETTINGS_PATH = path.join(DATA_DIR, 'app-settings.json');

let mainWindow, chatSession, feishuManager, credentialStore;

// 必须在 app.whenReady 之前注册，渲染层 file:// 才能跨源请求 pi-core:// 的字体
protocol.registerSchemesAsPrivileged([{
  scheme: 'pi-core',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const sendToRenderer = (ch, payload) => {
  try { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(ch, payload); } catch {}
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, backgroundColor: '#f4f3ee', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.once('ready-to-show', () => { if (!process.argv.includes('--shot')) mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\\/\\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  if (process.argv.includes('--shot')) runShotSequence();
}

/* 测试截图：--shot --shot-dir <dir>，遍历业务页与设置各 tab 后退出 */
async function runShotSequence() {
  const idx = process.argv.indexOf('--shot-dir');
  const dir = idx >= 0 && process.argv[idx + 1] ? path.resolve(process.argv[idx + 1]) : path.join(PROJECT_ROOT, 'shot-output');
  fs.mkdirSync(dir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jsErrors = [];
  mainWindow.webContents.on('console-message', (_e, _lvl, msg) => { if (/error|uncaught|failed/i.test(msg)) jsErrors.push(msg.slice(0, 200)); });
  const js = (code) => mainWindow.webContents.executeJavaScript(code).catch((e) => 'JSERR:' + e.message);
  const shot = async (name) => {
    try {
      await mainWindow.webContents.capturePage(); // 丢弃隐藏窗口的过期合成帧
      await sleep(600);
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      console.log('[shot] saved', name);
    } catch (e) { console.error('[shot] failed', name, e.message); }
  };
  try {
    console.log('[shot] waiting load, loading=', mainWindow.webContents.isLoading());
    await new Promise((res) => {
      if (!mainWindow.webContents.isLoading()) return res();
      const done = () => res();
      mainWindow.webContents.once('did-finish-load', done);
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => { console.error('[shot] load failed', code, desc); done(); });
      setTimeout(() => { console.error('[shot] load wait timeout'); done(); }, 30000);
    });
    await sleep(3500);
    await shot('01-workbench.png');
    await js('window.App && window.App.switchPage && window.App.switchPage(\\'settings\\')');
    await sleep(2500);
    const tabs = await js('Array.from(document.querySelectorAll(\\'[data-settings-tab]\\')).map(t=>t.dataset.settingsTab)');
    console.log('[shot] settings tabs:', JSON.stringify(tabs));
    const tabList = Array.isArray(tabs) && tabs.length ? tabs : ['model', 'credentials', 'feishu', 'datasource'];
    let n = 2;
    for (const t of tabList) {
      await js('window.__shotTab=' + JSON.stringify(t) + ';');
      await js('(function(){var tab=document.querySelector(\\'[data-settings-tab="\\' + window.__shotTab + \\'"]\\');if(tab)tab.click();})()');
      await shot((n < 10 ? '0' : '') + n + '-settings-' + t + '.png');
      n += 1;
    }
    console.log('[shot] renderer console errors:', JSON.stringify(jsErrors.slice(0, 10)));
    console.log('[shot] done ->', dir);
  } catch (e) { console.error('[shot] error', e.message); }
  app.quit();
}

/* ---------------- 应用设置（ownership 在应用层，存 DATA_DIR/app-settings.json） ---------------- */
function readAppSettings() {
  try { return JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}
function writeAppSettings(patch) {
  const next = { ...readAppSettings(), ...patch };
  fs.mkdirSync(path.dirname(APP_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

/* ---------------- 业务任务（示例：换成你自己的脚本/流程） ---------------- */
let runningSample = false;
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_ROOT, ...opts });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += String(d); });
    if (child.stderr) child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve({ code: 127, out, err: err + '\\n' + e.message }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out, err }));
  });
}

function registerWorkbenchIpc() {
  ipcMain.handle('myapp:getStatus', async () => ({ projectRoot: PROJECT_ROOT, runningSample }));
  ipcMain.handle('myapp:getAppSettings', async () => readAppSettings());
  ipcMain.handle('myapp:setAppSettings', async (_e, patch) => writeAppSettings(patch || {}));
  ipcMain.handle('myapp:ping', async () => ({ ok: true, projectRoot: PROJECT_ROOT }));
  // 示例长任务：替换为你的业务脚本；无日志面板，只返回结果 + 防重入
  ipcMain.handle('myapp:runSample', async () => {
    if (runningSample) return { ok: false, message: '任务进行中，请等待完成。' };
    runningSample = true;
    try {
      const r = await runCmd(process.execPath, ['-e', 'console.log("sample done")']);
      return r.code === 0 ? { ok: true, message: '示例任务完成' } : { ok: false, message: '失败（exit ' + r.code + '）\\n' + (r.err || r.out).trim().split('\\n').slice(-25).join('\\n') };
    } finally { runningSample = false; }
  });
}

app.whenReady().then(async () => {
  if (!process.argv.includes('--dev')) Menu.setApplicationMenu(null);

  // pi-core://renderer/<path> -> <core>/electron/renderer/<path>
  const coreRoot = path.dirname(require.resolve('pi-electron-core/package.json'));
  protocol.handle('pi-core', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'renderer') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname.replace(/^\\//, ''));
    const root = path.resolve(coreRoot, 'electron', 'renderer');
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*'); // file:// -> pi-core:// 字体跨源
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers });
  });

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  credentialStore = new CredentialStore({ file: path.join(DATA_DIR, 'credentials.json') });
${creds}
  feishuManager = new FeishuManager({ projectRoot: PROJECT_ROOT });
  feishuManager.autoStartOnLaunch().catch(e=>console.error('[feishu]', e.message));

  chatSession = createChatSessionWithSettings({ projectRoot: PROJECT_ROOT, sessionDir: SESSION_DIR, piSettingsPath: PI_SETTINGS_PATH, emitToRenderer: sendToRenderer, name: 'workbench' });
  registerCoreIpc({ ipcMain, chatSession, piSettingsPath: PI_SETTINGS_PATH, emitToRenderer: sendToRenderer });
  registerCoreSettingsIpc({
    ipcMain, emitToRenderer: sendToRenderer,
    services: {
      credentialStore, feishuManager,
      dataRoot: {
        get: () => ({ dataRoot: DATA_ROOT, appRoot: PROJECT_ROOT, isPackaged: app.isPackaged, configurable: true }),
        choose: async () => { const r = await dialog.showOpenDialog(mainWindow, { title:'选择数据目录', defaultPath: DATA_ROOT, properties:['openDirectory','createDirectory'] }); return r.canceled?null:r.filePaths[0]; },
        set: (dir) => setDataRoot(dir, { devRoot: PROJECT_ROOT }),
      },
    },
  });

  registerWorkbenchIpc();
  createWindow();
});
`;
}

function preloadJs() {
  return `const { contextBridge, ipcRenderer } = require('electron');
const { coreWorkbenchBridge } = require('pi-electron-core/electron/preload-bridge');

contextBridge.exposeInMainWorld('workbench', {
  ...coreWorkbenchBridge(ipcRenderer),
  getStatus: () => ipcRenderer.invoke('myapp:getStatus'),
  getAppSettings: () => ipcRenderer.invoke('myapp:getAppSettings'),
  setAppSettings: (patch) => ipcRenderer.invoke('myapp:setAppSettings', patch),
  ping: () => ipcRenderer.invoke('myapp:ping'),
  runSample: () => ipcRenderer.invoke('myapp:runSample'),
});
`;
}

function indexHtml({ title, subtitle, pages, sidebar }) {
  const tabs = pages.map((p, i) =>
    `            <button class="nav-tab${i === 0 ? ' active' : ''}" data-page="${p.id}" aria-selected="${i === 0 ? 'true' : 'false'}">${p.label}</button>`).join('\n');
  const sections = pages.map((p, i) =>
    `            <section id="page-${p.id}" class="page-view${i === 0 ? ' active' : ''}"${i === 0 ? '' : ' hidden'} data-canvas="${p.canvas}">
              <div class="workbench-wrap">
                <div class="page-eyebrow-header">
                  <span class="eyebrow-text">${p.eyebrow}</span>
                  <h1 class="page-main-title">${p.heading}</h1>
                  <p class="page-subtitle">${p.desc}</p>
                </div>
                <div class="task-grid">
                  <div class="card task-card">
                    <div class="task-head"><h3>示例任务</h3><span class="tag mute" id="${p.id}-tag">就绪</span></div>
                    <p class="task-desc">把 myapp:runSample 换成你的业务流程。</p>
                    <div class="task-actions"><button class="btn btn-primary" id="btn-${p.id}-run">运行</button></div>
                    <div class="task-status" id="${p.id}-status"></div>
                  </div>
                </div>
              </div>
            </section>`).join('\n');
  const scriptPages = pages.map((p) => `  <script src="./pages/${p.id}.js"></script>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- 必须放行 pi-core:，否则 core 的 css/js/字体被 CSP 拦截 -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' pi-core:; style-src 'self' pi-core: 'unsafe-inline'; img-src 'self' pi-core: data:; font-src 'self' pi-core: data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*;">
  <title>${title}</title>
  <link rel="stylesheet" href="pi-core://renderer/styles.css">
  <link rel="stylesheet" href="./styles.css">
  <style>[hidden]{display:none !important}</style>
</head>
<body>
  <div id="app">
    <div class="app-layout">
      <header class="app-header">
        <div class="header-left">
          <div class="brand-badge">
            <div class="brand-text">
              <span class="brand-title">${title}</span>
              <span class="brand-subtitle">${subtitle}</span>
            </div>
          </div>
          <nav class="nav-tabs" aria-label="工作台导航">
${tabs}
          </nav>
        </div>
        <div class="header-right">
          <div class="header-date" id="today-label"></div>
          <div class="agent-status-badge ready" id="pi-status"><span class="status-indicator-dot"></span><span class="status-indicator-text">Agent 已就绪</span></div>
          <button class="icon-btn" id="sidebar-toggle" type="button" aria-expanded="true" aria-controls="agent-sidebar" title="展开/收起 Agent 侧栏 (Ctrl+B)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <line x1="15" y1="3" x2="15" y2="21"></line>
            </svg>
          </button>
          <button class="icon-btn" id="settings-trigger" type="button" title="设置" aria-expanded="false">⚙</button>
        </div>
      </header>
      <div class="app-body">
        <main class="main-content">
${sections}
          <section id="page-settings" class="page-view" hidden data-canvas="#F4F3EE"><div id="settings-root"></div></section>
        </main>

${sidebar.split('\n').map((l) => '        ' + l).join('\n')}
      </div>
    </div>
  </div>
  <script src="pi-core://renderer/lib/markdown.js"></script>
  <script src="pi-core://renderer/app.js"></script>
  <script src="pi-core://renderer/pages/chat.js"></script>
  <script src="pi-core://renderer/pages/settings-page.js"></script>
  <script src="pi-core://renderer/shell.js"></script>
${scriptPages}
  <script src="./pages/settings-ext.js"></script>
</body>
</html>
`;
}

function appStyles() {
  return `/* 应用层样式：复用 core 的 .card/.tag/.btn，只补业务布局。纯白浮岛。 */
.workbench-wrap { max-width: 960px; margin: 0 auto; padding: 28px 24px 64px; }
.task-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.task-card { background: #FFFFFF; border: 1px solid rgba(38,33,28,0.08); border-radius: 16px; box-shadow: 0 2px 8px -2px rgba(38,33,28,0.05); padding: 18px 20px; }
.task-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.task-head h3 { font-size: 16px; margin: 0; }
.task-desc { font-size: 13px; line-height: 1.7; opacity: 0.85; }
.task-actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.task-status { margin-top: 12px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.task-status:empty { display: none; }
.task-status.ok { color: #2f6b3a; }
.task-status.error { color: #8B261D; }
@media (max-width: 860px) { .task-grid { grid-template-columns: 1fr; } }
`;
}

function pageJs(pageId) {
  return `/* ${pageId} 页交互：运行中禁用 + 结果提示（无日志面板）。 */
(function () {
  'use strict';
  function setTag(text, ok) {
    const t = document.getElementById('${pageId}-tag');
    if (!t) return;
    t.textContent = text;
    t.className = 'tag ' + (ok === true ? 'ok' : 'mute');
  }
  function setStatus(text, kind) {
    const n = document.getElementById('${pageId}-status');
    if (!n) return;
    n.textContent = text || '';
    n.className = 'task-status' + (kind ? ' ' + kind : '');
  }
  async function run() {
    const btn = document.getElementById('btn-${pageId}-run');
    if (btn) btn.disabled = true;
    setTag('运行中…'); setStatus('处理中，请勿关闭窗口…');
    try {
      const r = await window.workbench.runSample();
      setTag(r.ok ? '已完成' : '失败', r.ok);
      setStatus(r.message, r.ok ? 'ok' : 'error');
    } catch (e) { setTag('失败'); setStatus(String((e && e.message) || e), 'error'); }
    finally { if (btn) btn.disabled = false; }
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-${pageId}-run')?.addEventListener('click', run);
    if (window.App?.registerPage) window.App.registerPage('${pageId}', {});
  });
})();
`;
}

function settingsExtJs() {
  return `/* 示例业务设置卡：挂 datasource tab，与数据目录同处 task-grid。复用 core 卡体系。 */
(function () {
  'use strict';
  function setStatus(msg, kind) {
    const n = document.getElementById('myapp-sample-status');
    if (!n) return;
    n.textContent = msg || '';
    n.className = 'task-status' + (kind ? ' ' + kind : '');
  }
  async function load() {
    try {
      const s = await window.workbench.getAppSettings();
      const input = document.getElementById('myapp-sample-field');
      if (input) input.value = s.sampleField || '';
    } catch (e) { setStatus(String((e && e.message) || e), 'error'); }
  }
  async function save() {
    try {
      const value = document.getElementById('myapp-sample-field')?.value || '';
      await window.workbench.setAppSettings({ sampleField: value });
      setStatus('已保存', 'ok');
    } catch (e) { setStatus(String((e && e.message) || e), 'error'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.SettingsPage?.registerExtraCards) return;
    window.SettingsPage.registerExtraCards({
      tabId: 'datasource',
      html: [
        '<div class="card task-card" id="myapp-sample-card">',
        '<div class="task-head"><h3>示例业务设置</h3><span class="tag mute">应用层</span></div>',
        '<p class="task-desc">替换成你的业务配置项。</p>',
        '<label class="settings-field">示例字段<input class="form-input" id="myapp-sample-field"></label>',
        '<div class="task-actions"><button class="btn btn-primary btn-sm" id="myapp-sample-save">保存</button></div>',
        '<div class="task-status" id="myapp-sample-status"></div>',
        '</div>',
      ].join(''),
      init() { document.getElementById('myapp-sample-save')?.addEventListener('click', save); },
      refresh: load,
    });
  });
})();
`;
}

function parsePages(raw, fallbackLabel) {
  if (!raw) return [{ id: 'workbench', label: fallbackLabel || '工作台', eyebrow: 'WORKBENCH', heading: '工作台', desc: '示例业务页，把 runSample 换成你的流程。', canvas: '#E3E8E4' }];
  const canvases = ['#E3E8E4', '#DCE6F0', '#F0EAD8'];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((label, i) => {
    const id = 'page' + (i + 1);
    return { id, label, eyebrow: label.toUpperCase().slice(0, 12) || ('PAGE' + (i + 1)), heading: label, desc: '示例业务页，把 runSample 换成你的流程。', canvas: canvases[i % canvases.length] };
  });
}

async function runInit(argv) {
  const args = parseArgs(argv);
  // 先断言：core 漂移则直接失败，不生成坏脚手架
  assertCoreApi();
  assertRendererAssets();
  const sidebar = extractSidebar();
  const tabs = coreSettingsTabs();
  if (!tabs.includes('datasource')) throw new Error('core 已漂移：设置页缺少 datasource tab，扩展卡无处挂载');

  const root = path.resolve(args.root || process.cwd());
  const filled = await fillMissing([
    { key: 'name', label: '应用名（package.json）', default: path.basename(root).replace(/\s+/g, '-') || 'my-pi-app' },
    { key: 'title', label: '窗口标题', default: '我的桌面工作台' },
    { key: 'subtitle', label: '副标题', default: 'PI Workbench' },
    { key: 'pages', label: '业务页（逗号分隔，首个为主页）', default: '工作台' },
  ], args);
  const creds = parseCredentials(args.credentials === undefined ? 'sample-token:示例Token:SAMPLE_TOKEN' : args.credentials);
  const pages = parsePages(filled.pages, filled.pages);

  const desk = path.join(root, 'desktop');
  const exists = fs.existsSync(desk) && fs.readdirSync(desk).length > 0;
  if (exists && !args.force) throw new Error(`目标已存在且非空：${desk}（加 --force 覆盖）`);

  const pkg = corePkg();
  const write = (rel, content) => {
    const abs = path.join(desk, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log('[init] wrote', rel);
  };
  write('package.json', JSON.stringify({
    name: filled.name, version: '0.1.0', private: true,
    description: `${filled.title}（pi-electron-core 底座）`,
    main: 'electron/main.js',
    scripts: { start: 'electron electron/main.js --cwd ..', dev: 'electron electron/main.js --cwd .. --dev' },
    dependencies: { 'pi-electron-core': `github:Jst-Well-Dan/pi-electron-core#v${pkg.version}` },
    devDependencies: { electron: '43.2.0' },
  }, null, 2) + '\n');
  write('electron/main.js', mainJs({ title: filled.title, creds: credSchemaLines(creds) }));
  write('electron/preload.js', preloadJs());
  write('electron/renderer/index.html', indexHtml({ title: filled.title, subtitle: filled.subtitle, pages, sidebar }));
  write('electron/renderer/styles.css', appStyles());
  for (const p of pages) write(`electron/renderer/pages/${p.id}.js`, pageJs(p.id));
  write('electron/renderer/pages/settings-ext.js', settingsExtJs());

  console.log(`\n[init] 完成：${desk}`);
  console.log('[init] 下一步：cd desktop && npm install && npm start');
  console.log('[init] 校验：npx github:Jst-Well-Dan/pi-electron-core doctor --root <应用根>');
  return 0;
}

module.exports = { runInit };
