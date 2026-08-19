/**
 * pages/settings-page.js — 通用设置页：模型 / 凭证 / 飞书 / 其他。
 *
 * 由 core 渲染到 #settings-root（DOM 由本脚本生成，不在各应用的 index.html 里
 * 重复维护）。模型、凭证、飞书三个 tab 由 core 提供；「其他」tab 为通用
 * 凭证注册制：内容层在主进程通过 CredentialStore.registerSchema 注册自己的
 * 凭证项（如某数据 API 的 Token、某平台 Cookie），本页按 schema 渲染卡片。
 * 内容层还可通过 SettingsPage.registerExtraCards 向任意 tab 追加应用专属
 * 设置卡（core 只负责挂载与生命周期，不含业务）。
 *
 * 兼容接口：window.SettingsPage = { init, onShow, activateTab, registerExtraCards }；
 * 同时注册 window.App 的 'settings' 页生命周期。
 */
(function () {
  'use strict';
  const { $, $$, el } = window.App;

  /* ============================== 通用 ============================== */

  let initialized = false;

  function setStatus(nodeId, message, kind) {
    const node = $(nodeId);
    if (!node) return;
    node.textContent = message;
    node.className = `task-status${kind ? ` ${kind}` : ''}`;
  }

  function setTag(nodeId, text, ok) {
    const tag = $(nodeId);
    if (!tag) return;
    tag.textContent = text;
    tag.className = ok ? 'tag ok' : 'tag mute';
  }

  async function openExternalUrl(url, statusNodeId) {
    try {
      if (typeof window.workbench.openExternal !== 'function') throw new Error('openExternal bridge missing');
      await window.workbench.openExternal(url);
    } catch (error) {
      const message = `⚠ 无法自动打开浏览器，请复制链接手动打开：${url}`;
      if (statusNodeId) setStatus(statusNodeId, message, 'error');
      else console.error(message, error);
    }
  }

  function activateTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
      const active = tab.dataset.settingsTab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      const active = panel.dataset.settingsPanel === name;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    const page = $('#page-settings') || document.querySelector('.settings-page');
    if (page) page.scrollTop = 0;
  }

  /* ============================== 模型 tab ============================== */

  let models = [];
  let groups = new Map();
  let selectedKey = null;
  let loaded = false;
  let installing = false;
  let lastInstallOutput = '';

  function fmtCost(m) {
    if (!m.cost) return '';
    return `$${m.cost.input}/$${m.cost.output} 每 1M tok`;
  }

  function buildGroups(list) {
    const map = new Map();
    for (const m of list) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider).push(m);
    }
    return map;
  }

  function renderList(filterText) {
    const list = $('#settings-model-list');
    if (!list) return;
    list.innerHTML = '';
    const q = (filterText || '').trim().toLowerCase();
    let shown = 0;
    for (const [provider, groupModels] of groups) {
      const filtered = q
        ? groupModels.filter((m) =>
          (m.name || '').toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          provider.toLowerCase().includes(q))
        : groupModels;
      if (!filtered.length) continue;
      list.appendChild(el('div', 'model-list-group', provider));
      for (const m of filtered) {
        const key = `${m.provider}::${m.id}`;
        const item = el('div', 'model-item');
        item.dataset.key = key;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(key === selectedKey));
        if (key === selectedKey) item.classList.add('is-selected');
        item.appendChild(el('span', null, m.name || m.id));
        const cost = fmtCost(m);
        if (cost) item.appendChild(el('span', 'model-item-cost', cost));
        item.addEventListener('click', () => {
          selectedKey = key;
          $$('.model-item', list).forEach((n) => n.classList.toggle('is-selected', n.dataset.key === key));
        });
        list.appendChild(item);
        shown += 1;
      }
    }
    if (!shown) list.appendChild(el('div', 'model-list-empty', '没有匹配的模型'));
  }

  function setModelUnavailable(message) {
    loaded = false;
    $('#settings-current-tag').textContent = '等待 Pi';
    $('#settings-current-tag').className = 'tag mute';
    $('#settings-model-list').innerHTML = '';
    setStatus('#settings-model-status', message);
  }

  function renderRuntime(status) {
    const tag = $('#pi-runtime-tag');
    const detail = $('#pi-runtime-status');
    const install = $('#btn-pi-install');
    const recheck = $('#btn-pi-runtime-recheck');
    const nodeLink = $('#pi-get-node-link');

    if (status.installed) {
      tag.textContent = '已就绪';
      tag.className = 'tag ok';
      detail.textContent = status.cliPath ? `已找到 Pi：${status.cliPath}` : 'Pi 已就绪。';
      detail.className = 'task-status done';
      install.textContent = 'Pi 已安装';
      install.disabled = true;
      recheck.disabled = false;
      nodeLink.hidden = true;
      return;
    }

    tag.textContent = '未安装';
    tag.className = 'tag warn';
    detail.textContent = status.message || '未检测到 Pi。';
    detail.className = `task-status ${status.installable ? 'running' : 'error'}`;
    install.textContent = '安装 Pi';
    install.disabled = !status.installable || installing;
    recheck.disabled = installing;
    nodeLink.hidden = !!status.installable;
  }

  async function refreshRuntime() {
    try {
      const status = await window.workbench.piRuntimeStatus();
      renderRuntime(status);
      return status;
    } catch (error) {
      setStatus('#pi-runtime-status', `⚠ 无法检查 Pi：${error.message}`, 'error');
      $('#pi-runtime-tag').textContent = '检查失败';
      $('#pi-runtime-tag').className = 'tag warn';
      $('#btn-pi-install').disabled = true;
      return { installed: false };
    }
  }

  function showInstallProgress(event) {
    if (!installing || !event) return;
    const status = $('#pi-runtime-status');
    if (event.kind === 'output' && event.text) {
      lastInstallOutput = `${lastInstallOutput}${event.text}`.split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
      status.textContent = lastInstallOutput || '正在安装 Pi…';
    } else if (event.text) {
      status.textContent = event.text;
    }
    status.className = 'task-status running runtime-progress';
  }

  async function installPi() {
    if (installing) return;
    const approved = window.confirm(
      '应用将执行 npm install -g --ignore-scripts @earendil-works/pi-coding-agent，\n以在本机全局安装 Pi。是否继续？'
    );
    if (!approved) return;

    installing = true;
    lastInstallOutput = '';
    $('#btn-pi-install').disabled = true;
    $('#btn-pi-runtime-recheck').disabled = true;
    setStatus('#pi-runtime-status', '正在准备安装 Pi…', 'running');
    try {
      await window.workbench.piInstall();
      const runtime = await refreshRuntime();
      if (runtime.installed) await loadModels();
    } catch (error) {
      $('#pi-runtime-tag').textContent = '安装失败';
      $('#pi-runtime-tag').className = 'tag warn';
      setStatus('#pi-runtime-status', `⚠ ${error.message}`, 'error');
      $('#btn-pi-install').disabled = false;
    } finally {
      installing = false;
      $('#btn-pi-runtime-recheck').disabled = false;
    }
  }

  async function loadModels() {
    setStatus('#settings-model-status', '正在加载可用模型…');
    try {
      const [list, current] = await Promise.all([
        window.workbench.settingsListModels(),
        window.workbench.settingsGetCurrentModel(),
      ]);
      models = list || [];
      groups = buildGroups(models);
      if (current) {
        selectedKey = `${current.provider}::${current.id}`;
        $('#settings-current-tag').textContent = `当前：${current.name || current.id}`;
        $('#settings-current-tag').className = 'tag ok';
      } else {
        $('#settings-current-tag').textContent = '请选择模型';
        $('#settings-current-tag').className = 'tag mute';
      }
      renderList($('#settings-model-filter').value);
      setStatus('#settings-model-status', models.length
        ? `共 ${models.length} 个可用模型。选择后点击「应用」立即切换并记住。`
        : 'Pi 已启动，但尚未发现可用模型。请配置 provider 的 API Key 或登录授权。');
      loaded = true;
    } catch (error) {
      setStatus('#settings-model-status', `⚠ 加载可用模型失败：${error.message}`, 'error');
    }
  }

  async function applyModel() {
    if (!loaded) return;
    const [provider, modelId] = (selectedKey || '').split('::');
    if (!provider || !modelId) return;
    setStatus('#settings-model-status', '切换中…', 'running');
    try {
      const model = await window.workbench.settingsSetModel(provider, modelId);
      $('#settings-current-tag').textContent = `当前：${model.name || model.id}`;
      $('#settings-current-tag').className = 'tag ok';
      setStatus('#settings-model-status', `已切换到 ${model.name || model.id}，并已记住这次选择。`, 'done');
    } catch (error) {
      setStatus('#settings-model-status', `⚠ 切换失败：${error.message}`, 'error');
    }
  }

  /* ============================== 凭证 tab ============================== */

  let oauthProviders = [];
  let pendingOAuth = null;

  function setOauthBusy(busy) {
    ['#oauth-provider', '#btn-oauth-start', '#btn-oauth-cancel', '#oauth-input', '#btn-oauth-submit']
      .forEach((selector) => { const node = $(selector); if (node) node.disabled = busy && selector !== '#btn-oauth-cancel'; });
    $('#btn-oauth-cancel').disabled = !busy;
  }

  async function refreshModelsAfterAuth() {
    try { await loadModels(); } catch { /* 模型卡自行报错 */ }
  }

  async function restartAgent() {
    if (!window.confirm('重启会保留会话历史，但会中止当前回复，并让 Pi 重新读取凭证。是否继续？')) return;
    const button = $('#btn-agent-restart');
    button.disabled = true;
    try {
      setStatus('#auth-key-status', '正在重启 Agent 并重新读取模型配置…', 'running');
      await window.workbench.chatRestart();
      await refreshModelsAfterAuth();
      await loadApiProviders();
      setStatus('#auth-key-status', 'Agent 已重启，模型列表与凭证状态已刷新。', 'done');
    } catch (error) {
      setStatus('#auth-key-status', `⚠ Agent 重启失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* API Key：Provider 下拉动态来自 Pi ModelRuntime（与 TUI 同源），凭证状态按 auth.json 精确匹配 */
  let apiProviders = [];

  async function loadApiProviders() {
    try {
      apiProviders = await window.workbench.authListProviders();
      const select = $('#auth-provider-id');
      if (!select) return;
      const previous = select.value;
      const usable = apiProviders.filter((p) => p.apiKeySupported);
      select.replaceChildren();
      if (!usable.length) {
        select.appendChild(new Option('没有可用 API Provider', ''));
        setStatus('#auth-key-status', '未发现支持 API Key 的 Provider（需先安装 Pi）。');
        return;
      }
      usable.forEach((p) => {
        select.appendChild(new Option(`${p.name}${p.configured ? ' · 已配置' : ''}`, p.id));
      });
      select.value = usable.some((p) => p.id === previous) ? previous : usable[0].id;
      refreshKeyStatus();
    } catch (error) {
      setStatus('#auth-key-status', `⚠ 无法读取 Provider 列表：${error.message}`, 'error');
    }
  }

  function refreshKeyStatus() {
    const providerId = $('#auth-provider-id').value.trim();
    const tag = $('#auth-key-tag');
    if (!providerId) {
      tag.textContent = '待选择'; tag.className = 'tag mute';
      setStatus('#auth-key-status', '选择 Provider 后检查认证状态。');
      return;
    }
    const provider = apiProviders.find((p) => p.id === providerId);
    const configured = !!provider?.configured;
    const isOAuth = provider?.type === 'oauth';
    tag.textContent = !configured ? '未配置' : (isOAuth ? 'OAuth 已连接' : 'Key 已保存');
    tag.className = configured ? 'tag ok' : 'tag mute';
    setStatus('#auth-key-status', configured
      ? `Pi 已保存 ${provider.name}（${providerId}）的${isOAuth ? ' OAuth 凭证' : ' API Key'}；不会显示明文。`
      : `尚未发现 ${providerId} 的凭证。`);
  }

  async function saveKey() {
    const providerId = $('#auth-provider-id').value.trim();
    const key = $('#auth-key-input').value;
    if (!providerId || !key.trim()) {
      setStatus('#auth-key-status', '请选择 Provider 并填写 API Key。', 'error');
      return;
    }
    setStatus('#auth-key-status', '正在交给 Pi 保存凭证…', 'running');
    try {
      await window.workbench.authSetKey(providerId, key.trim());
      $('#auth-key-input').value = '';
      await loadApiProviders();
      setStatus('#auth-key-status', 'API Key 已保存到 Pi 认证库。重启 Agent 后可加载新增模型。', 'done');
    } catch (error) {
      setStatus('#auth-key-status', `⚠ 保存失败：${error.message}`, 'error');
    }
  }

  async function clearKey() {
    const providerId = $('#auth-provider-id').value.trim();
    if (!providerId) return setStatus('#auth-key-status', '请先选择 Provider。', 'error');
    const provider = apiProviders.find((p) => p.id === providerId);
    if (provider?.type === 'oauth') return setStatus('#auth-key-status', '该 Provider 是 OAuth 订阅登录，请勿在此清除；如需登出请通过 Pi TUI。', 'error');
    if (!window.confirm(`清除 Pi 中 ${providerId} 的 API Key？`)) return;
    try {
      await window.workbench.authDeleteKey(providerId);
      await loadApiProviders();
      setStatus('#auth-key-status', '凭证已清除。重启 Agent 后模型列表会同步更新。', 'done');
    } catch (error) {
      setStatus('#auth-key-status', `⚠ 清除失败：${error.message}`, 'error');
    }
  }

  function renderOauthProviders() {
    const select = $('#oauth-provider');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    if (!oauthProviders.length) {
      select.appendChild(new Option('没有可用的 OAuth Provider', ''));
      $('#oauth-status-tag').textContent = '不可用';
      $('#oauth-status-tag').className = 'tag mute';
      return;
    }
    oauthProviders.forEach((provider) => select.appendChild(new Option(`${provider.name}${provider.configured ? ' · 已连接' : ''}`, provider.id)));
    select.value = oauthProviders.some((provider) => provider.id === previous) ? previous : oauthProviders[0].id;
    renderOauthState();
  }

  function renderOauthState() {
    const current = oauthProviders.find((provider) => provider.id === $('#oauth-provider').value);
    const tag = $('#oauth-status-tag');
    tag.textContent = current?.configured ? '已连接' : '未连接';
    tag.className = current?.configured ? 'tag ok' : 'tag mute';
    if (!pendingOAuth) setStatus('#oauth-status', current?.configured ? '已连接；可重新登录以更新授权。' : '选择服务后使用官方 OAuth 流程登录。');
  }

  async function refreshOAuth() {
    try {
      oauthProviders = await window.workbench.authListOAuthProviders();
      renderOauthProviders();
    } catch (error) {
      setStatus('#oauth-status', `⚠ OAuth 服务不可用：${error.message}`, 'error');
      $('#oauth-status-tag').textContent = '不可用';
      $('#oauth-status-tag').className = 'tag mute';
    }
  }

  function showOAuthPrompt(event) {
    pendingOAuth = event;
    const prompt = $('#oauth-prompt');
    const input = $('#oauth-input');
    const label = $('#oauth-input-label');
    const options = $('#oauth-options');
    prompt.hidden = false;
    options.replaceChildren();
    if (event.type === 'select') {
      input.closest('.settings-field').hidden = true;
      $('#btn-oauth-submit').hidden = true;
      event.options.forEach((option) => {
        const button = el('button', 'btn btn-secondary btn-sm', option.label);
        button.type = 'button';
        button.addEventListener('click', () => submitOAuth(option.id));
        options.appendChild(button);
      });
    } else {
      input.closest('.settings-field').hidden = false;
      $('#btn-oauth-submit').hidden = false;
      label.firstChild.textContent = event.message || '验证信息';
      input.type = event.secret ? 'password' : 'text';
      input.placeholder = event.placeholder || '';
      input.value = '';
      input.focus();
    }
  }

  async function startOAuth() {
    const providerId = $('#oauth-provider').value;
    if (!providerId) return;
    pendingOAuth = null;
    $('#oauth-prompt').hidden = true;
    setOauthBusy(true);
    setStatus('#oauth-status', '正在初始化官方 Pi OAuth 登录…', 'running');
    try {
      await window.workbench.authOAuthStart(providerId);
    } catch (error) {
      setOauthBusy(false);
      setStatus('#oauth-status', `⚠ 无法开始登录：${error.message}`, 'error');
    }
  }

  async function submitOAuth(value) {
    if (!pendingOAuth || !value?.trim()) return;
    try {
      setStatus('#oauth-status', '正在继续登录…', 'running');
      await window.workbench.authOAuthSubmit(pendingOAuth.providerId, pendingOAuth.token, value.trim());
      pendingOAuth = null;
      $('#oauth-prompt').hidden = true;
    } catch (error) {
      setStatus('#oauth-status', `⚠ 验证信息无效：${error.message}`, 'error');
    }
  }

  async function cancelOAuth() {
    const providerId = $('#oauth-provider').value;
    if (!providerId) return;
    await window.workbench.authOAuthCancel(providerId).catch(() => {});
    pendingOAuth = null;
    $('#oauth-prompt').hidden = true;
    setOauthBusy(false);
    renderOauthState();
  }

  function handleOAuthEvent(event) {
    if (!event || event.providerId !== $('#oauth-provider').value) return;
    if (event.type === 'auth-url') {
      setStatus('#oauth-status', event.instructions || '授权页面已在默认浏览器中打开；完成授权后返回此窗口。', 'running');
      openExternalUrl(event.url, '#oauth-status');
    } else if (event.type === 'device-code') {
      setStatus('#oauth-status', `请在浏览器完成验证，设备码：${event.userCode}`, 'running');
      openExternalUrl(event.verificationUri, '#oauth-status');
    } else if (event.type === 'input' || event.type === 'select') showOAuthPrompt(event);
    else if (event.type === 'progress') setStatus('#oauth-status', event.message || '正在登录…', 'running');
    else if (event.type === 'success') {
      pendingOAuth = null; $('#oauth-prompt').hidden = true; setOauthBusy(false);
      setStatus('#oauth-status', '登录成功。重启 Agent 后可加载新模型。', 'done');
      refreshOAuth();
    } else if (event.type === 'cancelled') {
      pendingOAuth = null; $('#oauth-prompt').hidden = true; setOauthBusy(false); renderOauthState();
    } else if (event.type === 'error') {
      pendingOAuth = null; $('#oauth-prompt').hidden = true; setOauthBusy(false);
      setStatus('#oauth-status', `⚠ 登录失败：${event.message}`, 'error');
    }
  }

  /* ============================== 飞书 tab ============================== */

  function setFeishuStatus(message, kind) {
    setStatus('#feishu-status', message, kind);
  }

  function setFeishuBusy(busy) {
    document.querySelectorAll('#settings-feishu-card button, #settings-feishu-card input, #settings-feishu-card select')
      .forEach((node) => { node.disabled = busy; });
  }

  function renderFeishu(status) {
    const tag = $('#feishu-status-tag');
    if (!tag) return;
    const configured = Boolean(status.configured);
    tag.textContent = configured ? `${status.domain === 'lark' ? 'Lark' : '飞书'} · 已配置` : '未配置';
    tag.className = configured ? 'tag ok' : 'tag mute';
    $('#feishu-domain').value = status.domain || 'feishu';
    $('#feishu-group-policy').value = status.groupPolicy || 'mention';
    $('#feishu-auto-start').checked = status.autoStart !== false;

    const envManaged = status.source === 'environment';
    $('#feishu-config-form').classList.toggle('is-environment-managed', envManaged);
    $('#feishu-app-id').placeholder = envManaged ? `由环境变量管理：${status.appId}` : configured ? `当前：${status.appId}` : 'cli_xxx';
    $('#feishu-app-id').required = !envManaged && !configured;
    $('#feishu-app-secret').required = !envManaged && !configured;
    $('#feishu-app-id').disabled = envManaged;
    $('#feishu-app-secret').disabled = envManaged;
    $('#btn-feishu-save').hidden = envManaged;
    $('#btn-feishu-qr-setup').hidden = envManaged;

    if (status.cardActionMode !== 'ws' && configured) {
      setFeishuStatus('检测到非安全的卡片回调配置；首次执行操作时将切换为 WebSocket 模式。', 'error');
    } else if (!status.busy) {
      setFeishuStatus(configured
        ? `已配置 ${status.appId}。卡片回调使用安全的 WebSocket 模式。`
        : '填写已有飞书 / Lark 应用凭证后即可启动。');
    }
  }

  async function refreshFeishu() {
    try {
      renderFeishu(await window.workbench.feishuStatus());
    } catch (error) {
      setFeishuStatus(`⚠ 无法读取飞书配置：${error.message}`, 'error');
    }
  }

  async function runFeishuCommand(command) {
    if (command === 'reset' && !window.confirm('确定重置飞书配置与会话映射？会保留 Pi 会话历史。')) return;
    setFeishuBusy(true);
    setFeishuStatus(command === 'status' ? '正在检查飞书连接…' : '正在执行飞书操作…', 'running');
    try {
      const result = await window.workbench.feishuCommand(command);
      renderFeishu(result.status);
      if (command !== 'status') setFeishuStatus('操作已提交。连接状态将通过下方消息更新。', 'done');
    } catch (error) {
      setFeishuStatus(`⚠ ${error.message}`, 'error');
    } finally {
      setFeishuBusy(false);
      refreshFeishu();
    }
  }

  async function setupFeishuByQr() {
    if (!window.confirm('将打开飞书授权页面。扫码完成后会创建或更新本机飞书配置，是否继续？')) return;
    setFeishuBusy(true);
    setFeishuStatus('正在准备飞书授权页面…', 'running');
    try {
      const result = await window.workbench.feishuSetupByQr({
        groupPolicy: $('#feishu-group-policy').value,
        autoStart: $('#feishu-auto-start').checked,
      });
      if (result?.status) renderFeishu(result.status);
      setFeishuStatus('飞书配置已创建，并已提交后台连接重启。', 'done');
    } catch (error) {
      setFeishuStatus(`⚠ ${error.message}`, 'error');
      setFeishuBusy(false);
      refreshFeishu();
    }
  }

  async function saveFeishu(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setFeishuBusy(true);
    setFeishuStatus('正在保存配置并启动飞书连接…', 'running');
    try {
      await window.workbench.feishuSaveConfig({
        domain: $('#feishu-domain').value,
        groupPolicy: $('#feishu-group-policy').value,
        appId: $('#feishu-app-id').value,
        appSecret: $('#feishu-app-secret').value,
        autoStart: $('#feishu-auto-start').checked,
      });
      $('#feishu-app-secret').value = '';
      await runFeishuCommand('restart');
    } catch (error) {
      setFeishuStatus(`⚠ ${error.message}`, 'error');
      setFeishuBusy(false);
      refreshFeishu();
    }
  }

  function handleFeishuEvent(event) {
    if (!event) return;
    if (event.status) renderFeishu(event.status);
    if (event.type === 'notice') setFeishuStatus(event.message, event.level === 'error' ? 'error' : event.level === 'warning' ? 'running' : 'done');
    if (event.type === 'qr-url') {
      setFeishuStatus('飞书授权页面已在浏览器中打开；完成扫码后请返回此窗口。', 'running');
      openExternalUrl(event.url, '#feishu-status');
    }
    if (event.type === 'status' && event.message) setFeishuStatus(event.message, 'done');
    if (event.type === 'error') setFeishuStatus(`⚠ ${event.message}`, 'error');
  }

  /* ============================== 其他 tab（数据目录 + 注册凭证） ============================== */

  // 每个注册凭证卡片的状态缓存：{ status, busy, busyActionId }
  const credentialUi = new Map();

  function defaultTagText(status) {
    if (!status.configured) return '未配置';
    if (status.source === 'environment') return status.managed ? '环境变量' : '环境托管';
    return '已配置';
  }

  function defaultDetailText(status) {
    if (!status.configured) return '未配置。请填写后保存。';
    if (status.source === 'environment') {
      return status.managed
        ? `当前使用环境变量 ${status.envName || ''}；在此保存后将优先使用页面配置。`
        : `当前由环境变量 ${status.envName || ''} 提供，应用内不可修改。`;
    }
    return `已保存到应用凭证库（${new Date(status.updatedAt || Date.now()).toLocaleString()}）。输入新值并保存可覆盖。`;
  }

  function credentialTag(status) {
    return (status.extra && status.extra.summary) || defaultTagText(status);
  }

  function credentialDetail(status) {
    return (status.extra && status.extra.detail) || defaultDetailText(status);
  }

  function buildCredentialCard(status) {
    const wrap = el('div');
    wrap.innerHTML = `
      <section class="card task-card" id="${status.cardId || `settings-${status.id}-card`}">
        <div class="task-head"><h3></h3><span class="tag mute"></span></div>
        <p class="task-desc"></p>
        <label class="settings-field"></label>
        <div class="task-actions"></div>
        <div class="task-status"></div>
      </section>`;
    const card = wrap.firstElementChild;
    card.querySelector('.task-head h3').textContent = status.label;
    card.querySelector('.task-head .tag').id = status.tagId || `${status.id}-status-tag`;
    card.querySelector('.task-head .tag').textContent = '读取中…';
    card.querySelector('.task-desc').textContent = status.description || '';
    const field = card.querySelector('.settings-field');
    field.append(document.createTextNode(status.label));
    if (status.input === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.className = 'select cookie-textarea';
      textarea.id = status.inputId || `${status.id}-input`;
      textarea.rows = 5;
      textarea.spellcheck = false;
      textarea.placeholder = status.placeholder || '';
      field.appendChild(textarea);
    } else {
      const input = document.createElement('input');
      input.className = 'select';
      input.id = status.inputId || `${status.id}-input`;
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.spellcheck = false;
      input.placeholder = status.placeholder || '';
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveCredential(status.id); });
      if (status.revealable) {
        const secretWrap = el('div', 'credential-secret-input');
        const revealBtn = el('button', 'credential-reveal-btn', '显示');
        revealBtn.type = 'button';
        revealBtn.setAttribute('aria-label', `显示${status.label}`);
        revealBtn.addEventListener('click', () => {
          const showing = input.type === 'text';
          input.type = showing ? 'password' : 'text';
          revealBtn.textContent = showing ? '显示' : '隐藏';
          revealBtn.setAttribute('aria-label', `${showing ? '显示' : '隐藏'}${status.label}`);
          input.focus();
        });
        secretWrap.append(input, revealBtn);
        field.appendChild(secretWrap);
      } else {
        field.appendChild(input);
      }
    }
    const actions = card.querySelector('.task-actions');
    const saveBtn = el('button', 'btn btn-primary btn-sm', '保存');
    saveBtn.type = 'button';
    saveBtn.id = status.saveId || `btn-${status.id}-save`;
    saveBtn.addEventListener('click', () => saveCredential(status.id));
    actions.appendChild(saveBtn);
    const clearBtn = el('button', 'btn btn-secondary btn-sm', '清除');
    clearBtn.type = 'button';
    clearBtn.id = status.clearId || `btn-${status.id}-clear`;
    clearBtn.addEventListener('click', () => clearCredential(status.id));
    actions.appendChild(clearBtn);
    for (const action of status.actions || []) {
      const btn = el('button', 'btn btn-secondary btn-sm', action.label);
      btn.type = 'button';
      btn.id = action.buttonId || `btn-${status.id}-${action.id}`;
      btn.addEventListener('click', () => runCredentialAction(status.id, action.id));
      actions.appendChild(btn);
    }
    card.querySelector('.task-status').id = status.statusId || `${status.id}-status`;
    return card;
  }

  function renderCredentialCard(status) {
    const ui = credentialUi.get(status.id) || {};
    ui.status = status;
    credentialUi.set(status.id, ui);
    const card = $(`#${status.cardId || `settings-${status.id}-card`}`);
    if (!card) return;
    const tag = card.querySelector('.task-head .tag');
    tag.textContent = credentialTag(status);
    tag.className = status.configured ? 'tag ok' : 'tag mute';
    setStatus(`#${status.statusId || `${status.id}-status`}`, credentialDetail(status));
    const input = $(`#${status.inputId || `${status.id}-input`}`);
    if (input) {
      const environmentLocked = status.source === 'environment' && !status.managed;
      input.disabled = environmentLocked;
      input.placeholder = environmentLocked ? '当前由环境变量管理' : (status.placeholder || '');
      const revealBtn = input.parentElement?.querySelector('.credential-reveal-btn');
      if (revealBtn) revealBtn.disabled = environmentLocked;
    }
    if (ui.busy) {
      card.querySelectorAll('button, input, textarea, select').forEach((node) => { node.disabled = true; });
    }
  }

  async function refreshCredentials() {
    try {
      const list = await window.workbench.credentialStatus();
      const grid = $('#datasource-grid');
      for (const status of list) {
        const cardId = status.cardId || `settings-${status.id}-card`;
        if (grid && !$(`#${cardId}`)) grid.appendChild(buildCredentialCard(status));
        renderCredentialCard(status);
      }
    } catch (error) {
      setStatus('#datasource-status', `⚠ 读取凭证失败：${error.message}`, 'error');
      $('#datasource-status').hidden = false;
    }
  }

  async function saveCredential(id) {
    const ui = credentialUi.get(id);
    const input = $(`#${ui.status.inputId || `${id}-input`}`);
    const value = input ? input.value.trim() : '';
    if (!value) {
      setStatus(`#${ui.status.statusId || `${id}-status`}`, '请先填写内容。', 'error');
      return;
    }
    setStatus(`#${ui.status.statusId || `${id}-status`}`, '保存中…', 'running');
    try {
      const status = await window.workbench.credentialSet(id, value);
      if (input) {
        input.value = '';
        input.type = 'password';
        const revealBtn = input.parentElement?.querySelector('.credential-reveal-btn');
        if (revealBtn) {
          revealBtn.textContent = '显示';
          revealBtn.setAttribute('aria-label', `显示${status.label}`);
        }
      }
      renderCredentialCard(status);
      setStatus(`#${status.statusId || `${id}-status`}`, (status.extra && status.extra.detail) || '已保存。', 'done');
    } catch (error) {
      setStatus(`#${ui.status.statusId || `${id}-status`}`, `⚠ 保存失败：${error.message}`, 'error');
    }
  }

  async function clearCredential(id) {
    const ui = credentialUi.get(id);
    if (!window.confirm(`清除「${ui.status.label}」？`)) return;
    setStatus(`#${ui.status.statusId || `${id}-status`}`, '清除中…', 'running');
    try {
      const status = await window.workbench.credentialClear(id);
      renderCredentialCard(status);
      const message = status.source === 'environment'
        ? `页面配置已清除，已回退到环境变量 ${status.envName || ''}。`
        : '已清除。';
      setStatus(`#${status.statusId || `${id}-status`}`, message, 'done');
    } catch (error) {
      setStatus(`#${ui.status.statusId || `${id}-status`}`, `⚠ 清除失败：${error.message}`, 'error');
    }
  }

  function setCredentialBusy(ui, busy) {
    const card = $(`#${ui.status.cardId || `settings-${ui.status.id}-card`}`);
    if (!card) return;
    if (busy) {
      ui.disabledControls = Array.from(card.querySelectorAll('button, input, textarea, select'))
        .map((node) => ({ node, disabled: node.disabled }));
      ui.disabledControls.forEach(({ node }) => { node.disabled = true; });
      return;
    }
    for (const { node, disabled } of ui.disabledControls || []) node.disabled = disabled;
    ui.disabledControls = null;
  }

  async function runCredentialAction(id, actionId) {
    const ui = credentialUi.get(id);
    if (!ui || ui.busy) return;
    ui.busy = true;
    setCredentialBusy(ui, true);
    ui.busyActionId = actionId;
    const statusNode = $(`#${ui.status.statusId || `${id}-status`}`);
    const action = (ui.status.actions || []).find((item) => item.id === actionId);
    const input = $(`#${ui.status.inputId || `${id}-input`}`);
    const value = action?.useInput ? (input?.value.trim() || undefined) : undefined;
    if (statusNode) {
      statusNode.textContent = '正在执行…';
      statusNode.className = 'task-status running';
    }
    try {
      const status = await window.workbench.credentialAction(id, actionId, value);
      ui.busy = !!status.actionResult?.pending;
      ui.status = status;
      if (!ui.busy) {
        setCredentialBusy(ui, false);
        if (statusNode) {
          const ok = status.actionResult?.ok !== false;
          statusNode.textContent = status.actionResult?.message || '操作完成。';
          statusNode.className = `task-status ${ok ? 'done' : 'error'}`;
        }
      }
    } catch (error) {
      ui.busy = false;
      setCredentialBusy(ui, false);
      if (statusNode) {
        statusNode.textContent = `⚠ ${error.message}`;
        statusNode.className = 'task-status error';
      }
    }
    // 返回 pending=true 的长任务由 credential:event 更新终态。
  }

  function handleCredentialEvent(event) {
    if (!event || !event.id) return;
    const ui = credentialUi.get(event.id);
    if (!ui) return;
    const statusNode = $(`#${ui.status.statusId || `${event.id}-status`}`);
    const terminal = ['success', 'cancelled', 'timeout', 'error'];
    if (terminal.includes(event.type)) {
      ui.busy = false;
      setCredentialBusy(ui, false);
    }
    if (statusNode) {
      statusNode.textContent = event.message || (event.type === 'success' ? '完成。' : '');
      statusNode.className = `task-status ${event.type === 'error' ? 'error' : terminal.includes(event.type) ? 'done' : 'running'}`;
    }
    if (event.type === 'success') refreshCredentials();
  }

  /* ============================== 数据目录卡 ============================== */

  async function refreshDataRoot() {
    try {
      const info = await window.workbench.dataRootGet();
      $('#data-root-input').value = info.dataRoot;
      setTag('#data-root-tag', info.isPackaged ? '便携版' : '开发模式', true);
      setStatus('#data-root-status', `数据根：${info.dataRoot}${info.isPackaged ? '（便携版默认 exe 旁 data/，可迁移至其他磁盘）' : ''}`);
      const configurable = info.configurable !== false;
      $('#btn-data-root-browse').hidden = !configurable;
      $('#btn-data-root-save').hidden = !configurable;
    } catch (error) {
      setStatus('#data-root-status', `⚠ 读取失败：${error.message}`, 'error');
    }
  }

  async function browseDataRoot() {
    try {
      const picked = await window.workbench.dataRootChoose();
      if (picked) $('#data-root-input').value = picked;
    } catch (error) {
      setStatus('#data-root-status', `⚠ 选择失败：${error.message}`, 'error');
    }
  }

  async function saveDataRoot() {
    const dir = $('#data-root-input').value.trim();
    if (!dir) {
      setStatus('#data-root-status', '请先选择数据目录。', 'error');
      return;
    }
    try {
      const result = await window.workbench.dataRootSet(dir);
      if (!result.ok) {
        setStatus('#data-root-status', `⚠ ${result.error}`, 'error');
        return;
      }
      setStatus('#data-root-status', `已保存到 ${result.dataRoot}。重启应用后生效。`, 'done');
    } catch (error) {
      setStatus('#data-root-status', `⚠ 保存失败：${error.message}`, 'error');
    }
  }

  /* ============================== 页面骨架与初始化 ============================== */

  function buildSettingsPage() {
    const root = $('#settings-root');
    if (!root || root.dataset.rendered === '1') return;
    root.dataset.rendered = '1';
    root.classList.add('settings-page');
    root.innerHTML = `
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">
        <button class="settings-tab is-active" id="settings-tab-model" type="button" role="tab" aria-selected="true" aria-controls="settings-panel-model" data-settings-tab="model">模型</button>
        <button class="settings-tab" id="settings-tab-credentials" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-credentials" data-settings-tab="credentials">凭证</button>
        <button class="settings-tab" id="settings-tab-feishu" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-feishu" data-settings-tab="feishu">飞书 / Lark</button>
        <button class="settings-tab" id="settings-tab-datasource" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-datasource" data-settings-tab="datasource">其他</button>
      </nav>
      <div class="settings-tab-panels">
        <section class="settings-tab-panel is-active" id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model" data-settings-panel="model">
          <div class="task-grid settings-model-grid">
            <div class="card task-card" id="settings-runtime-card">
              <div class="task-head"><h3>Pi 运行环境</h3><span class="tag mute" id="pi-runtime-tag">检查中…</span></div>
              <p class="task-desc">Agent 与一键任务通过本机 Pi RPC 运行。未安装时，可在此处确认后安装。</p>
              <p class="runtime-command">将执行 <code>npm install -g --ignore-scripts @earendil-works/pi-coding-agent</code></p>
              <div class="task-actions"><button class="btn btn-primary" id="btn-pi-install" type="button">安装 Pi</button><button class="btn btn-secondary" id="btn-pi-runtime-recheck" type="button">重新检查</button></div>
              <div class="task-status" id="pi-runtime-status" aria-live="polite">正在检查本机 Pi…</div>
              <a class="runtime-node-link" id="pi-get-node-link" href="https://nodejs.org/" target="_blank" rel="noreferrer" hidden>获取 Node.js LTS ↗</a>
            </div>
            <div class="card task-card" id="settings-model-card"><div class="task-head"><h3>模型</h3><span class="tag" id="settings-current-tag">读取中…</span></div><p class="task-desc">切换后立即对常驻 Agent 会话生效，并记住本次选择。</p><div class="task-actions"><input type="text" id="settings-model-filter" class="select" placeholder="搜索模型…"><button class="btn btn-primary" id="btn-settings-apply">应用</button></div><div class="model-list" id="settings-model-list" role="listbox"></div><div class="task-status" id="settings-model-status">正在加载可用模型…</div></div>
          </div>
        </section>
        <section class="settings-tab-panel" id="settings-panel-credentials" role="tabpanel" aria-labelledby="settings-tab-credentials" data-settings-panel="credentials" hidden>
          <section class="settings-credentials" id="settings-credentials-card" aria-labelledby="settings-credentials-title">
            <div class="settings-section-head"><div><h3 id="settings-credentials-title">连接模型</h3><p>凭证保存到 Pi 自己的认证库，终端与工作台共用；不会回显密钥。</p></div><div class="task-actions"><button class="btn btn-secondary btn-sm" id="btn-auth-refresh" type="button">刷新状态</button><button class="btn btn-secondary btn-sm" id="btn-agent-restart" type="button">重启 Agent</button></div></div>
            <div class="settings-config-grid">
              <div class="card task-card auth-card"><div class="task-head"><h3>订阅登录</h3><span class="tag mute" id="oauth-status-tag">读取中…</span></div><p class="task-desc">使用 Pi 官方 OAuth 流程；授权链接会在默认浏览器中打开。</p><label class="settings-field">服务<select class="select" id="oauth-provider"></select></label><div class="task-actions"><button class="btn btn-primary btn-sm" id="btn-oauth-start" type="button">登录</button><button class="btn btn-secondary btn-sm" id="btn-oauth-cancel" type="button" disabled>取消</button></div><div class="oauth-prompt" id="oauth-prompt" hidden><label class="settings-field" id="oauth-input-label">验证信息<input class="select" id="oauth-input" autocomplete="off"></label><div class="task-actions" id="oauth-options"></div><button class="btn btn-primary btn-sm" id="btn-oauth-submit" type="button">继续</button></div><div class="task-status" id="oauth-status" aria-live="polite">正在读取可登录服务…</div></div>
              <div class="card task-card auth-card"><div class="task-head"><h3>API Key</h3><span class="tag mute" id="auth-key-tag">未检查</span></div><p class="task-desc">用于 API 计费 Provider。Provider 列表来自 Pi 运行时（与 TUI 一致），保存后可刷新模型列表并选择模型。</p><label class="settings-field">Provider<select class="select" id="auth-provider-id"></select></label><label class="settings-field">API Key<input class="select" id="auth-key-input" type="password" autocomplete="new-password" placeholder="仅提交给 Pi 认证库"></label><div class="task-actions"><button class="btn btn-primary btn-sm" id="btn-auth-key-save" type="button">保存 Key</button><button class="btn btn-secondary btn-sm" id="btn-auth-key-clear" type="button">清除凭证</button></div><div class="task-status" id="auth-key-status" aria-live="polite">正在读取 Provider 列表…</div></div>
            </div>
          </section>
        </section>
        <section class="settings-tab-panel" id="settings-panel-feishu" role="tabpanel" aria-labelledby="settings-tab-feishu" data-settings-panel="feishu" hidden>
          <div class="task-grid settings-feishu-grid">
            <div class="card task-card feishu-card" id="settings-feishu-card"><div class="task-head"><h3>飞书 / Lark</h3><span class="tag mute" id="feishu-status-tag">检查中…</span></div><p class="task-desc">由项目级 <code>pi-feishu-lark</code> 独立会话管理，不与常驻 Agent 共享上下文。</p><form class="feishu-config" id="feishu-config-form"><div class="feishu-fields"><label>应用区域<select id="feishu-domain" class="select"><option value="feishu">飞书（中国）</option><option value="lark">Lark（国际）</option></select></label><label>群聊策略<select id="feishu-group-policy" class="select"><option value="mention">仅 @ 机器人时回复</option><option value="open">群内自动回复</option></select></label><label>App ID<input id="feishu-app-id" class="select" autocomplete="off" spellcheck="false" placeholder="cli_xxx"></label><label>App Secret<input id="feishu-app-secret" class="select" type="password" autocomplete="new-password" placeholder="仅在保存时写入本机配置"></label></div><label class="feishu-autostart"><input id="feishu-auto-start" type="checkbox" checked> 应用启动时自动连接</label><div class="task-actions"><button class="btn btn-primary btn-sm" id="btn-feishu-save" type="submit">保存并启动</button><button class="btn btn-secondary btn-sm" id="btn-feishu-qr-setup" type="button">扫码创建应用</button><button class="btn btn-secondary btn-sm" type="button" data-feishu-command="status">检查状态</button><button class="btn btn-secondary btn-sm" type="button" data-feishu-command="stop">停止</button><button class="btn btn-secondary btn-sm" type="button" data-feishu-command="restart">重启</button></div></form><div class="feishu-security-note">卡片回调固定使用 WebSocket 模式；请仅向本人开放飞书应用，避免将机器人加入群聊。</div><div class="task-status" id="feishu-status">正在检查飞书配置…</div><button class="feishu-reset" type="button" data-feishu-command="reset">重置飞书配置与会话映射</button></div>
          </div>
        </section>
        <section class="settings-tab-panel" id="settings-panel-datasource" role="tabpanel" aria-labelledby="settings-tab-datasource" data-settings-panel="datasource" hidden>
          <div class="task-grid settings-datasource-grid" id="datasource-grid">
            <div class="card task-card" id="settings-data-root-card"><div class="task-head"><h3>数据目录</h3><span class="tag mute" id="data-root-tag">检查中…</span></div><p class="task-desc">所有业务数据（帖子、股票池、凭证、会话、看板数据）收拢于此，换机/备份只需拷贝整个目录。修改后重启应用生效。</p><label class="settings-field">当前数据根<input class="select" id="data-root-input" readonly spellcheck="false" placeholder="读取中…"></label><div class="task-actions"><button class="btn btn-secondary btn-sm" id="btn-data-root-browse" type="button">选择目录</button><button class="btn btn-primary btn-sm" id="btn-data-root-save" type="button">保存</button></div><div class="task-status" id="data-root-status" aria-live="polite">正在读取…</div></div>
          </div>
          <div class="task-status" id="datasource-status" hidden></div>
        </section>
      </div>`;

    // tab 切换
    $$('[data-settings-tab]', root).forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.settingsTab));
    });

    // 模型 tab
    $('#btn-settings-apply').addEventListener('click', applyModel);
    $('#settings-model-filter').addEventListener('input', (e) => renderList(e.target.value));
    $('#btn-pi-runtime-recheck').addEventListener('click', () => refreshRuntime());
    $('#btn-pi-install').addEventListener('click', installPi);
    window.workbench.onPiInstallProgress(showInstallProgress);

    // 凭证 tab
    $('#btn-auth-refresh').addEventListener('click', refreshAllCredentials);
    $('#btn-agent-restart').addEventListener('click', restartAgent);
    $('#auth-provider-id').addEventListener('change', refreshKeyStatus);
    $('#btn-auth-key-save').addEventListener('click', saveKey);
    $('#btn-auth-key-clear').addEventListener('click', clearKey);
    $('#oauth-provider').addEventListener('change', renderOauthState);
    $('#btn-oauth-start').addEventListener('click', startOAuth);
    $('#btn-oauth-cancel').addEventListener('click', cancelOAuth);
    $('#btn-oauth-submit').addEventListener('click', () => submitOAuth($('#oauth-input').value));
    $('#oauth-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitOAuth(event.currentTarget.value); });
    window.workbench.onAuthOAuthEvent(handleOAuthEvent);

    // 飞书 tab
    $('#feishu-config-form')?.addEventListener('submit', saveFeishu);
    $('#btn-feishu-qr-setup')?.addEventListener('click', setupFeishuByQr);
    $$('[data-feishu-command]').forEach((button) => {
      button.addEventListener('click', () => runFeishuCommand(button.dataset.feishuCommand));
    });
    window.workbench.onFeishuEvent(handleFeishuEvent);

    // 其他 tab（数据目录 + 注册凭证；应用专属设置卡经 registerExtraCards 挂载）
    $('#btn-data-root-browse').addEventListener('click', browseDataRoot);
    $('#btn-data-root-save').addEventListener('click', saveDataRoot);
    window.workbench.onCredentialEvent(handleCredentialEvent);

    // 挂载应用通过 registerExtraCards 注册的额外设置卡（幂等，可重复调用）
    mountExtraCards();
  }

  async function refreshAllCredentials() {
    await Promise.all([refreshOAuth(), loadApiProviders()]);
  }

  async function onShow() {
    const runtime = await refreshRuntime();
    if (runtime.installed) await loadModels();
    else setModelUnavailable('请先安装 Pi；安装完成后即可在这里选择模型。');
    await refreshAllCredentials();
    await refreshFeishu();
    await refreshDataRoot();
    await refreshCredentials();
    refreshExtraCards();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    buildSettingsPage();
    window.workbench.onPiInstallProgress(showInstallProgress);
    onShow();
  }

  /* ============================== 应用扩展卡片（registerExtraCards） ============================== */

  // 内容层可通过 window.SettingsPage.registerExtraCards 向任意 tab 追加应用专属
  // 设置卡（如某项目的自定义开关）。core 只负责：挂载 DOM、幂等保护、
  // 生命周期调用（init 在挂载时、refresh 在每次进入设置页时）。不包含任何业务。
  const extraCards = []; // { tabId, html, init?, refresh? }

  function mountExtraCards() {
    for (const card of extraCards) {
      if (card.mounted) continue;
      const panel = document.querySelector(`[data-settings-panel="${card.tabId}"]`);
      if (!panel) {
        console.warn(`[settings] registerExtraCards 的 tab 不存在: ${card.tabId}`);
        continue;
      }
      const grid = panel.querySelector('.task-grid');
      if (!grid) continue;
      const template = document.createElement('template');
      template.innerHTML = card.html.trim();
      grid.appendChild(template.content);
      card.mounted = true;
      if (typeof card.init === 'function') {
        try { card.init(grid); } catch (error) { console.error('[settings] 扩展卡片 init 失败:', error); }
      }
    }
  }

  function refreshExtraCards() {
    for (const card of extraCards) {
      if (!card.mounted || typeof card.refresh !== 'function') continue;
      try { card.refresh(); } catch (error) { console.error('[settings] 扩展卡片 refresh 失败:', error); }
    }
  }

  function registerExtraCards({ tabId, html, init, refresh }) {
    if (!tabId || typeof html !== 'string') throw new Error('registerExtraCards 需要 { tabId, html }');
    extraCards.push({ tabId, html, init, refresh });
    // 若页面已渲染（脚本在 DOMContentLoaded 之后才加载），立即补挂载
    mountExtraCards();
  }

  window.SettingsPage = { init, onShow, activateTab, registerExtraCards };
  window.App.registerPage('settings', { onShow });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
