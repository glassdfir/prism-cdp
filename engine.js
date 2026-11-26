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
 *   { rules, starter, enabled, ui, contextChars (0 = no context on the hover card) }  rules and starter are .prism.json text the controller built from files
 * Source: https://jon.glass/prism/ · MIT © 2026 Jon Glass
 */
// The run's promise, so the controller can wait for rules to be checked and running before it reports back
globalThis.__PRISM_READY__ = (async () => {
  'use strict';

  const BOOT = globalThis.__PRISM_BOOT__ || {};
  // Characters of surrounding text shown on the hover card. Off (0) unless the controller's --context asks for it:
  // on a live page the text around a hit is already on screen.
  const CONTEXT_CHARS = Math.max(0, Number(BOOT.contextChars) || 0);
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
      rules.push({ id: r.id, name: r.name, desc: r.desc, color: r.color, style: r.style, re, prio: list.length - i });
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
  // Shadow-root styles go in constructed sheets: a page's CSP can block <style> tags, but not these
  function styled(root, html) {
    const m = /^<style>([\s\S]*?)<\/style>/.exec(html);
    const sh = new CSSStyleSheet(); sh.replaceSync(m[1]);
    root.adoptedStyleSheets = [sh];
    root.innerHTML = html.slice(m[0].length);
  }
  const host = document.createElement('div');
  host.setAttribute('data-prism-tip', '');
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
  (document.body || document.documentElement).appendChild(host);
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
  function render(node, list) {
    const byId = new Map(rules.map((r) => [r.id, r]));
    list = list.slice().sort((x, y) => byId.get(y.rid).prio - byId.get(x.rid).prio).slice(0, 4);
    card.innerHTML = list.map((h, i) => {
      const r = byId.get(h.rid), cx = ctxChars > 0 ? context(node, h) : null, [R, G, B] = rgb(r.color);
      let groups = '';
      if (h.g) {
        const rows = [], named = h.g.n ? Object.entries(h.g.n).filter(([, v]) => v != null) : [], vals = named.map(([, v]) => v);
        h.g.l.forEach((v, k) => { if (v == null) return; const j = vals.indexOf(v); if (j >= 0) vals[j] = undefined; else rows.push(['$' + (k + 1), v]); });
        rows.push(...named);
        if (rows.length) groups = `<div class="groups mono">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;
      }
      return `<div class="hit" data-i="${i}">
        <div class="head"><span class="chip" data-bg="${r.color}"></span><b>${esc(r.name)}</b></div>
        ${r.desc ? `<div class="desc">${esc(r.desc)}</div>` : ''}
        <div class="val mono">${esc(node.data.slice(h.s, h.e))}</div>${groups}
        ${cx ? `<div class="ctx mono">${esc(cx.before)}<mark data-bg="rgba(${R},${G},${B},.4)">${esc(cx.match)}</mark>${esc(cx.after)}</div>` : ''}
        <div class="act"><button data-copy="val">Copy match</button>${cx ? '<button data-copy="ctx">Copy context</button>' : ''}${i === 0 ? '<span class="brand">Prism</span>' : ''}</div>
      </div>`;
    }).join('');
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
  document.addEventListener('mousemove', onMove, { passive: true });
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
      style: ['fill', 'underline', 'box', 'text'].includes(r.style) ? r.style : 'fill', desc: String(r.desc || ''), on: r.on !== false,
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
  pill.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px';
  const ps = pill.attachShadow({ mode: 'closed' });
  styled(ps, `<style>
    .p { font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6ebf2; background: #141a24; border: 1px solid #364357;
      border-radius: 18px; box-shadow: 0 4px 16px rgba(0,0,0,.35); display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; }
    .p b { font-weight: 700; } .n { color: #8b97a8; min-width: 48px; }
    button { font: inherit; color: #e6ebf2; background: #212b3b; border: 1px solid #2a3546; border-radius: 12px; padding: 2px 9px; cursor: pointer; }
    button:hover { border-color: #4c8dff; }
    .box { position: absolute; right: 0; bottom: 40px; width: 380px; background: #141a24; border: 1px solid #364357; border-radius: 10px; padding: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; color: #e6ebf2; }
    textarea { width: 100%; box-sizing: border-box; height: 90px; background: #0e131b; color: #e6ebf2; border: 1px solid #2a3546; border-radius: 6px; font: 11.5px ui-monospace, Menlo, Consolas, monospace; }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; } .m { color: #8b97a8; margin: 0 0 6px; } .err { color: #ef5b5b; }
  </style>
  <div class="p"><b>Prism</b><span class="n" id="n">no rules</span><button id="rules">Rules</button><button id="tog">Off</button><button id="x" title="Remove Prism from this tab">✕</button></div>
  <div class="box" id="box" hidden><p class="m">Paste a Prism rule link or .prism.json text. Rules stay in memory for this tab until it reloads.</p>
    <textarea id="ta" spellcheck="false" placeholder="https://jon.glass/prism/#rules=…"></textarea><div class="err" id="err"></div>
    <div class="row">${BOOT.starter ? '<button id="starter">Starter rules</button>' : ''}<button id="cancel">Cancel</button><button id="load">Load</button></div></div>`);
  if (SHOW_UI) (document.body || document.documentElement).appendChild(pill);
  const $p = (id) => ps.getElementById(id);
  function panelCount(n) { $p('n').textContent = !rules.length ? 'no rules' : on ? `${n.toLocaleString()} hit${n === 1 ? '' : 's'}` : 'off'; $p('tog').textContent = on ? 'Off' : 'On'; }
  $p('rules').onclick = () => { $p('box').hidden = !$p('box').hidden; $p('err').textContent = ''; };
  $p('cancel').onclick = () => { $p('box').hidden = true; };
  $p('load').onclick = async () => {
    try { await useRules(await parseRules($p('ta').value)); $p('box').hidden = true; $p('ta').value = ''; }
    catch (e) { $p('err').textContent = e.message; }
  };
  if (BOOT.starter) $p('starter').onclick = async () => { await useRules(await parseRules(BOOT.starter)); $p('box').hidden = true; };
  $p('tog').onclick = () => { if (on) stop(); else if (rules.length) start(); panelCount(total); };
  $p('x').onclick = () => window.prismHL.stop();
  // Typing in the paste box must not reach the page's keyboard shortcuts
  ['keydown', 'keyup', 'keypress'].forEach((t) => pill.addEventListener(t, (e) => e.stopPropagation()));

  window.prismHL = {
    stop() {
      stop();
      for (const r of rules) CSS.highlights.delete('prism-' + r.id);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      document.removeEventListener('mousemove', onMove);
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
    get hits() { return total; },
  };
  if (BOOT.rules) {
    try { await window.prismHL.load(BOOT.rules); if (BOOT.enabled === false) window.prismHL.off(); }
    catch (e) { console.warn('[Prism] Rules from the controller:', e.message); }
  } else panelCount(0);
})();
