# pi-electron-core

打包好的项目级 pi。不认识"蹊涯""股票池""帖子"这些具体项目的词——指向任意项目
目录就能用，可以独立运行，也可以被别的内容层（写作、分析、其它可视化场景）依赖。

> 未来维护或让 agent 修改前，建议先读 [`CORE_GUIDE.md`](./CORE_GUIDE.md)：它说明
> core 的职责边界、哪些应留在应用层、哪些才值得沉淀进 core，以及如何基于 core 构建应用。

## 独立运行

```bash
npm install
npm start -- --cwd <项目目录>   # 不带 --cwd 时默认当前目录
```

弹出一个两个 tab 的窗口：**自由讨论**（常驻 pi 会话，可调用 `<项目目录>/.pi/skills`
下的项目技能）+ **设置**（切模型、配置 API Key）。会话和模型偏好落盘在
`<项目目录>/.pi-electron-core/`，按项目区分，不影响 pi 自身的全局/项目配置，也不影响
别的项目用这个 app 时的状态。聊天侧栏可浏览并继续历史会话；Pi 原生 `sessions/*.jsonl`
作为事实源，`sessions-index.json` 是可自动重建的摘要索引。若项目目录已移动，恢复时会
创建指向原文件的兼容副本并更新副本中的 cwd，原始 JSONL 保持不变。

## 首次使用：安装 Pi

运行应用只需要 Node.js 与 Electron；不要求用户预先全局安装 Pi。若启动时未找到 Pi，
设置页的 **Pi 运行环境**卡片会说明状态，并在用户明确确认后执行：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

向导会展示安装进度并在完成后重新检测 CLI；它不会静默安装。若没有 `npm`，页面会提示
先安装 Node.js LTS。Pi 安装完成后仍需配置模型的 API Key 或登录授权，才能实际发起模型调用。

## 提供什么

### Node 主进程模块（`require('pi-electron-core')`）

| 导出 | 作用 |
|---|---|
| `PiRpcClient` | spawn 一个 `pi --mode rpc` 子进程，JSONL 通信、请求/响应关联、生命周期管理 |
| `ChatSessionManager` | 常驻会话封装（`--session-dir` + 安全恢复最近会话），支持历史枚举与 `switch_session`，双 sink：Electron 渲染进程 + 自身 EventEmitter |
| `SessionCatalog` | 只读扫描 Pi 原生会话 JSONL，生成可重建的 `sessions-index.json` 摘要索引 |
| `CredentialStore` | 通用业务凭证库：应用注册 schema（字段/动作/落盘钩子），统一存取与状态回显（渲染层不见明文）；值存 `<数据根>/.pi-electron-core/credentials.json` |
| `FeishuManager` | 飞书 / Lark 桥接管理（凭证配置、扫码建应用、start/stop/restart/status/reset），不含任何具体业务逻辑 |
| `appRoot`/`resolveDataRoot`/`setDataRoot`/`scriptsDir` | 数据根解析（打包便携 = exe 旁 data/，开发 = devRoot，可经 config/data-root.json 配置） |
| `readSettings`/`writeSettings`/`toSpawnArgs`/`getAvailableModels`/`setModel`/`getCurrentModel` | provider/model 偏好：本地存储 + 一次性子进程用的 spawn 参数 + 常驻会话运行时切换 |
| `readCredentialStatus`/`writeApiKey`/`deleteApiKey`/`getAuthPath` | provider API Key：直接读写 pi 自己的 `~/.pi/agent/auth.json`，跟终端日常用的 pi 共享凭证（见下方"API Key 管理"） |
| `listProviderCredentials` | 动态 Provider 目录与凭证状态：全部来自 Pi ModelRuntime（`getProviders` + `listCredentials` + `getProviderAuthStatus`），与 TUI 看到的完全一致，不回显密钥 |

CLI 自检：`node scripts/check-pi.js [prompt] [--cwd <path>]`。

### Electron 组装件 + 渲染页面（`electron/`）

不止是无 UI 的库——`electron/` 目录本身就是一个可独立跑的 Electron app（自由讨论 +
设置两个 tab），同时把里面可复用的部分拆成两块，供内容层消费者（如 `xiya-content`）
和这个独立 app 共用，不用两处维护同样的组装样板：

