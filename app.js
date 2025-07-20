'use strict';

/** ========== CONSTANTS ========== */
const GCQD_DUPLICATE_BUTTON_CLASS = 'dup-btn';
const GCQD_DUPLICATE_BUTTON_SELECTOR = `.${ GCQD_DUPLICATE_BUTTON_CLASS }`;
const CIRCLE_BUTTON_CLASS = 'VbA1ue';
const CALENDAR_EVENT_SELECTOR = 'div[data-eventid][data-eventchip]';
const EVENT_PANEL_SELECTOR = '.pPTZAe';
const OPTIONS_BUTTON_SELECTOR = '.d29e1c';
const SAVE_BUTTON_SELECTOR = '[jsname="x8hlje"]';
const DUPLICATE_BUTTON_SELECTOR = '[jsname="lbYRR"]';
const MINI_CALENDAR_NOT_THIS_MONTH_SELECTOR = '.q2d9Ze';
const MINI_CALENDAR_DAY_SELECTOR = `.IOneve:not(${ MINI_CALENDAR_NOT_THIS_MONTH_SELECTOR })`;
const MINI_CALENDAR_CURRENT_DAY_SELECTOR = '.pWJCO';
const INTERVAL_DELAY = 50;
const MAX_RETRIES = 100; // Prevent infinite loops
const DUPLICATE_ICON_SVG = '<svg height="20" viewBox="0 0 24 24" width="20" focusable="false" class="NMm5M"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm-1 4H8c-1.1 0-1.99.9-1.99 2L6 21c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V11l-6-6zM8 21V7h6v5h5v9H8z"/></svg>';

/** ========== INTERNATIONALIZATION ========== */
const TRANSLATIONS = {
  de: {
    duplicateEvent: 'Termin duplizieren',
  },
  en: {
    duplicateEvent: 'Duplicate event',
  },
  es: {
    duplicateEvent: 'Duplicar evento',
  },
  fr: {
    duplicateEvent: 'Dupliquer l’événement',
  },
  it: {
    duplicateEvent: 'Duplica evento',
  },
  pt: {
    duplicateEvent: 'Duplicar evento',
  },
  nl: {
    duplicateEvent: 'Evenement dupliceren',
  },
  pl: {
    duplicateEvent: 'Duplikuj wydarzenie',
  },
  tr: {
    duplicateEvent: 'Etkinliği çoğalt',
  },
  uk: {
    duplicateEvent: 'Дублювати подію',
  },
};

/**
 * Get user's language preference
 */
function getUserLanguage() {
  const lang = navigator.language || 'en';
  const variants = [lang.toLowerCase(), lang.split('-')[0].toLowerCase()];
  for (const code of variants) {
    if (TRANSLATIONS[code]) {
      return code;
    }
  }
  return 'en';
}

/**
 * Get translated text
 */
function t(key) {
  const lang = getUserLanguage();
  return TRANSLATIONS[lang][key] || TRANSLATIONS.en[key];
}

/** ======================================== */

/** ========== STATE MANAGEMENT ========== */
class DuplicatorState {
  constructor() {
    this.intervals = new Map();
    this.currentDate = '';
    this.retryCount = new Map();
  }

  setInterval(name, func, delay) {
    this.clearInterval(name);
    this.intervals.set(name, setInterval(func, delay));
  }

  clearInterval(name) {
    if (this.intervals.has(name)) {
      clearInterval(this.intervals.get(name));
      this.intervals.delete(name);
    }
  }

