import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError, failureOf, submitKey, useManagementKey } from '@/services/api/client';
import { polledAfter } from '@/features/quota/hooks/useQuotaPilotUsage';
import {
  QUOTA_PILOT_SNAPSHOT_PATH,
  normalizeQuotaPilotSnapshot,
  quotaPilotApi,
} from '@/services/api/quotaPilot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { rawSnapshot } from './fixtures/quotaPilotSnapshot';

const realFetch = globalThis.fetch;
const calls: { url: string; init?: RequestInit }[] = [];
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
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

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe('quota-pilot snapshot API', () => {
  test('reads the plugin route on this origin with the management key', async () => {
    submitKey('k1');
    answer(200, rawSnapshot);
    const snapshot = await quotaPilotApi.getSnapshot();
    expect(calls[0].url).toBe('/v0/management/quota-pilot/snapshot');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer k1');
    // Given up after a while, so a stuck request does not hold a poll or the Refresh button.
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(snapshot.sequence).toBe(37);
    expect(QUOTA_PILOT_SNAPSHOT_PATH).toBe('/v0/management/quota-pilot/snapshot');
  });

  test('a refused key is dropped once, so the page asks instead of trying it again', async () => {
    submitKey('wrong');
    answer(401, { error: 'invalid management key' });
    await expect(quotaPilotApi.getSnapshot()).rejects.toMatchObject({
      status: 401,
      message: 'invalid management key',
    });
    expect(keyInUse()).toBe('');
  });

  test('rejects a payload that is not a snapshot', async () => {
    submitKey('k1');
    answer(200, '"<html>proxy error</html>"');
    await expect(quotaPilotApi.getSnapshot()).rejects.toThrow('malformed');
  });

  test('normalizes wire fields and drops unusable values', () => {
    const snapshot = normalizeQuotaPilotSnapshot({
      ...rawSnapshot,
      providers: {
        Claude: {
          health: 'on fire',
          credentials: [
            { id: '', label: 'x' },
            {
              id: 'claude-alice.json',
              email: 'alice@example.com',
              order: 1,
              tier: 1,
              sessions: -1,
              windows: [
                { kind: '7d', remaining: 1.4, reset_at: '0001-01-01T00:00:00Z' },
                { label: 'no kind' },
              ],
            },
          ],
        },
      },
    })!;

    expect(snapshot.generatedAtMs).toBe(Date.parse('2026-10-03T23:59:48Z'));
    expect(snapshot.config).toEqual({
      crossProvider: 'off',
      fallbackMap: { claude: 'codex:gpt-6-sol' },
      minFiveHourLeftPercent: 10,
      idlePollMinutes: 10,
    });
    const claude = snapshot.providers.claude;
    expect(claude.health).toBe('unknown');
    expect(claude.credentials).toHaveLength(1);
    expect(claude.credentials[0].sessions).toBe(0);
    expect(claude.credentials[0].windows).toEqual([
      {
        kind: '7d',
        label: '7d',
        remaining: 1,
        resetAtMs: null,
        observedAtMs: null,
        stale: false,
      },
    ]);
    expect(normalizeQuotaPilotSnapshot(null)).toBeNull();
    expect(normalizeQuotaPilotSnapshot({ providers: [] })).toBeNull();
  });
});

describe('read failures', () => {
  test('say why a read failed', () => {
    expect(failureOf(new DOMException('timed out', 'TimeoutError'))).toEqual({ kind: 'timeout' });
    expect(failureOf(new ApiError('HTTP 404', 404))).toEqual({ kind: 'missing' });
    expect(failureOf(new ApiError('boom', 500))).toEqual({ kind: 'error', message: 'boom' });
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
  });
});

describe('a poll that fails', () => {
  test('keeps what it read for the same request and key, beside why; for another, nothing', () => {
    const read = polledAfter<string>(null, 'week', 'k1', { value: 'report' });
    expect(read).toEqual({ key: 'week', auth: 'k1', value: 'report', failure: null });
    const failed = polledAfter(read, 'week', 'k1', { failure: { kind: 'timeout' } });
    expect(failed).toEqual({ key: 'week', auth: 'k1', value: 'report', failure: { kind: 'timeout' } });
    expect(polledAfter(failed, 'week', 'k1', { value: 'newer' }).failure).toBe(null);
    expect(polledAfter(read, '7d', 'k1', { failure: { kind: 'timeout' } }).value).toBe(null);
    expect(polledAfter(read, 'week', 'k2', { failure: { kind: 'timeout' } }).value).toBe(null);
  });

  test('a 404 the plugin names is its answer, not a missing plugin', () => {
    expect(failureOf(new ApiError('unknown account or provider', 404, true))).toEqual({
      kind: 'error',
      message: 'unknown account or provider',
    });
  });
});
