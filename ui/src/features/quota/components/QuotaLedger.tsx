/**
 * Quota Ledger view: a summary line per provider and one dense row per
 * credential in routing order, read from the quota-pilot snapshot.
 *
 * All maths lives in ledgerModel.ts; this file is layout only.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import { openPanelRoute } from '@/host';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/time/relativeTime';
import { SECOND_CLOCK } from '@/utils/time/sharedClock';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/utils/providers';
import type { QuotaTabId } from '../constants';
import {
  buildLedger,
  maskFileName,
  reasonKey,
  snapshotAgeParts,
  weeklyWindowOf,
  type LedgerGroup,
  type LedgerRow,
  type LedgerWindow,
} from '../ledgerModel';
import type { QuotaPilotSnapshotState } from '../hooks/useQuotaPilotSnapshot';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from '../constants';
import styles from './QuotaLedger.module.scss';

const SKELETON_ROW_COUNT = 4;

// The ledger reads as used, as the band and the usage view do: a meter fills as quota goes, and
// its colour still warns as what is left runs low.
const usedOf = (remaining: number) => 100 - remaining;

const levelOf = (remaining: number) =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? 'high'
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? 'medium'
      : 'low';

export interface QuotaLedgerProps {
  snapshot: QuotaPilotSnapshotState;
  tab: QuotaTabId;
  search: string;
  resolvedTheme: ResolvedTheme;
}

export function QuotaLedger(props: QuotaLedgerProps) {
  const [showEmails, setShowEmails] = useState(() => readQuotaUiState()?.showEmails ?? false);

  return (
    <QuotaLedgerView
      {...props}
      showEmails={showEmails}
      onShowEmailsChange={(value) => {
        setShowEmails(value);
        writeQuotaUiState({ showEmails: value });
      }}
    />
  );
}

export interface QuotaLedgerViewProps extends QuotaLedgerProps {
  showEmails: boolean;
  onShowEmailsChange: (value: boolean) => void;
  /** Injectable for tests and screenshots; defaults to the real clock. */
  now?: number;
}

export function QuotaLedgerView({
  tab,
  search,
  resolvedTheme,
  snapshot,
  showEmails,
  onShowEmailsChange,
  now: nowProp,
}: QuotaLedgerViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;

  const live = snapshot.status === 'live' ? snapshot.snapshot : null;
  const ledger = useMemo(
    () => (live ? buildLedger(live, tab, search, now) : { kinds: [], groups: [] }),
    [live, tab, search, now]
  );
  const identityOf = (row: LedgerRow) =>
    showEmails ? row.fileName : maskFileName(row.fileName, row.email);

  return (
    <section className={styles.ledger} aria-label={t('quota_ledger.title')}>
      <div className={styles.topline}>
        <p className={styles.source}>
          {snapshot.status === 'live'
            ? t('quota_ledger.source_live')
            : snapshot.status === 'loading'
              ? t('quota_ledger.source_loading')
              : t('quota_ledger.source_unavailable')}
          {live && <SnapshotAge generatedAtMs={live.generatedAtMs} now={nowProp} />}
        </p>
        <ToggleSwitch
          checked={showEmails}
          onChange={onShowEmailsChange}
          label={t('quota_ledger.show_emails')}
        />
      </div>

      {snapshot.status === 'loading' ? (
        <div className={styles.skeleton} aria-hidden="true">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <Skeleton key={index} height={index === 0 ? 150 : 64} rounded={12} />
          ))}
        </div>
      ) : !live ? (
        <EmptyState
          title={t('quota_ledger.unavailable_title')}
          description={t('quota_ledger.unavailable_desc')}
        />
      ) : ledger.groups.length === 0 ? (
        <EmptyState
          title={t('quota_ledger.empty_title')}
          description={t(
            tab === 'all' && !search.trim()
              ? 'quota_ledger.empty_none_desc'
              : 'quota_ledger.empty_live_desc'
          )}
        />
      ) : (
        <>
          <div className={styles.overview}>
            {ledger.groups.map((group) => (
              <ProviderSummary
                key={group.provider}
                group={group}
                now={now}
                locale={locale}
                resolvedTheme={resolvedTheme}
                identityOf={identityOf}
              />
            ))}
          </div>
          {ledger.groups.map((group) => (
            <ProviderSection
              key={group.provider}
              group={group}
              kinds={ledger.kinds}
              now={now}
              locale={locale}
              identityOf={identityOf}
            />
          ))}
        </>
      )}

      {live && (
        <footer className={styles.foot}>
          {live.lastError && (
            <p className={styles.lastError} role="status">
              {t('quota_ledger.last_error', { message: live.lastError })}
            </p>
          )}
          {Object.entries(live.config.fallbackMap).map(([from, to]) => {
            const [provider = '', model = to] = to.split(':');
            return (
              <span key={from} className={styles.footItem}>
                {t('quota_ledger.fallback_rule', {
                  from: getTypeLabel(t, from),
                  model,
                  provider: getTypeLabel(t, provider),
                })}
              </span>
            );
          })}
          <span className={styles.footItem}>
            {t(live.config.crossProvider === 'auto' ? 'quota_ledger.auto_on' : 'quota_ledger.auto_off')}
          </span>
          <button type="button" className={styles.pluginLink} onClick={() => openPanelRoute('/plugins')}>
            {t('quota_ledger.plugin_settings')}
            <span aria-hidden="true">›</span>
          </button>
        </footer>
      )}
    </section>
  );
}

