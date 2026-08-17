const assert = require('node:assert/strict');
const { INSTALL_ARGS, PiInstaller } = require('../src/pi-installer');

async function testMissingPiButNpmAvailable() {
  const calls = [];
  const installer = new PiInstaller({
    getNpmCommand: () => 'test-npm',
    resolvePi: () => null,
    run: async (command, args) => {
      calls.push([command, args]);
      return { exitCode: 0, stdout: '10.0.0\n', stderr: '' };
    },
  });
  const status = await installer.getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.installable, true);
  assert.deepEqual(calls, [['test-npm', ['--version']]]);
}

async function testExplicitInstallAndRediscovery() {
  let installed = false;
  const calls = [];
  const progress = [];
  const installer = new PiInstaller({
    getNpmCommand: () => 'test-npm',
    resolvePi: () => (installed ? { node: 'node', script: '/mock/pi/dist/cli.js' } : null),
    run: async (command, args, options = {}) => {
      calls.push([command, args]);
      if (args[0] === '--version') return { exitCode: 0, stdout: '10.0.0\n', stderr: '' };
      assert.equal(command, 'test-npm');
      assert.deepEqual(args, INSTALL_ARGS);
      options.onOutput?.({ stream: 'stdout', text: 'installed\n' });
      installed = true;
      return { exitCode: 0, stdout: 'done\n', stderr: '' };
    },
  });

  const result = await installer.install({ onProgress: (event) => progress.push(event) });
  assert.equal(result.installed, true);
  assert.equal(result.installedNow, true);
  assert.ok(progress.some((event) => event.kind === 'started'));
  assert.ok(progress.some((event) => event.kind === 'output' && event.text === 'installed\n'));
  assert.ok(progress.some((event) => event.kind === 'complete'));
  assert.deepEqual(calls[1], ['test-npm', INSTALL_ARGS]);
}

async function testFailedInstallIsReported() {
  const installer = new PiInstaller({
    getNpmCommand: () => 'test-npm',
    resolvePi: () => null,
    run: async (_command, args) => {
      if (args[0] === '--version') return { exitCode: 0, stdout: '10.0.0\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'permission denied' };
    },
  });
  await assert.rejects(installer.install(), /Pi 安装失败：permission denied/);
}

(async () => {
  await testMissingPiButNpmAvailable();
  await testExplicitInstallAndRediscovery();
  await testFailedInstallIsReported();
  console.log('Pi installer tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
