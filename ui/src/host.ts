/**
 * What this page takes from the management panel that frames it. The plugin serves the page from
 * the proxy, the panel's own origin, so the page reads the panel's saved management key, theme and
 * language where the panel keeps them, follows them when the panel changes them, and lays itself
 * out at the panel's width rather than the frame's.
 *
 * Opened on its own, outside the panel, the page still works: it asks for the key and follows the
 * system theme and the browser's language.
 */

import { useSyncExternalStore } from 'react';

export type Language = 'zh-CN' | 'zh-TW' | 'en' | 'ru';
export type ResolvedTheme = 'light' | 'dark';

// Where the panel keeps its state (src/utils/constants.ts in the panel).
const AUTH_KEY = 'cli-proxy-auth';
const THEME_KEY = 'cli-proxy-theme';
const LANGUAGE_KEY = 'cli-proxy-language';
// A key typed into this page, kept for the browser tab only, when the panel did not save one.
const OWN_KEY = 'quota-pilot.managementKey';

const LANGUAGES: readonly Language[] = ['zh-CN', 'zh-TW', 'en', 'ru'];

const readStorage = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const stateOf = (value: unknown): Record<string, unknown> => {
  const state = (value as { state?: unknown } | null)?.state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
};

/**
 * The panel's reversible obfuscation of saved values (src/utils/encryption.ts in the panel): XOR
 * with a key made of a fixed salt, the host and the user agent, then base64 behind a prefix.
 */
const OBFUSCATED_PREFIX = 'enc::v1::';
const OBFUSCATION_SALT = 'cli-proxy-api-webui::secure-storage';

export function deobfuscate(raw: string, host: string, userAgent: string): string {
  if (!raw.startsWith(OBFUSCATED_PREFIX)) return raw;
  const key = new TextEncoder().encode(`${OBFUSCATION_SALT}|${host}|${userAgent}`);
  const binary = atob(raw.slice(OBFUSCATED_PREFIX.length));
  const bytes = Uint8Array.from(binary, (char, i) => char.charCodeAt(0) ^ key[i % key.length]);
  return new TextDecoder().decode(bytes);
}

// Fingerprints of keys the API refused, kept for the browser tab, so no visit tries one again.
const REFUSED_KEYS = 'quota-pilot.refusedKeys';

/** FNV-1a, 64 bit: tells refused keys apart without keeping them. */
export function fingerprint(key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(key)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16);
}

const refusedKeys = (): string[] => {
  const list = parseJson(readStorage(() => sessionStorage, REFUSED_KEYS));
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
};

const writeRefusedKeys = (list: string[]) => {
  try {
    sessionStorage.setItem(REFUSED_KEYS, JSON.stringify(list));
  } catch {
    // Without storage the page still drops the key it holds; a new visit may try it once more.
  }
};

/** Notes a refused key, and drops it if it was typed here. */
export function refuseKey(key: string) {
  if (!key) return;
  const print = fingerprint(key);
  const list = refusedKeys();
  if (!list.includes(print)) writeRefusedKeys([...list, print]);
  if (readStorage(() => sessionStorage, OWN_KEY)?.trim() === key) saveOwnKey('');
}

const panelSavedKey = (): string => {
  const raw = readStorage(() => localStorage, AUTH_KEY);
  if (!raw) return '';
  try {
    const saved = stateOf(parseJson(deobfuscate(raw, location.host, navigator.userAgent)));
    return typeof saved.managementKey === 'string' ? saved.managementKey.trim() : '';
  } catch {
    // A value the panel wrote some other way: the page asks.
    return '';
  }
};

/**
 * A key typed into this page in this browser tab, else the one the panel saved at login; never
 * one the API refused in this tab, since five wrong keys ban the address for 30 minutes.
 */
export function readManagementKey(): string {
  const refused = refusedKeys();
  const own = readStorage(() => sessionStorage, OWN_KEY)?.trim() ?? '';
  return (
    [own, panelSavedKey()].find((key) => key !== '' && !refused.includes(fingerprint(key))) ?? ''
  );
}

/** Keeps a key typed into the page for the browser tab; typing a refused key tries it again. */
export function saveOwnKey(key: string) {
  try {
    if (key) {
      sessionStorage.setItem(OWN_KEY, key);
      const print = fingerprint(key);
      writeRefusedKeys(refusedKeys().filter((item) => item !== print));
    } else {
      sessionStorage.removeItem(OWN_KEY);
    }
  } catch {
    // Without storage the key lasts as long as the page.
  }
}

const systemDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The panel's theme setting as the page applies it: dark, white, or the default light. */
function appliedTheme(): 'dark' | 'white' | 'light' {
  const theme = stateOf(parseJson(readStorage(() => localStorage, THEME_KEY))).theme;
  if (theme === 'dark' || theme === 'white' || theme === 'light') return theme;
  return systemDark() ? 'dark' : 'white';
}

export function readLanguage(): Language {
  const stored = stateOf(parseJson(readStorage(() => localStorage, LANGUAGE_KEY))).language;
  if (typeof stored === 'string' && LANGUAGES.includes(stored as Language)) {
    return stored as Language;
  }
  const raw = (navigator.languages?.[0] || navigator.language || 'zh-CN').toLowerCase();
  if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].some((prefix) => raw.startsWith(prefix))) {
    return 'zh-TW';
  }
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('ru')) return 'ru';
  return 'en';
}

/** The panel's window when the page is framed by it on the same origin, else null. */
function panelWindow(): Window | null {
  try {
    if (window.parent === window) return null;
    // Reading the location throws across origins.
    void window.parent.location.href;
    return window.parent;
  } catch {
    return null;
  }
}

// The panel's page padding (src/styles/layout.scss in the panel): `.main-content` leaves room
// for the floating header on top, and narrows below 768 px, where the panel turns mobile.
const MOBILE_MAX = 768;

export interface PageLayout {
  mobile: boolean;
  padX: number;
  padTop: number;
  padBottom: number;
}

export function pageLayout(width: number): PageLayout {
  if (width <= MOBILE_MAX) return { mobile: true, padX: 16, padTop: 74 + 16, padBottom: 24 };
  return { mobile: false, padX: Math.min(48, Math.max(20, width * 0.03)), padTop: 70, padBottom: 40 };
}

let theme: ResolvedTheme = 'light';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function applyHost(onLanguage: (language: Language) => void) {
  const applied = appliedTheme();
  if (applied === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', applied);
  theme = applied === 'dark' ? 'dark' : 'light';

  const width = (panelWindow() ?? window).innerWidth;
  const layout = pageLayout(width);
  const style = document.documentElement.style;
  style.setProperty('--panel-vw', `${width / 100}px`);
  style.setProperty('--page-pad-x', `${layout.padX}px`);
  style.setProperty('--page-pad-top', `${layout.padTop}px`);
  style.setProperty('--page-pad-bottom', `${layout.padBottom}px`);
  document.documentElement.toggleAttribute('data-mobile', layout.mobile);

  onLanguage(readLanguage());
  notify();
}

/**
 * Applies the panel's theme, language and layout now and whenever they change: the panel writes
 * theme and language to storage, which reaches this page as a `storage` event, and its window
 * resizes with the frame or on its own.
 */
export function followHost(onLanguage: (language: Language) => void) {
  const apply = () => applyHost(onLanguage);
  apply();
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === THEME_KEY || event.key === LANGUAGE_KEY) apply();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  window.addEventListener('resize', apply);
  // The panel's window outlives the frame: its listener goes when the page does, or every visit
  // would leave one behind.
  const panel = panelWindow();
  if (panel) {
    panel.addEventListener('resize', apply);
    window.addEventListener('pagehide', () => panel.removeEventListener('resize', apply), { once: true });
  }
}

/** The theme the page shows, for the few things drawn per theme (provider icons). */
export const useResolvedTheme = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => theme,
    () => theme
  );

/**
 * Opens one of the panel's own pages (a route such as `/plugins`) in the panel, through the
 * panel's own link to it, so its router keeps its history and asks before leaving unsaved changes.
 * Without such a link the panel is loaded at that route.
 */
export function openPanelRoute(route: string) {
  const panel = panelWindow();
  if (!panel) {
    window.open(`/management.html#${route}`, '_top');
    return;
  }
  const link = panel.document.querySelector<HTMLAnchorElement>(`a[href="#${route}"]`);
  if (link) {
    link.click();
    return;
  }
  panel.location.hash = route;
  panel.location.reload();
}
