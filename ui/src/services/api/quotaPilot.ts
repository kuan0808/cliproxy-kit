/**
 * quota-pilot's Management API routes: the routing snapshot, the usage report, a session's detail
 * and a refresh. The host mounts plugin routes under `/v0/management`.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type {
  QuotaPilotComposition,
  QuotaPilotConfig,
  QuotaPilotCredential,
  QuotaPilotHealth,
  QuotaPilotProvider,
  QuotaPilotRefreshResult,
  QuotaPilotSnapshot,
  QuotaPilotTokens,
  QuotaPilotUsage,
  QuotaPilotUsageAccount,
  QuotaPilotUsageDay,
  QuotaPilotUsageProject,
  QuotaPilotUsageProvider,
  QuotaPilotUsageRange,
  QuotaPilotUsageSession,
  QuotaPilotUsageSessionDetail,
  QuotaPilotUsageTotals,
  QuotaPilotUsageWindow,
  QuotaPilotWindow,
} from '@/types';

export const QUOTA_PILOT_SNAPSHOT_PATH = '/v0/management/quota-pilot/snapshot';
export const QUOTA_PILOT_USAGE_PATH = '/v0/management/quota-pilot/usage';
export const QUOTA_PILOT_USAGE_SESSION_PATH = '/v0/management/quota-pilot/usage/session';
export const QUOTA_PILOT_REFRESH_PATH = '/v0/management/quota-pilot/refresh';

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asString).filter(Boolean) : [];

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Go encodes an unset `time.Time` as year 1, so anything at or before the epoch is absent. */
const asInstantMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const HEALTH_VALUES = new Set<string>(['healthy', 'exhausted', 'unknown']);

const normalizeWindow = (value: unknown): QuotaPilotWindow | null => {
  if (!isRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind,
    label: asString(value.label) || kind,
    remaining: Math.min(1, Math.max(0, asNumber(value.remaining))),
    resetAtMs: asInstantMs(value.reset_at),
    observedAtMs: asInstantMs(value.observed_at),
    stale: value.stale === true,
  };
};

const normalizeCredential = (value: unknown): QuotaPilotCredential | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    authIndex: asString(value.auth_index),
    label: asString(value.label),
    email: asString(value.email),
    plan: asString(value.plan),
    order: asNumber(value.order),
    tier: asNumber(value.tier),
    reason: asString(value.reason),
    sessions: Math.max(0, asNumber(value.sessions)),
    unavailable: value.unavailable === true,
    windows: Array.isArray(value.windows)
      ? value.windows
          .map(normalizeWindow)
          .filter((window): window is QuotaPilotWindow => window !== null)
      : [],
    absent: asStrings(value.absent),
    sameAs: asString(value.same_as),
  };
};

const normalizeProvider = (value: unknown): QuotaPilotProvider => {
  const record = isRecord(value) ? value : {};
  const health = asString(record.health);
  return {
    health: HEALTH_VALUES.has(health) ? (health as QuotaPilotHealth) : 'unknown',
    credentials: Array.isArray(record.credentials)
      ? record.credentials
          .map(normalizeCredential)
          .filter((credential): credential is QuotaPilotCredential => credential !== null)
      : [],
  };
};

const normalizeConfig = (value: unknown): QuotaPilotConfig => {
  const record = isRecord(value) ? value : {};
  const fallbackMap: Record<string, string> = {};
  if (isRecord(record.fallback_map)) {
    Object.entries(record.fallback_map).forEach(([from, to]) => {
      const target = asString(to);
      if (from.trim() && target) fallbackMap[from.trim()] = target;
    });
  }
  return {
    crossProvider: asString(record.cross_provider) || 'off',
    fallbackMap,
    minFiveHourLeftPercent: asNumber(record.min_five_hour_left_percent),
    idlePollMinutes: asNumber(record.idle_poll_minutes),
  };
};

/** Null when the payload is not a snapshot at all (for example an HTML error page). */
export function normalizeQuotaPilotSnapshot(value: unknown): QuotaPilotSnapshot | null {
  if (!isRecord(value) || !isRecord(value.providers)) return null;
  const providers: Record<string, QuotaPilotProvider> = {};
  Object.entries(value.providers).forEach(([provider, view]) => {
    const key = provider.trim().toLowerCase();
    if (key) providers[key] = normalizeProvider(view);
  });
  return {
    schemaVersion: asNumber(value.schema_version),
    bootId: asString(value.boot_id),
    sequence: asNumber(value.sequence),
    generatedAtMs: asInstantMs(value.generated_at),
    config: normalizeConfig(value.config),
    providers,
    lastError: asString(value.last_error),
  };
}

