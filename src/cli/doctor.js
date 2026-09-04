/**
 * src/cli/doctor.js — 校验一个已生成的应用是否符合 pi-electron-core 接入规范。
 * 10 项：语法 / core 导出 / 渲染资产 / 资源引用 / 侧栏 / CSP / 画布 / hidden /
 *        数据目录 / 桥接与凭证。全部通过 exit 0，否则 exit 1。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, assertCoreApi, assertRendererAssets } = require('./util');

function check(deskside, results, name, fn) {
  try {
    const detail = fn() || '';
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`FAIL ${name} — ${e.message}`);
  }
}
function need(cond, msg) { if (!cond) throw new Error(msg); }
function read(p) {
  if (!fs.existsSync(p)) throw new Error(`缺少文件：${path.basename(p)}`);
  return fs.readFileSync(p, 'utf8');
}

async function runDoctor(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root || process.cwd());
  const desk = path.join(root, 'desktop');
  need(fs.existsSync(desk), `找不到 desktop/：${desk}（先跑 init，或用 --root 指向应用根）`);
  const results = [];
  const main = path.join(desk, 'electron', 'main.js');
  const preload = path.join(desk, 'electron', 'preload.js');
  const html = path.join(desk, 'electron', 'renderer', 'index.html');

  check(desk, results, 'JS 语法', () => {
    const files = [main, preload,
      ...fs.readdirSync(path.join(desk, 'electron', 'renderer', 'pages')).map((f) => path.join(desk, 'electron', 'renderer', 'pages', f))];
    for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    return `${files.length} 个文件`;
  });
  check(desk, results, 'core 导出', () => { assertCoreApi(); return 'main-app/index/bridge 均存在'; });
  check(desk, results, 'core 渲染资产', () => { const a = assertRendererAssets(); return `${Object.keys(a).length} 个文件`; });
  check(desk, results, '资源引用', () => {
    const h = read(html);
    for (const rel of ['styles.css', 'app.js', 'shell.js', 'lib/markdown.js', 'pages/chat.js', 'pages/settings-page.js']) {
      need(h.includes(`pi-core://renderer/${rel}`), `index.html 未引用 pi-core://renderer/${rel}`);
    }
    return '6 处 pi-core:// 引用齐全（含 chat.js/shell.js）';
  });
  check(desk, results, 'Agent 侧栏', () => {
    const h = read(html);
    need(h.includes('<aside class="agent-sidebar"'), '缺少 <aside class="agent-sidebar">（chat.js 无处挂载）');
    need(h.includes('id="sidebar-toggle"'), '缺少 #sidebar-toggle（侧栏不可收起）');
    need(h.includes('id="settings-trigger"'), '缺少 #settings-trigger（设置无入口）');
    return 'aside + 收起按钮 + 设置齿轮齐全';
  });
  check(desk, results, 'CSP 放行', () => {
    const h = read(html);
    const csp = (h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
    need(csp, '缺少 CSP meta');
    for (const d of ['script-src', 'style-src', 'font-src']) {
      need(new RegExp(`${d}[^;]*pi-core:`).test(csp), `CSP ${d} 未放行 pi-core:`);
    }
    return 'script/style/font 均放行 pi-core:';
  });
  check(desk, results, '情境画布', () => {
    const h = read(html);
    const actives = h.match(/class="page-view active"/g) || [];
    need(actives.length === 1, `有 ${actives.length} 个 active page-view（必须恰好 1 个）`);
    const views = [...h.matchAll(/<section id="(page-[^"]+)" class="page-view[^"]*"([^>]*)>/g)];
    need(views.length >= 1, '找不到 .page-view');
    for (const v of views) need(/data-canvas="#/.test(v[2]), `${v[1]} 缺少 data-canvas`);
    return `${views.length} 个 page-view，各有 data-canvas`;
  });
  check(desk, results, 'hidden 优先级', () => {
    need(read(html).includes('[hidden]{display:none !important}'), '缺少 [hidden]{display:none !important}（空状态会盖掉 hidden）');
    return '全局规则存在';
  });
  check(desk, results, '协议与数据目录', () => {
    const m = read(main);
    need(m.includes('registerSchemesAsPrivileged'), '缺少 registerSchemesAsPrivileged');
    need(m.includes("hostname !== 'renderer'") || m.includes('hostname !=="renderer"'), 'pi-core 协议缺少 hostname 校验');
    need(m.includes('Access-Control-Allow-Origin'), 'pi-core 协议缺少 CORS 头（字体 403）');
    need(m.includes('configurable: true'), 'dataRoot 未传 configurable:true（选择按钮会被隐藏）');
    need(m.includes('choose:') && m.includes('set:'), 'dataRoot 缺少 choose/set');
    return '协议三件套 + 数据目录可配置';
  });
  check(desk, results, '桥接与凭证', () => {
    const p = read(preload);
    need(p.includes('coreWorkbenchBridge(ipcRenderer)'), 'preload 未合并 coreWorkbenchBridge');
    const m = read(main);
    need(!m.includes('CredentialStore.registerSchema'), '用了静态 CredentialStore.registerSchema（已废弃，必 crash）');
    if (!m.includes('credentialStore.registerSchema')) return 'core 桥接正常；无业务凭证（如需，用实例 API 注册）';
    return 'core 桥接 + 实例化凭证注册';
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[doctor] ${results.length - failed.length}/${results.length} 通过 — ${root}`);
  return failed.length ? 1 : 0;
}

module.exports = { runDoctor };
