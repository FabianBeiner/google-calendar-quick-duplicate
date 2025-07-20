'use strict';

/**
 * Duplicate Button Extension – dynamic style adaptive + View Context restore (variant c).
 * - Speichert View-Kontext (Mode, Datum, EventID, Scroll)
 * - Navigiert nach Duplizieren zurück in identische Ansicht
 * - Öffnet ursprüngliches Eventpanel erneut (REOPEN_EVENT_PANEL = true)
 */

const DEBUG = false;
const REOPEN_EVENT_PANEL = true;              // Panel nach Rückkehr wieder öffnen
const VIEW_RESTORE_TIMEOUT = 6000;            // Max Zeit (ms) um View + Event wiederherzustellen
const EVENT_REOPEN_RETRY_INTERVAL = 120;      // Poll-Intervall beim Suchen des Eventchips
const GRID_READY_SELECTOR_CANDIDATES = [
  '[role="grid"]',
  '.YQXjgd',          // mögliche Kalender-Hauptgrid Klasse
  '.W0m3G',            // alternative Grid-Klasse
];

function log(...args) {
  if (DEBUG) {
    console.debug('[GCQD]', ...args);
  } else {
    console.log('[GCQD]', ...args);
  }
}

const GCQD_DUPLICATE_BUTTON_CLASS = 'dup-btn';
const GCQD_DUPLICATE_BUTTON_SELECTOR = `.${ GCQD_DUPLICATE_BUTTON_CLASS }`;
const CALENDAR_EVENT_SELECTOR = 'div[data-eventid][data-eventchip], div[data-event-id][data-eventchip]';
const EVENT_PANEL_SELECTOR = '.pPTZAe';
const OPTIONS_BUTTON_SELECTOR = '.d29e1c';
const SAVE_BUTTON_SELECTOR = '[jsname="x8hlje"]';
const DUPLICATE_MENU_ITEM_SELECTOR = '[jsname="lbYRR"]';
const MINI_CAL_SELECTOR = '.pWJCO';

const INTERVAL_DELAY = 50;
const MAX_RETRIES = 100;
const INJECTION_DEBOUNCE_MS = 120;
const HEAL_OBSERVER_DURATION_MS = 3000;
const HEAL_RECHECK_DELAY = 60;

const DUPLICATE_ICON_SVG =
          '<svg height="20" viewBox="0 0 24 24" width="20" focusable="false" class="NMm5M"><path d="M0 0h24v24H0V0z" fill="none"></path><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm-1 4H8c-1.1 0-1.99.9-1.99 2L6 21c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V11l-6-6zM8 21V7h6v5h5v9H8z"></path></svg>';

const TRANSLATIONS = {
  de: { duplicateEvent: 'Termin duplizieren' },
  en: { duplicateEvent: 'Duplicate event' },
  es: { duplicateEvent: 'Duplicar evento' },
  fr: { duplicateEvent: 'Dupliquer l\'événement' },
  it: { duplicateEvent: 'Duplica evento' },
  pt: { duplicateEvent: 'Duplicar evento' },
  nl: { duplicateEvent: 'Evenement dupliceren' },
  pl: { duplicateEvent: 'Duplikuj wydarzenie' },
  tr: { duplicateEvent: 'Etkinliği çoğalt' },
  uk: { duplicateEvent: 'Дублювати подію' },
};

const GCQD_LANG = (() => {
  const lang = (navigator.language || 'en').toLowerCase();
  const base = lang.split('-')[0];
  return TRANSLATIONS[lang] ? lang : (TRANSLATIONS[base] ? base : 'en');
})();

function t(key) {
  return (TRANSLATIONS[GCQD_LANG] && TRANSLATIONS[GCQD_LANG][key]) ||
         TRANSLATIONS.en[key] || key;
}

/* ================== STATE ================== */
class DuplicatorState {
  constructor() {
    this.intervals = new Map();
    this.retryCount = new Map();
    this.originalUrl = '';
    this.currentDate = '';
    this.isDuplicating = false;
    this.viewContext = null;
  }

  setInterval(name, fn, d) {
    this.clearInterval(name);
    this.intervals.set(name, setInterval(fn, d));
  }

  clearInterval(name) {
    if (this.intervals.has(name)) {
      clearInterval(this.intervals.get(name));
      this.intervals.delete(name);
    }
  }

  clearAllIntervals() {
    for (const id of this.intervals.values()) clearInterval(id);
    this.intervals.clear();
  }

  incrementRetry(name) {
    const c = (this.retryCount.get(name) || 0) + 1;
    this.retryCount.set(name, c);
    return c;
  }