/** Millisecond instants arrive as numbers here; 0 means absent. */
const asMs = (value: unknown): number | null => {
  const ms = asNumber(value);
  return ms > 0 ? ms : null;
};

const fraction = (value: unknown): number => Math.min(1, Math.max(0, asNumber(value)));

const normalizeTokens = (value: unknown): QuotaPilotTokens => {
  const record = isRecord(value) ? value : {};
  return {
    input: asNumber(record.input),
    output: asNumber(record.output),
    cacheRead: asNumber(record.cache_read),
    cacheWrite: asNumber(record.cache_write),
  };
};

/** A map of names to non-negative numbers. */
/** Each provider's part of a row: a part of 0 is a reading that found none, not a missing one. */
const asProviderParts = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, part]) => {
      if (typeof part === 'number' && Number.isFinite(part) && part >= 0)
        out[key.toLowerCase()] = part;
    });
  }
  return out;
};

const asWeights = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, weight]) => {
      const n = asNumber(weight);
      if (n > 0) out[key] = n;
    });
  }
  return out;
};

const listOf = <T>(value: unknown, normalize: (item: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.map(normalize).filter((item): item is T => item !== null) : [];

const normalizeComposition = (value: unknown): QuotaPilotComposition => {
  const record = isRecord(value) ? value : {};
  return {
    requests: asNumber(record.requests),
    tokens: normalizeTokens(record.tokens),
    weights: normalizeTokens(record.weights),
  };
};

/** A part of one account's week: a provider's total runs past 1 across its accounts. */
const share = (value: unknown): number => Math.max(0, asNumber(value));

const normalizeUsageSession = (value: unknown): QuotaPilotUsageSession | null => {
  if (!isRecord(value)) return null;
  return {
    id: asString(value.id),
    title: asString(value.title),
    used: share(value.used),
    requests: asNumber(value.requests),
    lastMs: asMs(value.last),
    tokens: normalizeTokens(value.tokens),
    accounts: asStrings(value.accounts),
    origin: asString(value.origin),
    remote: value.remote === true,
    usedBy: asProviderParts(value.used_by),
    metered: value.metered === true,
    providers: asStrings(value.providers).map((p) => p.toLowerCase()),
  };
};

const normalizeUsageProject = (value: unknown): QuotaPilotUsageProject | null => {
  if (!isRecord(value)) return null;
  return {
    name: asString(value.name),
    path: asString(value.path),
    used: share(value.used),
    usedBy: asProviderParts(value.used_by),
    metered: value.metered === true,
    requests: asNumber(value.requests),
    lastMs: asMs(value.last),
    tokens: normalizeTokens(value.tokens),
    sessions: listOf(value.sessions, normalizeUsageSession),
  };
};

const normalizeUsageAccount = (value: unknown): QuotaPilotUsageAccount | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    label: asString(value.label),
    plan: asString(value.plan),
    provider: asString(value.provider).toLowerCase(),
    resetAtMs: asInstantMs(value.reset_at),
    order: asNumber(value.order),
    sessions: Math.max(0, asNumber(value.sessions)),
    used: fraction(value.used),
    known: value.known === true,
    beforeLog: fraction(value.before_log),
    outside: fraction(value.outside),
    projects: asWeights(value.projects),
    coveredFromMs: asMs(value.covered_from),
    offProxy: value.off_proxy === true,
    restartedAtMs: asMs(value.restarted_at),
    noWindow: value.no_window === true,
  };
};

const normalizeUsageProvider = (value: unknown): QuotaPilotUsageProvider | null => {
  if (!isRecord(value)) return null;
  const provider = asString(value.provider).toLowerCase();
  const accounts = listOf(value.accounts, normalizeUsageAccount);
  // A provider without an account here still has its tokens over a range.
  return provider ? { provider, accounts } : null;
};