/** `in 11 hours · 10/04 19:59`, or null when the instant has passed or is unknown. */
const resetLine = (atMs: number | null, now: number, locale?: string) =>
  atMs !== null && atMs > now
    ? `${formatRelativeInstant(atMs, now, locale)} · ${formatInstantShort(atMs)}`
    : null;

/** Ticks every second on its own so the rest of the ledger re-renders once a minute. */
function SnapshotAge({ generatedAtMs, now: nowProp }: { generatedAtMs: number | null; now?: number }) {
  const { t } = useTranslation();
  const tick = useNow(nowProp === undefined, SECOND_CLOCK);
  const age = snapshotAgeParts(generatedAtMs, nowProp ?? tick);
  if (!age) return null;
  return (
    <span className={styles.age}>
      {age.unit === 'second'
        ? t('quota_ledger.updated_seconds', { seconds: age.value })
        : t('quota_ledger.updated_minutes', { minutes: age.value })}
    </span>
  );
}

function ProviderName({ provider, resolvedTheme }: { provider: string; resolvedTheme: ResolvedTheme }) {
  const { t } = useTranslation();
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  return (
    <span className={styles.provider}>
      {iconSrc && (
        <span
          className={styles.providerIcon}
          style={
            isThemeSurfaceIconProvider(provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          <img src={iconSrc} alt="" />
        </span>
      )}
      <span className={styles.providerName}>{getTypeLabel(t, provider)}</span>
    </span>
  );
}

interface ProviderSummaryProps {
  group: LedgerGroup;
  now: number;
  locale?: string;
  resolvedTheme: ResolvedTheme;
  identityOf: (row: LedgerRow) => string;
}

/** One column of the overview: the weekly pool, one segment per account, the next reset. */
function ProviderSummary({ group, now, locale, resolvedTheme, identityOf }: ProviderSummaryProps) {
  const { t } = useTranslation();
  const segments = group.rows.map((row) => ({ row, weekly: weeklyWindowOf(row) }));
  const segmentsLabel = `${t('quota_ledger.pool_segments')}: ${segments
    .map(({ row, weekly }) => `${identityOf(row)} ${weekly ? `${usedOf(weekly.remaining)}%` : '–'}`)
    .join(', ')}`;
  const reset = group.nextReset ? resetLine(group.nextReset.atMs, now, locale) : null;

  return (
    <div className={styles.summary}>
      <div className={styles.summaryHead}>
        <ProviderName provider={group.provider} resolvedTheme={resolvedTheme} />
        {group.health === 'exhausted' ? (
          <span className={styles.pill} data-tone="exhausted">
            {t('quota_ledger.health_exhausted')}
          </span>
        ) : (
          <span className={styles.muted}>
            {t('quota_ledger.credentials', { count: group.rows.length })}
          </span>
        )}
      </div>
      <span className={styles.caption}>{t('quota_ledger.pool_used')}</span>
      <div className={styles.big}>
        <span className={styles.bigValue}>
          {group.pool ? `${group.pool.capacity - group.pool.remaining}%` : '--'}
        </span>
        <span className={styles.bigOf}>
          {t('quota_ledger.of_capacity', { capacity: group.pool?.capacity ?? 100 })}
        </span>
      </div>
      <div className={styles.segments} role="img" aria-label={segmentsLabel}>
        {segments.map(({ row, weekly }) => (
          <span key={row.key} className={styles.segment} title={`${identityOf(row)} ${weekly ? `${usedOf(weekly.remaining)}%` : '–'}`}>
            {weekly && (
              <span
                className={styles.fill}
                data-level={levelOf(weekly.remaining)}
                style={{ width: `${usedOf(weekly.remaining)}%` }}
              />
            )}
          </span>
        ))}
      </div>
      <span className={styles.reset}>{reset ?? t('quota_ledger.no_reset')}</span>
      {group.fiveHour && (
        <div className={styles.summaryFoot}>
          <span className={styles.muted}>{t('quota_ledger.five_used')}</span>
          <span className={styles.footPool}>
            {group.fiveHour.capacity - group.fiveHour.remaining}%
            <span className={styles.bigOf}>
              {t('quota_ledger.of_capacity', { capacity: group.fiveHour.capacity })}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

interface ProviderSectionProps {
  group: LedgerGroup;
  kinds: string[];
  now: number;
  locale?: string;
  identityOf: (row: LedgerRow) => string;
}

function ProviderSection({ group, kinds, now, locale, identityOf }: ProviderSectionProps) {
  const { t } = useTranslation();
  const providerName = getTypeLabel(t, group.provider);
  const style = { '--ledger-kinds': Math.max(1, kinds.length) } as CSSProperties;
  // Kinds some account of this provider reports: another account missing one says so.
  const groupKinds = new Set(group.rows.flatMap((row) => row.windows.map((window) => window.kind)));
  return (
    <section className={styles.group} aria-label={providerName}>
      <h3 className={styles.groupTitle}>
        {providerName}
        <span className={styles.groupCount}>{group.rows.length}</span>
      </h3>
      <ol className={styles.rows} role="list" style={style}>
        {group.rows.map((row) => (
          <LedgerRowItem
            key={row.key}
            row={row}
            kinds={kinds}
            groupKinds={groupKinds}
            soleAccount={group.rows.length === 1}
            now={now}
            locale={locale}
            identity={identityOf(row)}
          />
        ))}
      </ol>
    </section>
  );
}

/** A plugin reason in the panel's language; an unknown one as the plugin wrote it. */
function reasonText(reason: string, t: (key: string, vars?: Record<string, string>) => string): string {
  const known = reasonKey(reason);
  return known ? t(`quota_ledger.${known.key}`, known.family ? { family: known.family } : undefined) : reason;
}

interface LedgerRowItemProps {
  row: LedgerRow;
  kinds: string[];
  groupKinds: Set<string>;
  /** The provider has one account, so saying new sessions get it adds nothing. */
  soleAccount: boolean;
  now: number;
  locale?: string;
  identity: string;
}

function LedgerRowItem({ row, kinds, groupKinds, soleAccount, now, locale, identity }: LedgerRowItemProps) {
  const { t } = useTranslation();
  const reason = reasonText(row.reason, t);

  // Only what needs attention: an account that cannot serve, the one new sessions get, the
  // sessions on it. Its routing order is the order of the rows.
  const blocked = row.unavailable;
  return (
    <li className={styles.row}>
      <div className={styles.account}>
        <span className={styles.identity} title={identity}>
          {identity}
        </span>
        {row.plan && <span className={styles.plan}>{row.plan}</span>}
      </div>

      <div className={styles.meters}>
        {kinds.map((kind) => {
          const quotaWindow = row.windows.find((item) => item.kind === kind);
          if (quotaWindow) {
            return <LedgerMeter key={kind} quotaWindow={quotaWindow} now={now} locale={locale} />;
          }
          return groupKinds.has(kind) ? (
            <div key={kind} className={styles.meter} data-missing="true">
              <div className={styles.meterHead}>
                <span className={styles.meterLabel}>{t(`quota_ledger.kind_${kind}`, { defaultValue: kind })}</span>
                <span className={styles.meterValue}>—</span>
              </div>
              <div className={styles.track} aria-hidden="true" />
              <span className={styles.meterReset}>{t('quota_ledger.not_reported')}</span>
            </div>
          ) : (
            <span key={kind} className={styles.meterEmpty} aria-hidden="true" />
          );
        })}
      </div>

      <div className={styles.routing}>
        {blocked ? (
          <span className={styles.blocked}>{reason}</span>
        ) : row.next && !soleAccount ? (
          <span className={styles.next} title={t('quota_ledger.next_title')}>
            {t('quota_ledger.next')}
          </span>
        ) : null}
        {row.serving && (
          <span title={t('quota_ledger.serving_title', { sessions: row.sessions })}>
            {t('quota_ledger.serving_count', { count: row.sessions })}
          </span>
        )}
      </div>
    </li>
  );
}

function LedgerMeter({ quotaWindow, now, locale }: { quotaWindow: LedgerWindow; now: number; locale?: string }) {
  const { t } = useTranslation();
  const reset = resetLine(quotaWindow.resetAtMs, now, locale);
  return (
    <div
      className={styles.meter}
      data-stale={quotaWindow.stale ? 'true' : undefined}
      title={quotaWindow.stale ? t('quota_ledger.stale_title') : undefined}
    >
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>
          {t(`quota_ledger.kind_${quotaWindow.kind}`, { defaultValue: quotaWindow.label })}
        </span>
        <span className={styles.meterValue}>
          {t('quota_ledger.used_value', { value: usedOf(quotaWindow.remaining) })}
          {quotaWindow.stale && (
            <>
              <span aria-hidden="true">~</span>
              <span className={styles.srOnly}> {t('quota_ledger.stale')}</span>
            </>
          )}
        </span>
      </div>
      <div className={styles.track} aria-hidden="true">
        <span
          className={styles.fill}
          data-level={levelOf(quotaWindow.remaining)}
          style={{ width: `${usedOf(quotaWindow.remaining)}%` }}
        />
      </div>
      <span className={styles.meterReset}>{reset ?? t('quota_ledger.no_reset')}</span>
    </div>
  );
}
