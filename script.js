// ==UserScript==
// @name         Clarity Scanner Helper (Angular)
// @namespace    http://tampermonkey.net/
// @version      3.34
// @description  Shows all rows, checks date + service, keeps cursor in the scan box, flags repeat scans
// @match        https://cohmis.clarityhs.com/*
// @match        https://*.clarityhs.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- services (names must match the Service dropdown exactly) -------------
  const SERVICES = [
    'Food: Dining Room: Hot Meal',
    'Food: Trailer: Hot Meal',
    'Food: Trailer: Protein',
    'Food: Trailer: Breakfast Bag',
  ];
  const DEFAULT_SERVICE = SERVICES[1];   // used only until a device has been configured via the gear

  // How many scans per person are normal on each service. Anything beyond this gets the
  // orange banner + tone. Services not listed here default to 1.
  const NORMAL_SCANS = {
    'Food: Trailer: Protein': 2,
  };

  // ---- settings (persisted per device in localStorage) --------------------
  const SETTINGS_KEY = 'sh-settings';
  const defaults = { service: DEFAULT_SERVICE, autoService: true, autoDate: true, soundOk: false, edge: true, scale: 1 };
  let locked = true;   // always on; Ctrl+Shift+L toggles for this session only (staff use)
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch {}
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  // ---- constants -----------------------------------------------------------
  const PAGE_SIZE = 1000;        // rows to show instead of the hidden-paginator default of 10
  const FLAG_AT_SCANS = 3;       // report a Unique ID once it reaches this many swipes
  const POLL_MS = 750;
  const FLASH_OK_MS = 3000;      // how long the green "scanned" banner stays
  const FLASH_REPEAT_MS = 5000;  // how long the orange "repeat" banner stays
  const PANEL_IDLE_MS = 15000;   // settings panel closes itself after this long without interaction
  const SERVICE_FIX_TRIES = 3;   // auto-select attempts per wrong-service episode before giving up
  const TIME_ZONE = 'America/Denver';
  const SCAN_INPUT = 'input[focusbarcodedetect]';
  const SERVICE_FIELD = 'mat-form-field.service-field';
  const SERVICE_VALUE = SERVICE_FIELD + ' .mat-mdc-select-value-text';
  const DATE_CONTROL = '.date-control';
  const DATE_LABEL = DATE_CONTROL + ' .date-pill .mdc-button__label';
  const UID_RE = /^[0-9A-F]{9}$/;

  const val = x => (typeof x === 'function' ? x() : x);
  const onPassport = () => /^\/(horizon\/)?passport/.test(location.pathname);

  // The only things volunteers may click while locked down. Everything else is swallowed.
  const ALLOWED = [
    SCAN_INPUT,                               // the scan box itself
    SERVICE_FIELD,                            // Service dropdown
    DATE_CONTROL,                             // date pill
    '.cdk-overlay-container',                 // dropdown options, date picker, dialogs
    'focus-datatable button:not(.focus-datatable-card__chevron)', // row trash icons, not expanders
    '#sh-overlay',                            // our own box, gear and panel
  ].join(', ');

  // ---- styles / overlay ----------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #sh-overlay { --sh-scale:1; position:fixed; top:10px; left:0; right:0; margin:0 auto; z-index:99999;
      width:calc(440px * var(--sh-scale)); padding:.7em 1em 1.1em; border-radius:.65em; box-sizing:border-box;
      font-family:"Open Sans",sans-serif; font-size:calc(22px * var(--sh-scale)); line-height:1.3;
      box-shadow:0 6px 24px rgba(0,0,0,.35); color:#fff; text-align:center; transition:background .25s, top .2s;
      overflow:hidden;
      user-select:none; }
    #sh-overlay.ready    { background:#1b7f3b; }
    #sh-overlay.notready { background:#b3261e; }
    #sh-overlay.ok       { background:#15a34a; }
    #sh-overlay.repeat   { background:#d97706; }
    #sh-overlay:has(#sh-panel.open) { background:#b45309; }   /* amber: operator is in settings */

    /* screen-edge frame: thin + calm when ready, thicker when something needs fixing */
    #sh-frame { position:fixed; inset:0; z-index:99990; pointer-events:none; transition:box-shadow .3s; }
    #sh-frame.ready    { box-shadow:inset 0 0 0 8px #1b7f3b, inset 0 0 38px rgba(27,127,59,.45); }
    #sh-frame.ok       { box-shadow:inset 0 0 0 13px #15a34a, inset 0 0 62px rgba(21,163,74,.6); }
    #sh-frame.notready { box-shadow:inset 0 0 0 15px #b3261e, inset 0 0 75px rgba(179,38,30,.55); }
    #sh-frame.repeat   { box-shadow:inset 0 0 0 15px #d97706, inset 0 0 75px rgba(217,119,6,.55); }
    #sh-frame.off      { box-shadow:none; }
    #sh-status b { font-size:1.18em; }
    #sh-status .sh-row { display:flex; flex-wrap:wrap; justify-content:center; align-items:center;
      gap:.2em .7em; }
    #sh-overlay.wide { width:fit-content; min-width:calc(440px * var(--sh-scale)); max-width:94vw; }

    /* bottom-corner controls */
    #sh-gear, #sh-warn, #sh-resize { position:absolute; bottom:.35em; font-size:.6em; line-height:1;
      height:1.3em; display:flex; align-items:center; justify-content:center; font-family:"Open Sans",sans-serif; }
    #sh-gear svg, #sh-warn svg { display:block; width:1.1em; height:1.1em; }
    #sh-gear { left:.6em; border:0; background:transparent; color:rgba(255,255,255,.55); cursor:pointer; padding:0;
      gap:.3em; white-space:nowrap; }
    #sh-gear:hover { color:#fff; }
    #sh-gear .sh-close { display:none; font-size:.95em; }
    #sh-overlay:has(#sh-panel.open) #sh-gear { color:#fff; }
    #sh-overlay:has(#sh-panel.open) #sh-gear .sh-close { display:inline; }
    #sh-warn { left:2.1em; display:none; color:#ffd54a; cursor:pointer; }
    #sh-overlay:has(#sh-panel.open) #sh-warn { left:5em; }
    #sh-resize { width:1.3em; }
    #sh-warn.on { display:flex; }
    #sh-resize { right:.5em; color:rgba(255,255,255,.55); cursor:nwse-resize; touch-action:none; }
    #sh-resize:hover { color:#fff; }
    /* give the corner controls their own row when the panel is open */
    #sh-overlay:has(#sh-panel.open) { padding-bottom:1.9em; }

    /* settings panel */
    #sh-panel { display:none; margin-top:.5em; padding-top:.45em; border-top:1px solid rgba(255,255,255,.4);
      font-size:.5em; text-align:left; }
    #sh-panel.open { display:block; }
    #sh-panel ul { margin:0 0 .45em; padding:0 0 .4em; list-style:none; font-size:1.05em;
      border-bottom:1px solid rgba(255,255,255,.25); }
    #sh-panel ul:empty { display:none; }
    #sh-panel li { margin:.1em 0; }
    #sh-panel label { display:flex; justify-content:space-between; align-items:center; gap:.7em; margin:.3em 0; }
    #sh-panel select, #sh-panel input[type=checkbox] { font:inherit; }
    #sh-panel select { max-width:14em; color:#222; background:#fff; border:0; border-radius:.6em;
      padding:.3em .6em; }
    #sh-panel input[type=checkbox] { width:1.3em; height:1.3em; flex:none; margin:0; }
    #sh-count { position:absolute; left:0; right:0; bottom:.3em; margin:auto; width:max-content;
      font-size:.6em; line-height:1; color:rgba(255,255,255,.75); pointer-events:none; }
    #sh-count b { font-weight:700; color:#fff; }
    #sh-overlay:has(#sh-panel.open) #sh-count { bottom:.5em; }

    #sh-arrow { position:fixed; z-index:99998; display:none; font-size:calc(40px * var(--sh-scale, 1));
      line-height:1; color:#b3261e; pointer-events:none; filter:drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    #sh-arrow.left  { display:block; animation:sh-nudge-right 1s ease-in-out infinite; }
    #sh-arrow.right { display:block; animation:sh-nudge-left 1s ease-in-out infinite; }
    @keyframes sh-nudge-right { 50% { transform:translateX(.3em); } }
    @keyframes sh-nudge-left  { 50% { transform:translateX(-.3em); } }
    .sh-pulse { outline:3px solid #b3261e !important; animation:sh-pulse 1s infinite; }
    @keyframes sh-pulse { 50% { outline-color:transparent; } }
    .sh-dup { background:#ffd6d6 !important; box-shadow:inset 4px 0 0 #b3261e; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'sh-overlay';
  overlay.className = 'notready';
  overlay.innerHTML = `
    <div id="sh-status">Loading…</div>
    <div id="sh-count"></div>
    <button id="sh-gear" type="button" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7 7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4L9 5.1a7 7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7 7 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.6a7 7 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg><span class="sh-close">Close</span></button>
    <span id="sh-warn" title="Repeat scans — open settings"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M12 2.5 1.5 21h21L12 2.5Zm0 5.3 6.9 11.7H5.1L12 7.8ZM11 11v4h2v-4h-2Zm0 5.2v2h2v-2h-2Z"/></svg></span>
    <div id="sh-panel">
      <ul id="sh-dups"></ul>
      <label>This device's service
        <select id="sh-service">${SERVICES.map(s => `<option>${s}</option>`).join('')}</select>
      </label>
      <label>Auto-select service if wrong <input type="checkbox" id="sh-auto-service"></label>
      <label>Auto-select today's date if wrong <input type="checkbox" id="sh-auto-date"></label>
      <label>Happy ding on good scan <input type="checkbox" id="sh-sound-ok"></label>
      <label>Color the screen edges <input type="checkbox" id="sh-edge"></label>
    </div>
    <div id="sh-resize" title="Drag to resize">⤡</div>`;
  document.body.appendChild(overlay);

  // A bobbing arrow that points at whatever needs fixing (service dropdown or date pill).
  const arrow = document.createElement('div');
  arrow.id = 'sh-arrow';
  document.body.appendChild(arrow);
  arrow.style.setProperty('--sh-scale', settings.scale);

  function pointAt(el) {
    const r = el && el.getBoundingClientRect();
    if (!r || !r.width) { arrow.className = ''; return; }
    const size = parseFloat(getComputedStyle(arrow).fontSize);
    const gap = size * 0.3;
    arrow.textContent = '➜';
    arrow.style.top = `${r.top + r.height / 2 - size / 2}px`;
    if (r.left > size * 2) {                         // room on the left: sit left, point right
      arrow.className = 'left';
      arrow.style.rotate = '';
      arrow.style.left = `${r.left - size - gap}px`;
    } else {                                          // otherwise sit right, point left
      arrow.className = 'right';
      arrow.style.rotate = '180deg';
      arrow.style.left = `${r.right + gap}px`;
    }
  }

  const $ = id => document.getElementById(id);

  const frame = document.createElement('div');
  frame.id = 'sh-frame';
  document.body.appendChild(frame);
  function syncFrame() {
    const state = ['ready', 'ok', 'notready', 'repeat'].find(c => overlay.classList.contains(c)) || '';
    const show = settings.edge && overlay.style.display !== 'none';
    frame.className = show ? state : 'off';
  }
  new MutationObserver(syncFrame).observe(overlay, { attributes: true, attributeFilter: ['class', 'style'] });

  // Animate the box between its old and new size whenever its content/state changes.
  let sizeAnim = null, resizeDepth = 0;
  function withResize(change) {
    if (resizeDepth > 0) { change(); return; }        // nested call: outermost one animates
    const before = overlay.getBoundingClientRect();
    if (sizeAnim) { sizeAnim.cancel(); sizeAnim = null; }
    resizeDepth++;
    try { change(); } finally { resizeDepth--; }
    const after = overlay.getBoundingClientRect();
    if (!before.width || (Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1)) return;
    sizeAnim = overlay.animate(
      [{ width: `${before.width}px`, height: `${before.height}px` },
       { width: `${after.width}px`,  height: `${after.height}px` }],
      { duration: 250, easing: 'cubic-bezier(.2,.8,.2,1)' });
    sizeAnim.onfinish = () => { sizeAnim = null; };
  }
  const panel = $('sh-panel');
  let panelTimer = null;
  const armPanelTimer = () => {
    clearTimeout(panelTimer);
    if (panel.classList.contains('open')) panelTimer = setTimeout(() => togglePanel(false), PANEL_IDLE_MS);
  };
  const togglePanel = open => {
    withResize(() => panel.classList.toggle('open', open ?? !panel.classList.contains('open')));
    if (!panel.classList.contains('open')) focusScanBox();
    armPanelTimer();
  };
  $('sh-gear').addEventListener('click', () => togglePanel());
  $('sh-warn').addEventListener('click', () => togglePanel(true));
  // Any interaction inside the panel restarts the idle timer.
  ['pointerdown', 'keydown', 'change', 'input', 'mousemove'].forEach(t =>
    panel.addEventListener(t, armPanelTimer));
  // A click anywhere outside the box closes the panel.
  document.addEventListener('pointerdown', e => {
    if (panel.classList.contains('open') && !overlay.contains(e.target)) togglePanel(false);
  }, true);

  $('sh-service').value = settings.service;
  $('sh-auto-service').checked = settings.autoService;
  $('sh-auto-date').checked = settings.autoDate;
  $('sh-sound-ok').checked = settings.soundOk;
  $('sh-edge').checked = settings.edge;
  $('sh-service').addEventListener('change', e => {
    settings.service = e.target.value; saveSettings(); updateStatus();
    // Apply right away rather than waiting for the panel to close.
    const svc = selectedService();
    if (settings.autoService && svc !== null && svc !== settings.service) {
      serviceFixKey = `${svc}>${settings.service}`; serviceFixTries = 1;
      fixService();
    }
  });
  $('sh-auto-service').addEventListener('change', e => { settings.autoService = e.target.checked; saveSettings(); });
  $('sh-auto-date').addEventListener('change', e => { settings.autoDate = e.target.checked; saveSettings(); });
  $('sh-sound-ok').addEventListener('change', e => { settings.soundOk = e.target.checked; saveSettings(); });

  // ---- resize: drag the corner handle; box stays centred and everything scales ---
  const applyScale = () => [overlay, arrow].forEach(el => el.style.setProperty('--sh-scale', settings.scale));
  applyScale();
  (() => {
    const handle = $('sh-resize');
    let startX = 0, startScale = 1;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX; startScale = settings.scale;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      // Box is centred, so moving the right edge by dx changes the width by 2*dx.
      const next = startScale + (2 * (e.clientX - startX)) / 440;
      settings.scale = Math.min(3, Math.max(0.5, +next.toFixed(3)));
      applyScale();
    });
    const end = e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      saveSettings();
      focusScanBox();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  $('sh-edge').addEventListener('change', e => { settings.edge = e.target.checked; saveSettings(); syncFrame(); });

  // ---- 1. show all rows ----------------------------------------------------
  function expandTables() {
    if (!window.ng) return;
    document.querySelectorAll('focus-datatable').forEach(el => {
      let dt;
      try { dt = ng.getComponent(el); } catch { return; }
      if (!dt || !dt.pageSize || typeof dt.pageSize.set !== 'function') return;
      try {
        if (val(dt.pageSize) < PAGE_SIZE) {
          dt.pageSize.set(PAGE_SIZE);
          ng.applyChanges(dt);
        }
      } catch (e) { console.warn('ScannerHelper: pageSize', e); }
    });
  }

  // ---- 2. date + service + focus status -----------------------------------
  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

  function todayYMD() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date());
    const get = t => +parts.find(p => p.type === t).value;
    return [get('year'), get('month'), get('day')];
  }
  function todayLabel() {
    return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date());
  }
  // Accepts: "Thursday, October 1, 2026", "Oct 1, 2026", "1 October 2026", "10/1/2026",
  // "10/01/26", "2026-10-01", "01-Oct-2026". Returns [y, m, d] or null.
  function parseYMD(text) {
    if (!text) return null;
    const t = text.replace(/\s+/g, ' ').trim();
    let m;
    if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return [+m[1], +m[2], +m[3]];
    if ((m = t.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/))) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return [y, +m[1], +m[2]];
    }
    if ((m = t.match(/([A-Za-z]{3,})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/))) {
      const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return [+m[3], mo, +m[2]];
    }
    if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,})\.?[ -,]*(\d{4})/))) {
      const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return [+m[3], mo, +m[1]];
    }
    const d = new Date(t);
    return isNaN(d) ? null : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  }
  function selectedDate() {
    const label = document.querySelector(DATE_LABEL);
    if (label) {
      const text = label.textContent.replace(/\s+/g, ' ').trim();
      const ymd = parseYMD(text);
      if (ymd) return { text, ymd };
    }
    const hidden = document.querySelector(DATE_CONTROL + ' input.mat-datepicker-input');
    if (hidden) {
      const raw = hidden.value || hidden.getAttribute('ng-reflect-value') || '';
      const ymd = parseYMD(raw);
      if (ymd) return { text: raw, ymd };
    }
    return null;
  }
  function selectedService() {
    const el = document.querySelector(SERVICE_VALUE);
    return el ? el.textContent.trim() : null;
  }

  let flashUntil = 0;   // while a scan banner is showing, updateStatus leaves the box alone
  let wrongDateNow = false;

  // Only touch the DOM when the message actually changes, so a button inside the status
  // isn't destroyed between mousedown and click.
  function setStatus(prop, v) {
    const el = $('sh-status');
    if (el[prop] === v) return;
    withResize(() => { el[prop] = v; });
    el.animate([{ opacity: .25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }
  const statusEl = { set innerHTML(v) { setStatus('innerHTML', v); },
                     set textContent(v) { setStatus('textContent', v); } };

  function updateStatus() { withResize(updateStatusInner); }
  function updateStatusInner() {
    const status = statusEl;
    const input = document.querySelector(SCAN_INPUT);
    const serviceField = document.querySelector(SERVICE_FIELD);
    const dateControl = document.querySelector(DATE_CONTROL);
    const service = selectedService();
    const date = selectedDate();

    // Priority 0: wrong date (compared as year/month/day in Mountain time, any display format)
    const dateOk = date === null || date.ymd.join('-') === todayYMD().join('-');
    wrongDateNow = !dateOk;
    if (dateControl) dateControl.classList.toggle('sh-pulse', !dateOk);

    // Priority 1: wrong service for this laptop
    const serviceOk = service === null || service === settings.service;
    if (serviceField) serviceField.classList.toggle('sh-pulse', !serviceOk);

    if (Date.now() < flashUntil) return;   // a scan banner is up; don't overwrite it

    if (!dateOk) {
      overlay.className = 'notready wide';
      if (input) input.classList.remove('sh-pulse');
      status.innerHTML = `<span class="sh-row"><b>WRONG DATE</b><span>Change to:</span><b>${todayLabel()}</b></span>`;
      pointAt(dateControl);
      return;
    }
    if (!serviceOk) {
      overlay.className = 'notready wide';
      if (input) input.classList.remove('sh-pulse');
      status.innerHTML = `<span class="sh-row"><b>WRONG SERVICE</b><span>Change to:</span><b>${settings.service}</b></span>`;
      pointAt(serviceField);
      return;
    }
    pointAt(null);
    if (!input) {
      overlay.className = 'notready';
      status.textContent = 'Scan field not found on this page';
      return;
    }
    const focused = document.activeElement === input;
    overlay.className = focused ? 'ready' : 'notready';
    input.classList.toggle('sh-pulse', !focused);
    status.textContent = (focused ? 'READY — scan now' : 'Click the "Unique Identifier" box') +
                         (locked ? '' : ' — UNLOCKED (Ctrl+Shift+L)');
  }

  // ---- 3. rows, repeat detection, scan feedback ----------------------------
  function getRows() {
    const el = document.querySelector('focus-passport-table');
    if (!el || !window.ng) return [];
    try {
      const rows = val(ng.getComponent(el).rows);
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  // Pull a UID and a display name out of a row object without knowing its exact shape.
  function describe(row) {
    let uid = null, name = null;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') {
          if (!uid && UID_RE.test(v)) uid = v;
          if (!name && /name/i.test(k) && v.includes(',')) name = v;
        } else if (typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(row, 0);
    return { uid, name };
  }

  function rowElements() {
    return document.querySelectorAll(
      'focus-datatable tr, focus-datatable [role="row"], focus-datatable li.focus-datatable-card'
    );
  }

  // Happy two-note ding via Web Audio (no files). Off by default because the page
  // already plays its own sound on a good scan.
  function okTone() {
    if (!settings.soundOk) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const note = (at, freq) => {
        const t = ctx.currentTime + at;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + 0.4);
      };
      note(0, 1047); note(0.12, 1319);   // C6 -> E6
      setTimeout(() => ctx.close(), 1500);
    } catch {}
  }

  function flash(kind, html, ms) {
    flashUntil = Date.now() + ms;
    withResize(() => { overlay.className = kind; $('sh-status').innerHTML = html; });
    setTimeout(() => { flashUntil = 0; updateStatus(); }, ms + 50);
  }

  let seenRowCount = -1;         // -1 = not seeded yet
  let lastSnapshot = new Map();  // uid -> count, from the previous tick
  let armed = false;             // only announce scans once the list has settled
  let lastContext = '';          // date + service; a change means the list is reloading

  function checkRows() {
    const rows = getRows();
    const date = selectedDate();
    const context = `${date ? date.ymd.join('-') : ''}|${selectedService() || ''}`;
    const dateOk = date === null || date.ymd.join('-') === todayYMD().join('-');
    const serviceOk = (selectedService() || settings.service) === settings.service;

    // Re-seed (no announcements) when the day/service changes or the list shrinks/reloads.
    if (context !== lastContext || rows.length < seenRowCount) {
      lastContext = context;
      armed = false;
      seenRowCount = rows.length;
      lastSnapshot = new Map();
    }
    const counts = new Map(); // uid -> {count, name}
    for (const r of rows) {
      const { uid, name } = describe(r);
      if (!uid) continue;
      const c = counts.get(uid) || { count: 0, name };
      c.count++;
      counts.set(uid, c);
    }

    // -- running count
    $('sh-count').innerHTML = `<b>${rows.length}</b> scanned today`;

    // -- scan feedback: only when armed (list has held still for a tick), on the right
    //    day and service, and only on growth
    if (armed && dateOk && serviceOk && rows.length > seenRowCount) {
      // find which UID(s) grew
      const grown = [...counts].filter(([uid, c]) => c.count > (lastSnapshot.get(uid) || 0));
      const [uid, c] = grown[0] || [];
      if (uid) {
        const label = c.name || uid;
        const normal = NORMAL_SCANS[settings.service] || 1;
        if (c.count > normal) {
          const nth = ['', '', '2nd', '3rd'][c.count] || `${c.count}th`;
          flash('repeat', `<b>${nth} SCAN TODAY</b><br>${label}`, FLASH_REPEAT_MS);
        } else {
          const suffix = normal > 1 ? ` (${c.count} of ${normal})` : '';
          flash('ok', `<b>✓ SCANNED${suffix}</b><br>${label}`, FLASH_OK_MS);
          okTone();
        }
      }
    }
    if (!armed && rows.length === seenRowCount) armed = true;   // settled -> arm
    seenRowCount = rows.length;
    lastSnapshot = new Map([...counts].map(([uid, c]) => [uid, c.count]));

    // -- repeat report (3+ swipes)
    const flagged = [...counts].filter(([, c]) => c.count >= FLAG_AT_SCANS);
    const flaggedUids = new Set(flagged.map(([uid]) => uid));
    const flaggedNames = new Set(flagged.map(([, c]) => c.name).filter(Boolean));
    rowElements().forEach(el => {
      const text = el.textContent;
      const hit = [...flaggedUids].some(u => text.includes(u)) ||
                  [...flaggedNames].some(n => text.includes(n));
      el.classList.toggle('sh-dup', hit);
    });
    const dupHtml = flagged.map(([uid, c]) => `<li>⚠ ${c.name || uid}: ${c.count} swipes</li>`).join('');
    if ($('sh-dups').innerHTML !== dupHtml) withResize(() => { $('sh-dups').innerHTML = dupHtml; });
    $('sh-warn').classList.toggle('on', flagged.length > 0);
  }

  // ---- 3b. auto-fixers: drive the page's own controls ------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(sel, ms = 1500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(50);
    }
    return null;
  }
  const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  let fixingDate = false;
  async function fixDate() {
    if (fixingDate) return;
    fixingDate = true;
    try {
      const pill = document.querySelector(DATE_CONTROL + ' .date-pill');
      if (!pill) { console.warn('ScannerHelper: date pill not found'); return; }
      pill.click();
      let cal = await waitFor('.mat-calendar', 1000);
      if (!cal && window.ng) {
        // Fallback: open the datepicker through its Angular directive.
        try {
          const input = document.querySelector(DATE_CONTROL + ' input.mat-datepicker-input');
          const dir = input && ng.getDirectives(input).find(d => d._datepicker);
          if (dir) { dir._datepicker.open(); cal = await waitFor('.mat-calendar', 1000); }
        } catch (e) { console.warn('ScannerHelper: datepicker fallback', e); }
      }
      if (!cal) { console.warn('ScannerHelper: calendar did not open'); return; }
      const [ty, tm] = todayYMD();
      for (let i = 0; i < 36; i++) {
        const today = document.querySelector('.mat-calendar-body-today');
        if (today) {
          (today.closest('.mat-calendar-body-cell') || today).click();
          return;
        }
        // Not on the current month: read the "OCT 2026" period label and page toward today.
        const label = document.querySelector('.mat-calendar-period-button')?.textContent.trim() || '';
        const m = label.match(/([A-Za-z]{3,})\.?\s+(\d{4})/);
        const mo = m ? MONTHS[m[1].slice(0, 3).toLowerCase()] : null;
        const yr = m ? +m[2] : null;
        const dir = (yr === null || yr < ty || (yr === ty && mo < tm)) ? 'next' : 'previous';
        const btn = document.querySelector(`.mat-calendar-${dir}-button`);
        if (!btn) { console.warn('ScannerHelper: no month nav button; label =', label); break; }
        btn.click();
        await sleep(120);
      }
      pressEscape();                                  // couldn't find today; back out
    } finally {
      await sleep(300);
      fixingDate = false;
      focusScanBox();
    }
  }

  let lastServiceFix = 0, fixingService = false, serviceFixTries = 0, serviceFixKey = '';
  let lastDateFix = 0, dateFixTries = 0, dateFixKey = '';
  async function fixService() {
    if (fixingService || fixingDate) return;
    fixingService = true;
    lastServiceFix = Date.now();
    try {
      const trigger = document.querySelector(SERVICE_FIELD + ' .mat-mdc-select-trigger, ' + SERVICE_FIELD + ' mat-select');
      if (!trigger) return;
      trigger.click();
      if (!(await waitFor('.cdk-overlay-container mat-option'))) return;
      const want = settings.service.replace(/\s+/g, ' ').trim();
      const opt = [...document.querySelectorAll('.cdk-overlay-container mat-option')]
        .find(o => o.textContent.replace(/\s+/g, ' ').trim() === want);
      if (opt) opt.click(); else pressEscape();
    } finally {
      await sleep(300);
      fixingService = false;
      focusScanBox();
    }
  }

  // ---- 4. lockdown: only ALLOWED controls work, cursor lives in the scan box
  const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"], [role="combobox"]';
  const somethingOpen = () => !!document.querySelector('.cdk-overlay-backdrop');

  function focusScanBox() {
    const input = document.querySelector(SCAN_INPUT);
    if (input && document.activeElement !== input) {
      input.focus();
      updateStatus();
      return true;
    }
    return false;
  }

  const isAllowed = el => {
    try { return !!(el && el.closest && el.closest(ALLOWED)); } catch { return false; }
  };

  // Swallow pointer events on anything not allowed (capture phase, before Angular sees them).
  function guardPointer(e) {
    if (!locked || !onPassport()) return;
    if (isAllowed(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && !somethingOpen()) focusScanBox();
  }
  ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'pointerdown']
    .forEach(t => document.addEventListener(t, guardPointer, true));

  // Keyboard: Ctrl+Shift+U opens settings; Tab is blocked; stray keys go to the scan box.
  document.addEventListener('keydown', e => {
    if (!onPassport()) return;
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'U') {
      e.preventDefault();
      togglePanel();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'L') {
      e.preventDefault();
      locked = !locked;
      updateStatus();
      return;
    }
    if (!locked) return;
    if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); focusScanBox(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;           // leave browser shortcuts alone
    if (somethingOpen()) return;                              // typing inside a dropdown/dialog is fine
    const a = document.activeElement;
    if (a && a.closest(TEXT_ENTRY) && isAllowed(a)) return;   // scan box / service / date / our panel
    focusScanBox();
  }, true);

  // When a dropdown / date picker / dialog closes, send the cursor back to the scan box
  // so picking a service doesn't cost an extra click.
  let overlayWasOpen = false;
  function autofocusTick() {
    const open = somethingOpen();
    if (overlayWasOpen && !open && onPassport()) setTimeout(focusScanBox, 150);
    overlayWasOpen = open;
    if (!onPassport() || open || panel.classList.contains('open')) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) { focusScanBox(); return; }
    if (locked && !isAllowed(a)) focusScanBox();
  }

  // ---- 5. display tweaks ----------------------------------------------------
  const TIME_24 = /^\s*([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*$/;
  function to12h() {
    const root = document.querySelector('focus-datatable');
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const m = n.nodeValue.match(TIME_24);
      if (!m) continue;
      const h = +m[1], ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
      n.nodeValue = `${h12}:${m[2]}${m[3] ? ':' + m[3] : ''} ${ampm}`;
    }
  }

  // On a wrong-date error, don't sit on top of the date pill: drop below it so the
  // prev/next arrows stay reachable. Other states stay at the top.
  function placeOverlay() {
    const wrongDate = overlay.classList.contains('notready') && wrongDateNow;
    let top = 10;
    if (wrongDate) {
      // Test against where the box WOULD be at the top, not where it is now (otherwise it
      // moves down, stops overlapping, moves back up, and oscillates).
      const b = overlay.getBoundingClientRect();
      const box = { left: b.left, right: b.right, top: 10, bottom: 10 + b.height };
      const el = document.querySelector(DATE_CONTROL);
      if (el) {
        const r = el.getBoundingClientRect();
        const overlaps = r.width && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
        if (overlaps) top = Math.max(top, r.bottom + 12);
      }
    }
    const want = `${top}px`;
    if (overlay.style.top !== want) overlay.style.top = want;
  }

  // ---- loop ---------------------------------------------------------------
  function tick() {
    if (!onPassport()) { overlay.style.display = 'none'; pointAt(null); return; }
    overlay.style.display = '';
    expandTables();
    autofocusTick();
    updateStatus();
    placeOverlay();
    checkRows();
    to12h();
    // Date auto-fix: up to SERVICE_FIX_TRIES attempts per "wrong date" episode (keyed on
    // the wrong date shown, so paging to another day starts a fresh episode).
    const d = selectedDate();
    const dKey = d && d.ymd.join('-') !== todayYMD().join('-') ? d.ymd.join('-') : '';
    if (dKey !== dateFixKey) { dateFixKey = dKey; dateFixTries = 0; }
    if (dKey && settings.autoDate && dateFixTries < SERVICE_FIX_TRIES && !somethingOpen() &&
        !panel.classList.contains('open') && Date.now() - lastDateFix > 3000) {
      dateFixTries++; lastDateFix = Date.now();
      fixDate();
    }

    // Service auto-fix: up to SERVICE_FIX_TRIES attempts per "wrong service" episode.
    // The counter resets when the service becomes right or the target setting changes.
    const svc = selectedService();
    const key = svc === null || svc === settings.service ? '' : `${svc}>${settings.service}`;
    if (key !== serviceFixKey) { serviceFixKey = key; serviceFixTries = 0; }
    if (key && settings.autoService && serviceFixTries < SERVICE_FIX_TRIES && !somethingOpen() &&
        !panel.classList.contains('open') && Date.now() - lastServiceFix > 3000) {
      serviceFixTries++;
      fixService();
    }
  }

  document.addEventListener('focusin', updateStatus, true);
  document.addEventListener('focusout', updateStatus, true);
  setInterval(tick, POLL_MS);
  tick();
})();
