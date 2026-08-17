/**
 * shell.js — 共享外壳交互：Agent 常驻侧栏收起/展开（含 Ctrl+B 快捷键）。
 * 在新壳里设置是顶部 nav-tab 或常驻页面，不再走「齿轮 → 悬浮面板」，
 * 因此这里只保留侧栏开关，不含页面路由逻辑（路由在 app.js）。
 */
(function () {
  'use strict';
  const { $ } = window.App;

  function initSidebarToggle() {
    const btn = $('#sidebar-toggle');
    const sidebar = $('#agent-sidebar');
    if (!btn || !sidebar) return;

    function setCollapsed(collapsed) {
      sidebar.classList.toggle('collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? '展开 Agent 侧栏 (Ctrl+B)' : '收起 Agent 侧栏 (Ctrl+B)';
    }

    btn.addEventListener('click', () => {
      setCollapsed(!sidebar.classList.contains('collapsed'));
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed(!sidebar.classList.contains('collapsed'));
      }
    });
  }

  function initSettingsTrigger() {
    const gear = $('#settings-trigger');
    if (!gear) return;
    gear.addEventListener('click', () => window.App.toggleSettings());
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSidebarToggle();
    initSettingsTrigger();
  });
})();
