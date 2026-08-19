# pi-electron-core 边界与应用构建指南

> 面向未来维护者与 coding agent：在修改桌面应用前，先用本文判断——代码应该放在应用层，还是应该沉淀进 `pi-electron-core`。目标是让 core 保持通用、可复用、无业务痕迹，同时让具体项目可以低成本基于 core 构建自己的工作台。

## 1. 一句话定位

`pi-electron-core` 是一个**项目无关的 Pi 桌面外壳与通用能力层**：

- 提供 Pi RPC / 常驻会话 / 历史会话 / 模型与 API Key 设置；
- 提供通用 Electron 组装件（main/preload/renderer）；
- 提供通用聊天页、设置页、主题 token 与基础 UI 组件；
- 可以独立运行，也可以被具体应用作为底座引用。

它**不理解任何具体业务**，例如：社交媒体抓取、知识库入库、股票池、帖子、raw/wiki 目录、某个按钮触发哪个 skill 等。

## 2. 分层原则

### 2.1 core 负责什么

放进 `pi-electron-core` 的内容必须满足：**项目无关、可复用、可独立运行时成立**。

典型归属：

| 类型 | 应放在 core 的内容 |
|---|---|
| Pi 通用能力 | `PiRpcClient`、`ChatSessionManager`、会话历史、模型切换、API Key 管理、Pi 安装检测 |
| Electron 通用外壳 | `registerCoreIpc()`、`createChatSessionWithSettings()`、`coreWorkbenchBridge()`、core 独立 app 入口 |
| 通用页面 | 自由讨论页、设置页、历史会话抽屉、发送/停止按钮、通用设置 tab |
| 通用扩展点 | `SettingsPage.registerExtraCards()`、`CredentialStore.registerSchema()` 等 schema/callback 驱动机制 |
| 通用 UI/主题 | `styles.css` token、`.card`、`.chip`、`.status-badge`、`.notice-box`、`.form-*`、聊天气泡、侧栏磨砂 |
| 通用桥接 | Feishu/Lark 连接管理这类可被多个项目复用的基础桥接能力 |

### 2.2 应用层负责什么

放在具体应用里的内容通常满足：**出现项目名词、业务目录、业务流程、业务 IPC、业务页面**。

以本项目为例，应保留在应用层：

| 类型 | 应用层示例 |
|---|---|
| 业务页面 | URL 入库页、Wiki 浏览页、项目仪表盘 |
| 业务流程 | URL → capture → raw → wiki-catalog 入库、去重、图片识别 |
| 业务数据 | `raw/`、`wiki/`、`.pi/skills/capture/config.json`、项目数据库/缓存 |
| 业务 IPC | `capture:submit`、`capture:mediaGet/Set`、`wiki:list/read` 等 |
| 业务设置卡 | “URL 入库媒体策略”这类只对当前项目有意义的设置卡；通过 core 扩展口挂载 |
| 业务样式 | 某个页面布局、列表密度、业务卡片内部结构、特定数据状态展示 |
| 业务 skill 触发 | 调用哪个脚本、解析哪个产物路径、展示哪个产出文件 |

## 3. 判断：改应用，还是改 core？

修改前先走这个判断链。

### 3.1 优先留在应用层的信号

只要满足任一条，默认放应用层：

1. 代码中出现业务名词：`capture`、`wiki`、`raw`、`stock`、`post`、`media`、某平台名等；
2. 依赖某个项目目录结构或文件格式；
3. 只服务一个页面或一个业务流程；
4. 需要调用项目自己的 backend、skill、脚本或 IPC；
5. core 独立运行时无法解释它的意义；
6. 配置项只对当前项目有意义。

### 3.2 应该改进 core 的信号

满足以下条件时，优先考虑沉淀到 core：

1. 同一段 UI/逻辑在两个以上应用中重复；
2. 是聊天、设置、会话、模型、凭证、历史记录、窗口外壳的共性问题；
3. 是通用设计系统能力，例如浮岛卡片、胶囊、状态徽标、表单、磨砂侧栏；
4. 是通用 bug 修复，例如聊天气泡可读性、设置页生命周期、会话恢复；
5. 可以用 schema/callback/slot/extension point 表达，而不引入业务词；
6. core 独立 app 也能自然使用或至少不受影响。

### 3.3 边界不清时的推荐做法

优先不要把业务直接塞进 core，而是：

1. 在 core 增加**通用扩展点**；
2. 在应用层通过扩展点注册业务内容；
3. 等有第二个真实项目复用后，再考虑是否把更大能力抽象进 core。

例如：

- ✅ core 提供 `SettingsPage.registerExtraCards({ tabId, html, init, refresh })`；
- ✅ 应用层注册“URL 入库媒体策略”设置卡；
- ❌ core 直接内置“URL 入库媒体策略”。

## 4. 当前项目的真实边界案例

