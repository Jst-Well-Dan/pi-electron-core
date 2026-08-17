---
name: pi-electron-core · Checklist Design System
description: 动态情境画布 + 纯白浮岛 + 克制紫强调色的桌面 agent 工作台视觉系统
colors:
  ambient-canvas: "#F4F3EE"
  surface: "#FFFFFF"
  surface-subtle: "#FAFAF7"
  dark: "#26211C"
  text-main: "#1F1F2C"
  primary: "#684D95"
  primary-hover: "#563F7B"
  success: "#684D95"
  suggestion: "#905910"
typography:
  main:
    fontFamily: "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  full: "9999px"
motion:
  ease-silky: "cubic-bezier(0.16, 1, 0.3, 1)"
  transition-canvas: "background-color 450ms cubic-bezier(0.16, 1, 0.3, 1)"
---

# Design System: pi-electron-core · Checklist

## Overview

**Creative North Star: "The Dynamic Contextual Canvas"（动态情境画布）**

一个安静、克制、可随内容情境流动演变的桌面工作台，而不是一个 SaaS 仪表盘。界面由三层视觉深度构成：底层是随「页面 / 分类」流动的中立莫兰迪环境画布，中层是永不染色的纯白浮岛卡片（承载一切正文），顶层是高对比的暖炭黑文本与一个极度克制的紫色强调色。信心来自克制与精确，而非装饰。

组件气质偏精确、轻量：交互以小而确定的动效回应（按钮 hover 上浮 1px、聚焦时扩散 20% 透明度的紫晕圈），而非弹跳或厚重投影。圆角用 24px 大圆角 + 无锯齿内嵌边框替代粗硬灰线。

**已确认的拒绝项**：不做 SaaS 蓝渐变或玻璃拟态炫技、不做暗黑终端风、不做 Material 式重投影卡片、不做多强调色（唯一主色是紫 `#684D95`）。

**核心特征**：

- 单一克制强调色（紫）稀疏地用于 CTA / 打勾 / 聚焦环，其余一律中性
- 莫兰迪环境画布随路由/分类动态流转，纯白浮岛承载正文，对比度恒定 15:1+
- 渐进 Alpha 透明度阶梯取代粗硬灰边框；24px 圆角 + 1px 内嵌边框
- Plus Jakarta Sans（拉丁）+ 系统 CJK 承载正文；JetBrains Mono 专用于系统/状态/数字

## 三层视觉深度架构（Three-Tier Depth Model）

