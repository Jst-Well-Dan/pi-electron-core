const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const INDEX_VERSION = 1;
const DEFAULT_TITLE = '新对话';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

function compactTitle(value, maxLength = 60) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return DEFAULT_TITLE;
  return title.length > maxLength ? `${title.slice(0, maxLength)}…` : title;
}

function timestampOf(value) {
  if (!value) return 0;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function pathKey(value) {
  let resolved = path.resolve(value || '');
  try { resolved = fs.realpathSync.native(resolved); } catch { /* missing paths stay resolved textually */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function parseSessionLines(sessionPath) {
  const raw = fs.readFileSync(sessionPath, 'utf8');
  const lines = raw.split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (!line.trim()) continue;
    try {
      records.push({ index, entry: JSON.parse(line) });
    } catch {
      const remaining = lines.slice(index + 1).some((candidate) => candidate.trim());
      if (remaining) throw new Error('会话文件中包含损坏的 JSONL 记录');
      // Pi 可能正在追加最后一行；迁移副本必须丢弃该碎片并保留换行，
      // 否则 Pi 后续 append 会直接拼到损坏片段末尾。
      lines[index] = '';
    }
  }
  const header = records[0] && records[0].entry;
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') {
    throw new Error('缺少有效的 Pi 会话头');
  }
  if (records.slice(1).some(({ entry }) => entry.type === 'session')) {
    throw new Error('Pi 会话头只能位于第一条记录');
  }
  return { raw, lines, records, header };
}

/** Parse one Pi session JSONL file without changing it. */
function summarizeSessionFile(sessionPath) {
  const stat = fs.statSync(sessionPath);
  const { records, header } = parseSessionLines(sessionPath);
  let explicitName = '';
  let firstPrompt = '';
  let latestTimestamp = stat.mtimeMs;
  let messageCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let model = null;
  let lastStopReason = null;

  for (const { entry } of records.slice(1)) {
    latestTimestamp = Math.max(latestTimestamp, timestampOf(entry.timestamp));
    if (entry.type === 'session_info' && typeof entry.name === 'string') {
      explicitName = entry.name.trim();
      continue;
    }
    if (entry.type === 'model_change') {
      model = { provider: entry.provider || '', id: entry.modelId || '' };
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;

    const message = entry.message;
    if (message.role === 'user') {
      messageCount += 1;
      userMessages += 1;
      if (!firstPrompt) firstPrompt = contentText(message.content);
    } else if (message.role === 'assistant') {
      messageCount += 1;
      assistantMessages += 1;
      if (message.provider || message.model) model = { provider: message.provider || '', id: message.model || '' };
      if (message.stopReason) lastStopReason = message.stopReason;
      const blocks = Array.isArray(message.content) ? message.content : [];
      toolCalls += blocks.filter((block) => block && block.type === 'toolCall').length;
    }
  }

  const createdAtMs = timestampOf(header.timestamp) || stat.birthtimeMs || stat.ctimeMs;
  return {
    id: header.id,
    fileName: path.basename(sessionPath),
    cwd: header.cwd,
    migratedFrom: typeof header.piElectronMigratedFrom === 'string' ? header.piElectronMigratedFrom : '',
    title: compactTitle(explicitName === 'pi agent 会话' ? firstPrompt : (explicitName || firstPrompt)),
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(latestTimestamp || createdAtMs).toISOString(),
    messageCount,
    userMessages,
    assistantMessages,
    toolCalls,
    model,
    lastStopReason,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (firstError) {
    try { fs.unlinkSync(file); } catch { /* missing destination */ }
    try {
      fs.renameSync(temp, file);
    } catch (secondError) {
      try { fs.unlinkSync(temp); } catch { /* best effort cleanup */ }
      throw secondError || firstError;
    }
  }
}

function migrateSessionFile(sessionPath, sessionDir, projectRoot) {
  const { lines, records, header } = parseSessionLines(sessionPath);
  if (samePath(header.cwd, projectRoot)) return sessionPath;
  if (fs.existsSync(path.resolve(header.cwd))) throw new Error('该会话属于另一个仍存在的项目目录，已拒绝切换');

  const now = new Date();
  const id = randomUUID();
  const migratedHeader = {
    ...header,
    id,
    timestamp: now.toISOString(),
    cwd: path.resolve(projectRoot),
    parentSession: path.resolve(sessionPath),
    piElectronMigratedFrom: path.basename(sessionPath),
  };
  const firstRecordLine = records[0].index;
  lines[firstRecordLine] = JSON.stringify(migratedHeader);
  const fileName = `${now.toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`;
  const target = path.join(sessionDir, fileName);
  fs.writeFileSync(target, lines.join('\n'), { encoding: 'utf8', flag: 'wx' });
  return target;
}

class SessionCatalog {
  constructor({ sessionDir, indexPath, projectRoot }) {
    this.sessionDir = path.resolve(sessionDir);
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.indexPath = path.resolve(indexPath || path.join(path.dirname(this.sessionDir), 'sessions-index.json'));
    this.sessions = [];
    this._signature = null;
  }

  refresh() {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    let sessions = [];
    for (const entry of fs.readdirSync(this.sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        sessions.push(summarizeSessionFile(path.join(this.sessionDir, entry.name)));
      } catch { /* one invalid session must not hide the remaining history */ }
    }
    const migratedSources = new Set(sessions.map((session) => session.migratedFrom).filter(Boolean));
    sessions = sessions.filter((session) => !migratedSources.has(session.fileName));
    sessions.sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
    this.sessions = sessions;
    const signature = JSON.stringify(sessions);
    if (signature !== this._signature || !fs.existsSync(this.indexPath)) {
      writeJsonAtomic(this.indexPath, { version: INDEX_VERSION, generatedAt: new Date().toISOString(), sessions });
      this._signature = signature;
    }
    return sessions;
  }

  find(sessionId) {
    this.refresh();
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const sessionPath = path.resolve(this.sessionDir, session.fileName);
    if (path.dirname(sessionPath) !== this.sessionDir || !fs.existsSync(sessionPath)) return null;
    return { ...session, sessionPath };
  }

  continueTarget() {
    const sessions = this.refresh();
    for (const session of sessions) {
      try { return this.switchTarget(session.id); } catch { /* try the next eligible local session */ }
    }
    return null;
  }

  switchTarget(sessionId) {
    const session = this.find(sessionId);
    if (!session) return null;
    if (samePath(session.cwd, this.projectRoot)) return session;
    const sessionPath = migrateSessionFile(session.sessionPath, this.sessionDir, this.projectRoot);
    const migrated = summarizeSessionFile(sessionPath);
    return { ...migrated, sessionPath };
  }

  list(activeSessionId) {
    this.refresh();
    return this.sessions.map(({ fileName, cwd, migratedFrom, ...session }) => {
      const available = samePath(cwd, this.projectRoot);
      const needsMigration = !available && !fs.existsSync(path.resolve(cwd));
      return {
        ...session,
        active: session.id === activeSessionId,
        available,
        needsMigration,
        unavailableReason: available || needsMigration ? '' : '属于另一个项目目录',
      };
    });
  }
}

module.exports = {
  SessionCatalog,
  summarizeSessionFile,
  migrateSessionFile,
  compactTitle,
  contentText,
  samePath,
  INDEX_VERSION,
};
