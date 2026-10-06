/**
 * Quota Ledger: one dense row per credential, grouped by provider, from the quota-pilot snapshot
 * with credentials already in routing order.
 *
 * Pure: no React, no store, no clock of its own (`nowMs` is passed in).
 */

import type { QuotaPilotHealth, QuotaPilotSnapshot } from '@/types';
import { QUOTA_TAB_ORDER, type QuotaTabId } from './constants';

/** The window the pooled sum and the next-reset column are computed from. */
export const LEDGER_WEEKLY_KIND = '7d';

export interface LedgerWindow {
  kind: string;
  /** Source label, used when the kind has no translation. */
  label: string;
  /** Remaining percent, rounded, 0..100. */
  remaining: number;
  resetAtMs: number | null;
  stale: boolean;
}

export interface LedgerRow {
  key: string;
  /** Auth file name, e.g. `claude-…-a@example.com.json`. */
  fileName: string;
  /** Routing order; null when the plugin gives none. */
  order: number | null;
  /** Masked identity, e.g. `d•••`. */
  label: string;
  /** Full email, '' when unknown. */
  email: string;
  /** Subscription plan, '' when unknown. */
  plan: string;
  /** Routing reason from the plugin. */
  reason: string;
  sessions: number;
  serving: boolean;
  next: boolean;
  unavailable: boolean;
  windows: LedgerWindow[];
}

export interface LedgerGroup {
  provider: string;
  health: QuotaPilotHealth;
  rows: LedgerRow[];
  /** Weekly remaining summed over the accounts that report one, out of 100% each. */
  pool: LedgerPool | null;
  /** The same for the 5-hour window. */
  fiveHour: LedgerPool | null;
  /** Soonest upcoming weekly reset among the rows. */
  nextReset: { atMs: number; row: LedgerRow } | null;
}

export interface LedgerPool {
  remaining: number;
  capacity: number;
}

export interface Ledger {
  /** Window kinds present across all groups, in column order. */
  kinds: string[];
  groups: LedgerGroup[];
}

/** `a•••@e•••.com`: first character of the local part and of the domain, then the top-level domain. */
export function maskEmailAddress(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const labels = domain.split('.');
  const tld = labels.length > 1 ? `.${labels[labels.length - 1]}` : '';
  const first = (value: string) => Array.from(value)[0] ?? '';
  return `${first(local)}•••@${first(domain)}•••${tld}`;
}

/** The auth file name with its email masked, as the card view shows it. */
export function maskFileName(fileName: string, email: string): string {
  return email && fileName.includes(email) ? fileName.replace(email, maskEmailAddress(email)) : fileName;
}

/** Same rule as the plugin's `MaskEmail`: first character of the local part. */
export function maskEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = Array.from(local)[0];
  return first ? `${first}•••` : '•••';
}

const toPercent = (fraction: number) => Math.min(100, Math.max(0, Math.round(fraction * 100)));

const kindRank = (kind: string) => (kind === '5h' ? 0 : kind === LEDGER_WEEKLY_KIND ? 1 : 2);

