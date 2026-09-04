/**
 * test/cli-init-doctor.test.js — init 生成 + doctor 全过（纯 node，无 Electron）。
 * 跑法：node --test test/cli-init-doctor.test.js（已纳入 npm test）。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'pi-electron-core.js');

function run(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('cli init + doctor', () => {
  it('init 生成可通过 doctor 的脚手架', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-app-'));
    run(['init', '--root', target, '--name', 'demo-app', '--title', '演示工作台',
      '--pages', '工作台', '--credentials', 'demo-key:演示Key:DEMO_KEY', '--yes'], process.cwd());
    for (const rel of ['desktop/package.json', 'desktop/electron/main.js', 'desktop/electron/preload.js',
      'desktop/electron/renderer/index.html', 'desktop/electron/renderer/styles.css',
      'desktop/electron/renderer/pages/page1.js', 'desktop/electron/renderer/pages/settings-ext.js']) {
      assert.ok(fs.existsSync(path.join(target, rel)), `应生成 ${rel}`);
    }
    const html = fs.readFileSync(path.join(target, 'desktop/electron/renderer/index.html'), 'utf8');
    assert.ok(html.includes('<aside class="agent-sidebar"'), '侧栏应从 core 逐字提取');
    assert.ok(html.includes('pages/chat.js') && html.includes('shell.js'), '应引用 chat.js/shell.js');
    const out = run(['doctor', '--root', target], process.cwd());
    assert.match(out, /10\/10 通过/);
  });

  it('doctor 能发现缺侧栏的坏脚手架', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-app-'));
    run(['init', '--root', target, '--yes'], process.cwd());
    const htmlPath = path.join(target, 'desktop/electron/renderer/index.html');
    const broken = fs.readFileSync(htmlPath, 'utf8').replace(/<aside class="agent-sidebar"[\s\S]*?<\/aside>/, '');
    fs.writeFileSync(htmlPath, broken);
    let stdout = '';
    try { run(['doctor', '--root', target], process.cwd()); } catch (e) { stdout = e.stdout || ''; }
    assert.match(stdout, /FAIL Agent 侧栏/);
  });

  it('无凭证应用也能通过 doctor（正确性而非存在性）', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-app-'));
    run(['init', '--root', target, '--yes', '--credentials', ''], process.cwd());
    const out = run(['doctor', '--root', target], process.cwd());
    assert.match(out, /10\/10 通过/);
    assert.match(out, /无业务凭证/);
  });

  it('main-app.js 在无 electron 环境也可 require（CLI 校验场景，防 F1 回归）', () => {
    const target = path.join(__dirname, '..', 'electron', 'main-app.js');
    const code = [
      "const M = require('node:module');",
      'const orig = M._load;',
      'M._load = function (req) { if (req === \'electron\') throw new Error(\'no electron here\');',
      '  return orig.apply(this, arguments); };',
      `const m = require(${JSON.stringify(target)});`,
      "if (typeof m.registerCoreIpc !== 'function') throw new Error('exports missing');",
      "console.log('lazy-ok');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.match(out, /lazy-ok/);
  });
});
