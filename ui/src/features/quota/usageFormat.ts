import type { TFunction } from 'i18next';
import type {
  QuotaPilotTokens,
  QuotaPilotUsage,
  QuotaPilotUsageAccount,
  QuotaPilotUsageProject,
} from '@/types';

/** "<0.1%", "4.2%", "52%": a share with one decimal while it is small. */
export function formatShare(fraction: number): string {
  const pct = fraction * 100;
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/** "99.4%": a rate that sits near 100%, where whole percents would hide the difference. */
export function formatRate(fraction: number): string {
  return `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(1)}%`;
}

/** "387", "4.2k", "38k", "1.9M", "35.1B". */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** To the nearest minute: a reset reported as 07:59:59.8 is the 08:00 reset. */
const nearestMinute = (ms: number) => Math.round(ms / 60_000) * 60_000;

/** Day, weekday and time in the reader's language, e.g. "10/10（週六）08:00" in zh-TW. */
export function formatDayTime(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(nearestMinute(ms));
}

/** Day and weekday, e.g. "10/10 週六". */
export function formatDate(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).format(ms);
}

/** "10/5" or "Oct 5", for chart axes. */
export function formatDay(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(ms);
}

/** "08:40". */
export function formatTime(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(nearestMinute(ms));
}

/** Local midnight of a YYYY-MM-DD day. */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Input that went through the cache, as a part of all input. */
/**
 * What some requests ran, in one line: how many, each kind of token they used, and how much of
 * their input the cache served.
 */
