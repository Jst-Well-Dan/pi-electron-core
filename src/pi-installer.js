/**
 * pi-installer.js — Pi CLI runtime detection and explicit, user-approved installation.
 *
 * This module never installs anything on its own. The Electron UI must obtain user
 * confirmation first, then invoke install() through a narrowly-scoped IPC handler.
 */
const { spawn } = require('node:child_process');
const { resolvePiCommand } = require('./pi-rpc');

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const INSTALL_ARGS = ['install', '-g', '--ignore-scripts', PI_PACKAGE];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Run a command without a shell and return captured output. */
function runCommand(command, args, { env = process.env, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    const forward = (stream, chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (onOutput) onOutput({ stream, text });
    };
    child.stdout.on('data', (chunk) => forward('stdout', chunk));
    child.stderr.on('data', (chunk) => forward('stderr', chunk));
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      resolve({ command, args, exitCode, signal, stdout, stderr });
    });
  });
}

class PiInstaller {
  constructor({ resolvePi = resolvePiCommand, run = runCommand, env = process.env, getNpmCommand = npmCommand } = {}) {
    this.resolvePi = resolvePi;
    this.run = run;
    this.env = env;
    this.getNpmCommand = getNpmCommand;
    this.installPromise = null;
  }

  async _probeNpm() {
    const command = this.getNpmCommand();
    try {
      const result = await this.run(command, ['--version'], { env: this.env });
      if (result.exitCode === 0) {
        return { available: true, command, version: result.stdout.trim() || null };
      }
      return { available: false, command, reason: (result.stderr || result.stdout || 'npm 返回了非零退出码').trim() };
    } catch (error) {
      return { available: false, command, reason: error.message };
    }
  }

  /** Describe whether this machine can start Pi and, when not, whether it can install it. */
  async getStatus() {
    const resolved = this.resolvePi();
    if (resolved) {
      return {
        installed: true,
        cliPath: resolved.script,
        nodePath: resolved.node,
        installable: false,
        message: 'Pi 已就绪。',
      };
    }

    const npm = await this._probeNpm();
    if (npm.available) {
      return {
        installed: false,
        installable: true,
        npm,
        message: '尚未检测到 Pi；可在本机全局安装。',
      };
    }
    return {
      installed: false,
      installable: false,
      npm,
      message: '尚未检测到 Pi，且无法使用 npm。请先安装 Node.js LTS。',
    };
  }

  /**
   * Install Pi globally. Callers must have already obtained explicit user consent.
   * @param {(event: {kind: string, text: string, stream?: string}) => void} [onProgress]
   */
  async install({ onProgress } = {}) {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this._install({ onProgress }).finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  async _install({ onProgress }) {
    const existing = this.resolvePi();
    if (existing) {
      return {
        ...(await this.getStatus()),
        alreadyInstalled: true,
      };
    }

    const npm = await this._probeNpm();
    if (!npm.available) {
      throw new Error(`无法启动 npm：${npm.reason || '未找到 npm'}。请先安装 Node.js LTS。`);
    }

    const commandText = `${npm.command} ${INSTALL_ARGS.join(' ')}`;
    onProgress?.({ kind: 'started', text: `正在执行：${commandText}` });
    let result;
    try {
      result = await this.run(npm.command, INSTALL_ARGS, {
        env: this.env,
        onOutput: ({ stream, text }) => onProgress?.({ kind: 'output', stream, text }),
      });
    } catch (error) {
      throw new Error(`无法启动安装程序：${error.message}`);
    }

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `退出码 ${result.exitCode}`).trim();
      throw new Error(`Pi 安装失败：${detail}`);
    }

    const status = await this.getStatus();
    if (!status.installed) {
      throw new Error('npm 已完成，但应用仍无法定位 Pi。请重启工作台，或设置 PI_CLI_PATH 指向 Pi 的 dist/cli.js。');
    }
    onProgress?.({ kind: 'complete', text: 'Pi 已安装并可启动。' });
    return { ...status, installedNow: true };
  }
}

module.exports = { PI_PACKAGE, INSTALL_ARGS, npmCommand, runCommand, PiInstaller };
