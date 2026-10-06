/**
 * Management API calls from this page. The page is served by the proxy, so the plugin's routes are
 * on this origin; each call carries the management key, and a 401 sends the page back to asking
 * for one. A call that takes over 30 seconds is given up, as the panel's own client does, so a
 * stuck request never holds a poll or the Refresh button.
 */

const REQUEST_TIMEOUT_MS = 30_000;

import { useSyncExternalStore } from 'react';
import { readManagementKey, refuseKey, saveOwnKey } from '@/host';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

// The key in use; null until the page first looks, '' when there is none or it was refused.
let key: string | null = null;
// The last key tried was refused, so the page says so when it asks again.
let refused = false;
const listeners = new Set<() => void>();
const setKey = (next: string, wasRefused = false) => {
  key = next;
  refused = wasRefused;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const currentKey = () => {
  if (key === null) key = readManagementKey();
  return key;
};

/** The key in use, '' when the page has to ask for one. */
export const useManagementKey = () => useSyncExternalStore(subscribe, currentKey, currentKey);

/** The last key tried was refused. */
export const useKeyRefused = () =>
  useSyncExternalStore(
    subscribe,
    () => refused,
    () => refused
  );

/** Takes a key typed into the page; it stays for this browser tab. */
export function submitKey(next: string) {
  saveOwnKey(next);
  setKey(next);
}

const messageOf = (body: string, status: number) => {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const message = parsed.error ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // Not JSON: the status says enough.
  }
  return `HTTP ${status}`;
};

async function call(method: 'GET' | 'POST', path: string): Promise<unknown> {
  const used = currentKey();
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${used}` },
    cache: 'no-store',
    // Covers reading the body too.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  // A refused key is noted for the browser tab and never tried again, here or on a later visit:
  // five wrong keys ban the address for 30 minutes. Another key, one the panel saved since, is
  // tried next, else the page asks.
  if (response.status === 401) {
    refuseKey(used);
    if (used === currentKey()) setKey(readManagementKey(), true);
  }
  if (!response.ok) throw new ApiError(messageOf(body, response.status), response.status);
  return body ? JSON.parse(body) : null;
}

export const apiClient = {
  get: (path: string) => call('GET', path),
  post: (path: string) => call('POST', path),
};
