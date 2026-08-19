const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FeishuManager } = require('../src/feishu-bridge');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-electron-core-feishu-'));
}

test('FeishuManager stores config under project .pi/feishu by default', () => {
  const projectRoot = tempProject();
  const manager = new FeishuManager({ projectRoot });

  assert.equal(manager.rootDir, path.join(projectRoot, '.pi', 'feishu'));
  assert.equal(manager.configPath, path.join(projectRoot, '.pi', 'feishu', 'config.json'));
  assert.equal(manager.getStatus().source, 'none');

  const status = manager.saveConfig({
    appId: 'cli_test_project',
    appSecret: 'secret_for_unit_test',
    domain: 'feishu',
    groupPolicy: 'mention',
    autoStart: true,
  });

  assert.equal(status.source, 'file');
  const saved = JSON.parse(fs.readFileSync(manager.configPath, 'utf8'));
  assert.equal(saved.appId, 'cli_test_project');
  assert.equal(saved.appSecret, 'secret_for_unit_test');
  assert.equal(saved.cardActionMode, 'ws');
});

test('FeishuManager autoStartOnLaunch starts configured gateway when enabled', async () => {
  const projectRoot = tempProject();
  const manager = new FeishuManager({ projectRoot });
  manager.saveConfig({
    appId: 'cli_test_autostart',
    appSecret: 'secret_for_autostart',
    domain: 'feishu',
    groupPolicy: 'mention',
    autoStart: true,
  });

  let called = '';
  manager.command = async (name) => {
    called = name;
    return { ok: true, status: manager.getStatus() };
  };

  const result = await manager.autoStartOnLaunch();
  assert.equal(called, 'start');
  assert.equal(result.ok, true);
});

test('FeishuManager loads bundled extension in isolated pi RPC child', async () => {
  const projectRoot = tempProject();
  const instances = [];

  class MockClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._running = false;
      this.prompts = [];
      instances.push(this);
    }
    get running() { return this._running; }
    spawn() { this._running = true; }
    async send(cmd) {
      if (cmd.type === 'get_state') return {};
      if (cmd.type === 'get_commands') return { commands: [{ name: 'feishu' }] };
      if (cmd.type === 'prompt') {
        this.prompts.push(cmd.message);
        return {};
      }
      return {};
    }
    async waitForSettled() { return 'mock-settled'; }
    sendRaw() {}
    kill() { this._running = false; }
  }

  const manager = new FeishuManager({ projectRoot, ClientClass: MockClient });
  const result = await manager.command('status');

  assert.equal(result.ok, true);
  assert.equal(instances.length, 1);
  const client = instances[0];
  assert.equal(client.opts.cwd, projectRoot);
  assert.deepEqual(client.opts.env, { PI_FEISHU_ROOT: path.join(projectRoot, '.pi', 'feishu') });
  assert.ok(client.opts.args.includes('--no-extensions'));
  const extensionFlagIndex = client.opts.args.indexOf('-e');
  assert.notEqual(extensionFlagIndex, -1);
  assert.equal(client.opts.args[extensionFlagIndex + 1], manager.extensionPath);
  assert.ok(fs.existsSync(manager.extensionPath));
  assert.deepEqual(client.prompts, ['/feishu status']);
});
