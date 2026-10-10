import { useEffect, useState } from 'react';
import { failureOf, quotaPilotApi, useManagementKey, type ReadFailure } from '@/services/api';
import type { QuotaPilotSnapshot } from '@/types';
import { useUsageVersion } from '../usageRefresh';
import { polledAfter, type Polled } from './useQuotaPilotUsage';

export const QUOTA_PILOT_POLL_MS = 15_000;

/** `failure` on a live snapshot says why the last read did not replace it. */
export type QuotaPilotSnapshotState =
  | { status: 'loading' }
  | { status: 'live'; snapshot: QuotaPilotSnapshot; failure: ReadFailure | null }
  | { status: 'unavailable'; failure: ReadFailure };

const LOADING: QuotaPilotSnapshotState = { status: 'loading' };

/**
 * Polls the quota-pilot snapshot every 15 s while mounted and the browser tab is visible;
 * returning to the tab, or a refresh, reads it at once. A read that fails keeps the last snapshot,
 * saying why; with none it reads as "unavailable". Results are tagged with the key they were read
 * with, so an answer from before the key changed never shows.
 */
export function useQuotaPilotSnapshot(): QuotaPilotSnapshotState {
  const key = useManagementKey();
  const version = useUsageVersion();
  const [result, setResult] = useState<Polled<QuotaPilotSnapshot> | null>(null);

  useEffect(() => {
    if (!key) return;
    let disposed = false;
    let inFlight = false;

    const load = async () => {
      // A slow response is not abandoned for a newer one; the next tick waits for it.
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const snapshot = await quotaPilotApi.getSnapshot();
        if (!disposed) setResult((prev) => polledAfter(prev, key, key, { value: snapshot }));
      } catch (err: unknown) {
        const failure = failureOf(err);
        if (!disposed) setResult((prev) => polledAfter(prev, key, key, { failure }));
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), QUOTA_PILOT_POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [key, version]);

  if (!key || result?.key !== key) return LOADING;
  if (result.value) return { status: 'live', snapshot: result.value, failure: result.failure };
  return result.failure ? { status: 'unavailable', failure: result.failure } : LOADING;
}
