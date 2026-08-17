/**
 * check-pi.js — self-check.js 的 CLI 包装
 * 用法：node check-pi.js [prompt] [--cwd <path>]
 * 默认 cwd 为当前工作目录；内容层通常有自己的 scripts/check-pi.js，
 * 传入项目根目录后调用 runSelfCheck，而不是直接跑这个文件。
 */
const { runSelfCheck } = require('./self-check');

const argv = process.argv.slice(2);
const cwdIdx = argv.indexOf('--cwd');
const cwd = cwdIdx !== -1 ? argv[cwdIdx + 1] : process.cwd();
const prompt = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1)[0];

runSelfCheck({ cwd, prompt })
  .then((r) => {
    console.log(`\n[SETTLED] outcome=${r.outcome} ok=${r.ok} textLen=${r.text.length} toolCalls=${r.toolCalls}`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('\n[CHECK FAILED]', e.message);
    process.exit(1);
  });
