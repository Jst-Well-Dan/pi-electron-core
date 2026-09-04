#!/usr/bin/env node
/**
 * pi-electron-core CLI 入口。
 * 用法: npx pi-electron-core <init|doctor> [flags]
 */
const { runInit } = require('../src/cli/init');
const { runDoctor } = require('../src/cli/doctor');

const [cmd, ...rest] = process.argv.slice(2);

(async () => {
  if (cmd === 'init') {
    const code = await runInit(rest);
    process.exit(code);
  } else if (cmd === 'doctor') {
    const code = await runDoctor(rest);
    process.exit(code);
  } else {
    console.log([
      'pi-electron-core — Pi 桌面底座脚手架与校验',
      '',
      '  npx github:Jst-Well-Dan/pi-electron-core init [--root <dir>] [--name <app>] [--title <标题>]',
      '      [--pages <a,b>] [--credentials <id:label:env,...>] [--yes] [--force]',
      '  npx github:Jst-Well-Dan/pi-electron-core doctor [--root <dir>]',
      '',
      'init 缺少的参数会进入交互问答；加 --yes 则全用默认值（agent headless 调用）。',
    ].join('\n'));
    process.exit(cmd === '--help' || cmd === '-h' ? 0 : 2);
  }
})().catch((e) => { console.error('[cli]', e.message); process.exit(1); });
