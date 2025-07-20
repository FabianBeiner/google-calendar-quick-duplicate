'use strict';

/**
 * Dynamic style-adaptive duplicate button.
 * Adapts to both panel variants (with or without background image / circle spacer).
 * Includes previous stabilization (debounced injection + heal observer).
 */

const DEBUG = true;

function log(...args) {
  if (DEBUG) {
    console.debug('[GCQD]', ...args);
  } else {
    console.info('[GCQD]', ...args);
  }
}

/* ================== CONSTANTS ================== */
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

  reset() {
    this.clearAllIntervals();
    this.retryCount.clear();
    this.originalUrl = '';
    this.currentDate = '';
    this.isDuplicating = false;
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

/* ================== DYNAMIC BUTTON TEMPLATE ================== */

// PATCH: Build button based on reference button in panel
function buildDuplicateButtonMarkup(panel, eventId) {
  const tooltipId = `tt-dup-${ Date.now() }-${ Math.random().
                                                    toString(36).
                                                    slice(2, 6) }`;
  const label = t('duplicateEvent');

  // Find a reference action button (exclude our own)
  const refBtn = Array.from(panel.querySelectorAll('button')).
                       find(b => !b.closest(GCQD_DUPLICATE_BUTTON_SELECTOR) &&
                                 b.getAttribute('aria-label') &&
                                 b.getAttribute('aria-label') !== label);

  let btnClasses = 'pYTkkf-Bz112c-LgbsSe';
  let includeCircleSpacer = false;

  if (refBtn) {
    btnClasses = refBtn.className.trim() || btnClasses;
    // Check if ref has an immediate previous sibling that is the circle spacer
    const prev = refBtn.previousElementSibling;
    if (prev && prev.classList.contains('VbA1ue')) {
      includeCircleSpacer = true;
    } else {
      // Some panels put circle *inside* previous wrapper; also check panel root variant
      includeCircleSpacer = !!panel.querySelector('.VbA1ue');
    }
  } else {
    // Heuristik: any circle in panel
    includeCircleSpacer = !!panel.querySelector('.VbA1ue');
  }

  // Build inner spans similar to Google structure (copy minimal consistent structure)
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
    // Wait briefly for panel to appear
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
  // Must have at least one Google action button present
  return panel.querySelector('button[aria-label]') != null;
}

function injectButtonIntoPanel(panel, eventId) {
  if (!panel || panel.querySelector(GCQD_DUPLICATE_BUTTON_SELECTOR)) {
    log('Skip (present/!panel)');
    return;
  }
  if (!panelLooksStable(panel)) {
    log('Panel not stable yet – retry inject');
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
      log('Heal observer stopped');
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
    log('Dup already running');
    return;
  }
  state.isDuplicating = true;
  document.body.classList.add('gcqd-active');
  state.storeUrl();

  state.resetRetry('duplicate');
  state.setInterval('duplicate', () => {
    if (state.hasExceeded('duplicate')) {
      console.error('Max retries duplicate');
      cleanup();
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
      cleanup();
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
      cleanup();
    }
  }, INTERVAL_DELAY);
}

async function handlePostSaveNavigation() {
  if (!state.originalUrl || !state.isDuplicating) {
    cleanup();
    return;
  }
  try {
    await new Promise(r => setTimeout(r, 700));
    if (location.href.includes('duplicate')) {
      location.assign(state.originalUrl);
    }
    await waitForNavigationComplete(state.originalUrl);
  } catch (e) {
    console.error('post-save nav', e);
  } finally {
    cleanup();
  }
}

function waitForNavigationComplete(target, maxWait = 5000) {
  return new Promise(res => {
    const start = Date.now();
    const id = setInterval(() => {
      const cur = location.href;
      if (cur === target ||
          (!cur.includes('duplicate') && !cur.includes('eventedit'))) {
        clearInterval(id);
        res(true);
      } else if (Date.now() - start > maxWait) {
        clearInterval(id);
        res(false);
      }
    }, 100);
  });
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

  window.addEventListener('beforeunload', cleanup);

  // URL change watcher
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (!url.includes('duplicate') && state.isDuplicating) {
        cleanup();
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // Fallback body click (if delegated missed)
  document.body.addEventListener('click', e => {
    if (extractEventId(e)) {
      injectDuplicateButton(extractEventId(e));
    }
  });
}

function cleanup() {
  state.reset();
  document.body.classList.remove('gcqd-active');
  document.querySelectorAll(GCQD_DUPLICATE_BUTTON_SELECTOR).
           forEach(n => n.remove());
}

function app() {
  setupEventListeners();
  log('Duplicate extension initialized (dynamic style adaptive).');
}

/* ================== INIT ================== */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', app);
} else {
  app();
}
