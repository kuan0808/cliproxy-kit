/**
 * The usage view's table: projects that open onto their sessions, and a session that opens onto
 * its own detail. One switch trades the quota column for token columns.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronDown, IconLaptop, IconZap } from '@/components/ui/icons';
import type {
  QuotaPilotTokens,
  QuotaPilotUsage,
  QuotaPilotUsageProject,
  QuotaPilotUsageRange,
  QuotaPilotUsageBucket,
  QuotaPilotUsageSession,
  QuotaPilotUsageSessionDetail,
} from '@/types';
import { formatRelativeInstant } from '@/utils/time/relativeTime';
import { useQuotaPilotUsageSession } from '../hooks/useQuotaPilotUsage';
import { useUsageFocus } from '../usageFocus';
import {
  averageContext,
  cacheHitRate,
  cacheWritesOf,
  failureText,
  formatDate,
  formatDay,
  formatDayTime,
  formatRate,
  formatShare,
  formatTime,
  formatTokens,
  coveredFrom,
  isWindowRange,
  modelName,
  projectColours,
  projectLabel,
  projectSources,
  providerColour,
  providerTitle,
  rangeKey,
  ranLine,
  scopeAccounts,
  sessionLabel,
  sessionSources,
  sourceTag,
  sourceWhy,
  splitAutomated,
  windowKey,
  type ProjectSources,
  type SessionSource,
} from '../usageFormat';
import { BarCard, PickableBars } from './QuotaUsageBars';
import { Composition } from './QuotaUsageSummary';
import styles from './QuotaUsage.module.scss';

/** Sessions listed under an open project before "show N more". */
const SESSION_PREVIEW = 8;

/** The open state of a project's automated row, kept beside the projects': no folder name holds a NUL. */
const autoKey = (key: string) => `\u0000${key}`;

type Columns = 'quota' | 'tokens';

interface Row {
  used: number;
  /** False when only its tokens are known: no quota reading covers it. */
  metered: boolean;
  usedBy: Record<string, number>;
  requests: number;
  lastMs: number | null;
  tokens: QuotaPilotTokens;
}

