/* Prism CDP engine: injected into every page by prism_cdp.py over the Chrome DevTools Protocol.
 *
 * The same highlighter as Prism (https://jon.glass/prism/). Regex rules color matches as the page changes, and
 * hovering a hit shows its rule, capture groups and the text around it.
 *
 * - Runs in its own isolated world ("prism"), so page scripts can't see window.prismHL or this code.
 * - Changes nothing in the page's DOM text: highlights use the CSS Custom Highlight API. The hover card and the
 *   control sit in closed shadow roots on their own elements.
 * - Makes no network requests and saves nothing. Rules come from the controller and live in memory only.
 *
 * globalThis.__PRISM_BOOT__ (set by the controller just before this file):
 *   { rules, starter, enabled, ui, enhance (a lookup is loaded), copy (false = no copy buttons), match (false = no matched text), contextChars (0 = no context on the hover card) }  rules and starter are .prism.json text the controller built from files
 * Source: https://jon.glass/prism/ · MIT © 2026 Jon Glass
 */
// The run's promise, so the controller can wait for rules to be checked and running before it reports back
globalThis.__PRISM_READY__ = (async () => {
  'use strict';

  const BOOT = globalThis.__PRISM_BOOT__ || {};
  // Characters of surrounding text shown on the hover card. Off (0) unless the controller's --context asks for it:
  // on a live page the text around a hit is already on screen.
  const CONTEXT_CHARS = Math.max(0, Number(BOOT.contextChars) || 0);
  const COPY = BOOT.copy !== false;  // the hover card's copy buttons; --no-copy turns them off
  const SHOW_MATCH = BOOT.match !== false;  // the matched text on the hover card; --no-match turns it off
  // Enhance: when the controller has a --lookup file, hits that are IP addresses get a button that asks it to
  // look the address up and add a rule for it (name, color and notes from the network it belongs to)
  const canEnhance = () => BOOT.enhance === true && typeof globalThis.__prismEnhance === 'function';
  const looksLikeIp = (t) => /^\[?(?:\d{1,3}(?:\.|\[\.\])){3}\d{1,3}\]?$/.test(t.trim()) || /^\[?(?=[0-9a-f:.]*::|(?:[0-9a-f]{1,4}:){7})[0-9a-f:.]+\]?$/i.test(t.trim());  // IPv6 needs :: or all 8 groups
  // Web pages and local files only: leave edge://, about:, devtools and extension pages alone
  if (!/^(https?|file):$/.test(location.protocol)) return;
  let TOP = true; try { TOP = window.top === window; } catch (e) { TOP = false; }
  const SHOW_UI = TOP && BOOT.ui !== false;
  // Injected at document start: wait for the page to exist before adding anything
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));

  if (window.prismHL) window.prismHL.stop();
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') { console.warn('[Prism] This client has no CSS Custom Highlight API.'); return; }

  // No rules are built in: they all come from the controller (CSV or .prism.json files), or are pasted into the control

  const PALETTE = ['#4c8dff', '#3ecf8e', '#f2a93b', '#ef5b5b', '#a78bfa', '#22d3ee', '#ec4899', '#facc15', '#fb923c', '#84cc16', '#14b8a6', '#94a3b8'];
  const MAX_NODE = 20000;       // characters: longer text nodes are skipped
  const MAX_PER_NODE = 500;     // hits per rule per text node
  const SKIP = 'script,style,noscript,textarea,input,select,option,svg,math,template';
  const BOUNDARY = '[role="listitem"],[role="article"],[role="row"],li,article,tr,blockquote,pre,[data-tid*="message"],[data-tid*="chat-pane-item"]';

  let rules = [];               // compiled: { id, name, desc, color, re, prio }
  let on = false, ctxChars = CONTEXT_CHARS;
  const hits = new Map();       // Text node -> [{ rid, s, e, g, range }]
  let total = 0;

  // ---------- Styles: one ::highlight() rule per rule, in a sheet the page can't see or break ----------
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  function rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function css(r) {
    const [R, G, B] = rgb(r.color), c = `rgb(${R},${G},${B})`, a = (x) => `rgba(${R},${G},${B},${x})`;
    switch (r.style) {
      case 'underline': return `text-decoration: underline 2px ${c};`;
      case 'box': return `background-color: ${a(0.12)}; text-decoration: underline dotted 2px ${c};`;
      case 'text': return `color: ${c};`;
      default: return `background-color: ${a(0.35)}; text-decoration: underline 2px ${a(0.95)};`;
    }
  }

  // ---------- Matching ----------
  function clearAll() {
    for (const r of rules) CSS.highlights.delete('prism-' + r.id);
    hits.clear(); total = 0;
  }
  function compile(list) {
    clearAll();
    rules = [];
    list.forEach((r, i) => {
      if (!r.on || r.paused || !r.pattern) return;
      let re;
      try { re = new RegExp(r.pattern, Array.from(new Set((r.flags + 'g').split(''))).join('')); } catch (e) { return; }
      rules.push({ id: r.id, name: r.name, desc: r.desc, extra: r.extra || {}, color: r.color, style: r.style, re, prio: list.length - i });
    });
    sheet.replaceSync(rules.map((r) => `::highlight(prism-${r.id}) { ${css(r)} }`).join('\n'));
    for (const r of rules) { const h = new Highlight(); h.priority = r.prio; CSS.highlights.set('prism-' + r.id, h); }
  }
  function skipParent(el) {
    if (!el || el.closest(SKIP) || el.isContentEditable) return true;
    if (el.closest('[data-prism-tip]')) return true;
    return false;
  }
  function forget(node) {
    const list = hits.get(node);
    if (!list) return;
    for (const h of list) { const hl = CSS.highlights.get('prism-' + h.rid); if (hl) hl.delete(h.range); }
    total -= list.length;
    hits.delete(node);
  }
  function processNode(node) {
    forget(node);
    if (!on || !rules.length || !node.isConnected) return;
    const t = node.data;
    if (t.length < 2 || t.length > MAX_NODE || !/\S/.test(t) || skipParent(node.parentElement)) return;
    const list = [];
    for (const r of rules) {
      r.re.lastIndex = 0;
      let m, n = 0;
      while ((m = r.re.exec(t)) !== null) {
        if (!m[0].length) { r.re.lastIndex++; continue; }
        const range = new Range();
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        CSS.highlights.get('prism-' + r.id).add(range);
        list.push({ rid: r.id, s: m.index, e: m.index + m[0].length, g: m.length > 1 ? { l: m.slice(1), n: m.groups || null } : null, range });
        if (++n >= MAX_PER_NODE) break;
      }
    }
    if (list.length) { hits.set(node, list); total += list.length; }
  }
  function scan(root) {
    if (root.nodeType === 3) { processNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && skipParent(root)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) processNode(n);
  }

  // ---------- Watching the page ----------
  const pending = new Set();
  let flushT = 0;
  const mo = new MutationObserver((muts) => {
    if (!on) return;
    for (const m of muts) {
      if (m.target.closest?.('[data-prism-tip]') || m.target.parentElement?.closest?.('[data-prism-tip]')) continue;
      if (m.type === 'characterData') pending.add(m.target);
      else m.addedNodes.forEach((n) => pending.add(n));
    }
    if (pending.size && !flushT) flushT = setTimeout(flush, 120);
  });
  // Work through new content in slices of about 30 ms, so a big batch (scrolling back through a long channel) never stalls the page
  let queue = [];
  function flush() {
    flushT = 0;
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    for (const node of hits.keys()) if (!node.isConnected) forget(node);
    queue.push(...pending); pending.clear();
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 30) {
      const n = queue.shift();
      if (!n.isConnected) continue;
      if (n.nodeType === 1 && n.childNodes.length > 50) { queue.unshift(...n.childNodes); continue; } // split big containers
      scan(n);
    }
    if (queue.length) flushT = setTimeout(flush, 0);
    report();
  }
  let reportT = 0, lastSent = -1;
  function report() {
    clearTimeout(reportT);
    reportT = setTimeout(() => {
      if (total === lastSent) return;
      lastSent = total;
      panelCount(total);
    }, 400);
  }

  // ---------- Hover card (in a closed shadow root, outside the page's own tree) ----------
  // Prism's markup is built element by element, never through innerHTML. Sites that enforce Trusted Types
  // (Teams, Outlook and the rest of Microsoft 365) block every HTML-string API in this world too, and the engine
  // would fail before highlighting anything. Only Prism's own templates come through here; every value taken
  // from the page or a rule is escaped with esc() first.
  const VOID = new Set(['input', 'br', 'img', 'hr', 'col', 'wbr']);
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  const unent = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] !== '#' ? (ENT[e.toLowerCase()] ?? m)
    : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)));
  function build(html) {
    const frag = document.createDocumentFragment(), stack = [];
    const tags = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->|([^<]+|<)/g;
    const attrs = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m, cur = frag;
    while ((m = tags.exec(html))) {
      if (m[5] !== undefined) { cur.append(unent(m[5])); continue; }
      if (!m[2]) continue;  // a comment
      const tag = m[2].toLowerCase();
      if (m[1]) {  // a closing tag: back out to the matching element
        while (stack.length && stack.pop().localName !== tag);
        cur = stack.length ? stack[stack.length - 1] : frag;
        continue;
      }
      const el = document.createElement(tag);
      let a; attrs.lastIndex = 0;
      while ((a = attrs.exec(m[3]))) if (!/^on/i.test(a[1])) el.setAttribute(a[1], unent(a[2] ?? a[3] ?? a[4] ?? ''));
      cur.append(el);
      if (!VOID.has(tag) && !m[4]) { stack.push(el); cur = el; }
    }
    return frag;
  }
  const setHTML = (el, html) => el.replaceChildren(build(html));
  // Shadow-root styles go in constructed sheets: a page's CSP can block <style> tags, but not these
  function styled(root, html) {
    const m = /^<style>([\s\S]*?)<\/style>/.exec(html);
    const sh = new CSSStyleSheet(); sh.replaceSync(m[1]);
    root.adoptedStyleSheets = [sh];
    setHTML(root, html.slice(m[0].length));
  }
  // Prism's two elements (hover card and control) hang off <html>, not <body>, because single-page apps
  // (Splunk, for one) clear out <body> children they don't own. They go in the browser's top layer as manual
  // popovers, so no page overlay, z-index or transform can cover or clip them; and if the page removes them
  // anyway, they're put back.
  function mount(el) {
    if (!el.isConnected) document.documentElement.appendChild(el);
    if (el.showPopover && !el.matches(':popover-open')) { try { el.showPopover(); } catch (e) {} }
  }
  let remountT = 0, remounts = 0;
  const guard = new MutationObserver(() => {
    if (remountT || (host.isConnected && (!SHOW_UI || pill.isConnected))) return;
    if (++remounts > 50) { guard.disconnect(); console.warn('[Prism] This page keeps removing the Prism control; leaving it off.'); return; }
    remountT = setTimeout(() => { remountT = 0; mount(host); if (SHOW_UI) mount(pill); }, 50);
  });
  const host = document.createElement('div');
  host.setAttribute('data-prism-tip', '');
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:none';
  const shadow = host.attachShadow({ mode: 'closed' });
  styled(shadow, `<style>
    .card { font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6ebf2; background: #141a24;
      border: 1px solid #364357; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35); padding: 8px 10px; max-width: min(520px, calc(100vw - 16px)); }
    .hit + .hit { border-top: 1px solid #2a3546; margin-top: 8px; padding-top: 8px; }
    .head { display: flex; gap: 7px; align-items: center; }
    .chip { width: 10px; height: 10px; border-radius: 3px; flex: none; }
    b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .desc, .muted { color: #8b97a8; }
    .desc { margin-top: 3px; white-space: pre-wrap; }
    .mono { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .val { margin-top: 6px; word-break: break-all; white-space: pre-wrap; max-height: 90px; overflow: auto; }
    .groups { margin-top: 4px; display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; font-size: 11.5px; }
    .groups span:nth-child(odd) { color: #8b97a8; }
    .groups span:nth-child(even) { word-break: break-all; }
    .ctx { margin-top: 6px; font-size: 11.5px; line-height: 16px; white-space: pre-wrap; word-break: break-word; background: #0e131b;
      border: 1px solid #2a3546; border-radius: 6px; padding: 6px 8px; max-height: 160px; overflow: auto; color: #8b97a8; }
    .ctx mark { color: #e6ebf2; border-radius: 2px; }
    .act { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    button { font: inherit; font-size: 12px; color: #e6ebf2; background: #212b3b; border: 1px solid #2a3546; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    button:hover { border-color: #364357; }
    .brand { margin-left: auto; font-size: 11px; color: #8b97a8; }
  </style><div class="card" part="card"></div>`);
  const card = shadow.querySelector('.card');
  mount(host);
  let shown = null, hideT = 0, overCard = false;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function context(node, h) {
    // Climb for more text, but never past one message: a list item, an article or a chat item
    let el = node.parentElement;
    for (let i = 0; i < 8 && el && el.parentElement && !el.matches(BOUNDARY) && (el.textContent || '').length < ctxChars * 2 + (h.e - h.s); i++) {
      if (el.parentElement.matches('[role="list"],[role="feed"],[role="log"],ul,ol,main,body')) break;
      el = el.parentElement;
    }
    if (!el) return { before: '', match: node.data.slice(h.s, h.e), after: '' };
    const full = el.textContent || '';
    let off;
    try { const pre = document.createRange(); pre.setStart(el, 0); pre.setEnd(node, h.s); off = pre.toString().length; } catch (e) { off = full.indexOf(node.data.slice(h.s, h.e)); }
    if (off < 0) off = 0;
    const len = h.e - h.s, a = Math.max(0, off - ctxChars), b = Math.min(full.length, off + len + ctxChars);
    return { before: (a > 0 ? '…' : '') + full.slice(a, off), match: full.slice(off, off + len), after: full.slice(off + len, b) + (b < full.length ? '…' : '') };
  }
  // A rule's notes plus its extra CSV columns (severity, ticket ...), as the hover card shows them
  const notes = (r) => [r.desc, ...Object.entries(r.extra || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');
  function render(node, list) {
    const byId = new Map(rules.map((r) => [r.id, r]));
    list = list.slice().sort((x, y) => byId.get(y.rid).prio - byId.get(x.rid).prio).slice(0, 4);
    let enhOffered = false;  // one Enhance button per card: the overlapping entries share the same address
    setHTML(card, list.map((h, i) => {
      const r = byId.get(h.rid), cx = ctxChars > 0 ? context(node, h) : null, [R, G, B] = rgb(r.color);
      const enh = !enhOffered && canEnhance() && looksLikeIp(node.data.slice(h.s, h.e)) && (enhOffered = true);
      let groups = '';
      if (h.g) {
        const rows = [], named = h.g.n ? Object.entries(h.g.n).filter(([, v]) => v != null) : [], vals = named.map(([, v]) => v);
        h.g.l.forEach((v, k) => { if (v == null) return; const j = vals.indexOf(v); if (j >= 0) vals[j] = undefined; else rows.push(['$' + (k + 1), v]); });
        rows.push(...named);
        if (rows.length) groups = `<div class="groups mono">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;
      }
      return `<div class="hit" data-i="${i}">
        <div class="head"><span class="chip" data-bg="${r.color}"></span><b>${esc(r.name)}</b></div>
        ${notes(r) ? `<div class="desc">${esc(notes(r))}</div>` : ''}
        ${SHOW_MATCH ? `<div class="val mono">${esc(node.data.slice(h.s, h.e))}</div>` : ''}${groups}
        ${cx ? `<div class="ctx mono">${esc(cx.before)}<mark data-bg="rgba(${R},${G},${B},.4)">${esc(cx.match)}</mark>${esc(cx.after)}</div>` : ''}
        ${COPY || enh ? `<div class="act">${COPY ? `<button data-copy="val">Copy match</button>${cx ? '<button data-copy="ctx">Copy context</button>' : ''}` : ''}${enh ? '<button data-enhance="1" title="Look this address up and add a rule for it">Enhance</button>' : ''}${i === 0 ? '<span class="brand">Prism</span>' : ''}</div>` : ''}
      </div>`;
    }).join(''));
    card.querySelectorAll('[data-bg]').forEach((e) => { e.style.background = e.dataset.bg; }); // CSSOM: allowed under a strict CSP
    card._data = { node, list };
  }
  function place(range) {
    const r = range.getBoundingClientRect();
    host.style.display = 'block';
    const w = host.offsetWidth, ht = host.offsetHeight;
    let x = Math.min(Math.max(8, r.left), innerWidth - w - 8), y = r.bottom + 6;
    if (y + ht > innerHeight - 8) y = Math.max(8, r.top - ht - 6);
    host.style.left = x + 'px'; host.style.top = y + 'px';
  }
  function hide() { host.style.display = 'none'; shown = null; }
  shadow.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !card._data) return;
    const { node, list } = card._data, h = list[+b.closest('.hit').dataset.i];
    if (b.dataset.enhance) {
      if (!canEnhance()) return;
      b.disabled = true; b.textContent = 'Looking up…';
      globalThis.__prismEnhance(JSON.stringify({ match: node.data.slice(h.s, h.e) }));  // the controller answers with a notice
      return;
    }
    const cx = b.dataset.copy === 'ctx' ? context(node, h) : null;
    const text = !cx ? node.data.slice(h.s, h.e) : cx.before.replace(/^…/, '') + cx.match + cx.after.replace(/…$/, '');
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (err) { b.textContent = 'Copy blocked'; }
  });
  host.addEventListener('mouseenter', () => { overCard = true; clearTimeout(hideT); });
  host.addEventListener('mouseleave', () => { overCard = false; hideT = setTimeout(hide, 250); });

  function caretNode(x, y) {
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p && p.offsetNode; }
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); return r && r.startContainer; }
    return null;
  }
  function hitAt(x, y) {
    const node = caretNode(x, y);
    const list = node && hits.get(node);
    if (!list) return null;
    const under = list.filter((h) => Array.from(h.range.getClientRects()).some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1));
    return under.length ? { node, list: under } : null;
  }
  let raf = 0, mx = 0, my = 0;
  function onMove(e) {
    if (!on || !total) return;
    mx = e.clientX; my = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (overCard) return;
      const f = hitAt(mx, my);
      if (f) {
        clearTimeout(hideT);
        const key = f.list.map((h) => h.rid + ':' + h.s).join('|');
        if (!shown || shown.node !== f.node || shown.key !== key) { render(f.node, f.list); place(f.list[0].range); shown = { node: f.node, key }; }
      } else if (shown && !hideT) {
        hideT = setTimeout(() => { hideT = 0; if (!overCard) hide(); }, 250);
      }
    });
  }
  addEventListener('mousemove', onMove, { capture: true, passive: true });  // capture: before any page handler can stop it
  const onScroll = () => { if (shown && !overCard) hide(); };
  const onKey = (e) => { if (e.key === 'Escape' && shown) hide(); };
  addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('keydown', onKey);


  // ---------- Rules: links, JSON, and the runaway-pattern check ----------
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function inflate(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
  async function parseRules(input) {
    input = String(input || '').trim();
    let text = input;
    const m = /[#&]rules=([zj])([A-Za-z0-9_-]+)/.exec(input);
    if (m) { let u8 = unb64u(m[2]); if (m[1] === 'z') u8 = await inflate(u8); text = new TextDecoder().decode(u8); }
    const d = JSON.parse(text);
    const list = Array.isArray(d) ? d : Array.isArray(d.rules) ? d.rules : null;
    if (!list || !list.every((r) => r && typeof r.pattern === 'string')) throw new Error('No rules found');
    return { name: (!Array.isArray(d) && d.name) || '', rules: list.map((r, i) => ({
      id: 'r' + i + Math.random().toString(36).slice(2, 7), name: String(r.name || 'Rule'), pattern: r.pattern,
      flags: String(r.flags || '').replace(/[^imsu]/g, ''), color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : PALETTE[i % PALETTE.length],
      style: ['fill', 'underline', 'box', 'text'].includes(r.style) ? r.style : 'fill', desc: String(r.desc || r.description || ''), on: r.on !== false,
      extra: r.extra && typeof r.extra === 'object' ? Object.fromEntries(Object.entries(r.extra).map(([k, v]) => [String(k), String(v ?? '')])) : {},
      ...(typeof r.ioc === 'boolean' ? { ioc: r.ioc } : {}),
    })) };
  }
  // Each pattern runs first in a worker against text built to make regexes stall. A page's security policy may
  // block blob: workers; then a simpler check runs instead, since a stalled regex would freeze the page.
  const CHECK_SRC = `onmessage = (e) => { const re = new RegExp(e.data.p, Array.from(new Set((e.data.f + 'g').split(''))).join(''));
    const tests = ['a'.repeat(4000) + '!', ' '.repeat(4000) + '!', 'x '.repeat(3000) + '!', '1.'.repeat(2000) + '!', '-_.'.repeat(1500) + '!',
      'ab'.repeat(3000) + 'c', '0'.repeat(4000) + 'z', 'A1b2'.repeat(1500) + '"', '\\\\\\\\'.repeat(2000) + 'x',
      '2026-11-20T14:02:11Z host=WS-01 user=CORP\\\\jsmith cmd="powershell -nop -enc SQBF" src=198.51.100.23 https://files.example/a?b=c '.repeat(40)];
    for (const t of tests) { re.lastIndex = 0; let m, n = 0; while ((m = re.exec(t)) !== null && n++ < 5000) if (!m[0].length) re.lastIndex++; }
    postMessage('ok'); };`;
  let workerBlocked = false;
  // Fallback when workers are blocked: a group that repeats and contains its own repetition, like (a+)+ or (\w+\s?)*
  // (only unbounded repetition counts: {1,3} inside {3} is fine, + or {2,} inside + or * is not)
  const risky = (p) => /\((?:[^()\\]|\\.)*(?:[+*]|,\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\})/.test(p);
  function check(r) {
    try { new RegExp(r.pattern, r.flags); } catch (e) { r.paused = 'invalid: ' + e.message; return Promise.resolve(); }
    if (workerBlocked) { if (risky(r.pattern)) r.paused = 'paused: nested repetition can stall, and it could not be tested here'; return Promise.resolve(); }
    return new Promise((resolve) => {
      let w, url;
      // Revoked once the worker has finished, so blobs don't pile up for the life of the tab
      const free = () => { try { w && w.terminate(); } catch (e) {} if (url) { URL.revokeObjectURL(url); url = null; } };
      try { url = URL.createObjectURL(new Blob([CHECK_SRC], { type: 'text/javascript' })); w = new Worker(url); }
      catch (e) { free(); workerBlocked = true; console.warn('[Prism] Background workers are blocked here, so patterns get a simpler check. Patterns with nested repetition are paused.'); return check(r).then(resolve); }
      const done = (slow) => { clearTimeout(t); free(); if (slow) r.paused = 'paused: stalls on some text'; resolve(); };
      const t = setTimeout(() => done(true), 1500);
      w.onmessage = () => done(false);
      w.onerror = (e) => { e.preventDefault(); clearTimeout(t); free(); workerBlocked = true; console.warn('[Prism] Background workers are blocked here, so patterns get a simpler check. Patterns with nested repetition are paused.'); check(r).then(resolve); };
      w.postMessage({ p: r.pattern, f: r.flags });
    });
  }
  let setName = '', all = [];
  async function useRules(found) {
    for (const r of found.rules) await check(r);
    all = found.rules; setName = found.name;
    stop();
    compile(all);
    if (rules.length) start();
    const paused = all.filter((r) => r.paused);
    console.info(`[Prism] ${rules.length} rules running${setName ? ` from “${setName}”` : ''}.` + (paused.length ? ` Not running: ${paused.map((r) => `${r.name} (${r.paused})`).join(', ')}` : ''));
    panelCount(total);
  }
  function start() {
    if (on) return;
    on = true;
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    pending.add(document.body || document.documentElement);
    flush();
  }
  function stop() {
    on = false; mo.disconnect(); pending.clear(); queue = []; clearTimeout(flushT); flushT = 0; hide();
    for (const node of [...hits.keys()]) forget(node);
    report();
  }

  // ---------- Floating control (same closed shadow root as the hover card) ----------
  const pill = document.createElement('div');
  pill.setAttribute('data-prism-tip', '');
  pill.setAttribute('popover', 'manual');
  pill.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px';
  const ps = pill.attachShadow({ mode: 'closed' });
  styled(ps, `<style>
    :host { all: initial; }
    [hidden] { display: none !important; }  /* .box sets display: flex, which would otherwise beat the hidden attribute */
    .p { font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6ebf2; background: #141a24; border: 1px solid #364357;
      border-radius: 18px; box-shadow: 0 4px 16px rgba(0,0,0,.35); display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; }
    .p b { font-weight: 700; } .n { color: #8b97a8; min-width: 48px; } .n.ok { color: #3ecf8e; } .n.bad { color: #ef5b5b; }
    button { font: inherit; color: #e6ebf2; background: #212b3b; border: 1px solid #2a3546; border-radius: 12px; padding: 2px 9px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: #4c8dff; } button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #2a4f99; border-color: #4c8dff; } button.icon { padding: 1px 6px; border-radius: 6px; color: #8b97a8; }
    .box { position: absolute; right: 0; bottom: 40px; width: min(600px, calc(100vw - 40px)); max-height: min(72vh, 680px); display: flex; flex-direction: column;
      background: #141a24; border: 1px solid #364357; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6ebf2; }
    .top { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px 6px; } .top b { font-size: 13px; } .m { color: #8b97a8; }
    .list { overflow: auto; padding: 0 12px; flex: 1; }
    .rule { border: 1px solid #2a3546; border-radius: 8px; padding: 7px 8px; margin: 0 0 6px; background: #0f141d; }
    .rule.off { opacity: .6; } .rule.bad { border-color: #ef5b5b; }
    .r1, .r2, .r3 { display: flex; align-items: center; gap: 6px; } .r2, .r3 { margin-top: 5px; }
    input, select, textarea { font: inherit; color: #e6ebf2; background: #0b1017; border: 1px solid #2a3546; border-radius: 5px; padding: 3px 6px; min-width: 0; box-sizing: border-box; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #4c8dff; }
    input[type=checkbox] { padding: 0; accent-color: #4c8dff; }
    input[type=color] { width: 26px; height: 22px; padding: 1px; cursor: pointer; }
    .name { flex: 1; font-weight: 600; } .pat { flex: 1; } .flags { width: 46px; text-align: center; }
    .mono, .pat, .flags, textarea.paste { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
    .hits { color: #8b97a8; font-size: 11px; min-width: 52px; text-align: right; white-space: nowrap; }
    .desc { flex: 1; resize: vertical; min-height: 24px; height: 24px; }
    .x { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; } .x label { display: flex; align-items: center; gap: 4px; color: #8b97a8; }
    .x input { width: 130px; }
    .err { color: #ef5b5b; font-size: 11px; margin-top: 3px; } .warn { color: #f2a93b; font-size: 11px; margin-top: 3px; }
    .foot { display: flex; align-items: center; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid #222c3b; }
    .grow { flex: 1; } .to { color: #8b97a8; font-size: 11px; text-align: right; }
    .pastebox { padding: 0 12px 6px; } textarea.paste { width: 100%; height: 70px; }
    .empty { color: #8b97a8; padding: 14px 4px; text-align: center; }
  </style>
  <div class="p"><b>Prism</b><span class="n" id="n">no rules</span><button id="rules">Rules</button><button id="tog">Off</button><button id="x" title="Remove Prism from this tab">✕</button></div>
  <div class="box" id="box" hidden>
    <div class="top"><b>Rules</b><span class="m" id="sum"></span></div>
    <div class="pastebox" id="pastebox" hidden><textarea class="paste" id="ta" spellcheck="false" placeholder="Paste a Prism rule link or .prism.json text, then Load"></textarea>
      <div class="err" id="perr"></div><div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px"><button id="pcancel">Cancel</button><button id="pload">Load</button></div></div>
    <div class="list" id="list"></div>
    <div class="foot"><button id="add">+ Rule</button><button id="paste">Paste…</button>${BOOT.starter ? '<button id="starter">Starter rules</button>' : ''}
      <span class="grow"></span><span class="to" id="to"></span><button id="cancel">Cancel</button><button class="primary" id="save">Save</button></div>
  </div>`);
  if (SHOW_UI) mount(pill);
  guard.observe(document.documentElement, { childList: true });
  const $p = (id) => ps.getElementById(id);
  const canSave = () => typeof globalThis.__prismSave === 'function';  // the controller's channel, in this world only
  let noticeT = 0;
  function panelCount(n) {
    if (noticeT) return;
    const el = $p('n'); el.className = 'n';
    el.textContent = !rules.length ? 'no rules' : on ? `${n.toLocaleString()} hit${n === 1 ? '' : 's'}` : 'off';
    $p('tog').textContent = on ? 'Off' : 'On';
  }
  function notice(text, bad) {
    clearTimeout(noticeT);
    const el = $p('n'); el.textContent = text; el.className = 'n ' + (bad ? 'bad' : 'ok');
    if (bad) { $p('sum').textContent = text; $p('save').textContent = canSave() ? 'Save' : 'Apply'; validate(); }
    noticeT = setTimeout(() => { noticeT = 0; panelCount(total); }, bad ? 9000 : 4000);
  }

  // ---------- The rules editor ----------
  // Works on a draft copy of the rules. Save hands the draft to the controller, which writes the rules file and
  // reloads every tab; without a controller (or for pasted rules) it applies to this tab only.
  let draft = [];
  const STYLE_NAMES = { fill: 'Fill', underline: 'Underline', box: 'Box', text: 'Text color' };
  const extraKeys = () => [...new Set(draft.flatMap((r) => Object.keys(r.extra || {})))];
  function hitCounts() {
    const c = new Map();
    for (const list of hits.values()) for (const h of list) c.set(h.rid, (c.get(h.rid) || 0) + 1);
    return c;
  }
  function problem(r) {
    if (!r.pattern) return 'Needs a pattern';
    try { new RegExp(r.pattern, r.flags); } catch (e) { return e.message.replace(/^Invalid regular expression: /, ''); }
    return '';
  }
  function openEditor() {
    draft = all.map((r) => ({ id: r.id, name: r.name, pattern: r.pattern, flags: r.flags, color: r.color, style: r.style, desc: r.desc,
      on: r.on !== false, extra: { ...(r.extra || {}) }, paused: r.paused, ...(typeof r.ioc === 'boolean' ? { ioc: r.ioc } : {}) }));
    $p('pastebox').hidden = true;
    $p('to').textContent = canSave() ? `Saves to ${BOOT.saveTo || 'the rules file'} and updates every tab` : 'Applies to this tab only';
    $p('save').textContent = canSave() ? 'Save' : 'Apply';
    drawEditor();
    $p('box').hidden = false;
  }
  function drawEditor() {
    const counts = hitCounts(), keys = extraKeys();
    $p('sum').textContent = draft.length ? `${draft.length} rule${draft.length === 1 ? '' : 's'}${setName ? ` · ${setName}` : ''}` : '';
    setHTML($p('list'), draft.length ? draft.map((r, i) => {
      const n = counts.get(r.id), bad = problem(r);
      return `<div class="rule${r.on ? '' : ' off'}${bad ? ' bad' : ''}" data-i="${i}">
        <div class="r1"><input type="checkbox" data-f="on" ${r.on ? 'checked' : ''} title="Run this rule">
          <input type="color" data-f="color" value="${esc(r.color)}" title="Color">
          <input class="name" data-f="name" value="${esc(r.name)}" placeholder="Rule name" spellcheck="false">
          <span class="hits">${r.on && n != null ? `${n.toLocaleString()} hit${n === 1 ? '' : 's'}` : r.on && !bad && r.id ? '0 hits' : ''}</span>
          <button class="icon" data-a="up" title="Move up" ${i ? '' : 'disabled'}>↑</button><button class="icon" data-a="down" title="Move down" ${i < draft.length - 1 ? '' : 'disabled'}>↓</button>
          <button class="icon" data-a="del" title="Delete this rule">✕</button></div>
        <div class="r2"><input class="pat" data-f="pattern" value="${esc(r.pattern)}" placeholder="Regular expression, e.g. \\bWKS-\\d{2}\\b" spellcheck="false">
          <input class="flags" data-f="flags" value="${esc(r.flags)}" placeholder="flags" title="Flags: i ignore case, m multiline, s dot matches newlines, u unicode" spellcheck="false"></div>
        <div class="r3"><select data-f="style" title="How matches are drawn">${Object.entries(STYLE_NAMES).map(([k, v]) => `<option value="${k}" ${r.style === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <textarea class="desc" data-f="desc" placeholder="Notes (shown on the hover card)" spellcheck="false">${esc(r.desc)}</textarea></div>
        ${keys.length ? `<div class="x">${keys.map((k) => `<label>${esc(k)} <input data-x="${esc(k)}" value="${esc((r.extra || {})[k] || '')}" spellcheck="false"></label>`).join('')}</div>` : ''}
        <div class="err" data-err>${esc(bad)}</div>${!bad && r.paused && r.id ? `<div class="warn">Not running: ${esc(r.paused.replace(/^paused: /, ''))}</div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">No rules yet. Add one, paste a Prism link, or start from the starter rules.</div>');
    validate();
  }
  function validate() {
    const bad = draft.some((r) => problem(r));
    $p('save').disabled = bad;
    $p('save').title = bad ? 'Fix the rules marked in red first' : '';
  }
  $p('list').addEventListener('input', (e) => {
    const el = e.target, row = el.closest('.rule'); if (!row) return;
    const r = draft[+row.dataset.i];
    if (el.dataset.x != null) r.extra[el.dataset.x] = el.value;
    else if (el.dataset.f === 'on') { r.on = el.checked; row.classList.toggle('off', !r.on); }
    else if (el.dataset.f) r[el.dataset.f] = el.dataset.f === 'flags' ? el.value.replace(/[^imsu]/g, '') : el.value;
    if (el.dataset.f === 'pattern' || el.dataset.f === 'flags') {
      const bad = problem(r); row.classList.toggle('bad', !!bad); row.querySelector('[data-err]').textContent = bad;
    }
    validate();
  });
  $p('list').addEventListener('change', (e) => { if (e.target.dataset.f === 'style' || e.target.dataset.f === 'on') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
  $p('list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('.rule').dataset.i, a = b.dataset.a;
    if (a === 'del') draft.splice(i, 1);
    else { const j = a === 'up' ? i - 1 : i + 1; [draft[i], draft[j]] = [draft[j], draft[i]]; }
    drawEditor();
  });
  $p('add').onclick = () => {
    const used = new Set(draft.map((r) => r.color));
    draft.push({ name: 'New rule', pattern: '', flags: 'i', color: PALETTE.find((c) => !used.has(c)) || PALETTE[draft.length % PALETTE.length],
      style: 'fill', desc: '', on: true, extra: Object.fromEntries(extraKeys().map((k) => [k, ''])) });
    drawEditor();
    const rows = $p('list').querySelectorAll('.rule'); const last = rows[rows.length - 1];
    last.scrollIntoView({ block: 'nearest' }); last.querySelector('.pat').focus();
  };
  $p('cancel').onclick = () => { $p('box').hidden = true; };
  $p('save').onclick = async () => {
    if (draft.some((r) => problem(r))) return;
    const out = draft.map(({ id, paused, ...r }) => r);
    if (canSave()) {
      $p('save').disabled = true; $p('save').textContent = 'Saving…';
      globalThis.__prismSave(JSON.stringify({ name: setName, rules: out }));  // the controller reloads every tab, this one included
      return;
    }
    await useRules(await parseRules(JSON.stringify({ name: setName, rules: out })));
    $p('box').hidden = true; notice('Applied to this tab');
  };
  $p('paste').onclick = () => { $p('pastebox').hidden = !$p('pastebox').hidden; $p('perr').textContent = ''; if (!$p('pastebox').hidden) $p('ta').focus(); };
  $p('pcancel').onclick = () => { $p('pastebox').hidden = true; };
  // Pasted or starter rules land in the editor as a draft: Save keeps them, Cancel throws them away
  async function intoDraft(text) {
    const found = await parseRules(text);
    draft = found.rules.map(({ id, ...r }) => ({ ...r, extra: r.extra || {} }));
    if (found.name) setName = found.name;
    $p('pastebox').hidden = true; $p('ta').value = '';
    drawEditor();
  }
  $p('pload').onclick = async () => { try { await intoDraft($p('ta').value); } catch (e) { $p('perr').textContent = e.message; } };
  if (BOOT.starter) $p('starter').onclick = () => intoDraft(BOOT.starter);
  $p('rules').onclick = () => { if ($p('box').hidden) openEditor(); else $p('box').hidden = true; };
  $p('tog').onclick = () => { if (on) stop(); else if (rules.length) start(); panelCount(total); };
  $p('x').onclick = () => window.prismHL.stop();
  // Typing in the editor must not reach the page's keyboard shortcuts or input handlers
  ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut'].forEach((t) => pill.addEventListener(t, (e) => e.stopPropagation()));

  window.prismHL = {
    stop() {
      stop();
      for (const r of rules) CSS.highlights.delete('prism-' + r.id);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      removeEventListener('mousemove', onMove, { capture: true });
      guard.disconnect(); clearTimeout(remountT);
      removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('keydown', onKey);
      host.remove(); pill.remove();
      delete window.prismHL;
      console.info('[Prism] Removed.');
    },
    load: async (linkOrJson) => useRules(await parseRules(linkOrJson)),
    on() { if (rules.length) start(); panelCount(total); },
    off() { stop(); panelCount(total); },
    status() { return { url: location.href, top: TOP, on, rules: rules.length, paused: all.filter((r) => r.paused).map((r) => `${r.name} (${r.paused})`), hits: total }; },
    notice,
    get hits() { return total; },
  };
  if (BOOT.rules) {
    try { await window.prismHL.load(BOOT.rules); if (BOOT.enabled === false) window.prismHL.off(); }
    catch (e) { console.warn('[Prism] Rules from the controller:', e.message); }
  } else panelCount(0);
  if (BOOT.notice && SHOW_UI) notice(BOOT.notice);
})().catch((e) => console.warn('[Prism] Could not start on this page: ' + (e && e.message || e)));
