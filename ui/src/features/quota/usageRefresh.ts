import { useSyncExternalStore } from 'react';
import { quotaPilotApi } from '@/services/api';

/**
 * The page's polls follow one version: a refresh asks the plugin to read every account's quota
 * now, then bumps it, and the snapshot, every report and session detail on screen ask again.
 */
let version = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useUsageVersion = () =>
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  );

export function bumpUsageVersion() {
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Reads every account's quota now, then has the view ask again; a failed read still re-asks. */
export async function refreshUsage() {
  try {
    await quotaPilotApi.refresh();
  } finally {
    bumpUsageVersion();
  }
}