| 需求 | 归属 | 原因 |
|---|---|---|
| 用户聊天气泡由深底改为浅色胶囊 | core | 聊天气泡是所有基于 core 的应用共享的基础体验 |
| 侧栏跟随页面画布，形成磨砂玻璃 | core | shell 视觉层，不属于某个业务页 |
| `.chip` / `.status-badge` / `.notice-box` / `.step-num` | core | 通用组件，可被多个页面/应用复用 |
| “URL 入库媒体策略”设置卡 | 应用层 | 只和 capture skill 的媒体保存策略有关 |
| `capture:mediaGet/Set` IPC | 应用层 | 读写当前项目 `.pi/skills/capture/config.json` |
| `raw/` → `wiki/` 入库流程 | 应用层 | 明确业务流程，core 不应知道 raw/wiki |
| `CredentialStore.registerSchema()` | core | 通用业务凭证注册机制，不含具体业务字段 |
| 具体业务凭证 schema | 应用层 | 字段、标签、动作取决于项目 |

## 5. 如何基于 core 构建一个应用

### 5.1 安装/引用

在应用 `package.json` 中以本地路径或包版本引用 core：

```json
{
  "dependencies": {
    "pi-electron-core": "file:./pi-electron-core"
  }
}
```

实际路径按仓库结构调整；发布后也可以换成 npm/git 依赖。

### 5.2 主进程接入

应用主进程负责创建窗口、注册业务 IPC，并接入 core 的通用 IPC：

```js
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const {
  resolveDataRoot,
  readSettings,
  toSpawnArgs,
} = require('pi-electron-core');
const {
  registerCoreIpc,
  createChatSessionWithSettings,
} = require('pi-electron-core/electron/main-app');

const projectRoot = process.cwd();
const dataRoot = resolveDataRoot({ devRoot: projectRoot });
const sessionDir = path.join(dataRoot, '.pi-electron-core', 'sessions');
const piSettingsPath = path.join(dataRoot, '.pi-electron-core', 'settings.json');

let mainWindow;
const chatSession = createChatSessionWithSettings({
  projectRoot,
  sessionDir,
  piSettingsPath,
  emitToRenderer: (channel, payload) => mainWindow?.webContents.send(channel, payload),
});

registerCoreIpc({ ipcMain, chatSession, piSettingsPath });

// 应用自己的 IPC 写在应用层
ipcMain.handle('myapp:list-items', async () => {
  // read project-specific files/db/backend
});
```

### 5.3 注册 `pi-core://` 协议

渲染层通过协议引用 core 的静态资源，避免复制 core 页面脚本与样式：

```js
const coreRoot = path.dirname(require.resolve('pi-electron-core/package.json'));

protocol.handle('pi-core', async (request) => {
  const url = new URL(request.url);
  const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return net.fetch(`file://${path.join(coreRoot, 'electron', rel)}`);
});
```

具体实现可按 Electron 版本调整；原则是：应用 HTML 引用 `pi-core://renderer/...`，不要复制 core 文件。

### 5.4 preload 接入

应用 preload 把 core bridge 与业务 bridge 合并暴露：

```js
const { contextBridge, ipcRenderer } = require('electron');
const { coreWorkbenchBridge } = require('pi-electron-core/electron/preload-bridge');

contextBridge.exposeInMainWorld('workbench', {
  ...coreWorkbenchBridge(ipcRenderer),

  // 应用自己的能力
  myAppListItems: () => ipcRenderer.invoke('myapp:list-items'),
});
```

### 5.5 渲染层 HTML 加载顺序

应用 HTML 应先加载 core，再加载应用自己的页面与样式：

```html
<link rel="stylesheet" href="pi-core://renderer/styles.css">
<link rel="stylesheet" href="./styles.css">

<script src="pi-core://renderer/lib/markdown.js"></script>
<script src="pi-core://renderer/app.js"></script>
<script src="pi-core://renderer/pages/chat.js"></script>
<script src="pi-core://renderer/pages/settings-page.js"></script>

<script src="./pages/my-page.js"></script>
```

原则：

- core 样式先加载，应用样式后加载；
- 应用样式只写页面专属布局，不重复定义 core 通用组件；
- 聊天页、设置页不重新实现，直接使用 core 页面；
- 应用只添加自己的 `#page-*` markup 与页面脚本。

### 5.6 使用 core 通用组件

应用页面应优先使用 core 已提供的类：

```html
<div class="card">
  <div class="card-heading">标题</div>
  <div class="card-caption">说明文字</div>
  <span class="chip">标签</span>
  <span class="status-badge status-badge--done">已完成</span>
</div>

<div class="notice-box">
  <span class="step-num">1</span> 第一步说明
</div>
```

常用组件：

| 类名 | 用途 |
|---|---|
| `.card` | 纯白浮岛卡片，带 hover 微抬升 |
| `.card-heading` / `.card-caption` | 卡片标题与辅助说明 |
| `.chip` | 中性胶囊标签/链接 |
| `.status-badge` + `--running/--queued/--done/--dup/--fail` | 语义状态徽标 |
| `.notice-box` | 轻提示/说明框 |
| `.step-num` | 小步骤圆点 |
| `.form-*` | 表单标签、输入框、按钮行等 |
| `.btn` / `.btn-primary` / `.btn-ghost` | 通用按钮 |
| `.tag` | 带信号点的小标签 |

