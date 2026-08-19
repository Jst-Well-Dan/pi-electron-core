/**
 * pi-rpc.js — pi coding agent RPC 通信层
 *
 * 职责：spawn 一个 `pi --mode rpc` 子进程，提供
 *  - send(cmd): 发送一条 JSON 命令（自动带 id，返回对应 response 的 Promise）
 *  - 事件订阅：从 stdout 手工按 `\n` 分割解析 JSONL（不要用 readline，
 *    协议文档明确说明通用行读取器会错误处理 JSON 字符串内的 Unicode 分隔符）
 *  - 生命周期：kill()、进程异常退出清理
 *
 * 参考：https://pi.dev/docs/latest/rpc
 */

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * 解析出可直接 spawn 的 pi 启动方式。
 * Windows 上 npm 全局安装的是 pi.cmd shim（不能直接被 spawn 执行），
 * 但 shim 内部其实就是 `node <cli.js> %*`，所以这里直接定位 cli.js，
 * 用 node 执行，避免 shell:true 的参数转义问题。
 */
function resolvePiCommand() {
  const candidates = [];
  if (process.env.PI_CLI_PATH) {
    candidates.push({ node: 'node', script: process.env.PI_CLI_PATH });
  }

  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'npm'));
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
  }
  // npm global root（如果前面都找不到）
  roots.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));

  for (const root of roots) {
    const script = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (fs.existsSync(script)) {
      const node = path.join(root, 'node.exe');
      return { node: fs.existsSync(node) ? node : 'node', script };
    }
  }
  return null;
}

/** 子进程环境：清掉父会话的会话标识，避免子进程误继承/续接当前交互会话 */
function childEnv() {
  const env = { ...process.env };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_SUBAGENT_PARENT_SESSION;
  return env;
}

let seq = 0;
const nextId = () => `req-${Date.now().toString(36)}-${++seq}`;

class PiRpcClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]} [opts.args] 追加到 `--mode rpc` 之后的参数
   * @param {string} [opts.cwd] 子进程工作目录（技能发现、配置读取都依赖它）
   * @param {object} [opts.env] 追加/覆盖给子进程的环境变量
   * @param {string} [opts.name] 会话显示名
   */
  constructor(opts = {}) {
    super();
    this.args = opts.args || [];
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || {};
    this.name = opts.name === undefined ? 'pi-rpc' : opts.name;
    this.proc = null;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._pending = new Map(); // id -> {resolve, reject}
    this._started = false;
    this._exited = false;
    this.exitInfo = null;
    this.stderrTail = [];
  }

  /** 是否已经启动 */
  get running() {
    return this._started && !this._exited;
  }

  spawn() {
    if (this._started) return;
    const resolved = resolvePiCommand();
    if (!resolved) {
      const err = new Error(
        '无法定位 pi coding agent 的 cli.js。请在工作台「设置」的“Pi 运行环境”中安装 Pi，' +
        '或设置环境变量 PI_CLI_PATH 指向其 dist/cli.js。'
      );
      setImmediate(() => this.emit('error', err));
      throw err;
    }

    const args = [resolved.script, '--mode', 'rpc', ...this.args];
    if (this.name) args.push('--name', this.name);

    this.proc = spawn(resolved.node, args, {
      cwd: this.cwd,
      env: { ...childEnv(), ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this._started = true;

    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrTail.push(text);
      if (this.stderrTail.length > 200) this.stderrTail.shift();
      this.emit('stderr', text);
    });
    this.proc.on('error', (err) => {
      this._exited = true;
      this.emit('error', err);
    });
    this.proc.on('exit', (code, signal) => {
      this._exited = true;
      this.exitInfo = { code, signal };
      // 拒绝所有悬挂请求
      for (const [, p] of this._pending) {
        p.reject(new Error(`pi 子进程已退出 (code=${code} signal=${signal})`));
      }
      this._pending.clear();
      this.emit('exit', this.exitInfo);
    });

    return this;
  }

  /** 手工 JSONL 解析：只按 \n 分割，剥离尾部 \r */
  _onData(chunk) {
    const text = typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    this._buffer += text;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (line) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      this.emit('parse_error', line);
      return;
    }
    this.emit('raw', ev);

    if (ev.type === 'response') {
      const id = ev.id;
      if (id && this._pending.has(id)) {
        const p = this._pending.get(id);
        this._pending.delete(id);
        if (ev.success) p.resolve(ev.data ?? ev);
        else p.reject(new Error(ev.error || `命令失败: ${ev.command}`));
      }
      this.emit('response', ev);
      return;
    }

    this.emit('event', ev);
    this.emit(ev.type, ev);
  }

  /**
   * 发送命令并等待对应 response。
   * @param {object} cmd 命令对象（会补上 id）
   * @param {number} [timeoutMs] 超时（默认不超时）
   */
  send(cmd, timeoutMs) {
    if (!this.running) return Promise.reject(new Error('pi 子进程未运行'));
    const id = cmd.id || nextId();
    const full = { ...cmd, id };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (this._pending.has(id)) {
            this._pending.delete(id);
            reject(new Error(`命令超时: ${cmd.type}`));
          }
        }, timeoutMs);
      }
      // 保存 timer 以便 resolve 时清理
      this._pending.get(id).timer = timer;
      const origResolve = this._pending.get(id).resolve;
      this._pending.get(id).resolve = (v) => {
        if (timer) clearTimeout(timer);
        origResolve(v);
      };
      this.proc.stdin.write(JSON.stringify(full) + '\n');
    });
  }

  /** 只发送，不等响应 */
  sendRaw(cmd) {
    if (!this.running) return;
    this.proc.stdin.write(JSON.stringify(cmd) + '\n');
  }

  /**
   * 等待一次完整的 agent 运行结束（agent_settled 或进程退出）。
   * 返回 'settled' | 'exit'。
   */
  waitForSettled(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        this.removeListener('agent_settled', onSettled);
        this.removeListener('exit', onExit);
        this.removeListener('error', onError);
        resolve(r);
      };
      const onSettled = () => finish('settled');
      const onExit = () => finish('exit');
      const onError = () => finish('exit');
      this.on('agent_settled', onSettled);
      this.on('exit', onExit);
      this.on('error', onError);
      if (timeoutMs) {
        setTimeout(() => finish('timeout'), timeoutMs);
      }
    });
  }

  kill() {
    if (this.proc && !this._exited) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}

module.exports = { PiRpcClient, resolvePiCommand, childEnv };
