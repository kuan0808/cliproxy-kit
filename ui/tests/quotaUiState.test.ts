/**
 * The page's remembered choices. The merge-on-write case is the one that matters: the tabs, the
 * view switch and the email toggle each write one field, so a whole-object write would drop the
 * others.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readQuotaUiState, writeQuotaUiState } from '@/features/quota/uiState';

const KEY = 'quota-pilot.uiState';

/** Test files share one process; leaving a fake `window` behind would leak. */
const originalWindow = (globalThis as { window?: unknown }).window;

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  return storage;
}

let storage: ReturnType<typeof installLocalStorage>;

beforeEach(() => {
  storage = installLocalStorage();
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('quota ui state', () => {
  test('writing one choice keeps the others', () => {
    writeQuotaUiState({ tab: 'claude' });
    writeQuotaUiState({ view: 'usage' });
    writeQuotaUiState({ showEmails: true });
    expect(readQuotaUiState()).toEqual({ tab: 'claude', view: 'usage', showEmails: true });
  });

  test('keeps any provider tab; the page checks it against the providers it shows', () => {
    writeQuotaUiState({ tab: 'devin' });
    expect(readQuotaUiState()?.tab).toBe('devin');
  });

  test('drops values outside the contract', () => {
    storage.setItem(KEY, JSON.stringify({ tab: 7, view: 'cards', showEmails: 'yes' }));
    expect(readQuotaUiState()).toEqual({ tab: undefined, view: undefined, showEmails: undefined });
  });

  test('survives absent, malformed and non-object payloads', () => {
    expect(readQuotaUiState()).toBeNull();

    storage.setItem(KEY, '{not json');
    expect(readQuotaUiState()).toBeNull();

    storage.setItem(KEY, '"a string"');
    expect(readQuotaUiState()).toBeNull();
  });
});