如果应用发现自己在重复写这些样式，优先删除重复，改用 core 组件。

### 5.7 添加应用专属设置卡

不要修改 core 设置页来塞业务卡片。应用应通过扩展口注册：

```js
window.SettingsPage.registerExtraCards({
  tabId: 'datasource',
  html: `
    <section class="settings-card" id="my-setting-card">
      <div class="settings-card-head">
        <div>
          <h3>业务设置</h3>
          <p>只对当前应用有意义的设置。</p>
        </div>
      </div>
      <button class="btn btn-primary" id="my-save-btn">保存</button>
    </section>
  `,
  init(root) {
    root.querySelector('#my-save-btn')?.addEventListener('click', async () => {
      await window.workbench.myAppSaveSetting();
    });
  },
  async refresh(root) {
    const value = await window.workbench.myAppGetSetting();
    // update UI
  },
});
```

业务 IPC、配置文件读写、默认值解释都留在应用层。

### 5.8 注册业务凭证 schema

如果某应用需要保存业务凭证，应使用 core 的通用凭证机制，而不是自己复制一套设置 UI：

```js
const { CredentialStore } = require('pi-electron-core');

CredentialStore.registerSchema({
  id: 'my-service',
  title: 'My Service',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
  ],
  async onSaved(values) {
    // 可选：同步写业务需要的配置文件
  },
});
```

注意：schema 本身可以在应用层；core 只提供统一存取、状态回显与渲染机制。

## 6. 修改 core 的安全流程

未来 agent 如果判断需要修改 core，应按以下流程执行。

### 6.1 修改前

1. 先说明边界判断：为什么这是 core 问题，而不是应用问题；
2. 搜索现有消费者和类名/IPC 使用点；
3. 确认不会引入业务词；
4. 如果是视觉变更，先对照 `checklist_design_system/CHECKLIST_DESIGN_SPEC.md`；
5. 优先新增通用扩展点或通用组件，而不是直接写业务逻辑。

### 6.2 修改时

- 保持 public API 向后兼容；确需破坏兼容时必须同步更新所有消费者；
- core 不读取应用业务目录，除非通过调用方显式传入；
- core 不硬编码业务 tab、业务卡片、业务按钮、业务状态；
- CSS 使用 design token，不写页面专属选择器；
- 通用语义色遵循 checklist 规范：避免高饱和红绿灯色，颜色只做稀释提示，语义交给文字/图标/动效；
- 增加扩展口时，要定义生命周期（挂载、初始化、刷新、销毁/幂等）与错误边界。

### 6.3 修改后验证

至少执行：

```bash
node --check src/main/index.js
node --check src/renderer/pages/*.js
SMOKE=1 npx electron . --dev
```

视修改范围补充：

```bash
cd pi-electron-core
node scripts/self-check.js
npm test
```

并做残留检查：

```bash
rg -n "业务名词|旧类名|旧 IPC" src pi-electron-core
```

如果 core CSS 新增组件，应在应用中至少有一个真实使用点或 core 独立 app 可自然使用。

## 7. 禁止事项

不要在 core 中做这些事：

- 写入或解析某项目的 `raw/`、`wiki/`、`capture`、业务数据库；
- 硬编码平台名、业务流程名、业务按钮文案；
- 直接调用项目 `.pi/skills/*/scripts/*.py`；
- 为单个项目新增专属设置 tab 或专属设置卡；
- 在 core 的 renderer CSS 中写 `.capture-*`、`.wiki-*`、`.stock-*` 等业务选择器；
- 为了一个项目临时修改 Pi 全局/项目配置文件，影响用户终端中的 pi 行为；
- 复制 core 的聊天页/设置页到应用层再改一份。

## 8. Agent 执行清单

每次接到修改请求时，agent 应先回答自己：

1. 这个需求是否含业务名词？含则默认应用层。
2. core 独立运行时是否也需要这个能力？需要则可能是 core。
3. 这是否是第二个以上应用会复用的能力？是则考虑 core。
4. 能否通过 schema / callback / slot 注册，而不是把业务塞进 core？能则优先扩展口。
5. 如果改 CSS，是否可以用已有 token 与通用组件表达？可以则不要新增页面专属样式。
6. 修改后是否更新 README/本指南/示例，并跑 SMOKE？

推荐在最终汇报中明确写出：

- 本次哪些改在 core；
- 哪些留在应用层；
- 为什么这样分层；
- 跑了哪些验证；
- 是否存在兼容风险。

## 9. 设计规范来源

core 的默认视觉审美以仓库根目录的 checklist 规范为准：

```text
checklist_design_system/CHECKLIST_DESIGN_SPEC.md
```

core 不再维护单独的 `DESIGN.md`。如果规范与实现冲突，以当前用户确认过的规范与真实应用视觉为准，变更时应在文档和代码注释中说明取舍。