import { useEffect, useState } from 'react';
import { quotaPilotApi, useManagementKey } from '@/services/api';
import type { QuotaPilotUsage, QuotaPilotUsageRange, QuotaPilotUsageSessionDetail } from '@/types';
import { useUsageVersion } from '../usageRefresh';

export const QUOTA_PILOT_USAGE_POLL_MS = 60_000;

export type QuotaPilotUsageState =
  { status: 'loading' } | { status: 'ready'; usage: QuotaPilotUsage } | { status: 'unavailable' };

export type QuotaPilotUsageResult = QuotaPilotUsageState & {
  /** The latest report for any scope, so the picker stays while another scope loads. */
  latest: QuotaPilotUsage | null;
};

/**
 * Polls `load` every minute while the tab is visible and `key` is set, and at once after a
 * refresh. A response for another key is dropped; the last one stays on screen while the next is
 * read. Results are tagged with the management key they were read with: what one key read never
 * shows under another.
 */
function usePolled<T>(key: string | null, load: (key: string) => Promise<T>) {
  const managementKey = useManagementKey();
  const connected = managementKey !== '';
  const version = useUsageVersion();
  const [stored, setStored] = useState<{
    key: string;
    auth: string;
    value: T | null;
    failed: boolean;
  } | null>(null);
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
        if (isCurrent()) setStored({ key, auth: managementKey, value, failed: false });
      } catch {
        if (isCurrent()) setStored({ key, auth: managementKey, value: null, failed: true });
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
  return result.failed || !value
    ? { status: 'unavailable', latest: shown }
    : { status: 'ready', usage: value, latest: shown };
}

export type QuotaPilotSessionState =
  | { status: 'loading' }
  | { status: 'ready'; detail: QuotaPilotUsageSessionDetail }
  | { status: 'unavailable' };

/** One session's detail within the view's scope and range while it is open; `null` loads nothing. */
export function useQuotaPilotUsageSession(
  id: string | null,
  scope: string,
  range: QuotaPilotUsageRange
): QuotaPilotSessionState {
  const key = id === null ? null : [id, scope, range].join(SEP);
  const { connected, result } = usePolled(key, loadSession);
  if (!connected || key === null || result?.key !== key) return { status: 'loading' };
  return result.failed || !result.value
    ? { status: 'unavailable' }
    : { status: 'ready', detail: result.value };
}