const normalizeUsageDay = (value: unknown): QuotaPilotUsageDay | null => {
  if (!isRecord(value)) return null;
  const day = asString(value.day);
  return /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? {
        day,
        projects: asWeights(value.projects),
        outside: asNumber(value.outside),
        metered: value.metered === true,
        undated: value.undated === true,
        requests: asNumber(value.requests),
        tokens: normalizeTokens(value.tokens),
        sessions: daySessions(value.sessions),
      }
    : null;
};

const daySessions = (value: unknown) =>
  listOf(value, (x) =>
    isRecord(x)
      ? {
          id: asString(x.id),
          title: asString(x.title),
          used: typeof x.used === 'number' && Number.isFinite(x.used) ? Math.max(0, x.used) : null,
        }
      : null
  );

const normalizeUsageWindow = (value: unknown): QuotaPilotUsageWindow | null => {
  if (!isRecord(value)) return null;
  const account = asString(value.account);
  const fromMs = asMs(value.from);
  const toMs = asMs(value.to);
  return account && fromMs !== null && toMs !== null
    ? {
        account,
        fromMs,
        toMs,
        running: value.running === true,
        used: fraction(value.used),
        beforeLog: fraction(value.before_log),
        outside: fraction(value.outside),
        projects: asWeights(value.projects),
        requests: asNumber(value.requests),
        tokens: normalizeTokens(value.tokens),
        sessions: daySessions(value.sessions),
      }
    : null;
};

const asPartList = (value: unknown) =>
  listOf(value, (p) =>
    isRecord(p) ? { name: asString(p.name), weight: asNumber(p.weight) } : null
  );

const normalizeTotals = (value: unknown): QuotaPilotUsageTotals => {
  const record = isRecord(value) ? value : {};
  return {
    capacity: Math.max(0, asNumber(record.capacity)),
    used: Math.max(0, asNumber(record.used)),
    known: record.known === true,
    beforeLog: Math.max(0, asNumber(record.before_log)),
    unplaced: Math.max(0, asNumber(record.unplaced)),
    undated: Math.max(0, asNumber(record.undated)),
    outside: Math.max(0, asNumber(record.outside)),
    unread: asStrings(record.unread),
  };
};

const USAGE_MODES = new Set(['account', 'provider', 'all']);
const USAGE_RANGES = new Set(['5h', 'week', '7d', '30d']);

export function normalizeQuotaPilotUsage(value: unknown): QuotaPilotUsage | null {
  if (!isRecord(value) || typeof value.mode !== 'string' || !USAGE_MODES.has(value.mode))
    return null;
  const range = asString(value.range);
  const totals: Record<string, QuotaPilotUsageTotals> = {};
  if (isRecord(value.totals)) {
    Object.entries(value.totals).forEach(([provider, t]) => {
      totals[provider.toLowerCase()] = normalizeTotals(t);
    });
  }
  const daily: Record<string, QuotaPilotUsageDay[]> = {};
  if (isRecord(value.daily)) {
    Object.entries(value.daily).forEach(([provider, days]) => {
      daily[provider.toLowerCase()] = listOf(days, normalizeUsageDay);
    });
  }
  const windows: Record<string, QuotaPilotUsageWindow[]> = {};
  if (isRecord(value.windows)) {
    Object.entries(value.windows).forEach(([provider, list]) => {
      windows[provider.toLowerCase()] = listOf(list, normalizeUsageWindow);
    });
  }
  return {
    mode: value.mode as QuotaPilotUsage['mode'],
    scope: asString(value.scope),
    range: USAGE_RANGES.has(range) ? (range as QuotaPilotUsageRange) : 'week',
    provider: asString(value.provider).toLowerCase(),
    capacity: Math.max(0, asNumber(value.capacity)),
    fromMs: asNumber(value.from),
    toMs: asNumber(value.to),
    used: Math.max(0, asNumber(value.used)),
    known: value.known === true,
    beforeLog: Math.max(0, asNumber(value.before_log)),
    unplaced: Math.max(0, asNumber(value.unplaced)),
    undated: Math.max(0, asNumber(value.undated)),
    unread: asStrings(value.unread),
    outside: Math.max(0, asNumber(value.outside)),
    totals,
    composition: normalizeComposition(value.composition),
    projects: listOf(value.projects, normalizeUsageProject),
    providers: listOf(value.providers, normalizeUsageProvider),
    daily,
    windows,
    windowsFromMs: asMs(value.windows_from),
  };
}

const BUCKET_UNITS = new Set(['10m', 'hour', 'day']);