| 视觉层级 | 语义 Token | 说明 |
|---|---|---|
| **L0 环境画布** | `--ambient-canvas` | 随路由/分类动态演变的全屏底色，无形提供情境氛围；由内容层驱动 |
| **L1 内容浮岛** | `--color-surface` (#FFFFFF) | 承载核心正文的纯白卡片，永不染色，保障最高可读性 |
| **L2 交互部件** | `--color-dark` / `--color-primary` | 高对比文本 + 克制紫色（CTA/打勾/聚焦环） |

## 主题契约（Theme Contract）

core **不硬编码**任何具体项目的「页面 / 分类 → 颜色」映射。它只提供：

1. **Token 层**：`:root` 里的全部 CSS 变量（见 Colors / Typography / Motion）。
2. **通用组件层**：按钮 / 卡片 / 标签 / 表单 / 模型列表 / 设置页 / 聊天气泡 / 工具卡片 / Markdown 渲染。
3. **扩展点**：
   - `App.setCanvas(color)`：内容层调用以切换 `--ambient-canvas`（分类情境色）。
   - `.page-view[data-canvas]`：页面声明自身画布色，`switchPage` 读取并应用。

**每个应用**负责把「自己的分类 / 页面」映射成莫兰迪色并驱动 `setCanvas`。core 的独立 app（`electron/renderer/index.html`）与内容层（如 `desktop/src/renderer/index.html`）共用同一套 shell + token + 组件，只替换品牌名、tab 标签与页面内容。

## 色彩（Colors）

### 中性（L0/L1）

- **暖奶油 Ambient Canvas**（`#F4F3EE`）：全局默认画布，也是设置页与 Agent 侧栏的固定底色。
- **纯白 Surface**（`#FFFFFF`）：浮岛卡片 / 输入框 / 聊天气泡（assistant）/ 模型列表。
- **暖炭黑 Dark**（`#26211C`）：主文案、标题、品牌图标底色、用户气泡。
- **次级白 Surface Subtle**（`#FAFAF7`）：工具卡片输出区、代码块底色。

### 克制强调色（L2，唯一主色）

- **Primary 紫**（`#684D95`）：仅用于三处「交互行为锚点」——① 勾选/成功确认态 ② 输入聚焦晕圈 ③ 终极 CTA 按钮（如「提交入库」「发送」）。悬停 `#563F7B`。
- **Focus Ring**（`rgba(104,77,149,.20)`）：聚焦时向外扩散的淡紫晕圈，不发光、无模糊。

### 语义色

> 完成/成功不再用高饱和色，而用**克制紫**（目标达成触发品牌正反馈，见 checklist 规范 §3.3）；所有 6px 只读状态信号点（`.tag.ok::before`、状态圆点）统一为紫色 `#684D95`，与主色保持一致。勾选框（checkbox）通过 `accent-color` 强制使用紫色。

- **Success**（`#684D95` / 底 `rgba(104,77,149,.08)` / 边 `rgba(104,77,149,.25)`）：完成态、已配置、Agent 就绪（完成触发品牌紫正反馈，与规范 §3.3 一致）。
- **Danger**（`#C0392B` / 底 `rgba(192,57,43,.08)` / 边 `rgba(192,57,43,.22)`）：错误态。
- **Suggestion**（`#905910` / 底 `rgba(144,89,16,.08)` / 边 `rgba(144,89,16,.22)`）：贴士、工作中、警告。

### 渐进 Alpha 阶梯（基于 `#26211C`）

| 阶梯 | 值 | 典型应用 |
|---|---|---|
| 2% | `.02` | 工具卡头、列表项极轻悬停底 |
| 4% | `.04` | 搜索框底、hover 底 |
| 6% | `.06` | 胶囊底、tab 容器底、分隔线 |
| 8% | `.08` | 卡片/组件线框、内嵌边框 |
| 10% | `.10` | 标准卡片线框、输入框边 |
| 15% | `.15` | 分隔线、滚动条 |
| 25% | `.25` | 未勾选 checkbox 边、hover 加深 |
| 40% | `.40` | 占位符、置灰文字、时间戳 |
| 60% | `.60` | 副标题、辅助文本 |
| 70% | `.70` | 次级正文 |
| 85% | `.85` | 高对比次级标题 |

### 多色域渐进透明度（Multi-Gamut Progressive Opacity）

除主炭黑 `#26211C` 阶梯外，全站还协同三个色域的 alpha 阶梯（见 checklist 规范 §4）：

| 色域 | Token | 用途 |
|---|---|---|
| 强调紫 `#684D95` | `--color-primary-05/08/10/15/20/40` | 微选中底 · 完成态底 · 轻高亮 · 悬浮底 · 聚焦光圈 · 次级选中线框 |
| 纯白 `#FFFFFF` | `--white-50/60/75/85` | 导航胶囊 hover · 日期胶囊 · 顶栏毛玻璃 · 侧栏头/输入区毛玻璃 |
| 语义色 | `--color-success/danger/suggestion` + 对应 `-bg`/`-border` | 完成/危险/贴士的低刺激度稀释微底 |

## 排版（Typography）

- **主字体**：`Plus Jakarta Sans`（拉丁，本地打包可变 woff2，weight 200–800）+ 系统 CJK（PingFang SC / Microsoft YaHei / 微软雅黑）。中英文混排时拉丁/数字用 Plus Jakarta Sans，中文回退系统字体。
- **代码字体**：`JetBrains Mono`（本地打包可变 woff2，weight 400–800），专用于系统/状态/数字/代码。

| 等级 | 字号 | 字重 | 说明 |
|---|---|---|---|
| Page Main Title | 24px | 800 | 页面大标题，`-0.03em` |
| Brand Title | 14.5px | 700 | 顶栏品牌名 |
| Card / Section Title | 16–17px | 700 | 卡片标题 |
| Body | 13.5–14.5px | 400 | 正文、气泡 |
| Caption | 12–12.5px | 500 | 辅助说明 |
| Eyebrow / Mono | 10–11px | 700 | 全大写 + 字距 0.08em，mono |

**The No-Mono-Prose Rule**：JetBrains Mono 只承载标签、数字、状态、代码；绝不用它排正文或标题。

## 形状与材质（Shapes & Materials）

- **圆角阶梯**：`8px`(sm) / `12px`(md) / `18px`(lg) / `24px`(xl，卡片) / `9999px`(胶囊)。
- **顶栏**：`rgba(255,255,255,.75)` + `backdrop-filter: blur(16px)` 磨砂穿透，底部 `1px alpha-08` 边。
- **内嵌边框**：`box-shadow: inset 0 0 0 1px rgba(38,33,28,.07)` 用于 24px 大圆角下的无锯齿描边（`--shadow-inset-border`）。
- **阴影阶梯**：`xs`(按钮) / `sm`(气泡) / `card`(浮岛) / `float`(阅读器大浮岛、设置浮层)。

## 组件（Components）

### 顶栏（app-header）

`srgba(255,255,255,.75)` 磨砂、`56px` 高、左右布局。左侧：品牌徽标（深底图标 + 名称/副标题）+ 导航 tab 胶囊；右侧：日期胶囊 + Agent 状态徽标 + 图标按钮。

### 导航 Tab（nav-tabs，Segmented Control）

胶囊容器（`alpha-06` 底 + `alpha-08` 边），激活项为纯白药丸 + 微阴影 + 加粗，**绝不加紫**。

### 按钮（btn）

- **Primary**：紫底白字，仅用于终极 CTA（提交入库 / 发送）。
- **Secondary**：暖炭黑底白字。
- **Outline**：白底 + alpha 线框。
- **Ghost**：透明，hover 灰底。
- `active` 时 `scale(0.98)`。

### 卡片（card / task-card / settings-card）

纯白浮岛：`#FFFFFF` 底 + `alpha-08` 边 + `--radius-xl` 圆角 + `--shadow-card`。

### 聊天气泡（chat-message-row / user-bubble / agent-bubble）

- 用户：右对齐，暖炭黑底白字，`16px` 圆角 + 右下 `4px` 尾巴角。
- Agent：左对齐，纯白底 + `alpha-08` 边，`18px` 圆角 + 左下 `4px` 尾巴角，正文用 markdown 渲染。
- 流式输出在正文末尾追加紫色 `▍` 光标（`.stream-cursor`，`blink` 动画）。

### 思考折叠（thinking-accordion）

`alpha-02` 底 + 圆角，头部「思考过程 ▸」点击展开/收起 `.thinking-body`。

### 工具卡片（tool-call-card）

头部（状态 glyph `●/✓/✗` + mono 工具名 + 参数摘要 + 状态标签）点击展开输出体（`surface-subtle` 底 mono 文本）。状态色：running=`--color-suggestion`（#905910 莫兰迪黄，非高饱和黄）、done=`--color-success`（紫）、error=`--color-danger`。

### 设置页（settings-page，core 提供）

四 tab（模型 / 凭证 / 飞书 / 其他），tab 复用 Segmented 胶囊样式。内部用 task-card 两列网格；飞书 tab 桌面端可隐藏。业务凭证由 `CredentialStore.registerSchema` 动态注册渲染。

## 动效（Motion）

- **核心曲线**：`--ease-silky: cubic-bezier(0.16, 1, 0.3, 1)`。
- **画布流转**：`--transition-canvas`（450ms 减速），分类切换时环境色平滑浸润。
- **页面进场**：`pageEnter`（opacity 0→1 + translateY 12px→0，450ms）。
- **侧栏收起**：animate `width`/`min-width`/`transform`（350ms silky），而非跳变。

## Do's and Don'ts

### Do:

- **Do** 让紫保持稀有——只在 CTA / 勾选确认 / 聚焦环出现（The One Voice Rule）。
- **Do** 让内容锚定纯白浮岛，环境画布尽情变换但卡片永不染色（White Surface Grounding）。
- **Do** 用渐进 Alpha 阶梯做分隔与层级，而非粗硬灰边框。
- **Do** 用 24px 大圆角 + 1px 内嵌边框承载浮岛卡片。
- **Do** 复用 `--color-success` / `--color-danger` / `--color-suggestion` 三组语义色，勿另造绿/红/黄。
- **Do** 侧栏收起/展开 animate 容器尺寸，而非瞬间跳变。
- **Do** 让应用通过 `data-canvas` / `App.setCanvas` 驱动画布，core 不猜具体项目的分类。

### Don't:

- **Don't** 引入 SaaS 蓝渐变或玻璃拟态炫技（顶栏磨砂是唯一例外，且仅 16px）。
- **Don't** 给卡片加 Material 式重投影（最高只用 `--shadow-float`）。
- **Don't** 用 mono 字体排正文或标题。
- **Don't** 在紫之外发明新的强调色相。
- **Don't** 让内容卡片跟随画布染色。
- **Don't** 在 core 里硬编码某个具体项目的「分类 → 颜色」映射（那属于内容层）。