| 文件 | 作用 |
|---|---|
| `electron/main-app.js` | `registerCoreIpc()`（chat/settings/auth 的 `ipcMain.handle` 注册）+ `createChatSessionWithSettings()`（常驻会话创建 + 恢复模型偏好） |
| `electron/preload-bridge.js` | `coreWorkbenchBridge(ipcRenderer)`，返回 chat/settings/auth 对应的 `window.workbench.*` 绑定，供各自的 preload.js 拼进自己的 `contextBridge.exposeInMainWorld` |
| `electron/renderer/{app.js, styles.css, lib/markdown.js, pages/{chat.js, settings-page.js}}` | 通用渲染层：tab 路由、聊天气泡、历史会话抽屉、发送/停止状态按钮、完整设置页（模型/凭证/飞书/其他，业务凭证按 schema 注册渲染）+ 通用主题组件（纯白浮岛 `.card`、胶囊 `.chip`、状态徽标 `.status-badge`、贴士框 `.notice-box`、步骤圆点 `.step-num`、表单 `.form-*`）。不含任何项目专属页面 |
| `electron/main.js` / `electron/preload.js` / `electron/renderer/index.html` | 独立 app 的入口，组装以上两块 |

## API Key 管理

设置页的"API Key"卡片直接写 pi 自己的凭证文件（`~/.pi/agent/auth.json`），跟用户
终端里日常用的 pi **共享凭证**——这是刻意的选择，不是"这一个工作台实例"私有存储
（那是 provider/model 偏好的边界，`pi-settings.js` 走的是这条路）。原因：

- pi 的 RPC 协议（`get_available_models`/`set_model`）没有设置 API Key 的命令，
  只能在已有凭证的 provider 间切换——加 Key 这件事本来就得落到 pi 自己认的凭证
  文件里，没有绕开它的干净路径。
- Provider 下拉列表不硬编码，由 `listProviderCredentials()` 动态来自 Pi 的
  `ModelRuntime.getProviders()`（当前版本 38 个 provider），凭证状态用
  `listCredentials()`/`getProviderAuthStatus()` 按 auth.json 精确匹配——
  与 TUI 看到的"已配置/未配置"完全一致（含环境变量覆盖），并区分
  `api_key` / `oauth` 两种凭证类型。
- 格式已用本机真实 `auth.json` 验证：`{ "<providerId>": { "type": "api_key", "key": "sk-..." } }`
  （OAuth 登录是 `{ "type": "oauth", "access": "...", ... }`，这里只新增/删除
  `api_key` 条目，不碰其他 provider 已有的 OAuth 状态）。
- pi 包不对外导出它的 `AuthStorage` 类（不在 `package.json` 的 `exports` 里），
  所以 `src/auth-settings.js` 按已验证格式自己做读-改-写，用 `proper-lockfile`
  （pi 自己也用这个库）做同步锁 + 手动重试，避免跟终端里另一个 pi 进程同时写
  导致互相覆盖或截断。
- core **不实现自定义 Provider 编辑**（不读写 `models.json`）：自定义 Provider
  是 Pi TUI / `pi install` / pi 自身配置的职责，core 只展示 Pi 运行时已识别的
  Provider 与模型。
- 保存后**不会**热更新到当前常驻会话（`ChatSessionManager` 不会重读 `auth.json`），
  UI 会提示需要重启会话；这是已知的、刻意先不做的限制。

## Skill 调用能力

不需要额外代码——`ChatSessionManager`/`PiRpcClient` spawn `pi` 子进程时把
`projectRoot` 当作 `cwd`，pi 自己会自动发现该目录下的 `.pi/skills`。独立运行时
`--cwd <项目目录>` 指哪个目录，聊天页就能调用哪个目录的技能。

## 飞书 / Lark 内置扩展

core 内置了一份 `pi-feishu-lark`：

```text
pi-electron-core/pi-packages/pi-feishu-lark/
```

`FeishuManager` 启动独立 RPC 控制进程时会使用 `--no-extensions -e <内置扩展路径>`，
只加载这份 vendored 扩展，调用方项目不需要再在 `.pi/settings.json` 安装
`npm:pi-feishu-lark`。飞书配置、状态、日志、锁文件默认仍按项目落盘：

```text
<projectRoot>/.pi/feishu/config.json
<projectRoot>/.pi/feishu/state.json
<projectRoot>/.pi/feishu/locks.json
```

