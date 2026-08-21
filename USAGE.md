# pi-electron-core 接入文档

> 5 分钟把 `pi` 接进你的 Electron 项目：一个可独立运行的桌面壳 + 可复用的库。

## 1. 它是什么

- **通用底座**：封装 `pi --mode rpc` 通信、常驻会话、历史会话、模型/API Key 设置、飞书桥接。
- **不含业务**：不认识 `raw`/`wiki`/`帖子` 这类词，业务代码留在你的应用层。
- **两种用法**：可 `npm start -- --cwd <项目目录>` 独立运行；也可被你的应用 `require('pi-electron-core')` 组装。

## 2. 安装

```bash
npm install github:Jst-Well-Dan/pi-electron-core#v0.1.0
# 或锁版本后 npm install pi-electron-core （发布到 npm 后）
```

要求：`Node >=18`，已安装 `pi`（未装也行，设置页会引导 `npm i -g @earendil-works/pi-coding-agent`）

## 3. 最小接入（复制即用）

### 3.1 主进程 `src/main/index.js`

```js
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const { resolveDataRoot } = require('pi-electron-core');
const { registerCoreIpc, createChatSessionWithSettings } = require('pi-electron-core/electron/main-app');

const projectRoot = process.cwd(); // 或你传进来的 --cwd
const dataRoot = resolveDataRoot({ devRoot: projectRoot });
const sessionDir = path.join(dataRoot, '.pi-electron-core/sessions');
const piSettingsPath = path.join(dataRoot, '.pi-electron-core/settings.json');

let win;
const chatSession = createChatSessionWithSettings({
  projectRoot, sessionDir, piSettingsPath,
  emitToRenderer: (ch, payload) => win?.webContents.send(ch, payload),
});

function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  // 让渲染层用 pi-core:// 引用 core 的样式和脚本
  const coreRoot = path.dirname(require.resolve('pi-electron-core/package.json'));
  protocol.handle('pi-core', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    return net.fetch(`file://${path.join(coreRoot, 'electron', rel)}`);
  });

  registerCoreIpc({ ipcMain, chatSession, piSettingsPath });
  // 你的业务 IPC 写在这里：ipcMain.handle('myapp:xxx', ...)
  createWindow();
});
```

### 3.2 Preload `src/main/preload.js`

```js
const { contextBridge, ipcRenderer } = require('electron');
const { coreWorkbenchBridge } = require('pi-electron-core/electron/preload-bridge');

contextBridge.exposeInMainWorld('workbench', {
  ...coreWorkbenchBridge(ipcRenderer),
  // 你的业务能力
  myAppDoSomething: (arg) => ipcRenderer.invoke('myapp:xxx', arg),
});
```

### 3.3 渲染层 `src/renderer/index.html`

```html
<!doctype html>
<link rel="stylesheet" href="pi-core://renderer/styles.css">
<link rel="stylesheet" href="./styles.css">

<div id="app"></div>
<script src="pi-core://renderer/lib/markdown.js"></script>
<script src="pi-core://renderer/app.js"></script>
<script src="pi-core://renderer/pages/chat.js"></script>
<script src="pi-core://renderer/pages/settings-page.js"></script>
<!-- 你的业务页面 -->
<script src="./pages/my-page.js"></script>
```

> 先加载 `pi-core://` 的样式和脚本，再加载你的业务脚本；`app.js` 负责 tab 路由和历史抽屉。

### 3.4 package.json

```json
{
  "dependencies": { "pi-electron-core": "github:Jst-Well-Dan/pi-electron-core#v0.1.0" },
  "scripts": { "start": "electron .", "dev": "electron . --dev" },
  "devDependencies": { "electron": "43.2.0" }
}
```

### 3.5 启动

```bash
npm install
npm start -- --cwd E:/你的项目
```

看到 **自由讨论 + 设置** 两个 tab 即成功；`--cwd` 指向的目录下的 `.pi/skills` 会自动被 pi 发现。

## 4. 核心 API

```js
const {
  PiRpcClient,              // 直接调 pi RPC
  ChatSessionManager,       // 常驻会话，历史/切换/中断
  SessionCatalog,           // 只读扫描 sessions/*.jsonl
  CredentialStore,          // 业务凭证库（按 schema 注册）
  FeishuManager,            // 飞书桥接 start/stop/status
  readSettings, writeSettings, toSpawnArgs, getAvailableModels, setModel,
  readCredentialStatus, writeApiKey, deleteApiKey,
  listProviderCredentials,
  resolveDataRoot, appRoot,
} = require('pi-electron-core');
```

渲染层通过 `window.workbench` 调用：`chat:send` `chat:abort` `chat:history` `settings:get/set` `feishu:*` 等（见 `electron/preload-bridge.js`）。

## 5. 扩展设置页

业务专属的设置卡不要改 core，用扩展口：

```js
// 渲染层
window.SettingsPage.registerExtraCards({
  tabId: 'other', // 或新建 tab
  html: `<div class="card">...你的表单...</div>`,
  init() { /* 绑定事件 */ },
  refresh() { /* 每次进设置页刷新 */ },
});
```

凭证类用主进程：`CredentialStore.registerSchema({ id, fields, actions })`。

## 6. 开发与发布

```bash
# 改 core
cd E:/Python_Doc/Agent/pi-electron-core-github
npm test                    # 18 用例
npm run dev -- --cwd E:/你的项目  # 独立运行验证

# 发布
git commit -m "feat: xxx" && git push
git tag v0.1.1 && git push --tags
gh release create v0.1.1 --notes "xxx"

# 消费方升级
cd E:/你的项目
npm install github:Jst-Well-Dan/pi-electron-core#v0.1.1
```

联调不愿发版：`cd pi-electron-core-github && npm link` → `cd 你的项目 && npm link pi-electron-core`，改完 `npm unlink pi-electron-core && npm install` 切回。

## 7. 常见问题

| 问题 | 原因 |
|---|---|
| `Cannot find module 'electron'` | 未在消费项目 `npm install`，core 不自带 electron 运行时 |
| 设置页显示未安装 Pi | 按引导点安装，或 `npm i -g @earendil-works/pi-coding-agent` |
| 改了 API Key 不生效 | 需重启会话（已知限制） |
| 两个项目会话串了 | `resolveDataRoot` 未按 `projectRoot` 隔离，检查 `--cwd` 是否正确 |

更多边界见 `CORE_GUIDE.md`。
