/**
 * The management key: the page never sends a key the API refused again, in this visit or a later
 * one in the same tab, since five wrong keys ban the address for 30 minutes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deobfuscate, fingerprint, readManagementKey } from '@/host';
import { submitKey, useManagementKey } from '@/services/api/client';
import { quotaPilotApi } from '@/services/api/quotaPilot';

const HOST = '127.0.0.1:8317';
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { localStorage: globals.localStorage, sessionStorage: globals.sessionStorage, location: globals.location };
const realFetch = globalThis.fetch;

const storage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

/** The panel's obfuscation is an XOR, so applying it twice gives the value back. */
const panelSaves = (managementKey: string) => {
  const state = JSON.stringify({ state: { apiBase: '', managementKey, rememberPassword: true }, version: 0 });
  const key = new TextEncoder().encode(`cli-proxy-api-webui::secure-storage|${HOST}|${navigator.userAgent}`);
  const bytes = new TextEncoder().encode(state).map((byte, i) => byte ^ key[i % key.length]);
  (globals.localStorage as Storage).setItem('cli-proxy-auth', `enc::v1::${btoa(String.fromCharCode(...bytes))}`);
};

const keyInUse = () => {
  let key = '';
  const Probe = () => {
    key = useManagementKey();
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return key;
};

const refuse = async () => {
  globalThis.fetch = (async () => new Response('{"error":"invalid management key"}', { status: 401 })) as unknown as typeof fetch;
  await expect(quotaPilotApi.getSnapshot()).rejects.toMatchObject({ status: 401 });
};

beforeAll(() => {
  globals.localStorage = storage();
  globals.sessionStorage = storage();
  globals.location = { host: HOST };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

describe('management key', () => {
  test('reads the key the panel saved at login', () => {
    panelSaves('panel-key');
    expect(readManagementKey()).toBe('panel-key');
    const raw = (globals.localStorage as Storage).getItem('cli-proxy-auth')!;
    expect(deobfuscate(raw, HOST, navigator.userAgent)).toContain('"managementKey":"panel-key"');
  });

  test('a refused key is never tried again, whichever key is refused next', async () => {
    submitKey('typed-wrong');
    expect(keyInUse()).toBe('typed-wrong');

    // The typed key is refused: the panel's key is tried next.
    await refuse();
    expect(keyInUse()).toBe('panel-key');

    // The panel's key is refused too: the page asks, and a later visit does not try either.
    await refuse();
    expect(keyInUse()).toBe('');
    expect(readManagementKey()).toBe('');

    // Typing a refused key again is the user's call; a key the panel saves since is tried.
    submitKey('typed-wrong');
    expect(readManagementKey()).toBe('typed-wrong');
    (globals.sessionStorage as Storage).removeItem('quota-pilot.managementKey');
    panelSaves('new-panel-key');
    expect(readManagementKey()).toBe('new-panel-key');
  });

  test('fingerprints tell keys apart without keeping them', () => {
    expect(fingerprint('a')).toBe(fingerprint('a'));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
    expect(fingerprint('secret-key')).not.toContain('secret');
  });
});