  clearAllIntervals() {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  incrementRetry(name) {
    const count = (this.retryCount.get(name) || 0) + 1;
    this.retryCount.set(name, count);
    return count;
  }

  resetRetry(name) {
    this.retryCount.delete(name);
  }

  hasExceededRetries(name) {
    return (this.retryCount.get(name) || 0) >= MAX_RETRIES;
  }
}

const state = new DuplicatorState();
/** ======================================== */

/** ========== TEMPLATES ========== */
/**
 * Creates the duplicate event button.
 *
 * @param {string} eventId - The event ID
 * @param {boolean} hasCircleBtn - true if the event has a circle button
 * @returns {string} HTML string for the duplicate button
 */
function getDuplicateButton(eventId, hasCircleBtn) {
  const tooltipId = `tt-dup-${ Date.now() }`;
  const tooltipText = t('duplicateEvent');

  return `
    <div class="${ GCQD_DUPLICATE_BUTTON_CLASS }" data-id="${ eventId }" jsaction="JIbuQc:DyVDA">
      ${ hasCircleBtn ? `<div class="${ CIRCLE_BUTTON_CLASS }"></div>` : '' }
      <span data-is-tooltip-wrapper="true">
        <button
          class="pYTkkf-Bz112c-LgbsSe pYTkkf-Bz112c-LgbsSe-OWXEXe-SfQLQb-suEOdc hJb6sc"
          jscontroller="PIVayb"
          jsaction="pointerenter:EX0mI;pointerleave:vpvbp;focus:h06R8;blur:zjh6rb;keydown.27:zjh6rb"
          jsname="DyVDA"
          data-idom-class="hJb6sc"
          data-use-native-focus-logic="true"
          data-tooltip-enabled="true"
          data-tooltip-id="${ tooltipId }"
          aria-label="${ tooltipText }"
        >
          <span class="OiePBf-zPjgPe pYTkkf-Bz112c-UHGRz"></span>
          <span class="RBHQF-ksKsZd" jscontroller="LBaJxb" jsname="m9ZlFb"></span>
          <span jsname="S5tZuc" aria-hidden="true" class="pYTkkf-Bz112c-kBDsod-Rtc0Jf">
            <span class="notranslate VfPpkd-kBDsod" aria-hidden="true">
              ${ DUPLICATE_ICON_SVG }
            </span>
          </span>
          <div class="pYTkkf-Bz112c-RLmnJb"></div>
        </button>
        <div class="ne2Ple-oshW8e-V67aGc" role="tooltip" aria-hidden="true" id="${ tooltipId }">
          ${ tooltipText }
        </div>
      </span>
    </div>
  `;
}

/** ======================================== */

/** ========== MAIN FUNCTION ========== */
function app() {
  try {
    setupEventListeners();
    console.info('Google Calendar Duplicate Extension initialized');
  } catch (error) {
    console.error('Failed to initialize extension:', error);
  }
}

/**
 * Sets up all event listeners
 */
function setupEventListeners() {
  // Event click handler
  addEvent(document, 'click', CALENDAR_EVENT_SELECTOR, handleEventClick);

  // Duplicate button click handler - now on the button element itself
  addEvent(document, 'click', `${ GCQD_DUPLICATE_BUTTON_SELECTOR } button`,
           handleDuplicateClick);

  // Cleanup on page unload
  window.addEventListener('beforeunload', cleanup);
}

/**
 * Handles calendar event clicks
 */
function handleEventClick(e) {
  // Pass the event element (this), not the event object
  injectDuplicateButton(this);
  setUpShortcut(e);
}

/**
 * Handles duplicate button clicks
 */
function handleDuplicateClick() {
  duplicateEvent();
}

/**
 * Cleanup function to clear all intervals
 */
function cleanup() {
  state.clearAllIntervals();
  document.body.classList.remove('gcqd-active');
}

/**
 * Injects the duplicate button in the event panel when the user clicks on the event.
 */
function injectDuplicateButton(eventElement) {
  console.debug('Injecting duplicate button');
  const eventId = eventElement.getAttribute('data-eventid');

  if (!eventId) {
    console.warn('No event ID found');
    return;
  }

  state.resetRetry('inject');
  state.setInterval('inject', function() {
    if (state.hasExceededRetries('inject')) {
      console.warn('Max retries exceeded for button injection');
      state.clearInterval('inject');
      return;
    }

    const eventPanelNode = document.querySelector(EVENT_PANEL_SELECTOR);
    if (!eventPanelNode) {
      state.incrementRetry('inject');
      return;
    }

    state.clearInterval('inject');
    const duplicateButton = eventPanelNode.querySelector(
        GCQD_DUPLICATE_BUTTON_SELECTOR);

    // Inject the button if it's not already there
    if (!duplicateButton) {
      prependDuplicateButton(eventPanelNode, eventId);
    }
    console.debug('Duplicate button injected successfully');
  }, INTERVAL_DELAY);
}

/**
 * Prepends the duplicate button to the event panel buttons list.
 */
function prependDuplicateButton(eventPanelNode, eventId) {
  const hasCircleBtn = hasCircleButton(eventPanelNode);
  const duplicateButton = getDuplicateButton(eventId, hasCircleBtn);
  const element = htmlToElement(duplicateButton);

  if (element) {
    eventPanelNode.prepend(element);
  }
}

/**
 * Returns true if the event panel has circle buttons.
 */
function hasCircleButton(eventPanelNode) {
  return eventPanelNode.querySelector(`.${ CIRCLE_BUTTON_CLASS }`) !== null;
}

/**
 * Duplicates the event
 */
function duplicateEvent() {
  console.debug('Duplicating event');
  document.body.classList.add('gcqd-active');

  state.resetRetry('duplicate');
  state.setInterval('duplicate', function() {
    if (state.hasExceededRetries('duplicate')) {
      console.error('Max retries exceeded for event duplication');
      cleanup();
      return;
    }

    const optionsButton = document.querySelector(OPTIONS_BUTTON_SELECTOR);
    const duplicateButton = document.querySelector(DUPLICATE_BUTTON_SELECTOR);

    // Open the options menu if it's closed, then click the duplicate button.
    if (isOptionsMenuClosed(optionsButton, duplicateButton)) {
      console.debug('Opening options menu');
      simulateClick(optionsButton);
      state.incrementRetry('duplicate');
    } else if (duplicateButton) {
      console.debug('Options menu opened');

      // Store current date before duplication
      const currentDayElement = document.querySelector(
          MINI_CALENDAR_CURRENT_DAY_SELECTOR);
      if (currentDayElement) {
        state.currentDate = currentDayElement.getAttribute('data-date');
        console.debug(`Current date: ${ state.currentDate }`);
      }

      console.debug('Clicking duplicate button');
      simulateClick(duplicateButton);
      saveEvent();
    } else {
      state.incrementRetry('duplicate');
    }
  }, INTERVAL_DELAY);
}

/**
 * Returns true if the options menu inside an event panel is closed.
 */
function isOptionsMenuClosed(optionsButton, duplicateButton) {
  return optionsButton !== null && duplicateButton === null;
}

/**
 * Saves the duplicated event when the save modal has opened.
 */
function saveEvent() {
  console.debug('Saving event');

  state.resetRetry('save');
  state.setInterval('save', function() {
    if (state.hasExceededRetries('save')) {
      console.error('Max retries exceeded for saving event');
      cleanup();
      return;
    }

    const saveButton = document.querySelector(SAVE_BUTTON_SELECTOR);
    if (!saveButton) {
      state.incrementRetry('save');
      return;
    }

    state.clearInterval('duplicate');
    state.clearInterval('save');

    try {
      saveButton.click();
      console.debug('Event saved');
      goToCurrentDate();
    } catch (error) {
      console.error('Failed to save event:', error);
      cleanup();
    }
  }, INTERVAL_DELAY);
}

/**
 * Returns to the date the user was on prior to duplicating the event.
 */
function goToCurrentDate() {
  if (!state.currentDate) {
    console.debug('No stored date to return to');
    cleanup();
    return;
  }

  console.debug(`Going to current date (${ state.currentDate })`);

  state.resetRetry('goToDate');
  state.setInterval('goToDate', function() {
    if (state.hasExceededRetries('goToDate')) {
      console.warn('Max retries exceeded for date navigation');
      cleanup();
      return;
    }

    if (location.href.includes('duplicate')) {
      state.incrementRetry('goToDate');
      return;
    }

    state.clearInterval('goToDate');

    const todayDate = padDate(new Date());
    if (state.currentDate !== todayDate) {
      console.debug(
          `Current date (${ state.currentDate }) is not today's date (${ todayDate }): navigating to stored date.`);

      try {
        navigateToDate(state.currentDate);
      } catch (error) {
        console.error('Failed to navigate to date:', error);
      }
    }

    console.debug('Navigation complete');
    cleanup();
  }, INTERVAL_DELAY);
}

/**
 * Navigates to a specific date using the mini calendar
 */
function navigateToDate(targetDate) {
  const miniDay = document.querySelector(MINI_CALENDAR_DAY_SELECTOR);
  if (!miniDay) {
    console.warn('Could not find mini calendar day element');
    return;
  }

  const miniWeek = miniDay.parentNode;
  const clonedDay = miniDay.cloneNode(true);
  clonedDay.setAttribute('data-date', targetDate);
  miniWeek.appendChild(clonedDay);
  clonedDay.click();
  clonedDay.remove();
  console.debug('Navigated to target date');
}

/**
 * Triggers event duplication on shortcut click.
 */
function setUpShortcut(event) {
  if (event.altKey && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    event.stopPropagation();
    duplicateEvent();
  }
}

/** ======================================== */

/** ========== UTILITY FUNCTIONS ========== */
/**
 * Pads a date with leading zeros.
 */
function padDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${ year }${ month }${ day }`;
}

/**
 * Adds event delegation
 */
function addEvent(parent, evt, selector, handler) {
  parent.addEventListener(evt, function(event) {
    const target = event.target.closest(selector);
    if (target) {
      handler.call(target, event);
    }
  }, false);
}

/**
 * Returns the element node corresponding to the html in input.
 */
function htmlToElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstChild;
}

/**
 * Simulates a click by the user.
 */
function simulateClick(element) {
  if (!element) {
    console.warn('Cannot click null element');
    return;
  }

  try {
    // Click the element
    element.click();

    // Dispatch mouse events for better compatibility
    ['mousedown', 'mouseup'].forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true, cancelable: true, view: window,
      }));
    });
  } catch (error) {
    console.error('Failed to simulate click:', error);
  }
}

/** ======================================== */

/** ========== INITIALIZATION ========== */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', app);
} else {
  app();
}
/** ======================================== */
