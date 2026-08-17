/**
 * self-check.js — pi RPC 通信层自检（不依赖 Electron）
 *
 * 起一个 `pi --mode rpc --no-session` 子进程，发一条无害 prompt，
 * 断言能收到 agent_settled。供 CLI 包装（check-pi.js）和内容层自己的
 * check:pi 脚本复用——cwd 由调用方决定（不同项目的技能发现依赖不同的
 * 项目根目录，这个模块本身不假设任何具体路径）。
 */
const { PiRpcClient } = require('../src/pi-rpc');

/**
 * @param {object} opts
 * @param {string} opts.cwd pi 子进程工作目录（技能发现依据）
 * @param {string} [opts.prompt] 默认发一句无害确认语
 * @param {number} [opts.timeoutMs] 等待 agent_settled 的超时
 * @returns {Promise<{ ok: boolean, text: string, toolCalls: number }>}
 */
function runSelfCheck(opts) {
  const cwd = opts.cwd;
  const prompt = opts.prompt || '只回复四个字：自检通过';
  const timeoutMs = opts.timeoutMs || 600000;

  const client = new PiRpcClient({ args: ['--no-session'], cwd, name: 'rpc-selfcheck' });
  let text = '';
  let tools = 0;

  client.on('message_update', (ev) => {
    const d = ev.assistantMessageEvent;
    if (d && d.type === 'text_delta') {
      text += d.delta;
      process.stdout.write(d.delta);
    }
  });
  client.on('tool_execution_start', () => { tools += 1; });

  return new Promise((resolve, reject) => {
    client.on('error', (e) => reject(e));
    (async () => {
      client.spawn();
      await new Promise((r) => setTimeout(r, 1200));
      await client.send({ type: 'prompt', message: prompt });
      const outcome = await client.waitForSettled(timeoutMs);
      client.kill();
      resolve({ ok: outcome === 'settled', text, toolCalls: tools, outcome });
    })().catch(reject);
  });
}

module.exports = { runSelfCheck };