  resetRetry(name) {
    this.retryCount.delete(name);
  }

  hasExceeded(name) {
    return (this.retryCount.get(name) || 0) >= MAX_RETRIES;
  }

  storeUrl() {
    this.originalUrl = location.href;
  }

  resetRuntime() {
    this.clearAllIntervals();
    this.retryCount.clear();
    this.isDuplicating = false;
  }

  fullReset() {
    this.resetRuntime();
    this.originalUrl = '';
    this.currentDate = '';
    this.viewContext = null;
  }
}

const state = new DuplicatorState();

/* ================== UTILS ================== */
function addEvent(parent, evt, selector, handler) {
  parent.addEventListener(evt, function(e) {
    const tEl = e.target.closest(selector);
    if (tEl) {
      handler.call(tEl, e);
    }
  }, false);
}

function htmlToElement(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstChild;
}

function simulateClick(el) {
  if (!el) {
    return;
  }
  try {
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    el.click();
  } catch (e) {
    console.error('simulateClick', e);
  }
}

function getEventIdFromElement(el) {
  if (!el) {
    return null;
  }
  return el.getAttribute('data-eventid') || el.getAttribute('data-event-id') ||
         null;
}

function extractEventId(e) {
  const tEl = e.target.closest('[data-eventid],[data-event-id]');
  return tEl ? getEventIdFromElement(tEl) : null;
}

function setUpShortcut(e) {
  if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    duplicateEvent();
  }
}

/* ================== VIEW CONTEXT CAPTURE / RESTORE ================== */

/**
 * Versucht Modus (view mode) und Datum aus der aktuellen URL zu extrahieren.
 * Google Calendar URLs Varianten:
 *  - https://calendar.google.com/calendar/u/0/r/week/2025/2/18
 *  - https://calendar.google.com/calendar/u/0/r/day
 *  - Parameter wie ?mode=day&date=20250218 möglich (Fallback)
 */
function parseModeAndDateFromUrl(url) {
  const res = { mode: null, dateToken: null };
  try {
    const u = new URL(url);
    // Query First
    if (u.searchParams.has('mode')) {
      res.mode = u.searchParams.get('mode');
    }
    if (u.searchParams.has('date')) {
      res.dateToken = u.searchParams.get('date');
    }
    // Path tokens
    const parts = u.pathname.split('/').filter(Boolean); // e.g. ["calendar","u","0","r","week","2025","2","18"]
    const rIndex = parts.indexOf('r');
    if (rIndex !== -1) {
      const after = parts.slice(rIndex + 1);
      if (after.length) {
        if (!res.mode && /^[a-z]+$/i.test(after[0])) {
          res.mode = after[0];
        }
        // Date segments follow mode
        const dateParts = after.slice(1).
                                map(x => parseInt(x, 10)).
                                filter(n => !isNaN(n));
        if (dateParts.length >= 3) {
          const [y, m, d] = dateParts;
          // Normalize to YYYYMMDD
          res.dateToken = `${ y.toString().padStart(4, '0') }${ m.toString().
                                                                  padStart(2,
                                                                           '0') }${ d.toString().
                                                                                      padStart(
                                                                                          2,
                                                                                          '0') }`;
        }
      }
    }
  } catch (e) {
    log('parseModeAndDate error', e);
  }
  return res;
}

function captureScrollContext() {
  // Versuche typische Scrollcontainer zu finden
  const candidates = [
    '.W0m3G',        // grid wrapper variant
    '.YQXjgd',       // alternative
    '.tEhMVd',       // mobile / alt
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      return {
        selector: sel,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
      };
    }
  }
  return null;
}

function restoreScrollContext(scrollCtx) {
  if (!scrollCtx) {
    return;
  }
  const el = document.querySelector(scrollCtx.selector);
  if (!el) {
    return;
  }
  try {
    el.scrollTop = scrollCtx.scrollTop;
    el.scrollLeft = scrollCtx.scrollLeft;
  } catch (_) { /* ignore */
  }
}

/**
 * Sichert alle relevanten Infos vor Start der Duplizierung.
 * eventId: optional bereits extrahiert
 */
function captureViewContext(originalEventId) {
  const { mode, dateToken } = parseModeAndDateFromUrl(location.href);
  const scrollCtx = captureScrollContext();
  state.viewContext = {
    mode: mode || null,
    dateToken: dateToken || null,
    originalEventId: originalEventId || null,
    originalUrl: location.href,
    scrollCtx,
  };
  log('Captured view context', state.viewContext);
}

