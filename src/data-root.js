/**
 * data-root.js — 数据根（DATA_ROOT）解析器（通用版）。
 *
 * 把「应用锚点（APP_ROOT，只读代码 + 配置）」与「业务数据根（DATA_ROOT，
 * 全部可写数据）」分离：
 *
 *  - 打包便携：exe 所在目录（PORTABLE_EXECUTABLE_DIR）为锚点，业务数据默认 exe 旁 data/
 *  - 开发模式：由调用方传入 devRoot（内容层通常传项目根），锚点与数据根默认同为此处
 *  - 可配置：<APP_ROOT>/config/data-root.json 里的 dataRoot 字段（设置页「数据目录」）
 *
 * 本模块不含任何具体项目的迁移逻辑（内容层如有旧数据迁移，自行实现）。
 */
const path = require('node:path');
const fs = require('node:fs');

function isPackaged(opts) {
  if (opts && typeof opts.isPackaged === 'boolean') return opts.isPackaged;
  // eslint-disable-next-line global-require
  return require('electron').app.isPackaged;
}

function exeDir(opts) {
  if (opts && opts.exeDir) return opts.exeDir;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  // eslint-disable-next-line global-require
  return path.dirname(require('electron').app.getPath('exe'));
}

/** 应用锚点：打包 = exe 所在目录；开发 = opts.devRoot（缺省当前工作目录） */
function appRoot(opts) {
  if (isPackaged(opts)) return exeDir(opts);
  return path.resolve((opts && opts.devRoot) || process.cwd());
}

/** 业务数据根默认值：打包 = exe 旁 data/；开发 = appRoot */
function defaultDataRoot(opts) {
  if (isPackaged(opts)) return path.join(exeDir(opts), 'data');
  return appRoot(opts);
}

/** 数据根配置文件（与 pi-settings.json 解耦：后者被 pi 白名单式覆盖） */
function dataRootConfigPath(opts) {
  return path.join(appRoot(opts), 'config', 'data-root.json');
}

/** 解析最终 DATA_ROOT：config 里的 dataRoot 优先（必须存在），否则默认值 */
function resolveDataRoot(opts) {
  const fallback = defaultDataRoot(opts);
  try {
    const cfg = JSON.parse(fs.readFileSync(dataRootConfigPath(opts), 'utf8'));
    if (typeof cfg.dataRoot === 'string' && cfg.dataRoot.trim() && fs.existsSync(cfg.dataRoot)) {
      return path.resolve(cfg.dataRoot.trim());
    }
  } catch { /* 无配置 → 默认 */ }
  return fallback;
}

/** 保存 dataRoot 配置（保留 config 里其他字段） */
function setDataRoot(dir, opts) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new Error('目录不存在');
  if (!fs.statSync(resolved).isDirectory()) throw new Error('不是目录');
  const file = dataRootConfigPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 新建 */ }
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, dataRoot: resolved }, null, 2)}\n`, 'utf8');
  return resolved;
}

/** 打包后解包到 app.asar.unpacked/scripts 的脚本目录；开发模式由调用方指定 */
function scriptsDir(opts) {
  if (isPackaged(opts)) {
    const resources = (opts && opts.resourcesPath) || process.resourcesPath;
    return path.join(resources, 'app.asar.unpacked', 'scripts');
  }
  if (opts && opts.devScriptsDir) return path.resolve(opts.devScriptsDir);
  return path.resolve(process.cwd(), 'scripts');
}

module.exports = {
  isPackaged,
  exeDir,
  appRoot,
  defaultDataRoot,
  dataRootConfigPath,
  resolveDataRoot,
  setDataRoot,
  scriptsDir,
};
