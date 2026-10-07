/**
 * Usage view: where weekly quota went this week (or 5-hour quota in the running window), by project
 * and session, for one account or a provider's accounts added up, or how all usage split over 30
 * days. Numbers come from the
 * quota-pilot plugin's usage log; per-session parts of the weekly quota are estimates, and the
 * view says how they are made at the bottom.
 *
 * Every report carries every account, so the picker, the summary and the table always show
 * figures from one reading of the log.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useNow } from '@/hooks/useNow';
import type {
  QuotaPilotUsage,
  QuotaPilotUsageAccount,
  QuotaPilotUsageProvider,
  QuotaPilotUsageRange,
  ResolvedTheme,
} from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  isThemeSurfaceIconProvider,
} from '@/utils/providers';
import type { QuotaTabId } from '../constants';
import type { QuotaPilotSnapshotState } from '../hooks/useQuotaPilotSnapshot';
import { useQuotaPilotUsage, type QuotaPilotUsageResult } from '../hooks/useQuotaPilotUsage';
import {
  formatDayTime,
  formatShare,
  isWindowRange,
  providerTitle,
  rangeKey,
  usedLevel,
  windowKey,
} from '../usageFormat';
import { UsageSummary } from './QuotaUsageSummary';
import { UsageTable } from './QuotaUsageTable';
import styles from './QuotaUsage.module.scss';

export const ALL_SCOPE = 'all';
const RANGES: QuotaPilotUsageRange[] = ['5h', 'week', '7d', '30d'];
const providerScope = (provider: string) => `provider:${provider}`;

export interface QuotaUsageProps {
  snapshot: QuotaPilotSnapshotState;
  tab: QuotaTabId;
  search: string;
  resolvedTheme: ResolvedTheme;
}

export function QuotaUsage({ snapshot, tab, search, resolvedTheme }: QuotaUsageProps) {
  const [picked, setPicked] = useState('');

  // The snapshot only chooses where to start and checks a pick still exists; the figures come
  // from the usage report.
  const { fallback, known } = useMemo(() => {
    const scopes = new Map<string, string>();
    let first = '';
    if (snapshot.status === 'live') {
      Object.entries(snapshot.snapshot.providers)
        .filter(
          ([provider, view]) => (tab === 'all' || provider === tab) && view.credentials.length > 0
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([provider, view]) => {
          const start =
            view.credentials.length > 1 ? providerScope(provider) : view.credentials[0].id;
          if (!first) first = start;
          scopes.set(providerScope(provider), provider);
          view.credentials.forEach((c) => scopes.set(c.id, provider));
        });
      if (tab === 'all') scopes.set(ALL_SCOPE, '');
    }
    return {
      fallback: first || (snapshot.status === 'live' && tab === 'all' ? ALL_SCOPE : ''),
      known: scopes,
    };
  }, [snapshot, tab]);
  const scope = picked && known.has(picked) ? picked : fallback;
  const [range, setRange] = useState<QuotaPilotUsageRange>('week');
  const usage = useQuotaPilotUsage(scope, range);

  return (
    <QuotaUsageView
      scope={scope}
      onPick={setPicked}
      range={range}
      onRange={setRange}
      state={snapshot.status === 'unavailable' ? { status: 'unavailable', latest: null } : usage}
      tab={tab}
      search={search}
      resolvedTheme={resolvedTheme}
    />
  );
}

export interface QuotaUsageViewProps {
  scope: string;
  onPick: (scope: string) => void;
  range: QuotaPilotUsageRange;
  onRange: (range: QuotaPilotUsageRange) => void;
  state: QuotaPilotUsageResult;
  tab: QuotaTabId;
  search: string;
  resolvedTheme: ResolvedTheme;
  /** Injectable for tests; defaults to the real clock. */
  now?: number;
}