/**
 * Baut eine Ziel-URL. Falls Mode / dateToken fehlen, nimm originalUrl.
 */
function buildViewUrl(context) {
  if (!context) {
    return state.originalUrl || location.origin;
  }
  // Wenn originalUrl noch gültig (z.B. /r/week/...), nimm die – solange sie kein duplicate/eventedit enthält.
  if (context.originalUrl && !/duplicate|eventedit/.test(context.originalUrl)) {
    return context.originalUrl;
  }
  // Fallback generisch: https://calendar.google.com/calendar/u/0/r/{mode}/{YYYY}/{M}/{D}
  const base = location.origin;
  const userSeg = '/calendar/u/0/r';
  if (context.mode && context.dateToken && context.dateToken.length === 8) {
    const y = context.dateToken.slice(0, 4);
    const m = parseInt(context.dateToken.slice(4, 6), 10); // no leading zeros in path
    const d = parseInt(context.dateToken.slice(6, 8), 10);
    return `${ base }${ userSeg }/${ context.mode }/${ y }/${ m }/${ d }`;
  }
  if (context.mode) {
    return `${ base }${ userSeg }/${ context.mode }`;
  }
  return `${ base }${ userSeg }`;
}

/**
 * Wartet bis mindestens eines der Grid-Selektoren vorhanden ist.
 */
function waitForGridReady(timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();

    function check() {
      if (GRID_READY_SELECTOR_CANDIDATES.some(
          sel => document.querySelector(sel))) {
        return resolve(true);
      }
      if (Date.now() - start > timeoutMs) {
        return resolve(false);
      }
      requestAnimationFrame(check);
    }

    check();
  });
}

/**
 * Sucht und klickt das ursprüngliche Event.
 */
function reopenOriginalEvent(context) {
  return new Promise(resolve => {
    if (!context || !context.originalEventId) {
      return resolve(false);
    }

    const start = Date.now();
    const tryFind = () => {
      const chip = document.querySelector(`div[data-eventid="${ CSS.escape(
          context.originalEventId) }"][data-eventchip], div[data-event-id="${ CSS.escape(
          context.originalEventId) }"][data-eventchip]`);
      if (chip) {
        simulateClick(chip);
        log('Reopened original event panel');
        return resolve(true);
      }
      if (Date.now() - start > VIEW_RESTORE_TIMEOUT) {
        return resolve(false);
      }
      setTimeout(tryFind, EVENT_REOPEN_RETRY_INTERVAL);
    };
    tryFind();
  });
}

/**
 * Führt die komplette Wiederherstellung durch:
 *  - Navigate zu rekonstruierter URL (falls nötig)
 *  - Warte Grid
 *  - Scroll wiederherstellen
 *  - Panel erneut öffnen (optional)
 */
async function restoreViewContext() {
  const ctx = state.viewContext;
  if (!ctx) {
    return;
  }

  const targetUrl = buildViewUrl(ctx);
  const needNavigate = location.href !== targetUrl;

  if (needNavigate) {
    log('Navigating back to view context URL', targetUrl);
    try {
      // location.replace um History Pollution zu vermeiden
      location.replace(targetUrl);
    } catch {
      location.assign(targetUrl);
    }
  }

  const maxWait = VIEW_RESTORE_TIMEOUT;
  const gridReady = await waitForGridReady(maxWait);
  if (!gridReady) {
    log('Grid not ready within timeout');
    return;
  }

  restoreScrollContext(ctx.scrollCtx);

  if (REOPEN_EVENT_PANEL) {
    const reopened = await reopenOriginalEvent(ctx);
    if (!reopened) {
      log('Could not reopen original event (timeout)');
    }
  }
}