export function normalizeQuotaPilotUsageSession(
  value: unknown
): QuotaPilotUsageSessionDetail | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const unit = asString(value.unit);
  return {
    id: value.id,
    title: asString(value.title),
    project: asString(value.project),
    firstMs: asMs(value.first),
    lastMs: asMs(value.last),
    composition: normalizeComposition(value.composition),
    unit: BUCKET_UNITS.has(unit) ? (unit as QuotaPilotUsageSessionDetail['unit']) : 'day',
    buckets: listOf(value.buckets, (b) =>
      isRecord(b) && asMs(b.at)
        ? {
            atMs: asNumber(b.at),
            weight: asNumber(b.weight),
            requests: asNumber(b.requests),
            tokens: normalizeTokens(b.tokens),
            agent: asNumber(b.agent),
            models: asPartList(b.models),
            accounts: asPartList(b.accounts),
            providers: asPartList(b.providers).map((p) => ({ ...p, name: p.name.toLowerCase() })),
            quota: asProviderParts(b.quota),
          }
        : null
    ),
    models: asPartList(value.models),
    agent: asNumber(value.agent),
    accounts: listOf(value.accounts, (a) =>
      isRecord(a)
        ? {
            id: asString(a.id),
            label: asString(a.label),
            provider: asString(a.provider).toLowerCase(),
            weight: asNumber(a.weight),
          }
        : null
    ),
    history: value.history === true,
    origin: asString(value.origin),
    remote: value.remote === true,
    tiers: listOf(value.tiers, (x) =>
      isRecord(x)
        ? {
            provider: asString(x.provider).toLowerCase(),
            asked: asString(x.asked).toLowerCase(),
            served: asString(x.served).toLowerCase(),
            requests: asNumber(x.requests),
          }
        : null
    ),
  };
}

export function normalizeQuotaPilotRefresh(value: unknown): QuotaPilotRefreshResult {
  const record = isRecord(value) ? value : {};
  return {
    read: asNumber(record.read),
    failed: listOf(record.failed, (f) =>
      isRecord(f) && asString(f.account)
        ? {
            account: asString(f.account),
            label: asString(f.label),
            failure: asString(f.failure),
            status: asNumber(f.status),
          }
        : null
    ),
    // An older plugin answers without it, having read what it listed.
    complete: record.complete !== false,
  };
}

/** The page's time zone, so a report's days are the reader's. */
const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
};

export const quotaPilotApi = {
  /**
   * Asks the plugin to read every account's quota now (an account read in the last minute is
   * not read again), and to log what it read before it answers which it could not read.
   */
  async refresh(): Promise<QuotaPilotRefreshResult> {
    return normalizeQuotaPilotRefresh(await apiClient.post(QUOTA_PILOT_REFRESH_PATH));
  },

  async getSnapshot(): Promise<QuotaPilotSnapshot> {
    const data = await apiClient.get(QUOTA_PILOT_SNAPSHOT_PATH);
    const snapshot = normalizeQuotaPilotSnapshot(data);
    if (!snapshot) throw new Error('quota-pilot returned a malformed snapshot');
    return snapshot;
  },

  /** An account, `provider:<name>` for all its accounts, or `all`, over a range. */
  async getUsage(scope: string, range: QuotaPilotUsageRange): Promise<QuotaPilotUsage> {
    const url = `${QUOTA_PILOT_USAGE_PATH}?account=${encodeURIComponent(scope)}&range=${range}&tz=${encodeURIComponent(timeZone())}`;
    const usage = normalizeQuotaPilotUsage(await apiClient.get(url));
    if (!usage) throw new Error('quota-pilot returned a malformed usage report');
    return usage;
  },

  /** One session within a scope and range; id '' is the requests that came without a session. */
  async getUsageSession(
    id: string,
    scope: string,
    range: QuotaPilotUsageRange
  ): Promise<QuotaPilotUsageSessionDetail> {
    const url = `${QUOTA_PILOT_USAGE_SESSION_PATH}?id=${encodeURIComponent(id)}&account=${encodeURIComponent(scope)}&range=${range}&tz=${encodeURIComponent(timeZone())}`;
    const detail = normalizeQuotaPilotUsageSession(await apiClient.get(url));
    if (!detail) throw new Error('quota-pilot returned a malformed session report');
    return detail;
  },
};