export function UsageTable({
  usage,
  search,
  now,
  onClearSearch,
}: {
  usage: QuotaPilotUsage;
  search: string;
  now: number;
  /** Clears the page's search, so a session the chart asks for that it hides shows. */
  onClearSearch?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [columns, setColumns] = useState<Columns>('quota');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<string | null>(null);

  const query = search.trim().toLowerCase();
  const [openFor, setOpenFor] = useState(query);
  if (openFor !== query) {
    setOpenFor(query);
    setOpen({});
  }
  // A project the search finds by name shows whole; one it finds by some sessions shows those, and
  // its figures are theirs.
  const projects = useMemo(() => {
    if (!query) return usage.projects;
    return usage.projects
      .map((project) => {
        if (projectLabel(t, project.name).toLowerCase().includes(query)) return project;
        const sessions = project.sessions.filter(
          (s) => s.title.toLowerCase().includes(query) || s.id.includes(query)
        );
        return { ...project, ...sumRows(sessions), sessions };
      })
      .filter((project) => project.sessions.length > 0);
  }, [usage.projects, query, t]);

  const all = usage.mode === 'all';
  const codexView =
    usage.mode !== 'all' && scopeAccounts(usage).every((a) => a.provider === 'codex');
  // A Claude Code session that used Codex did so through the proxy, whichever scope lists it.
  const sourcesOf = useCallback(
    (session: QuotaPilotUsageSession) =>
      session.id === ''
        ? []
        : sessionSources(
            session.origin,
            codexView || (all && session.providers.includes('codex')),
            session.remote,
            session.device
          ),
    [codexView, all]
  );

  // A session asked for from the chart above opens here: its project, its row even past the first
  // few (in its project's automated row too), and its detail; a search that hides it is cleared
  // first. Each ask is handled once, so the list refreshing does not open it again; the row is
  // brought into view once it is drawn.
  const focus = useUsageFocus();
  const handled = useRef(0);
  const reveal = useRef<string | null>(null);
  useEffect(() => {
    if (focus.ask === handled.current) return;
    const project = projects.find((p) => p.sessions.some((x) => x.id === focus.id));
    if (!project) {
      const hidden = usage.projects.some((p) => p.sessions.some((x) => x.id === focus.id));
      if (hidden && query && onClearSearch) {
        onClearSearch(); // asked again once the list shows it
        return;
      }
      handled.current = focus.ask;
      return;
    }
    handled.current = focus.ask;
    const key = project.name || '-';
    const { listed, automated } = splitAutomated(project.sessions, sourcesOf);
    const inGroup = automated.some((x) => x.id === focus.id);
    const at = (inGroup ? automated : listed).findIndex((x) => x.id === focus.id);
    const listKey = inGroup ? autoKey(key) : key;
    setOpen((o) => ({ ...o, [key]: true, ...(inGroup ? { [listKey]: true } : {}) }));
    if (at >= SESSION_PREVIEW) setMore((m) => ({ ...m, [listKey]: true }));
    setDetail(focus.id);
    reveal.current = focus.id;
  }, [focus, projects, sourcesOf, usage.projects, query, onClearSearch]);
  useEffect(() => {
    if (reveal.current === null) return;
    const row = document.querySelector(`[data-session="${CSS.escape(reveal.current)}"]`);
    if (!row) return;
    reveal.current = null;
    row.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [open, more, detail]);

  const colourOf = projectColours(usage.projects);
  const labels = useMemo(
    () => new Map(usage.providers.flatMap((p) => p.accounts.map((a) => [a.id, a.label] as const))),
    [usage.providers]
  );
  const showAccounts = usage.mode === 'provider';
  const providers = usage.providers.map((p) => p.provider);
  const covered = coveredFrom(scopeAccounts(usage).filter((a) => a.beforeLog > 0));
  const peak = Math.max(...usage.projects.map((p) => p.used), 0);
  const layout =
    columns === 'tokens' ? 'tokens' : all ? 'quotaAll' : showAccounts ? 'quotaAccounts' : 'quota';
  const when = (ms: number | null) => (ms ? formatRelativeInstant(ms, now, locale) : '—');
  const unread = (
    <span className={styles.value} title={t('quota_usage.no_reading')}>
      —
    </span>
  );

  // In mode all, one column per provider, each in its own unit: blank where a row did not use the
  // provider, "—" where it did but no reading covers it.
  const providerCell = (row: Row, provider: string, used: boolean) => (
    <span key={provider} role="cell" className={styles.num}>
      {row.usedBy[provider] !== undefined ? (
        <span className={styles.value}>{formatShare(row.usedBy[provider])}</span>
      ) : used ? (
        unread
      ) : null}
    </span>
  );

  /** The accounts a row's use came from, in the provider total's account column. */
  const accountCell = (accounts?: string[]) =>
    showAccounts && (
      <span role="cell" className={`${styles.tags} ${styles.optional}`}>
        {accounts?.map((id) => (
          <span key={id} className={styles.tag}>
            {labels.get(id) ?? t('quota_usage.account_removed')}
          </span>
        ))}
      </span>
    );

  const cells = (row: Row, colour: string, accounts?: string[], usedProviders?: string[]) =>
    columns === 'quota' ? (
      <>
        {all ? (
          providers.map((p) => providerCell(row, p, Boolean(usedProviders?.includes(p))))
        ) : row.metered ? (
          <span role="cell" className={styles.share}>
            <span className={styles.track} aria-hidden="true">
              <span
                className={styles.fill}
                style={{ width: `${peak > 0 ? (row.used / peak) * 100 : 0}%`, background: colour }}
              />
            </span>
            <span className={styles.value}>{formatShare(row.used)}</span>
          </span>
        ) : (
          <span role="cell" className={styles.share}>
            <span />
            {unread}
          </span>
        )}
        {accountCell(accounts)}
        <span role="cell" className={`${styles.num} ${styles.muted} ${styles.optional}`}>
          {when(row.lastMs)}
        </span>
      </>
    ) : (
      <>
        <span role="cell" className={`${styles.num} ${styles.optional}`}>
          {row.requests.toLocaleString(locale)}
        </span>
        <span role="cell" className={styles.num}>
          {formatTokens(row.tokens.output)}
        </span>
        {cacheWriteCell(row, usedProviders)}
        <span role="cell" className={styles.num}>
          {formatTokens(row.tokens.cacheRead)}
        </span>
        <span role="cell" className={`${styles.num} ${styles.optional}`}>
          {rate(cacheHitRate(row.tokens))}
        </span>
        <span role="cell" className={`${styles.num} ${styles.optional}`}>
          {tokensOrDash(averageContext(row.tokens, row.requests))}
        </span>
      </>
    );

  // Codex reports no cache writes: a row only it served has none to show, and one it shared
  // counts the others'.
  const cacheWriteCell = (row: Row, usedProviders?: string[]) => {
    const known = cacheWritesOf(usedProviders ?? []);
    return (
      <span
        role="cell"
        className={`${styles.num} ${styles.optional}`}
        title={known === 'some' ? t('quota_usage.kind_cacheWrite_partial') : undefined}
      >
        {known === 'none' ? '—' : formatTokens(row.tokens.cacheWrite)}
      </span>
    );
  };

  const special = (
    key: 'before' | 'outside',
    label: string,
    hint: string,
    used: number,
    note: string
  ) => (
    <div
      key={key}
      role="row"
      className={`${styles.row} ${styles.specialRow}`}
      data-layout={layout}
      title={hint}
    >
      <span role="cell" className={styles.specialName}>
        {label}
      </span>
      <span role="cell" className={styles.share}>
        <span className={styles.track} aria-hidden="true">
          <span
            className={`${styles.fill} ${key === 'before' ? styles.hatch : ''}`}
            style={{
              width: `${peak > 0 ? Math.min(100, (used / peak) * 100) : 0}%`,
              background: key === 'before' ? undefined : 'var(--usage-other)',
            }}
          />
        </span>
        <span className={styles.value}>{formatShare(used)}</span>
      </span>
      {accountCell(
        scopeAccounts(usage)
          .filter((a) => (key === 'before' ? a.beforeLog : a.outside) > 0)
          .map((a) => a.id)
      )}
      <span role="cell" className={`${styles.num} ${styles.muted} ${styles.optional}`}>
        {note}
      </span>
    </div>
  );

  return (
    <div className={styles.tableBlock}>
      <div className={styles.tableBar}>
        <h3 className={styles.tableTitle}>
          {t('quota_usage.table_title')}
          {usage.projects.length > 0 && (
            <span>{t('quota_usage.projects_count', { count: usage.projects.length })}</span>
          )}
        </h3>
        {usage.projects.length > 0 && (
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_usage.columns_label')}
          >
            <button
              type="button"
              aria-pressed={columns === 'quota'}
              onClick={() => setColumns('quota')}
            >
              {t('quota_usage.columns_quota')}
            </button>
            <button
              type="button"
              aria-pressed={columns === 'tokens'}
              onClick={() => setColumns('tokens')}
            >
              {t('quota_usage.columns_tokens')}
            </button>
          </div>
        )}
      </div>

      {usage.projects.length === 0 ? (
        <p className={styles.foot}>{t('quota_usage.empty_scope')}</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title={t('quota_usage.empty_title')}
          description={t('quota_usage.empty_search')}
        />
      ) : (
        <div
          className={styles.table}
          role="table"
          aria-label={t('quota_usage.table_label')}
          style={{ '--providers': providers.length } as CSSProperties}
        >
          <div role="row" className={`${styles.row} ${styles.head}`} data-layout={layout}>
            <span role="columnheader">{t('quota_usage.col_name')}</span>
            {columns === 'quota' ? (
              <>
                {all ? (
                  providers.map((p) => (
                    <span key={p} role="columnheader" className={styles.num}>
                      {t('quota_usage.col_provider_quota', { provider: providerTitle(p) })}
                    </span>
                  ))
                ) : isWindowRange(usage.range) ? (
                  <span role="columnheader">
                    {t(windowKey('col_weekly', usage.range))}
                    <span className={styles.optional}>
                      {t('quota_usage.col_weekly_of', { value: `${usage.capacity * 100}%` })}
                    </span>
                  </span>
                ) : (
                  <span role="columnheader">{t('quota_usage.col_range')}</span>
                )}
                {showAccounts && (
                  <span role="columnheader" className={styles.optional}>
                    {t('quota_usage.col_accounts')}
                  </span>
                )}
                <span role="columnheader" className={`${styles.num} ${styles.optional}`}>
                  {t('quota_usage.col_last')}
                </span>
              </>
            ) : (
              <>
                <span role="columnheader" className={`${styles.num} ${styles.optional}`}>
                  {t('quota_usage.col_requests')}
                </span>
                <span role="columnheader" className={styles.num}>
                  {t('quota_usage.col_output')}
                </span>
                <span role="columnheader" className={`${styles.num} ${styles.optional}`}>
                  {t('quota_usage.col_cache_write')}
                </span>
                <span role="columnheader" className={styles.num}>
                  {t('quota_usage.col_cache_read')}
                </span>
                <span role="columnheader" className={`${styles.num} ${styles.optional}`}>
                  {t('quota_usage.col_hit')}
                </span>
                <span role="columnheader" className={`${styles.num} ${styles.optional}`}>
                  {t('quota_usage.col_context')}
                </span>
              </>
            )}
          </div>

          {projects.map((project, index) => {
            const key = project.name || '-';
            const isOpen = open[key] ?? ((index === 0 && !query) || Boolean(query));
            const colour = colourOf(project.name);
            const summary = projectSources(project.sessions, sourcesOf);
            // Tags every session shares are said once, on the project; otherwise on each row.
            const tagsOf = (x: QuotaPilotUsageSession) => (summary.shared ? [] : sourcesOf(x));
            const { listed, automated } = splitAutomated(project.sessions, sourcesOf);
            const groupKey = autoKey(key);
            const groupOpen = open[groupKey] ?? Boolean(query);
            const sessionRow = (session: QuotaPilotUsageSession, inner: boolean, tag: boolean) => (
              <SessionRows
                key={session.id || 'none'}
                session={session}
                tags={tag ? tagsOf(session) : []}
                sources={sourcesOf(session)}
                inner={inner}
                project={project}
                layout={layout}
                scope={usage.scope}
                range={usage.range}
                open={detail === session.id}
                onToggle={() => setDetail(detail === session.id ? null : session.id)}
              >
                {cells(session, colour, session.accounts, session.providers)}
              </SessionRows>
            );
            const page = (list: QuotaPilotUsageSession[], listKey: string) =>
              more[listKey] ? list : list.slice(0, SESSION_PREVIEW);
            const moreButton = (list: QuotaPilotUsageSession[], listKey: string, inner: boolean) =>
              list.length > SESSION_PREVIEW &&
              !more[listKey] && (
                <button
                  type="button"
                  className={`${styles.more} ${inner ? styles.moreInner : ''}`}
                  onClick={() => setMore({ ...more, [listKey]: true })}
                >
                  {t('quota_usage.show_more', { count: list.length - SESSION_PREVIEW })}
                </button>
              );
            return (
              <div key={key} role="rowgroup" className={styles.projectGroup}>
                <div role="row" className={`${styles.row} ${styles.projectRow}`} data-layout={layout}>
                  <span role="cell" className={styles.name}>
                    <button
                      type="button"
                      className={styles.rowButton}
                      aria-expanded={isOpen}
                      onClick={() => setOpen({ ...open, [key]: !isOpen })}
                      title={project.path || undefined}
                    >
                      <IconChevronDown
                        size={14}
                        className={styles.chevron}
                        data-open={isOpen ? 'true' : undefined}
                        aria-hidden="true"
                      />
                      <span
                        className={styles.dot}
                        style={{ background: colour }}
                        aria-hidden="true"
                      />
                      <span className={styles.projectText}>
                        <span className={styles.projectName}>{projectLabel(t, project.name)}</span>
                        <ProjectSummary summary={summary} />
                      </span>
                    </button>
                  </span>
                  {cells(project, colour, undefined, [
                    ...new Set(project.sessions.flatMap((x) => x.providers)),
                  ])}
                </div>
                {isOpen && page(listed, key).map((session) => sessionRow(session, false, true))}
                {isOpen && moreButton(listed, key, false)}
                {isOpen && automated.length > 0 && (
                  <>
                    <div
                      role="row"
                      className={`${styles.row} ${styles.sessionRow}`}
                      data-layout={layout}
                    >
                      <span role="cell" className={styles.sessionName}>
                        <button
                          type="button"
                          className={styles.rowButton}
                          aria-expanded={groupOpen}
                          onClick={() => setOpen({ ...open, [groupKey]: !groupOpen })}
                        >
                          <IconChevronDown
                            size={14}
                            className={styles.chevron}
                            data-open={groupOpen ? 'true' : undefined}
                            aria-hidden="true"
                          />
                          <SourceTag source={sourcesOf(automated[0]).find((x) => x.kind === 'auto')!} />
                          <span>{t('quota_usage.sessions', { count: automated.length })}</span>
                        </button>
                      </span>
                      {cells(
                        sumRows(automated),
                        colour,
                        [...new Set(automated.flatMap((x) => x.accounts))],
                        [...new Set(automated.flatMap((x) => x.providers))]
                      )}
                    </div>
                    {groupOpen &&
                      page(automated, groupKey).map((session) => sessionRow(session, true, false))}
                    {groupOpen && moreButton(automated, groupKey, true)}
                  </>
                )}
              </div>
            );
          })}

          {!all && columns === 'quota' && !query && (
            <>
              {usage.beforeLog > 0 &&
                special(
                  'before',
                  t('quota_usage.before_log'),
                  t('quota_usage.before_log_hint'),
                  usage.beforeLog,
                  // The day fits the column; the summary above gives the time.
                  covered ? t('quota_usage.before_when', { when: formatDay(covered, locale) }) : ''
                )}
              {usage.outside > 0 &&
                special(
                  'outside',
                  t('quota_usage.outside'),
                  t('quota_usage.outside_hint'),
                  usage.outside,
                  t('quota_usage.outside_hint')
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const rate = (r: number | null) => (r === null ? '—' : formatRate(r));
const tokensOrDash = (n: number | null) => (n === null ? '—' : formatTokens(n));

/**
 * The tag of a session's source: a program, another device, or another app by name. What exactly
 * ran a session is said once, in its detail.
 */
function SourceTag({ source }: { source: SessionSource }) {
  const { t } = useTranslation();
  const Icon = source.kind === 'auto' ? IconZap : source.kind === 'device' ? IconLaptop : null;
  return (
    <span className={styles.sourceTag}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {sourceTag(t, source)}
    </span>
  );
}

/** A session's tags, side by side. */
function SourceTags({ sources }: { sources: SessionSource[] }) {
  return sources.map((source) => <SourceTag key={source.kind} source={source} />);
}

/** "75 sessions · [Automated] 74", "[Other device] 3 sessions", "Requests not in any session". */
function ProjectSummary({ summary }: { summary: ProjectSources }) {
  const { t } = useTranslation();
  const sessions = t('quota_usage.sessions', { count: summary.sessions });
  const parts: ReactNode[] = summary.shared
    ? [
        <>
          <SourceTags sources={summary.sources[0].source} />
          {sessions}
        </>,
      ]
    : summary.sessions > 0
      ? [
          sessions,
          ...summary.sources.map(({ source, count }) => (
            <>
              <SourceTags sources={source} />
              {t('quota_usage.source_count', { count })}
            </>
          )),
        ]
      : [];
  if (summary.none)
    parts.push(t(summary.sessions > 0 ? 'quota_usage.session_none_also' : 'quota_usage.session_none'));
  return (
    <span className={styles.projectSummary}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <span className={styles.summaryPart}>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** Rows added together: an automated row's figures are those of the sessions under it. */
function sumRows(rows: Row[]): Row {
  const usedBy: Record<string, number> = {};
  for (const row of rows)
    for (const [provider, x] of Object.entries(row.usedBy)) usedBy[provider] = (usedBy[provider] ?? 0) + x;
  const last = rows.map((r) => r.lastMs).filter((ms): ms is number => ms !== null);
  return {
    used: rows.reduce((sum, r) => sum + r.used, 0),
    metered: rows.some((r) => r.metered),
    usedBy,
    requests: rows.reduce((sum, r) => sum + r.requests, 0),
    lastMs: last.length ? Math.max(...last) : null,
    tokens: {
      input: rows.reduce((sum, r) => sum + r.tokens.input, 0),
      output: rows.reduce((sum, r) => sum + r.tokens.output, 0),
      cacheRead: rows.reduce((sum, r) => sum + r.tokens.cacheRead, 0),
      cacheWrite: rows.reduce((sum, r) => sum + r.tokens.cacheWrite, 0),
    },
  };
}

function SessionRows({
  session,
  tags,
  sources,
  inner,
  project,
  layout,
  scope,
  range,
  open,
  onToggle,
  children,
}: {
  session: QuotaPilotUsageSession;
  /** Shown beside the title: the session's tags where its project's sessions differ. */
  tags: SessionSource[];
  /** Said in full in the session's detail. */
  sources: SessionSource[];
  /** Listed under its project's automated row. */
  inner: boolean;
  project: QuotaPilotUsageProject;
  layout: string;
  scope: string;
  range: QuotaPilotUsageRange;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const name = sessionLabel(t, session.id, session.title);
  return (
    <>
      <div
        role="row"
        className={`${styles.row} ${styles.sessionRow}`}
        data-layout={layout}
        data-open={open ? 'true' : undefined}
        data-session={session.id}
      >
        <span role="cell" className={`${styles.sessionName} ${inner ? styles.inner : ''}`}>
          <button
            type="button"
            className={styles.rowButton}
            aria-expanded={open}
            onClick={onToggle}
            title={name}
          >
            <span className={styles.sessionTitle}>{name}</span>
            <SourceTags sources={tags} />
          </button>
        </span>
        {children}
      </div>
      {open && (
        <div className={inner ? styles.innerDetail : undefined}>
          <SessionDetail
            id={session.id}
            title={name}
            project={project.name}
            sources={sources}
            scope={scope}
            range={range}
          />
        </div>
      )}
    </>
  );
}

const UNIT_KEY = { '10m': 'unit_10m', hour: 'unit_hour', day: 'unit_day' } as const;
const UNIT_MS = { '10m': 600_000, hour: 3_600_000, day: 86_400_000 } as const;

/** Everything about one session within the view's scope and range, read when it opens. */
function SessionDetail({
  id,
  title,
  project,
  sources,
  scope,
  range,
}: {
  id: string;
  title: string;
  project: string;
  sources: SessionSource[];
  scope: string;
  range: QuotaPilotUsageRange;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const state = useQuotaPilotUsageSession(id, scope, range);
  if (state.status !== 'ready') {
    return (
      <div className={styles.detail} aria-live="polite">
        <p className={styles.foot}>
          {state.status === 'loading'
            ? t('quota_usage.detail_loading')
            : `${t('quota_usage.unavailable_title')}: ${failureText(t, state.failure)}`}
        </p>
      </div>
    );
  }
  return (
    <>
      {state.failure && (
        <p className={styles.notUpdated} role="status">
          {t('quota_pilot.not_updated', { why: failureText(t, state.failure) })}
        </p>
      )}
      <SessionDetailView
        detail={state.detail}
        title={title}
        project={project}
        sources={sources}
        range={range}
        locale={locale}
      />
    </>
  );
}

/** What a provider serves a request that names no tier: nothing to say about. */
const USUAL_TIERS = new Set(['', 'auto', 'default', 'standard']);

/** Service tiers with a name of their own in the locales (quota_usage.tier_*). */
const TIER_NAMES = new Set([
  'fast',
  'priority',
  'default',
  'standard',
  'auto',
  'flex',
  'scale',
  'batch',
]);

export function SessionDetailView({
  detail: d,
  title,
  project,
  sources,
  range,
  locale,
}: {
  detail: QuotaPilotUsageSessionDetail;
  title: string;
  project: string;
  /** Where the session ran and what ran it, said in plain words; none for Claude Code run here. */
  sources: SessionSource[];
  range: QuotaPilotUsageRange;
  locale?: string;
}) {
  const { t } = useTranslation();
  const total = d.models.reduce((sum, m) => sum + m.weight, 0);
  const peak = Math.max(...d.buckets.map((b) => b.weight), 0);
  const label = (ms: number) => (d.unit === 'day' ? formatDay(ms, locale) : formatTime(ms, locale));
  // A stretch said in full: its day, and its hours when shorter than a day.
  const stretch = (ms: number) =>
    d.unit === 'day'
      ? formatDate(ms, locale)
      : `${formatDate(ms, locale)} ${formatTime(ms, locale)}–${formatTime(ms + UNIT_MS[d.unit], locale)}`;
  const mid = d.buckets[Math.floor(d.buckets.length / 2)];
  const accountTotal = d.accounts.reduce((sum, a) => sum + a.weight, 0);
  const accountName = (id: string) => {
    const a = d.accounts.find((x) => x.id === id);
    if (!id) return t('quota_usage.account_unknown');
    if (!a?.label) return t('quota_usage.account_removed');
    return `${a.label}${a.provider !== 'claude' ? ` (${providerTitle(a.provider)})` : ''}`;
  };
  const oneProvider = new Set(d.accounts.map((a) => a.provider)).size <= 1;
  // A stretch's quota: each provider's part where readings settled its requests, or why not.
  const quotaOf = (b: QuotaPilotUsageBucket) => {
    const parts = Object.entries(b.quota);
    if (b.requests === 0) return { text: t('quota_usage.stretch_idle'), quiet: true };
    if (parts.length === 0) return { text: t('quota_usage.stretch_unsettled'), quiet: true };
    if (parts.length === 1 && oneProvider)
      return {
        text: t(windowKey('day_used', range), { value: formatShare(parts[0][1]) }),
        quiet: false,
      };
    return {
      text: parts.map(([p, x]) => `${providerTitle(p)} ${formatShare(x)}`).join(' · '),
      quiet: false,
    };
  };
  const share = (x: number, of: number) => formatShare(of > 0 ? x / of : 0);
  // The service tier its requests asked for and the one the provider reported, by its share of the
  // requests when they differ. Shown only once some request asked for a tier, or was served one
  // other than the usual: requests that named none and got the usual one have nothing to say.
  const tierTotal = d.tiers.reduce((sum, x) => sum + x.requests, 0);
  const tierProviders = new Set(d.tiers.map((x) => x.provider)).size;
  const tierShown = d.tiers.some(
    (x) => (x.asked !== '' && x.asked !== 'auto') || !USUAL_TIERS.has(x.served)
  );
  const tierName = (provider: string, tier: string, side: 'asked' | 'served') => {
    if (!tier) return t('quota_usage.tier_none');
    if (tier === 'auto' && side === 'asked') return t('quota_usage.tier_unnamed');
    // Codex calls its priority tier Fast; a tier with no name of ours shows as the provider names it.
    const key = tier === 'priority' && provider === 'codex' ? 'fast' : tier;
    const name = TIER_NAMES.has(key) ? t(`quota_usage.tier_${key}`) : tier;
    return tierProviders > 1 ? `${providerTitle(provider)} ${name}` : name;
  };
  const tierRow = (side: 'asked' | 'served') => {
    const counts = new Map<string, number>();
    d.tiers.forEach((x) => {
      const name = tierName(x.provider, x[side], side);
      counts.set(name, (counts.get(name) ?? 0) + x.requests);
    });
    const list = [...counts].sort((a, b) => b[1] - a[1]);
    const mixed = list.length > 1;
    return {
      text: list.map(([name, n]) => (mixed ? `${name} ${share(n, tierTotal)}` : name)).join(' · '),
      mixed,
    };
  };
  const tierRows = tierShown
    ? (['asked', 'served'] as const)
        .filter((side) => d.tiers.some((x) => x[side]))
        .map((side) => ({ side, ...tierRow(side) }))
    : [];
  const modelsOf = (b: QuotaPilotUsageBucket) =>
    [
      b.models
        .map((m) => `${modelName(m.name)} ${share(m.weight, b.weight)}`)
        .join(t('quota_usage.list_separator')),
      b.agent > 0 && t('quota_usage.agent', { value: share(b.agent, b.weight) }),
    ]
      .filter(Boolean)
      .join(' · ');
  const accountsOf = (b: QuotaPilotUsageBucket) =>
    b.accounts
      .map((a) => `${accountName(a.name)} ${share(a.weight, b.weight)}`)
      .join(t('quota_usage.list_separator'));
  const meta = [
    projectLabel(t, project || d.project),
    d.firstMs && d.lastMs
      ? `${formatDayTime(d.firstMs, locale)} → ${formatDayTime(d.lastMs, locale)}`
      : '',
    t('quota_usage.requests', {
      count: d.composition.requests,
      n: d.composition.requests.toLocaleString(locale),
    }),
    d.accounts.length > 0
      ? t('quota_usage.detail_accounts', {
          list: d.accounts
            .map((a) =>
              d.accounts.length > 1 && accountTotal > 0
                ? `${accountName(a.id)} ${formatShare(a.weight / accountTotal)}`
                : accountName(a.id)
            )
            .join(t('quota_usage.list_separator')),
        })
      : '',
  ].filter(Boolean);

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <strong>{d.title || title}</strong>
        <span>{meta.join(' · ')}</span>
        {sources.length > 0 && (
          <span className={styles.detailSource}>
            <SourceTags sources={sources} />
            {sources
              .map((source) => sourceWhy(t, source))
              .filter(Boolean)
              .join(' ')}
          </span>
        )}
      </div>
      <div className={styles.detailGrid}>
        <Composition
          composition={d.composition}
          note={t(rangeKey(range))}
          cacheWrites={cacheWritesOf(d.buckets.flatMap((b) => b.providers.map((p) => p.name)))}
        />
        <div>
          <div className={styles.subhead}>
            {t('quota_usage.timeline')}
            <span>{t(`quota_usage.${UNIT_KEY[d.unit]}`)}</span>
          </div>
          <PickableBars
            className={styles.timeline}
            label={t('quota_usage.timeline')}
            bars={d.buckets.map((b) => ({
              key: String(b.atMs),
              label: [
                `${stretch(b.atMs)}: ${quotaOf(b).text}`,
                ranLine(t, b.requests, b.tokens, locale),
                modelsOf(b),
                d.accounts.length > 1 ? accountsOf(b) : '',
              ]
                .filter((x) => x && x !== '—')
                .join(' · '),
              // Coloured by provider: a session that used two shows both.
              segments: b.providers.map((p) => ({ colour: providerColour(p.name), x: p.weight })),
            }))}
            peak={peak}
            axis={
              d.buckets.length > 0 && (
                <div className={styles.timelineAxis} aria-hidden="true">
                  <span>{label(d.buckets[0].atMs)}</span>
                  {d.buckets.length > 2 && <span>{label(mid.atMs)}</span>}
                  {d.buckets.length > 1 && <span>{label(d.buckets[d.buckets.length - 1].atMs)}</span>}
                </div>
              )
            }
            detail={(i) => {
              const b = d.buckets[i];
              const quota = quotaOf(b);
              return (
                <BarCard
                  title={stretch(b.atMs)}
                  figure={quota.text}
                  quiet={quota.quiet}
                  rows={[
                    {
                      label: t('quota_usage.readout_use'),
                      value: ranLine(t, b.requests, b.tokens, locale),
                    },
                    { label: t('quota_usage.readout_models'), value: modelsOf(b) },
                    // Which account served shows only for a session that moved between accounts.
                    ...(d.accounts.length > 1
                      ? [{ label: t('quota_usage.readout_accounts'), value: accountsOf(b) }]
                      : []),
                  ]}
                />
              );
            }}
          />

          <div className={styles.subhead}>
            {t('quota_usage.models')}
            <span>{t('quota_usage.col_estimated')}</span>
          </div>
          {d.models.map((m) => (
            <div key={m.name} className={styles.mix}>
              <span>{modelName(m.name)}</span>
              <span className={styles.kindBar} aria-hidden="true">
                <span style={{ width: `${total > 0 ? (m.weight / total) * 100 : 0}%` }} />
              </span>
              <strong>{formatShare(total > 0 ? m.weight / total : 0)}</strong>
            </div>
          ))}

          {tierRows.length > 0 && (
            <>
              <div className={styles.subhead}>
                {t('quota_usage.tiers')}
                {tierRows.some((row) => row.mixed) && <span>{t('quota_usage.tiers_note')}</span>}
              </div>
              <dl className={`${styles.facts} ${styles.tierFacts}`}>
                {tierRows.map((row) => (
                  <div key={row.side}>
                    <dt>{t(`quota_usage.tier_${row.side}`)}</dt>
                    <dd>{row.text}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          <div className={styles.subhead}>{t('quota_usage.main_vs_agent')}</div>
          <div className={styles.duo} aria-hidden="true">
            <span style={{ width: `${total > 0 ? (1 - d.agent / total) * 100 : 100}%` }} />
            <span style={{ width: `${total > 0 ? (d.agent / total) * 100 : 0}%` }} />
          </div>
          <div className={styles.duoLegend}>
            <span>
              {t('quota_usage.main', { value: formatShare(total > 0 ? 1 - d.agent / total : 1) })}
            </span>
            <span>
              {t('quota_usage.agent', { value: formatShare(total > 0 ? d.agent / total : 0) })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
