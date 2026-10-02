// ==UserScript==
// @name         Clarity Scanner Helper (Angular)
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  Shows all rows, checks date + service, keeps cursor in the scan box, flags repeat scans
// @match        https://cohmis.clarityhs.com/*
// @match        https://*.clarityhs.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- DEVICE CONFIGURATION — change EXPECTED_SERVICE for each laptop ------
  const DINING_ROOM           = 'Food: Dining Room: Hot Meal';
  const TRAILER_HOT_MEAL      = 'Food: Trailer: Hot Meal';
  const TRAILER_PROTEIN       = 'Food: Trailer: Protein';
  const TRAILER_BREAKFAST_BAG = 'Food: Trailer: Breakfast Bag';

  const EXPECTED_SERVICE = TRAILER_HOT_MEAL;   // <-- the only line to change per device
  // -------------------------------------------------------------------------

  // ---- settings ------------------------------------------------------------
  const PAGE_SIZE = 1000;        // rows to show instead of the hidden-paginator default of 10
  const FLAG_AT_SCANS = 3;       // report a Unique ID once it reaches this many swipes
  const POLL_MS = 750;
  const AUTOFOCUS = true;        // keep the cursor in the scan box whenever nothing else has it
  const LOCKDOWN = true;         // block every control except the ones in ALLOWED; Ctrl+Shift+U toggles
  let locked = LOCKDOWN;
  const SCAN_INPUT = 'input[focusbarcodedetect]';
  const SERVICE_FIELD = 'mat-form-field.service-field';
  const DATE_CONTROL = '.date-control';
  const DATE_LABEL = DATE_CONTROL + ' .date-pill .mdc-button__label';
  const TIME_ZONE = 'America/Denver';
  const SERVICE_VALUE = SERVICE_FIELD + ' .mat-mdc-select-value-text';
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
  ].join(', ');

  // ---- styles / overlay ----------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #sh-overlay { position:fixed; top:10px; left:50%; transform:translateX(-50%); z-index:99999;
      width:440px; padding:18px 22px; border-radius:14px; font:22px/1.35 "Open Sans",sans-serif;
      box-shadow:0 6px 24px rgba(0,0,0,.35); color:#fff; pointer-events:none; text-align:center; }
    #sh-overlay.ready { background:#1b7f3b; }
    #sh-overlay.notready { background:#b3261e; }
    #sh-overlay ul { margin:12px 0 0; padding:10px 0 0; list-style:none; font-size:20px;
      border-top:1px solid rgba(255,255,255,.4); text-align:left; }
    #sh-overlay ul:empty { display:none; }
    #sh-overlay li { margin:4px 0; }
    .sh-pulse { outline:3px solid #b3261e !important; animation:sh-pulse 1s infinite; }
    @keyframes sh-pulse { 50% { outline-color:transparent; } }
    .sh-dup { background:#ffd6d6 !important; box-shadow:inset 4px 0 0 #b3261e; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'sh-overlay';
  overlay.className = 'notready';
  overlay.innerHTML = '<div id="sh-status">Loading…</div><ul id="sh-dups"></ul>';
  document.body.appendChild(overlay);

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

  // ---- 2. service check + scan-field indicator -----------------------------
  function selectedService() {
    const el = document.querySelector(SERVICE_VALUE);
    return el ? el.textContent.trim() : null;
  }

  // ---- date handling: parse whatever the pill shows into [y, m, d] ----------
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
    if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)))                       // 2026-10-01
      return [+m[1], +m[2], +m[3]];
    if ((m = t.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/))) {              // 10/1/2026, 10.01.26
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return [y, +m[1], +m[2]];
    }
    if ((m = t.match(/([A-Za-z]{3,})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/))) { // October 1, 2026
      const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return [+m[3], mo, +m[2]];
    }
    if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,})\.?[ -,]*(\d{4})/))) { // 1 October 2026, 01-Oct-2026
      const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return [+m[3], mo, +m[1]];
    }
    const d = new Date(t);                                                   // last resort
    return isNaN(d) ? null : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  }

  function selectedDate() {
    // Prefer the visible pill text; fall back to the hidden datepicker input.
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

  function updateStatus() {
    const status = document.getElementById('sh-status');
    const input = document.querySelector(SCAN_INPUT);
    const serviceField = document.querySelector(SERVICE_FIELD);
    const service = selectedService();
    const dateControl = document.querySelector(DATE_CONTROL);
    const date = selectedDate();

    // Priority 0: wrong date (compared as year/month/day in Mountain time, any display format)
    const dateOk = date === null || date.ymd.join('-') === todayYMD().join('-');
    if (dateControl) dateControl.classList.toggle('sh-pulse', !dateOk);
    if (!dateOk) {
      overlay.className = 'notready';
      if (input) input.classList.remove('sh-pulse');
      if (serviceField) serviceField.classList.remove('sh-pulse');
      status.innerHTML = `<b>WRONG DATE</b><br>Change it to:<br><b>${todayLabel()}</b>`;
      return;
    }

    // Priority 1: wrong service for this laptop
    const serviceOk = service === EXPECTED_SERVICE;
    if (serviceField) serviceField.classList.toggle('sh-pulse', !serviceOk);
    if (service !== null && !serviceOk) {
      overlay.className = 'notready';
      if (input) input.classList.remove('sh-pulse');
      status.innerHTML = `<b>WRONG SERVICE SELECTED</b><br>Change it to:<br><b>${EXPECTED_SERVICE}</b>`;
      return;
    }

    // Priority 2: scan field focused
    if (!input) {
      overlay.className = 'notready';
      status.textContent = 'Scan field not found on this page';
      return;
    }
    const focused = document.activeElement === input;
    overlay.className = focused ? 'ready' : 'notready';
    input.classList.toggle('sh-pulse', !focused);
    status.textContent = focused ? 'READY — scan now' : 'Click the "Unique Identifier" box';
    if (!locked) status.textContent += ' — UNLOCKED (Ctrl+Shift+U to lock)';
  }

  // ---- 3. repeat-scan detection -------------------------------------------
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

  function checkDuplicates() {
    const counts = new Map(); // uid -> {count, name}
    for (const r of getRows()) {
      const { uid, name } = describe(r);
      if (!uid) continue;
      const c = counts.get(uid) || { count: 0, name };
      c.count++;
      counts.set(uid, c);
    }
    const flagged = [...counts].filter(([, c]) => c.count >= FLAG_AT_SCANS);
    const flaggedUids = new Set(flagged.map(([uid]) => uid));
    const flaggedNames = new Set(flagged.map(([, c]) => c.name).filter(Boolean));

    rowElements().forEach(el => {
      const text = el.textContent;
      const hit = [...flaggedUids].some(u => text.includes(u)) ||
                  [...flaggedNames].some(n => text.includes(n));
      el.classList.toggle('sh-dup', hit);
    });

    const list = document.getElementById('sh-dups');
    list.innerHTML = flagged
      .map(([uid, c]) => `<li>⚠ ${c.name || uid}: ${c.count} swipes</li>`)
      .join('');
  }

  // ---- loop ---------------------------------------------------------------
  function tick() {
    if (!onPassport()) { overlay.style.display = 'none'; return; }
    overlay.style.display = '';
    expandTables();
    autofocusTick();
    updateStatus();
    checkDuplicates();
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
    if (e.target === overlay || overlay.contains(e.target)) return;
    if (isAllowed(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && !somethingOpen()) focusScanBox();
  }
  ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'pointerdown']
    .forEach(t => document.addEventListener(t, guardPointer, true));

  // Keyboard: Ctrl+Shift+U toggles lockdown; Tab is blocked; stray keys go to the scan box.
  document.addEventListener('keydown', e => {
    if (!onPassport()) return;
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'U') {
      locked = !locked;
      e.preventDefault();
      updateStatus();
      return;
    }
    if (!locked) return;
    if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); focusScanBox(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;           // leave browser shortcuts alone
    if (somethingOpen()) return;                              // typing inside a dropdown/dialog is fine
    const a = document.activeElement;
    if (a && a.closest(TEXT_ENTRY) && isAllowed(a)) return;   // scan box / service / date field
    focusScanBox();
  }, true);

  // Nothing focused at all (e.g. after a button finished) -> scan box.
  function autofocusTick() {
    if (!AUTOFOCUS || !onPassport() || somethingOpen()) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) { focusScanBox(); return; }
    if (locked && !isAllowed(a)) focusScanBox();              // focus wandered somewhere it shouldn't
  }

  document.addEventListener('focusin', updateStatus, true);
  document.addEventListener('focusout', updateStatus, true);
  setInterval(tick, POLL_MS);
  tick();
})();