因此多个项目可以共用同一个 `pi-electron-core`，但分别绑定不同飞书机器人。

core 默认强制使用 WebSocket 卡片回调模式（`cardActionMode: "ws"`）。这样新项目不会尝试
监听本地 `0.0.0.0:3001/webhook/card`，避免 Windows 上常见的 `listen EACCES` 导致
后台 gateway 已启动但 `/feishu status` 仍显示未连接。通过设置页保存/启动时，旧配置也会被
自动迁移到 `ws`。

如果还希望在普通终端 Pi 会话中也能手动输入 `/feishu status`，调用方项目需要放一个
项目级 shim：`.pi/extensions/feishu/index.ts`，再转发到 core 内置扩展。当前项目已这样配置。

## 不提供什么，以及为什么

- **不含任何技能触发 prompt / 产出文件正则** —— 那是"内容层"的职责（比如
  蹊涯工作台里的 `xiya-content`：按钮任务、产出文件解析、股票池看板）。core 层
  不应该猜某个项目要触发哪个技能、读哪个目录。
- **不含 pi 自身 provider/model 配置文件的读写**（`~/.pi/agent/settings.json` /
  项目级 `.pi/settings.json`）—— 那是 pi 自己的全局/项目默认，改了会影响用户在
  终端里交互式用 pi。这里的 provider/model 配置是"这一个工作台实例"自己的偏好，
  只通过 spawn 参数或运行时 `set_model` 命令生效（跟 API Key 的共享边界不同，
  见上文）。
- **不是插件注册模式**（core 不反过来加载内容层）—— 只有一两个真实消费者的阶段，
  提前设计插件契约大概率设计错方向；`electron/main-app.js` + `preload-bridge.js`
  这层复用已经是根据两个真实调用点（独立 app 自己 + `xiya-content`）反推出来的，
  不是预先设计的抽象。

## 内容层怎么用

内容层（例如蹊涯工作台的 `xiya-content`）用本地路径依赖这个仓库
（`"pi-electron-core": "file:../相对路径/pi-electron-core"`），自己写
`src/main/index.js` 组装：

```js
const { readSettings, toSpawnArgs } = require('pi-electron-core');
const { registerCoreIpc, createChatSessionWithSettings } = require('pi-electron-core/electron/main-app');
const { DashboardTaskManager } = require('./dashboard-tasks'); // 内容层自己的技能触发逻辑

const chatSession = createChatSessionWithSettings({ projectRoot, sessionDir, piSettingsPath, emitToRenderer });
registerCoreIpc({ ipcMain, chatSession, piSettingsPath });
```

渲染层不重新实现聊天/设置页——内容层的 `index.html` 通过一个自定义协议
（例如 `pi-core://`，在主进程里用 `protocol.handle` 把它映射到
`require.resolve('pi-electron-core/package.json')` 所在目录下的
`electron/renderer/`）引用 core 提供的 `app.js` / `styles.css` / `pages/chat.js` /
`pages/settings-page.js`（完整 4-tab 设置页），自己只维护项目专属页面
（如仪表盘、股票池看板）的脚本和 `#page-*` markup，并在主进程注册业务凭证
（`CredentialStore.registerSchema`）。应用专属设置卡（如某项目的「入库媒体
策略」开关）经 `window.SettingsPage.registerExtraCards({ tabId, html, init,
refresh })` 注册：core 负责挂载 DOM、幂等保护，并在每次进入设置页时调用
`refresh`（init 在挂载时调用一次）。具体实现参考蹊涯工作台的
`workbench/packages/xiya-content/src/main/index.js`。

**主题与规范**：core 的 styles.css 即完整 checklist 设计审美——环境画布随页面流
动、内容锚定纯白浮岛、用户气泡为中性微底胶囊、侧栏磨砂同频。设计规范（色板/
透明度阶梯/动效/组件解剖）见仓库根目录 `checklist_design_system/CHECKLIST_DESIGN_SPEC.md`，
core 不再内置独立设计文档。

## 已知边界

- API Key 保存/清除后当前常驻会话不会自动感知，需要重启会话（重新打开窗口）。
- 目前只是本机独立 git 仓库，尚未推送到远端；消费者用本机相对路径的 `file:`
  依赖引用，换机器需要同步调整路径或先推到远端仓库。