export function ranLine(
  t: TFunction,
  requests: number,
  tokens: QuotaPilotTokens,
  locale?: string
): string {
  if (requests === 0) return '—';
  const hit = cacheHitRate(tokens);
  return [
    t('quota_usage.requests', { count: requests, n: requests.toLocaleString(locale) }),
    tokens.output > 0 && t('quota_usage.tokens_output', { value: formatTokens(tokens.output) }),
    tokens.cacheWrite > 0 &&
      t('quota_usage.tokens_cache_write', { value: formatTokens(tokens.cacheWrite) }),
    tokens.cacheRead > 0 &&
      t('quota_usage.tokens_cache_read', { value: formatTokens(tokens.cacheRead) }),
    tokens.input > 0 && t('quota_usage.tokens_input', { value: formatTokens(tokens.input) }),
    hit !== null && t('quota_usage.tokens_hit', { value: formatRate(hit) }),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function cacheHitRate(t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const all = t.input + t.cacheRead + t.cacheWrite;
  return all > 0 ? t.cacheRead / all : null;
}

/** Input tokens per request: how much context each turn sent. */
export function averageContext(
  t: { input: number; cacheRead: number; cacheWrite: number },
  requests: number
): number | null {
  return requests > 0 ? (t.input + t.cacheRead + t.cacheWrite) / requests : null;
}

/** "Opus 5.5" for Anthropic model ids; other ids as they are. */
export function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** "Claude", "Codex". */
export const providerTitle = (provider: string) =>
  provider.charAt(0).toUpperCase() + provider.slice(1);

/** Meter colour by how much is used. */
export const usedLevel = (used: number) => (used >= 0.9 ? 'high' : used >= 0.7 ? 'mid' : undefined);

/** Projects drawn in their own colour; the rest share one. */
const COLOURED = 8;

export const REST_COLOUR = 'var(--usage-rest)';

const PROVIDER_COLOUR: Record<string, string> = {
  claude: 'var(--usage-claude)',
  codex: 'var(--usage-codex)',
};

/** A provider's own colour, the same on its blocks and on a session's bars. */
export const providerColour = (provider: string) => PROVIDER_COLOUR[provider] ?? REST_COLOUR;

/** A project's colour by its rank in the scope, the same in the bar, the legend and the table. */
export function projectColours(projects: QuotaPilotUsageProject[]) {
  const rank = new Map(projects.map((p, i) => [p.name, i]));
  return (name: string) => {
    const i = rank.get(name);
    return i !== undefined && i < COLOURED ? `var(--usage-${i + 1})` : REST_COLOUR;
  };
}

export function projectLabel(t: TFunction, name: string) {
  if (name === '') return t('quota_usage.project_unknown');
  if (name === '~') return t('quota_usage.project_home');
  if (name === '/') return t('quota_usage.project_root');
  return name;
}

/** The accounts a quota scope covers, in picker order. */
export function scopeAccounts(usage: QuotaPilotUsage): QuotaPilotUsageAccount[] {
  if (usage.mode === 'provider')
    return usage.providers.find((p) => p.provider === usage.provider)?.accounts ?? [];
  if (usage.mode === 'account')
    return usage.providers.flatMap((p) => p.accounts).filter((a) => a.id === usage.scope);
  return [];
}

export function sessionLabel(t: TFunction, id: string, title: string) {
  if (id === '') return t('quota_usage.session_none');
  return title || t('quota_usage.session_untitled', { id: id.slice(0, 8) });
}

/**
 * Where a session came from, when not from Claude Code run on this machine: a program, another
 * device, or another app. `key` names an app (its tag) or explains a program or a device (its
 * detail); `raw` keeps an origin this page does not know, shown as given.
 */
export interface SessionSource {
  kind: 'auto' | 'device' | 'app';
  key: string;
  raw?: string;
}

const SOURCES: Record<string, SessionSource> = {
  // Run by a program: one tag for all, and the session's detail says which.
  'sdk-ts': { kind: 'auto', key: 'why_sdk_ts' },
  'sdk-py': { kind: 'auto', key: 'why_sdk_py' },
  'sdk-cli': { kind: 'auto', key: 'why_print' },
  codex_exec: { kind: 'auto', key: 'why_codex_exec' },
  'Claude Code': { kind: 'auto', key: 'why_claude_code' },
  // On another device, named by the band there.
  remote: { kind: 'device', key: 'why_remote' },
  // Opened by a person in another app.
  'claude-desktop': { kind: 'app', key: 'origin_claude_desktop' },
  'codex-tui': { kind: 'app', key: 'origin_codex_cli' },
  'Codex Desktop': { kind: 'app', key: 'origin_codex_app' },
  'codex-chrome-extension-sidepanel': { kind: 'app', key: 'origin_codex_chrome' },
};

/**
 * A session's source; null for Claude Code run on this machine, which carries no tag. In a Codex
 * view, Claude Code run by a person reached Codex through the proxy, and says so; a program's run
 * and another app keep their own tag.
 */
export function sessionSource(origin: string, onCodex: boolean): SessionSource | null {
  if (!origin) return onCodex ? { kind: 'app', key: 'origin_proxy' } : null;
  return SOURCES[origin] ?? { kind: 'app', key: '', raw: origin };
}

/** A source's tag: "Automated", "Other device", or the app's name. */
export function sourceTag(t: TFunction, source: SessionSource): string {
  if (source.kind === 'auto') return t('quota_usage.source_auto');
  if (source.kind === 'device') return t('quota_usage.source_device');
  return source.raw ?? t(`quota_usage.${source.key}`);
}

/** What a session's detail adds to its tag in plain words; nothing where the tag says it all. */
export function sourceWhy(t: TFunction, source: SessionSource): string {
  return source.kind === 'app' ? '' : t(`quota_usage.${source.key}`);
}

// Sessions that read the same tag count as one source: every program run is "Automated".
const tagOf = (source: SessionSource | null) =>
  source === null ? '' : source.kind === 'app' ? `app:${source.raw ?? source.key}` : source.kind;

export interface ProjectSources {
  /** Sessions, not counting the requests that came without one. */
  sessions: number;
  /** Each tag the sessions carry, with how many, most first; none for Claude Code run here. */
  sources: { source: SessionSource; count: number }[];
  /** Every session carries the one tag listed: it is said for the project, not on each row. */
  shared: boolean;
  /** Some requests came without a session. */
  none: boolean;
}

/**
 * Where a project's sessions came from, for its summary: "75 sessions · [Automated] 74", and
 * "[Other device] 3 sessions" when all share one source.
 */
export function projectSources<S extends { id: string }>(
  sessions: S[],
  sourceOf: (session: S) => SessionSource | null
): ProjectSources {
  const counts = new Map<string, { source: SessionSource | null; count: number }>();
  for (const session of sessions) {
    if (session.id === '') continue;
    const source = sourceOf(session);
    const entry = counts.get(tagOf(source));
    if (entry) entry.count += 1;
    else counts.set(tagOf(source), { source, count: 1 });
  }
  const sources = [...counts.values()]
    .filter((c): c is { source: SessionSource; count: number } => c.source !== null)
    .sort((a, b) => b.count - a.count);
  return {
    sessions: [...counts.values()].reduce((sum, c) => sum + c.count, 0),
    sources,
    shared: counts.size === 1 && sources.length === 1,
    none: sessions.some((session) => session.id === ''),
  };
}

/**
 * A project's sessions as its rows list them. Two or more run by programs beside sessions a person
 * ran gather under one row, so those are not lost among them.
 */
export function splitAutomated<S extends { id: string }>(
  sessions: S[],
  sourceOf: (session: S) => SessionSource | null
): { listed: S[]; automated: S[] } {
  const automated = sessions.filter((s) => s.id !== '' && sourceOf(s)?.kind === 'auto');
  const listed = sessions.filter((s) => !automated.includes(s));
  return automated.length >= 2 && listed.some((s) => s.id !== '')
    ? { listed, automated }
    : { listed: sessions, automated: [] };
}

/** The earliest time the log began to see any of these accounts. */
export function coveredFrom(accounts: QuotaPilotUsageAccount[]): number | null {
  const times = accounts.map((a) => a.coveredFromMs).filter((ms): ms is number => ms !== null);
  return times.length ? Math.min(...times) : null;
}

/** The i18n key naming a range. */
export const rangeKey = (range: string) =>
  range === '7d'
    ? 'quota_usage.range_7d'
    : range === '30d'
      ? 'quota_usage.range_30d'
      : 'quota_usage.range_week';
