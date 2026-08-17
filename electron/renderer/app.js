/**
 * app.js — 渲染层共享：Tab 路由、情境画布引擎、工具函数、页面生命周期。
 *
 * 主题契约：core 不硬编码任何页面/分类 → 颜色映射。
 *   - 页面级画布色由每个 .page-view 的 data-canvas 声明，switchPage 读取并应用；
 *   - 分类级画布色由内容层调用 App.setCanvas(color) 驱动；
 *   - 缺省回退 --ambient-canvas 默认值 #F4F3EE。
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /** 自动滚动到底部（若用户接近底部） */
  function autoscroll(container) {
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }

  /* ---------------- 情境画布引擎 ---------------- */

  /** 平滑切换环境画布色：改写 --ambient-canvas 并同步 body/#app 背景 */
  function setCanvas(color) {
    const c = color || '#F4F3EE';
    document.documentElement.style.setProperty('--ambient-canvas', c);
    document.body.style.backgroundColor = c;
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.backgroundColor = c;
  }

  const pages = {};
  let lastWorkPage = 'wiki';   // 离开设置时回到的最近工作面

  function registerPage(name, handlers) {
    pages[name] = handlers;
  }

  function switchPage(name) {
    if (name !== 'settings') lastWorkPage = name;
    $$('.nav-tab').forEach((t) => {
      const active = t.dataset.page === name;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    $$('.page-view').forEach((p) => {
      const active = p.id === `page-${name}`;
      p.hidden = !active;
      p.classList.toggle('active', active);
      if (active) {
        const h = pages[name];
        if (h && h.onShow) h.onShow();
        // 页面级情境色：优先页面声明的 data-canvas，缺省回退暖奶油
        setCanvas(p.dataset.canvas || '#F4F3EE');
      }
    });
    // 设置齿轮状态（设置非导航 tab，由右上角齿轮进入）
    const gear = $('#settings-trigger');
    if (gear) {
      const isSettings = name === 'settings';
      gear.classList.toggle('active', isSettings);
      gear.setAttribute('aria-expanded', String(isSettings));
      gear.title = isSettings ? '返回工作区' : '设置';
    }
  }

  /** 齿轮开关：在设置页与最近工作面之间切换 */
  function toggleSettings() {
    const settingsOn = $$('.page-view').some((p) => p.id === 'page-settings' && p.classList.contains('active'));
    switchPage(settingsOn ? lastWorkPage : 'settings');
  }

  /** 页面未必通过 tab 切换显示；供这类触发方式调用已注册的 onShow */
  function notifyShow(name) {
    const h = pages[name];
    if (h && h.onShow) h.onShow();
  }

  /* ---------------- 初始化 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    // 日期
    const today = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dateEl = $('#today-label');
    if (dateEl) {
      dateEl.textContent =
        `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 星期${weekdays[today.getDay()]}`;
    }

    // 顶部导航 tab 切换
    const tabsNav = document.querySelector('.nav-tabs');
    if (tabsNav) {
      tabsNav.addEventListener('click', (e) => {
        const tab = e.target.closest('.nav-tab');
        if (tab) switchPage(tab.dataset.page);
      });
    }

    // Agent 运行状态指示（顶栏徽标 + 侧栏圆点）
    const badge = $('#pi-status');
    const statusText = badge ? badge.querySelector('.status-indicator-text') : null;
    const dot = $('#agent-dot');
    window.workbench.onChatEvent((ev) => {
      if (!ev) return;
      if (ev.kind === 'agent_start') {
        if (badge) { badge.classList.remove('ready'); badge.classList.add('working'); }
        if (statusText) statusText.textContent = 'Agent 工作中';
        if (dot) dot.classList.add('working');
      } else if (ev.kind === 'agent_settled') {
        if (badge) { badge.classList.remove('working'); badge.classList.add('ready'); }
        if (statusText) statusText.textContent = 'Agent 已就绪';
        if (dot) dot.classList.remove('working');
      } else if (ev.kind === 'error') {
        if (badge) { badge.classList.remove('ready', 'working'); }
        if (statusText) statusText.textContent = 'Agent 异常';
      }
    });

    // 页面初始化
    if (window.DashboardPage) DashboardPage.init();
    if (window.ChatPage) ChatPage.init();
    if (window.StockBoardPage) StockBoardPage.init();
    if (window.SettingsPage) SettingsPage.init();
  });

  window.App = { $, $$, el, fmtTime, truncate, autoscroll, switchPage, registerPage, notifyShow, setCanvas, toggleSettings };
})();