/* ================== DYNAMIC BUTTON TEMPLATE ================== */
function buildDuplicateButtonMarkup(panel, eventId) {
  const tooltipId = `tt-dup-${ Date.now() }-${ Math.random().
                                                    toString(36).
                                                    slice(2, 6) }`;
  const label = t('duplicateEvent');

  const refBtn = Array.from(panel.querySelectorAll('button')).
                       find(b => !b.closest(GCQD_DUPLICATE_BUTTON_SELECTOR) &&
                                 b.getAttribute('aria-label') &&
                                 b.getAttribute('aria-label') !== label);

  let btnClasses = 'pYTkkf-Bz112c-LgbsSe';
  let includeCircleSpacer = false;

  if (refBtn) {
    btnClasses = refBtn.className.trim() || btnClasses;
    const prev = refBtn.previousElementSibling;
    if (prev && prev.classList.contains('VbA1ue')) {
      includeCircleSpacer = true;
    } else {
      includeCircleSpacer = !!panel.querySelector('.VbA1ue');
    }
  } else {
    includeCircleSpacer = !!panel.querySelector('.VbA1ue');
  }

  const circleDiv = includeCircleSpacer ? '<div class="VbA1ue"></div>' : '';

  return `
    <div class="${ GCQD_DUPLICATE_BUTTON_CLASS }" data-id="${ eventId || '' }" jsaction="JIbuQc:DyVDA">
      ${ circleDiv }
      <span data-is-tooltip-wrapper="true">
        <button
          type="button"
          class="${ btnClasses }"
          jscontroller="PIVayb"
          jsaction="pointerenter:EX0mI;pointerleave:vpvbp;focus:h06R8;blur:zjh6rb;keydown.27:zjh6rb"
          jsname="DyVDA"
          data-use-native-focus-logic="true"
          data-tooltip-enabled="true"
          data-tooltip-id="${ tooltipId }"
          aria-label="${ label }"
        >
          <span class="OiePBf-zPjgPe pYTkkf-Bz112c-UHGRz"></span>
          <span class="RBHQF-ksKsZd" jscontroller="LBaJxb" jsname="m9ZlFb"></span>
            <span jsname="S5tZuc" aria-hidden="true" class="pYTkkf-Bz112c-kBDsod-Rtc0Jf">
              <span class="notranslate VfPpkd-kBDsod" aria-hidden="true">${ DUPLICATE_ICON_SVG }</span>
            </span>
          <div class="pYTkkf-Bz112c-RLmnJb"></div>
        </button>
        <div class="ne2Ple-oshW8e-V67aGc" role="tooltip" aria-hidden="true" id="${ tooltipId }">
          ${ label }
        </div>
      </span>
    </div>
  `;
}

/* ================== INJECTION / HEAL ================== */
const panelInjectionTimers = new WeakMap();

function scheduleInjection(panel, eventId) {
  if (!panel) {
    return;
  }
  if (panelInjectionTimers.has(panel)) {
    clearTimeout(panelInjectionTimers.get(panel));
  }
  const tid = setTimeout(() => {
    try {
      injectButtonIntoPanel(panel, eventId);
      startHealObserver(panel, eventId);
    } catch (e) {
      console.error('inject error', e);
    }
  }, INJECTION_DEBOUNCE_MS);
  panelInjectionTimers.set(panel, tid);
}

function injectDuplicateButton(eventId) {
  const panels = document.querySelectorAll(EVENT_PANEL_SELECTOR);
  if (!panels.length) {
    const tempObs = new MutationObserver((_m, obs) => {
      const p = document.querySelector(EVENT_PANEL_SELECTOR);
      if (p) {
        obs.disconnect();
        scheduleInjection(p, eventId);
      }
    });
    tempObs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => tempObs.disconnect(), 2000);
    return;
  }
  panels.forEach(p => scheduleInjection(p, eventId));
}

function panelLooksStable(panel) {
  return panel.querySelector('button[aria-label]') != null;
}

function injectButtonIntoPanel(panel, eventId) {
  if (!panel || panel.querySelector(GCQD_DUPLICATE_BUTTON_SELECTOR)) {
    return;
  }
  if (!panelLooksStable(panel)) {
    scheduleInjection(panel, eventId);
    return;
  }
  const markup = buildDuplicateButtonMarkup(panel, eventId);
  const el = htmlToElement(markup);
  if (el) {
    panel.prepend(el);
    log('Injected duplicate button', { eventId });
  }
}

function startHealObserver(panel, eventId) {
  if (!panel) {
    return;
  }
  const start = Date.now();
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {
      observer.disconnect();
      return;
    }
    if (!panel.querySelector(GCQD_DUPLICATE_BUTTON_SELECTOR)) {
      injectButtonIntoPanel(panel, eventId);
    }
    if (Date.now() - start > HEAL_OBSERVER_DURATION_MS) {
      observer.disconnect();
    }
  });
  observer.observe(panel, { childList: true, subtree: true });

  const healInterval = setInterval(() => {
    if (!panel.isConnected || Date.now() - start > HEAL_OBSERVER_DURATION_MS) {
      clearInterval(healInterval);
      return;
    }
    if (!panel.querySelector(GCQD_DUPLICATE_BUTTON_SELECTOR)) {
      injectButtonIntoPanel(panel, eventId);
    }
  }, HEAL_RECHECK_DELAY);
}

