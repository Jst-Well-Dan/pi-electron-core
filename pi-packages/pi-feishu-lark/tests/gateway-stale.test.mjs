import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_KEY = "pi-feishu-lark.feishu-gateway";

// 单进程内 config.ts 的 ROOT_DIR / LOCKS_PATH 在首次 import 时固定一次，
// 因此整个测试共享同一个临时 feishu root。
const root = mkdtempSync(join(tmpdir(), "gl-suite-"));
process.env.PI_FEISHU_ROOT = join(root, ".pi", "feishu").replace(/\\/g, "/");
const url = pathToFileURL(join(repoRoot, ".pi/extensions/feishu/gateway-lock.ts")).href;

const feishuDir = join(root, ".pi", "feishu");
mkdirSync(feishuDir, { recursive: true });
const locksPath = join(feishuDir, "locks.json");

function writeLocks(owner) {
  writeFileSync(locksPath, JSON.stringify({ [LOCK_KEY]: owner }, null, 2) + "\n", "utf8");
}

function staleOwner(pid, cwd, status) {
  return {
    key: LOCK_KEY,
    pid,
    token: `stale-${pid}`,
    cwd,
    startedAt: "2020-01-01T00:00:00.000Z",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
    status,
  };
}

test("gateway lock stale reaping: dead pid + cwd mismatch is reaped", async () => {
  const gl = await import(url);
  writeLocks(staleOwner(2147483647, "E:\\Some\\Other\\Project", "connected"));

  // 过滤后的 readGatewayOwner 为空 → 自动启动不会被误判 busy
  assert.equal(gl.readGatewayOwner(), undefined);
  assert.equal(gl.isGatewayOwnerStale(gl.readGatewayOwnerRaw()), true);

  const reap = await gl.reapStaleGatewayLock();
  assert.equal(reap.status, "reaped");
  assert.equal(gl.readGatewayOwnerRaw(), undefined);
  assert.equal(gl.readGatewayOwner(), undefined);
});

test("gateway lock stale reaping: live owner with matching cwd is NOT reaped", async () => {
  const gl = await import(url);
  writeLocks({
    key: LOCK_KEY,
    pid: process.pid,
    token: "self",
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "connected",
  });

  assert.equal(gl.isGatewayOwnerStale(gl.readGatewayOwnerRaw()), false);
  assert.ok(gl.readGatewayOwner()); // 过滤后仍可见（存活持有者）

  const reap = await gl.reapStaleGatewayLock();
  assert.equal(reap.status, "none"); // 存活持有者不应被误清
  assert.ok(gl.readGatewayOwnerRaw()); // 锁保留
});
