import { useSyncExternalStore } from 'react';

/**
 * A session to open in the usage table, asked for from elsewhere on the page (a day's largest
 * sessions): the table opens its project and its detail, and brings it into view. Each ask has its
 * own number, so asking for the same session again opens it again.
 */
export interface UsageFocus {
  id: string;
  ask: number;
}

let focus: UsageFocus = { id: '', ask: 0 };
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useUsageFocus = () =>
  useSyncExternalStore(
    subscribe,
    () => focus,
    () => focus
  );

export function focusUsageSession(id: string) {
  focus = { id, ask: focus.ask + 1 };
  listeners.forEach((listener) => listener());
}