/* ================== DUPLICATION WORKFLOW ================== */
function duplicateEvent() {
  if (state.isDuplicating) {
    return;
  }
  state.isDuplicating = true;
  document.body.classList.add('gcqd-active');
  state.storeUrl();

  // Versuche ursprüngliche EventID aus geöffnetem Panel abzuleiten
  let panelEventId = null;
  const openPanel = document.querySelector(EVENT_PANEL_SELECTOR);
  if (openPanel) {
    // Falls unser Button schon drin, ID aus data-id:
    const dupWrapper = openPanel.querySelector(GCQD_DUPLICATE_BUTTON_SELECTOR);
    if (dupWrapper && dupWrapper.getAttribute('data-id')) {
      panelEventId = dupWrapper.getAttribute('data-id');
    } else {
      // alternativ: ersten Action-Button mit data-id
      const btnWithId = openPanel.querySelector('button[data-id]');
      if (btnWithId) {
        panelEventId = btnWithId.getAttribute('data-id');
      }
    }
  }

  captureViewContext(panelEventId);

  state.resetRetry('duplicate');
  state.setInterval('duplicate', () => {
    if (state.hasExceeded('duplicate')) {
      console.error('Max retries duplicate');
      cleanupFull();
      return;
    }
    const options = document.querySelector(OPTIONS_BUTTON_SELECTOR);
    const duplicateItem = document.querySelector(DUPLICATE_MENU_ITEM_SELECTOR);

    if (options && !duplicateItem) {
      simulateClick(options);
      state.incrementRetry('duplicate');
    } else if (duplicateItem) {
      const curDayEl = document.querySelector(MINI_CAL_SELECTOR);
      if (curDayEl) {
        state.currentDate = curDayEl.getAttribute('data-date') ||
                            '';
      }
      simulateClick(duplicateItem);
      saveEvent();
    } else {
      state.incrementRetry('duplicate');
    }
  }, INTERVAL_DELAY);
}

function saveEvent() {
  state.resetRetry('save');
  state.setInterval('save', () => {
    if (state.hasExceeded('save')) {
      console.error('Max retries save');
      cleanupFull();
      return;
    }
    const saveBtn = document.querySelector(SAVE_BUTTON_SELECTOR);
    if (!saveBtn) {
      state.incrementRetry('save');
      return;
    }
    state.clearInterval('duplicate');
    state.clearInterval('save');
    try {
      simulateClick(saveBtn);
      setTimeout(handlePostSaveNavigation, 500);
    } catch (e) {
      console.error('save failed', e);
      cleanupFull();
    }
  }, INTERVAL_DELAY);
}

async function handlePostSaveNavigation() {
  if (!state.originalUrl || !state.isDuplicating) {
    cleanupFull();
    return;
  }
  try {
    // Warte kurz bis Google seine Redirects macht
    await new Promise(r => setTimeout(r, 700));
    // Jetzt NICHT mehr stumpf originalUrl forcieren, sondern Kontext wiederherstellen
    await restoreViewContext();
  } catch (e) {
    console.error('post-save nav', e);
  } finally {
    cleanupRuntime();
  }
}

/* ================== CLEANUP ================== */
function cleanupRuntime() {
  state.resetRuntime();
  document.body.classList.remove('gcqd-active');
  document.querySelectorAll(GCQD_DUPLICATE_BUTTON_SELECTOR).
           forEach(n => n.remove());
}

function cleanupFull() {
  state.fullReset();
  document.body.classList.remove('gcqd-active');
  document.querySelectorAll(GCQD_DUPLICATE_BUTTON_SELECTOR).
           forEach(n => n.remove());
}

/* ================== APP / EVENTS ================== */
function setupEventListeners() {
  addEvent(document, 'click', CALENDAR_EVENT_SELECTOR, function(e) {
    const eventId = getEventIdFromElement(this);
    injectDuplicateButton(eventId);
    setUpShortcut(e);
  });

  addEvent(document, 'click', `${ GCQD_DUPLICATE_BUTTON_SELECTOR } button`,
           () => duplicateEvent());

  window.addEventListener('beforeunload', cleanupFull);

  // URL change watcher
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (!url.includes('duplicate') && state.isDuplicating &&
          !/eventedit/.test(url)) {
        // Wir lassen restoreViewContext übernehmen – kein sofortiges cleanup
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // Fallback body click
  document.body.addEventListener('click', e => {
    const id = extractEventId(e);
    if (id) {
      injectDuplicateButton(id);
    }
  });
}

function app() {
  setupEventListeners();
  log('Duplicate extension initialized (view context restore).');
}

/* ================== INIT ================== */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', app);
} else {
  app();
}
