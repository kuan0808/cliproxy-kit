import { useEffect, useState } from 'react';
import { failureOf, quotaPilotApi, useManagementKey, type ReadFailure } from '@/services/api';
import type { QuotaPilotUsage, QuotaPilotUsageRange, QuotaPilotUsageSessionDetail } from '@/types';
import { useUsageVersion } from '../usageRefresh';

export const QUOTA_PILOT_USAGE_POLL_MS = 60_000;

/** `failure` on a ready report says why the last read did not replace it. */
export type QuotaPilotUsageState =
  | { status: 'loading' }
  | { status: 'ready'; usage: QuotaPilotUsage; failure: ReadFailure | null }
  | { status: 'unavailable'; failure: ReadFailure };

export type QuotaPilotUsageResult = QuotaPilotUsageState & {
  /** The latest report for any scope, so the picker stays while another scope loads. */
  latest: QuotaPilotUsage | null;
};

/** What a poll holds: the value last read for `key` under the management key `auth`, and why the
 * last read failed, if it did. */
export type Polled<T> = { key: string; auth: string; value: T | null; failure: ReadFailure | null };

/**
 * What a poll holds after a read: a value read replaces what it held; a failure keeps the value
 * read before for the same request and key, beside why, and holds nothing for another.
 */
export function polledAfter<T>(
  prev: Polled<T> | null,
  key: string,
  auth: string,
  read: { value: T } | { failure: ReadFailure }
): Polled<T> {
  if ('value' in read) return { key, auth, value: read.value, failure: null };
  const kept = prev?.key === key && prev.auth === auth ? prev.value : null;
  return { key, auth, value: kept, failure: read.failure };
}

/**
 * Polls `load` every minute while the tab is visible and `key` is set, and at once after a
 * refresh. A response for another key is dropped; the last one stays on screen while the next is
 * read, and when the next fails, beside why. Results are tagged with the management key they were
 * read with: what one key read never shows under another.
 */
function usePolled<T>(key: string | null, load: (key: string) => Promise<T>) {
  const managementKey = useManagementKey();
  const connected = managementKey !== '';
  const version = useUsageVersion();
  const [stored, setStored] = useState<Polled<T> | null>(null);
  const result = stored?.auth === managementKey ? stored : null;

  useEffect(() => {
    if (!connected || key === null) return;
    let disposed = false;
    let inFlight = false;
    const isCurrent = () => !disposed;

    const run = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const value = await load(key);
        if (isCurrent()) setStored((prev) => polledAfter(prev, key, managementKey, { value }));
      } catch (err: unknown) {
        const failure = failureOf(err);
        if (isCurrent()) setStored((prev) => polledAfter(prev, key, managementKey, { failure }));
      } finally {
        inFlight = false;
      }
    };

    void run();
    const timer = window.setInterval(() => void run(), QUOTA_PILOT_USAGE_POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connected, managementKey, key, load, version]);

  return { connected, managementKey, result };
}

// Keys join what a request needs: scope and range, or session, scope and range.
const SEP = '\n';
const loadUsage = (key: string) => {
  const [scope, range] = key.split(SEP);
  return quotaPilotApi.getUsage(scope, range as QuotaPilotUsageRange);
};
const loadSession = (key: string) => {
  const [id, scope, range] = key.split(SEP);
  return quotaPilotApi.getUsageSession(id, scope, range as QuotaPilotUsageRange);
};

/** The usage report for `scope` (an account id, `provider:<name>` or `all`) over `range`. */
export function useQuotaPilotUsage(
  scope: string,
  range: QuotaPilotUsageRange
): QuotaPilotUsageResult {
  const key = scope ? [scope, range].join(SEP) : null;
  const { connected, managementKey, result } = usePolled(key, loadUsage);
  const [latest, setLatest] = useState<{ auth: string; usage: QuotaPilotUsage } | null>(null);
  const value = result?.value ?? null;
  if (value && value !== latest?.usage) setLatest({ auth: managementKey, usage: value });
  const shown = connected && latest?.auth === managementKey ? latest.usage : null;
  if (!connected || result?.key !== key) return { status: 'loading', latest: shown };
  if (value) return { status: 'ready', usage: value, failure: result.failure, latest: shown };
  return { status: 'unavailable', failure: result.failure ?? { kind: 'missing' }, latest: shown };
}

export type QuotaPilotSessionState =
  | { status: 'loading' }
  | { status: 'ready'; detail: QuotaPilotUsageSessionDetail; failure: ReadFailure | null }
  | { status: 'unavailable'; failure: ReadFailure };

/** One session's detail within the view's scope and range while it is open; `null` loads nothing. */
export function useQuotaPilotUsageSession(
  id: string | null,
  scope: string,
  range: QuotaPilotUsageRange
): QuotaPilotSessionState {
  const key = id === null ? null : [id, scope, range].join(SEP);
  const { connected, result } = usePolled(key, loadSession);
  if (!connected || key === null || result?.key !== key) return { status: 'loading' };
  return result.value
    ? { status: 'ready', detail: result.value, failure: result.failure }
    : { status: 'unavailable', failure: result.failure ?? { kind: 'missing' } };
}