export function QuotaUsageView({
  scope,
  onPick,
  range,
  onRange,
  state,
  tab,
  search,
  resolvedTheme,
  now: nowProp,
}: QuotaUsageViewProps) {
  const { t } = useTranslation();
  const tick = useNow(nowProp === undefined);
  const usage = state.status === 'ready' ? state.usage : null;
  const report = usage ?? state.latest;
  // The clock ticks by the minute; a report read since is newer, and nothing in it is in the future.
  const now = Math.max(nowProp ?? tick, report?.toMs ?? 0);

  return (
    <section className={styles.usage} aria-label={t('quota_usage.title')}>
      <div className={styles.toolbar}>
        <p className={styles.pickerLabel} id="usage-scope-label">
          {t('quota_usage.scope_label')}
        </p>
        <div className={styles.segmented} role="group" aria-label={t('quota_usage.range_label')}>
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => onRange(r)}>
              {t(rangeKey(r))}
            </button>
          ))}
        </div>
      </div>
      {report ? (
        <Picker
          report={report}
          scope={scope}
          onPick={onPick}
          tab={tab}
          resolvedTheme={resolvedTheme}
        />
      ) : (
        state.status === 'loading' && <Skeleton height={168} rounded={12} />
      )}
      {state.status === 'loading' ? (
        <div className={styles.skeleton} aria-hidden="true">
          <Skeleton height={220} rounded={12} />
          <Skeleton height={260} rounded={12} />
        </div>
      ) : !usage ? (
        <EmptyState
          title={t('quota_usage.unavailable_title')}
          description={t('quota_usage.unavailable_desc')}
        />
      ) : (
        <>
          <UsageSummary usage={usage} now={now} />
          <UsageTable usage={usage} search={search} now={now} />
          <details className={styles.method}>
            <summary>{t('quota_usage.method_title')}</summary>
            <p>{t('quota_usage.method_quota')}</p>
            {usage.mode !== 'account' && <p>{t('quota_usage.method_total')}</p>}
            {usage.range === '5h' && <p>{t('quota_usage.method_5h')}</p>}
            {!isWindowRange(usage.range) && <p>{t('quota_usage.method_range')}</p>}
          </details>
        </>
      )}
    </section>
  );
}

interface PickerProps {
  report: QuotaPilotUsage;
  scope: string;
  onPick: (scope: string) => void;
  tab: QuotaTabId;
  resolvedTheme: ResolvedTheme;
}

/** The accounts that have a window of the range: over 5h, not those with a weekly quota only. */
const windowed = (accounts: QuotaPilotUsageAccount[]) => accounts.filter((a) => !a.noWindow);

/**
 * Each provider is a group: its accounts added up first, then each account beneath on a tree
 * line. All providers together stand apart, because their quotas are not in the same unit.
 */