/** Plugin order: 5-hour, weekly, then model-scoped windows alphabetically. */
export function compareKinds(a: string, b: string): number {
  return kindRank(a) - kindRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

const providerRank = (provider: string) => {
  const index = QUOTA_TAB_ORDER.indexOf(provider as (typeof QUOTA_TAB_ORDER)[number]);
  return index === -1 ? QUOTA_TAB_ORDER.length : index;
};

const compareProviders = (a: string, b: string) =>
  providerRank(a) - providerRank(b) || (a < b ? -1 : a > b ? 1 : 0);

export const weeklyWindowOf = (row: LedgerRow): LedgerWindow | undefined =>
  row.windows.find((window) => window.kind === LEDGER_WEEKLY_KIND);

const poolOf = (rows: LedgerRow[], kind: string): LedgerPool | null => {
  const windows = rows.flatMap((row) => row.windows.filter((window) => window.kind === kind));
  return windows.length
    ? { remaining: windows.reduce((sum, window) => sum + window.remaining, 0), capacity: windows.length * 100 }
    : null;
};

function buildGroup(
  provider: string,
  health: QuotaPilotHealth,
  rows: LedgerRow[],
  nowMs: number
): LedgerGroup {
  let nextReset: LedgerGroup['nextReset'] = null;
  for (const row of rows) {
    const weekly = weeklyWindowOf(row);
    if (!weekly) continue;
    const atMs = weekly.resetAtMs;
    if (atMs !== null && atMs > nowMs && (nextReset === null || atMs < nextReset.atMs)) {
      nextReset = { atMs, row };
    }
  }
  return {
    provider,
    health,
    rows,
    pool: poolOf(rows, LEDGER_WEEKLY_KIND),
    fiveHour: poolOf(rows, '5h'),
    nextReset,
  };
}

const collectKinds = (groups: LedgerGroup[]) =>
  [
    ...new Set(
      groups.flatMap((group) => group.rows.flatMap((row) => row.windows.map((w) => w.kind)))
    ),
  ].sort(compareKinds);

const matchesSearch = (values: string[], query: string) =>
  !query || values.some((value) => value.toLowerCase().includes(query));

/** The ledger from the quota-pilot snapshot, filtered by provider tab and search. */
export function buildLedger(
  snapshot: QuotaPilotSnapshot,
  tab: QuotaTabId,
  search: string,
  nowMs: number
): Ledger {
  const query = search.trim().toLowerCase();
  const groups = Object.keys(snapshot.providers)
    .filter((provider) => tab === 'all' || provider === tab)
    .sort(compareProviders)
    .map((provider) => {
      const view = snapshot.providers[provider];
      // "Next" is a routing fact, so it is decided before the search narrows the rows.
      const nextId = view.credentials.find((cred) => cred.tier === 1 && !cred.unavailable)?.id;
      const rows = view.credentials
        // Same identifiers the card search matches: the auth file name and the email.
        .filter((cred) => matchesSearch([cred.id, cred.email], query))
        .map((cred): LedgerRow => ({
          key: cred.id,
          fileName: cred.id,
          order: cred.order > 0 ? cred.order : null,
          label: cred.label || maskEmail(cred.email),
          email: cred.email,
          plan: cred.plan,
          reason: cred.reason,
          sessions: cred.sessions,
          serving: cred.sessions > 0,
          next: cred.id === nextId,
          unavailable: cred.unavailable,
          windows: cred.windows.map((window) => ({
            kind: window.kind,
            label: window.label,
            remaining: toPercent(window.remaining),
            resetAtMs: window.resetAtMs,
            stale: window.stale,
          })),
        }));
      return buildGroup(provider, view.health, rows, nowMs);
    })
    .filter((group) => group.rows.length > 0);

  return { kinds: collectKinds(groups), groups };
}

/** Snapshot age for "updated 12 s ago": seconds below a minute, then whole minutes. */
export function snapshotAgeParts(
  generatedAtMs: number | null,
  nowMs: number
): { value: number; unit: 'second' | 'minute' } | null {
  if (generatedAtMs === null) return null;
  // A server clock slightly ahead of the browser must not read "-3 s ago".
  const seconds = Math.max(0, Math.floor((nowMs - generatedAtMs) / 1000));
  return seconds < 60
    ? { value: seconds, unit: 'second' }
    : { value: Math.floor(seconds / 60), unit: 'minute' };
}

/** The plugin's routing reasons, as translation keys; anything else is shown as sent. */
export function reasonKey(reason: string): { key: string; family?: string } | null {
  const known: Record<string, string> = {
    'weekly quota resets soonest': 'reason_resets_soonest',
    'quota unknown': 'reason_unknown',
    'cooling down on some model': 'reason_cooling',
    'weekly quota used up': 'reason_weekly_used',
    '5-hour quota used up': 'reason_five_used',
    '5-hour quota low': 'reason_five_low',
    disabled: 'reason_disabled',
  };
  if (known[reason]) return { key: known[reason] };
  const used = /^Weekly (\w+) quota used up$/.exec(reason);
  if (used) return { key: 'reason_bucket_used', family: used[1] };
  const soonest = /^Weekly (\w+) quota resets soonest$/.exec(reason);
  return soonest ? { key: 'reason_bucket_resets_soonest', family: soonest[1] } : null;
}
