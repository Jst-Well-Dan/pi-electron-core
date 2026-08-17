/**
 * markdown.js — 极简 Markdown 渲染（安全：先转义 HTML 再转换）
 * 支持：# 标题 / - 列表 / 1. 列表 / > 引用 / **加粗** / `代码` / [链接] / --- 分隔线
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function render(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let listType = null;

    const closeList = () => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };

    for (const raw of lines) {
      const line = raw;
      const trimmed = line.trim();

      if (!trimmed) { closeList(); continue; }

      if (/^#{1,4}\s/.test(trimmed)) {
        closeList();
        const level = trimmed.match(/^(#{1,4})\s/)[1].length;
        const text = inline(escapeHtml(trimmed.replace(/^#{1,4}\s/, '')));
        out.push(`<h${level}>${text}</h${level}>`);
        continue;
      }

      if (/^-{3,}$/.test(trimmed)) {
        closeList();
        out.push('<hr>');
        continue;
      }

      const ul = trimmed.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${inline(escapeHtml(ul[1]))}</li>`);
        continue;
      }

      const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${inline(escapeHtml(ol[1]))}</li>`);
        continue;
      }

      const quote = trimmed.match(/^&gt;\s?(.*)$/);
      if (trimmed.startsWith('>')) {
        closeList();
        out.push(`<blockquote>${inline(escapeHtml(trimmed.replace(/^>\s?/, '')))}</blockquote>`);
        continue;
      }

      closeList();
      out.push(`<p>${inline(escapeHtml(trimmed))}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  window.MD = { render, escapeHtml };
})();