function Picker({ report, scope, onPick, tab, resolvedTheme }: PickerProps) {
  const { t } = useTranslation();
  const range = report.range;
  // A provider with no account to pick (only its tokens, over a range) shows in the report, not here.
  const groups = report.providers.filter(
    (p) => p.accounts.length > 0 && (tab === 'all' || p.provider === tab)
  );

  return (
    <div className={styles.picker}>
      <div
        className={styles.scopes}
        role="group"
        aria-labelledby="usage-scope-label"
        data-single={groups.length === 1 ? 'true' : undefined}
      >
        {groups.map((group) => (
          <ProviderGroup
            key={group.provider}
            group={group}
            range={range}
            scope={scope}
            onPick={onPick}
            resolvedTheme={resolvedTheme}
          />
        ))}
        {tab === 'all' && (
          <button
            type="button"
            className={styles.allCard}
            aria-pressed={scope === ALL_SCOPE}
            onClick={() => onPick(ALL_SCOPE)}
          >
            <span className={styles.allHead}>
              <span className={styles.allTitle}>{t('quota_usage.all_providers')}</span>
              <span className={styles.muted}>{t(windowKey('all_providers_hint', range))}</span>
            </span>
            {/* Each provider's window in its own unit, side by side, never added. */}
            {groups.map((p) => {
              const slots = windowed(p.accounts);
              const known = slots.filter((a) => a.known);
              const total = known.reduce((sum, a) => sum + a.used, 0);
              return (
                <span key={p.provider} className={styles.allLine}>
                  <span>{providerTitle(p.provider)}</span>
                  <Meter slots={slots} />
                  <span className={styles.allValue}>
                    {slots.length === 0 ? (
                      <small>{t('quota_usage.no_five_window')}</small>
                    ) : (
                      <>
                        {known.length ? formatShare(total) : '—'}
                        <small>
                          {t('quota_usage.of_capacity', { value: `${slots.length * 100}%` })}
                        </small>
                      </>
                    )}
                  </span>
                </span>
              );
            })}
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderGroup({
  group,
  range,
  scope,
  onPick,
  resolvedTheme,
}: {
  group: QuotaPilotUsageProvider;
  range: QuotaPilotUsageRange;
  scope: string;
  onPick: (scope: string) => void;
  resolvedTheme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const { provider, accounts } = group;
  const slots = windowed(accounts);
  const total = slots.reduce((sum, a) => sum + (a.known ? a.used : 0), 0);
  const anyKnown = slots.some((a) => a.known);

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <ProviderIcon provider={provider} resolvedTheme={resolvedTheme} />
        <span className={styles.groupTitle}>{providerTitle(provider)}</span>
        <span className={styles.groupHint}>
          {slots.length === 0
            ? t('quota_usage.no_five_window')
            : t(windowKey('provider_accounts', range), { count: accounts.length })}
        </span>
      </div>
      {accounts.length > 1 ? (
        <>
          <button
            type="button"
            className={`${styles.scopeRow} ${styles.totalRow}`}
            aria-pressed={scope === providerScope(provider)}
            onClick={() => onPick(providerScope(provider))}
          >
            <span className={styles.rowName}>{t('quota_usage.total')}</span>
            <span className={styles.rowSub}>{accounts.map((a) => a.label).join(' + ')}</span>
            <Meter slots={slots} />
            <span className={styles.rowValue}>
              {anyKnown ? formatShare(total) : '—'}
              {slots.length > 0 && (
                <small>{t('quota_usage.of_capacity', { value: `${slots.length * 100}%` })}</small>
              )}
            </span>
            <span className={styles.rowNote}>
              {slots.length > 0 ? t(windowKey('total_hint', range)) : ''}
            </span>
          </button>
          <div className={styles.tree}>
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                range={range}
                scope={scope}
                onPick={onPick}
              />
            ))}
          </div>
        </>
      ) : (
        accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            range={range}
            scope={scope}
            onPick={onPick}
          />
        ))
      )}
    </div>
  );
}

function AccountRow({
  account,
  range,
  scope,
  onPick,
}: {
  account: QuotaPilotUsageAccount;
  range: QuotaPilotUsageRange;
  scope: string;
  onPick: (scope: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <button
      type="button"
      className={styles.scopeRow}
      aria-pressed={scope === account.id}
      onClick={() => onPick(account.id)}
    >
      <span className={styles.rowName}>{account.label}</span>
      <span className={styles.rowSub}>
        {account.offProxy ? t('quota_usage.account_removed') : account.plan}
        {account.sessions > 0 && (
          <span className={styles.inUse}>
            {t('quota_usage.in_use', { count: account.sessions })}
          </span>
        )}
      </span>
      <Meter slots={account.noWindow ? [] : [account]} />
      <span className={styles.rowValue}>{account.known ? formatShare(account.used) : '—'}</span>
      <span className={styles.rowNote}>
        {account.noWindow
          ? t('quota_usage.no_five_window')
          : !account.known
            ? t(windowKey('not_read', range))
            : account.resetAtMs
              ? t('quota_usage.resets_at', {
                  when: formatDayTime(account.resetAtMs, i18n.resolvedLanguage),
                })
              : range === '5h'
                ? t('quota_usage.five_idle')
                : ''}
      </span>
    </button>
  );
}

/** One slot per account, each filled to its use of its window. */
function Meter({ slots }: { slots: QuotaPilotUsageAccount[] }) {
  return (
    <span className={styles.meter} aria-hidden="true">
      {slots.map((s) => (
        <i key={s.id}>
          {s.known && (
            <b
              data-level={usedLevel(s.used)}
              style={{ width: `${Math.min(100, s.used * 100)}%` } as CSSProperties}
            />
          )}
        </i>
      ))}
    </span>
  );
}

export function ProviderIcon({
  provider,
  resolvedTheme,
}: {
  provider: string;
  resolvedTheme: ResolvedTheme;
}) {
  const src = getAuthFileIcon(provider, resolvedTheme);
  if (!src) return null;
  return (
    <span
      className={styles.icon}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
    >
      <img src={src} alt="" />
    </span>
  );
}
