/**
 * src/cli/util.js — CLI 共享：core 自定位、参数解析、交互问答、断言。
 * 零第三方依赖。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/** CLI 所在包的根 = core 根（bin/../）。require 自身包避免解析歧义。 */
function coreRoot() {
  return path.resolve(__dirname, '..', '..');
}

function corePkg() {
  return JSON.parse(fs.readFileSync(path.join(coreRoot(), 'package.json'), 'utf8'));
}

/** 极简 flags 解析：--key value / --key=value / --flag。返回 {_: [], key: val} */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { out[key] = argv[i + 1]; i += 1; }
    else out[key] = true;
  }
  return out;
}

/** 缺参时交互问答；--yes 或非 TTY 则直接取默认值。 */
async function fillMissing(specs, args) {
  const result = {};
  const missing = specs.filter((s) => args[s.key] === undefined || args[s.key] === true);
  let ask = null;
  if (missing.length && !args.yes && process.stdin.isTTY) {
    ask = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  try {
    for (const s of specs) {
      if (args[s.key] !== undefined && args[s.key] !== true) { result[s.key] = args[s.key]; continue; }
      if (ask) {
        const answer = await new Promise((res) => ask.question(`${s.label}${s.default ? `（默认 ${s.default}）` : ''}: `, res));
        result[s.key] = (answer || '').trim() || s.default;
      } else {
        result[s.key] = s.default;
      }
    }
  } finally {
    if (ask) ask.close();
  }
  return result;
}

/** 断言 core 导出存在；缺失即抛错（防漂移：模板与实现脱节时大声失败）。 */
function assertCoreApi() {
  const root = coreRoot();
  const mainApp = require(path.join(root, 'electron', 'main-app.js'));
  for (const k of ['registerCoreIpc', 'registerCoreSettingsIpc', 'createChatSessionWithSettings']) {
    if (typeof mainApp[k] !== 'function') throw new Error(`core 已漂移：electron/main-app.js 缺少 ${k}()，请先升级 CLI 或 core`);
  }
  const index = require(path.join(root, 'index.js'));
  for (const k of ['resolveDataRoot', 'setDataRoot', 'CredentialStore', 'FeishuManager']) {
    if (index[k] === undefined) throw new Error(`core 已漂移：index.js 缺少 ${k}，请先升级 CLI 或 core`);
  }
  const bridge = require(path.join(root, 'electron', 'preload-bridge.js'));
  if (typeof bridge.coreWorkbenchBridge !== 'function') throw new Error('core 已漂移：preload-bridge.js 缺少 coreWorkbenchBridge()');
  return { mainApp, index, bridge };
}

/** 校验 core 渲染层资产存在，返回 { rel: absPath }。缺失即抛错。 */
function assertRendererAssets() {
  const root = coreRoot();
  const rels = ['styles.css', 'app.js', 'shell.js', 'lib/markdown.js', 'pages/chat.js', 'pages/settings-page.js'];
  const out = {};
  for (const rel of rels) {
    const abs = path.join(root, 'electron', 'renderer', rel);
    if (!fs.existsSync(abs)) throw new Error(`core 已漂移：electron/renderer/${rel} 不存在，无法生成可运行的脚手架`);
    out[rel] = abs;
  }
  return out;
}

/** 从 core 自身 index.html 逐字提取 Agent 侧栏 <aside>（single source of truth）。 */
function extractSidebar() {
  const html = fs.readFileSync(path.join(coreRoot(), 'electron', 'renderer', 'index.html'), 'utf8');
  const m = html.match(/<aside class="agent-sidebar"[\s\S]*?<\/aside>/);
  if (!m) throw new Error('core 已漂移：core index.html 里找不到 <aside class="agent-sidebar">，无法提取侧栏模板');
  return m[0];
}

/** 从 core settings-page.js 解析设置 tab id 列表，用于校验扩展目标。 */
function coreSettingsTabs() {
  const src = fs.readFileSync(path.join(coreRoot(), 'electron', 'renderer', 'pages', 'settings-page.js'), 'utf8');
  const ids = [...src.matchAll(/data-settings-tab="([a-z-]+)"/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

/** 解析 --credentials：id:label:env,...（label/env 可省）。 */
function parseCredentials(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [id, label, env] = item.split(':').map((s) => (s || '').trim());
    if (!id) throw new Error(`--credentials 解析失败：${item}（格式 id:label:env）`);
    return { id, label: label || id, env: env || '' };
  });
}

module.exports = { coreRoot, corePkg, parseArgs, fillMissing, assertCoreApi, assertRendererAssets, extractSidebar, coreSettingsTabs, parseCredentials };
