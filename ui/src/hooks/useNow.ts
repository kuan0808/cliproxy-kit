/**
 * Current instant, refreshed once a minute, from a clock shared app-wide.
 */

import { useSyncExternalStore } from 'react';
import { MINUTE_CLOCK, type SharedClock } from '@/utils/time/sharedClock';

const noopSubscribe = () => () => {};

/**
 * Frozen snapshot for the disabled path and for SSR.
 *
 * Captured once at module load rather than per call: `useSyncExternalStore`
 * requires a stable snapshot, and `renderToStaticMarkup` (used by
 * tests/quotaTimelineRendering.test.ts) calls `getServerSnapshot`, so this
 * cannot be `Date.now`.
 */
const FROZEN_NOW = Date.now();
const frozenSnapshot = () => FROZEN_NOW;

/**
 * @param enabled pass false to opt out of minute re-renders — the hook still
 * runs (rules of hooks) but subscribes to nothing and returns a frozen value.
 * Callers that only need `now` in one branch should gate here rather than
 * calling the hook conditionally.
 * @param clock defaults to the minute clock; pass `SECOND_CLOCK` for labels that count seconds.
 */
export function useNow(enabled = true, clock: SharedClock = MINUTE_CLOCK): number {
  return useSyncExternalStore(
    enabled ? clock.subscribe : noopSubscribe,
    enabled ? clock.getSnapshot : frozenSnapshot,
    frozenSnapshot
  );
}
