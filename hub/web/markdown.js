// Renders the Markdown that agents write into HTML for the story panel: paragraphs, headings,
// lists, tables, quotes, code, links and emphasis. Every piece of text is escaped before any
// markup is added, so HTML inside a reply is shown as text and never reaches the page.
// Links open only for http(s); a link to a file in the repo is shown as its name.

(() => {
  'use strict';

  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const indentOf = (line) => line.length - line.trimStart().length;
  const isOrdered = (marker) => /\d/.test(marker);

  // -- inline: code spans, links, bold, italic, strikethrough --

  // Code spans and links are set aside as numbered placeholders, so emphasis can wrap them
  // (**see `x`**) but never reaches inside them.
  function inline(text) {
    const kept = [];
    const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
    let s = text.replace(/\u0000/g, '').replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => keep(`<code>${esc(body.replace(/^ (.+) $/, '$1'))}</code>`));
    s = esc(s).replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g, (_, label, href) => keep(link(emphasis(label), href)));
    const restore = (html) => html.replace(/\u0000(\d+)\u0000/g, (_, n) => restore(kept[Number(n)]));
    return restore(emphasis(s));
  }

  const emphasis = (s) => s
    .replace(/\*\*(?!\s)([^*]+?)\*\*|__(?!\s)([^_]+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?![\s*])([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?![\s_])([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?!\s)([^~]+?)~~/g, '<del>$1</del>');

  // `href` is already escaped, so it's safe inside an attribute.
  function link(label, href) {
    if (/^https?:\/\//i.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    return `<span class="md-ref" title="${href}">${label}</span>`;
  }

  // -- blocks --

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i += 1;
      } else if ((m = line.match(FENCE))) {
        const fence = m[1];
        const body = [];
        for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence); i += 1) body.push(lines[i]);
        i += 1;
        out.push(`<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>`);
      } else if ((m = line.match(HEADING))) {
        const level = Math.min(6, m[1].length + 2); // below the panel's own headings
        out.push(`<h${level} class="md-h">${inline(m[2])}</h${level}>`);
        i += 1;
      } else if (RULE.test(line)) {
        out.push('<hr>');
        i += 1;
      } else if (QUOTE.test(line)) {
        const body = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i += 1) body.push(lines[i].replace(QUOTE, ''));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
      } else if (isTable(lines, i)) {
        i = table(lines, i, out);
      } else if (ITEM.test(line)) {
        i = list(lines, i, out);
      } else {
        const para = [];
        do para.push(lines[i++].trim());
        while (i < lines.length && lines[i].trim() && !startsBlock(lines, i));
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

  const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i);

  function list(lines, start, out) {
    const first = lines[start].match(ITEM);
    const indent = first[1].length;
    const ordered = isOrdered(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(ITEM);
      if (m && m[1].length === indent) {
        if (isOrdered(m[2]) !== ordered) break; // the other kind of list starts here
        items.push({ width: indent + m[2].length + 1, lines: [m[3]] });
        i += 1;
        continue;
      }
      const item = items[items.length - 1];
      if (!line.trim()) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        const nextItem = next?.match(ITEM);
        if (next !== undefined && indentOf(next) > indent) item.lines.push('');
        else if (!nextItem || nextItem[1].length !== indent || isOrdered(nextItem[2]) !== ordered) break;
        i += 1;
        continue;
      }
      if (indentOf(line) <= indent) break;
      item.lines.push(line.slice(Math.min(indentOf(line), item.width)));
      i += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    const from = parseInt(first[2], 10);
    const startAt = ordered && from !== 1 ? ` start="${from}"` : '';
    const html = items.map(({ lines: body }) => {
      const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) body[0] = `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`;
      // A one-paragraph item sits in its <li> without a <p>, so short lists stay tight.
      return `<li>${blocks(body).replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
    }).join('');
    out.push(`<${tag}${startAt}>${html}</${tag}>`);
    return i;
  }

  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-') && DIVIDER.test(lines[i + 1]);

  function table(lines, start, out) {
    const head = cells(lines[start]);
    const aligns = cells(lines[start + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const rows = [];
    let i = start + 2;
    for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i += 1) rows.push(cells(lines[i]));
    const cell = (tag, text, n) => `<${tag}${aligns[n] ? ` class="md-${aligns[n]}"` : ''}>${inline(text)}</${tag}>`;
    const body = rows.map((row) => `<tr>${head.map((_, n) => cell('td', row[n] ?? '', n)).join('')}</tr>`).join('');
    out.push(`<div class="md-table"><table><thead><tr>${head.map((text, n) => cell('th', text, n)).join('')}</tr></thead><tbody>${body}</tbody></table></div>`);
    return i;
  }

  globalThis.renderMarkdown = (text) => blocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
})();
