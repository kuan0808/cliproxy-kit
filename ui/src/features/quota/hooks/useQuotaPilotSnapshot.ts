import { useEffect, useState } from 'react';
import { quotaPilotApi, useManagementKey } from '@/services/api';
import type { QuotaPilotSnapshot } from '@/types';
import { useUsageVersion } from '../usageRefresh';

export const QUOTA_PILOT_POLL_MS = 15_000;

export type QuotaPilotSnapshotState =
  | { status: 'loading' }
  | { status: 'live'; snapshot: QuotaPilotSnapshot }
  | { status: 'unavailable' };

const LOADING: QuotaPilotSnapshotState = { status: 'loading' };

/**
 * Polls the quota-pilot snapshot every 15 s while mounted and the browser tab is visible;
 * returning to the tab, or a refresh, reads it at once. A failure reads as "unavailable". Results are tagged
 * with the key they were read with, so an answer from before the key changed never shows.
 */
export function useQuotaPilotSnapshot(): QuotaPilotSnapshotState {
  const key = useManagementKey();
  const version = useUsageVersion();
  const [result, setResult] = useState<{ key: string; state: QuotaPilotSnapshotState } | null>(
    null
  );

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
        if (!disposed) setResult({ key, state: { status: 'live', snapshot } });
      } catch {
        if (!disposed) setResult({ key, state: { status: 'unavailable' } });
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

  return key && result?.key === key ? result.state : LOADING;
}
