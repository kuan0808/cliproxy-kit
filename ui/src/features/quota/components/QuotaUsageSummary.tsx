/**
 * The usage view's summary card. Each provider in the scope gets a block in its own unit, a part of
 * one of its accounts' weekly quota (5-hour quota over 5h), never added to another provider's. Over
 * the current week or 5-hour window a block shows each account's window as a bar, and beneath it
 * the days of the week or the 5-hour windows of the last day; over 7 or 30 days, what each day
 * used. Below the blocks: what the tokens were and how well the cache worked.
 */

import { Fragment, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  QuotaPilotComposition,
  QuotaPilotUsage,
  QuotaPilotUsageAccount,
  QuotaPilotUsageDay,
  QuotaPilotUsageProject,
  QuotaPilotUsageWindow,
} from '@/types';
import {
  averageContext,
  cacheHitRate,
  coveredFrom,
  dayStartMs,
  formatDate,
  formatDay,
  formatDayTime,
  formatRate,
  formatShare,
  formatTime,
  formatTokens,
  isWindowRange,
  projectColours,
  projectLabel,
  providerColour,
  REST_COLOUR,
  providerTitle,
  rangeKey,
  ranLine,
  scopeAccounts,
  sessionLabel,
  windowKey,
} from '../usageFormat';
import { BarCard, PickableBars } from './QuotaUsageBars';
import { focusUsageSession } from '../usageFocus';
import styles from './QuotaUsage.module.scss';

/** A block names at most this many projects; the rest are its other projects. */
const NAMED = 5;

/**
 * The projects a block names: its largest that have a colour of their own, so a project keeps one
 * colour across blocks and the table, and grey only ever means the other projects.
 */
function namedProjects(
  parts: Record<string, number>,
  projects: QuotaPilotUsageProject[],
  colourOf: (name: string) => string
) {
  return projects
    .filter((p) => parts[p.name] > 0 && colourOf(p.name) !== REST_COLOUR)
    .sort((a, b) => parts[b.name] - parts[a.name])
    .slice(0, NAMED)
    .map((p) => p.name);
}

/** One provider's part of the scope. */
interface Block {
  provider: string;
  accounts: QuotaPilotUsageAccount[];
  /** Set when the scope is this one account. */
  account?: QuotaPilotUsageAccount;
  capacity: number;
  used: number;
  known: boolean;
  beforeLog: number;
  unplaced: number;
  undated: number;
  outside: number;
  unread: string[];
}

function blocksOf(usage: QuotaPilotUsage): Block[] {
  if (usage.mode === 'all') {
    return usage.providers.map((p) => ({
      provider: p.provider,
      accounts: p.accounts,
      ...(usage.totals[p.provider] ?? {
        capacity: p.accounts.length,
        used: 0,
        known: false,
        beforeLog: 0,
        unplaced: 0,
        undated: 0,
        outside: 0,
        unread: [],
      }),
    }));
  }
  const accounts = scopeAccounts(usage);
  return [
    {
      provider: usage.provider || accounts[0]?.provider || '',
      accounts,
      account: usage.mode === 'account' ? accounts[0] : undefined,
      capacity: usage.capacity,
      used: usage.used,
      known: usage.known,
      beforeLog: usage.beforeLog,
      unplaced: usage.unplaced,
      undated: usage.undated,
      unread: usage.unread,
      outside: usage.outside,
    },
  ];
}

const periodText = (from: number, to: number, locale?: string) =>
  `${formatDay(from, locale)} → ${formatDay(to, locale)}`;

export function UsageSummary({ usage, now }: { usage: QuotaPilotUsage; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const colourOf = projectColours(usage.projects);
  const blocks = blocksOf(usage);
  const all = usage.mode === 'all';
  const anyBefore = blocks.some((b) => b.accounts.some((a) => a.beforeLog > 0));

  return (
    <div className={styles.summary}>
      {all && (
        <div className={styles.summaryHead}>
          <div className={styles.crumb}>
            <strong>{t('quota_usage.all_providers')}</strong>
            <span className={styles.crumbSep} aria-hidden="true">
              ›
            </span>
            {t(rangeKey(usage.range))}
          </div>
          <span className={styles.period}>
            {isWindowRange(usage.range)
              ? t(windowKey('all_week_hint', usage.range))
              : periodText(usage.fromMs, now, locale)}
          </span>
        </div>
      )}
      {blocks.map((block) => (
        <div key={block.provider} className={all ? styles.block : undefined}>
          {isWindowRange(usage.range) ? (
            <WindowBlock usage={usage} block={block} all={all} colourOf={colourOf} />
          ) : (
            <RangeBlock usage={usage} block={block} all={all} colourOf={colourOf} now={now} />
          )}
        </div>
      ))}
      {usage.composition.requests > 0 && (
        <div className={styles.split}>
          <Composition
            composition={usage.composition}
            note={
              isWindowRange(usage.range) && anyBefore
                ? t(windowKey('composition_week', usage.range))
                : t(rangeKey(usage.range))
            }
            noCacheWrite={blocks.every((b) => b.provider === 'codex')}
          />
          <Efficiency composition={usage.composition} />
        </div>
      )}
    </div>
  );
}

/** The block's title: in a single scope the scope itself, among all providers the provider. */
function BlockHead({ block, all, period }: { block: Block; all: boolean; period: string }) {
  const { t } = useTranslation();
  const { account } = block;
  return (
    <div className={all ? styles.blockHead : styles.summaryHead}>
      <div className={styles.crumb}>
        <span
          className={styles.providerDot}
          style={{ background: providerColour(block.provider) }}
          aria-hidden="true"
        />
        {all ? <strong>{providerTitle(block.provider)}</strong> : providerTitle(block.provider)}
        {!all && (
          <>
            <span className={styles.crumbSep} aria-hidden="true">
              ›
            </span>
            <strong>{account ? account.label : t('quota_usage.total')}</strong>
          </>
        )}
        <span className={styles.chip}>
          {account
            ? account.offProxy
              ? t('quota_usage.account_removed')
              : account.plan || '—'
            : block.accounts.map((a) => a.label).join(' + ') || t('quota_usage.no_accounts')}
        </span>
      </div>
      {period && <span className={styles.period}>{period}</span>}
    </div>
  );
}

/**
 * Over the current week or 5-hour window: the readings out of the accounts' quota, and each
 * account's window. Over 5h an account with a weekly quota only has no window to show.
 */
function WindowBlock({
  usage,
  block,
  all,
  colourOf,
}: {
  usage: QuotaPilotUsage;
  block: Block;
  all: boolean;
  colourOf: (name: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const range = usage.range;
  const whenOf = (ms: number | null) => (ms ? formatDayTime(ms, locale) : '—');
  const { account } = block;
  const accounts = block.accounts.filter((a) => !a.noWindow);
  const anyKnown = accounts.some((a) => a.known);
  const parts: Record<string, number> = {};
  accounts.forEach((a) =>
    Object.entries(a.projects).forEach(([name, x]) => (parts[name] = (parts[name] ?? 0) + x))
  );
  const named = namedProjects(parts, usage.projects, colourOf);

  const notes: string[] = [];
  const before = accounts.filter((a) => a.beforeLog > 0);
  const covered = coveredFrom(before);
  if (before.length > 0 && covered) {
    notes.push(
      t('quota_usage.before_note', {
        when: formatDayTime(covered, locale),
        value: formatShare(before.reduce((sum, a) => sum + a.beforeLog, 0)),
        accounts: before
          .map((a) =>
            t('quota_usage.before_note_account', { account: a.label, when: whenOf(a.resetAtMs) })
          )
          .join(t('quota_usage.list_separator')),
      })
    );
  }
  // A window that started over before its reset (a plan change) counts from then. Over 5h the
  // window before shows as a bar, unless its readings did not name their reset.
  const barred = (id: string) =>
    Object.values(usage.windows).some((list) => list.some((w) => w.account === id && !w.running));
  accounts
    .filter((a) => a.restartedAtMs !== null)
    .forEach((a) =>
      notes.push(
        t(
          range === '5h' && !barred(a.id)
            ? 'quota_usage.restart_note_5h_unlisted'
            : windowKey('restart_note', range),
          { account: a.label, when: formatDayTime(a.restartedAtMs ?? 0, locale) }
        )
      )
    );
  if (!anyKnown) notes.push(t(windowKey('not_read_note', range)));
  // Nothing used is said only when every account was read.
  else if (block.used === 0 && accounts.every((a) => a.known))
    notes.push(t(windowKey('unused_note', range)));
  else if (Object.keys(parts).length === 0 && block.used > block.beforeLog + block.outside) {
    notes.push(
      t('quota_usage.not_logged_note')
    );
  }

  const period =
    !all && account?.resetAtMs
      ? t(windowKey('period_week', range), {
          from: whenOf(usage.fromMs),
          to: whenOf(account.resetAtMs),
        })
      : t(windowKey('period_week_own', range));

  if (accounts.length === 0) {
    // Over 5h: accounts with a weekly quota only.
    return (
      <>
        <BlockHead block={block} all={all} period="" />
        <p className={styles.foot}>{t('quota_usage.five_none_note')}</p>
      </>
    );
  }
  return (
    <>
      <BlockHead block={block} all={all} period={period} />
      <div className={styles.big}>
        <span className={styles.bigValue}>{anyKnown ? formatShare(block.used) : '—'}</span>
        <span className={styles.bigUnit}>
          {t('quota_usage.of_capacity', { value: `${block.capacity * 100}%` })}
        </span>
        <span className={styles.bigHint}>
          {block.capacity > 1
            ? t(windowKey('capacity_accounts', range), { count: block.capacity })
            : t(windowKey('capacity_single', range))}
        </span>
      </div>
      <div className={styles.slots} data-many={accounts.length > 1 ? 'true' : undefined}>
        {accounts.map((a) => (
          <div key={a.id}>
            <div className={styles.slotHead}>
              <strong>{a.label}</strong>
              <span className={styles.slotValue}>
                {a.known ? formatShare(a.used) : t(windowKey('not_read', range))}
              </span>
              {a.resetAtMs ? (
                <span className={styles.slotReset}>
                  {t('quota_usage.resets_at', { when: whenOf(a.resetAtMs) })}
                </span>
              ) : (
                range === '5h' &&
                a.known && <span className={styles.slotReset}>{t('quota_usage.five_idle')}</span>
              )}
            </div>
            <AccountBar
              account={a}
              named={named}
              colourOf={colourOf}
              outside={t('quota_usage.outside')}
            />
          </div>
        ))}
      </div>
      <Legend
        parts={parts}
        named={named}
        beforeLog={block.beforeLog}
        outside={block.outside}
        colourOf={colourOf}
      />
      {range === '5h' ? (
        <WindowsChart usage={usage} block={block} named={named} colourOf={colourOf} />
      ) : (
        <DailyChart usage={usage} block={block} named={named} colourOf={colourOf} />
      )}
      {notes.map((note) => (
        <p key={note} className={styles.foot}>
          {note}
        </p>
      ))}
    </>
  );
}

/** One account's window: what was used before logging, each project, outside, and what is left. */
function AccountBar({
  account,
  named,
  colourOf,
  outside,
}: {
  account: QuotaPilotUsageAccount;
  named: string[];
  colourOf: (name: string) => string;
  outside: string;
}) {
  const { t } = useTranslation();
  const rest = Object.entries(account.projects)
    .filter(([name]) => !named.includes(name))
    .reduce((sum, [, x]) => sum + x, 0);
  const segments = [
    {
      key: 'before',
      label: t('quota_usage.before_log'),
      used: account.beforeLog,
      className: styles.hatch,
      colour: undefined,
    },
    ...named.map((name) => ({
      key: `p-${name}`,
      label: projectLabel(t, name),
      used: account.projects[name] ?? 0,
      className: undefined,
      colour: colourOf(name),
    })),
    {
      key: 'rest',
      label: t('quota_usage.other_projects'),
      used: rest,
      className: undefined,
      colour: REST_COLOUR,
    },
    {
      key: 'outside',
      label: outside,
      used: account.outside,
      className: undefined,
      colour: 'var(--usage-other)',
    },
  ].filter((s) => s.used > 0);
  return (
    <div
      className={styles.bar}
      role="img"
      aria-label={`${account.label}: ${segments.map((s) => `${s.label} ${formatShare(s.used)}`).join(', ') || formatShare(0)}`}
    >
      {segments.map((s) => (
        <span
          key={s.key}
          className={s.className}
          title={`${s.label} ${formatShare(s.used)}`}
          style={{ width: `${s.used * 100}%`, background: s.colour } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** Over 7 or 30 days: what the range used, across the weeks it touches, and each day of it. */
function RangeBlock({
  usage,
  block,
  all,
  colourOf,
  now,
}: {
  usage: QuotaPilotUsage;
  block: Block;
  all: boolean;
  colourOf: (name: string) => string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const days = usage.daily[block.provider] ?? [];
  const parts: Record<string, number> = {};
  days.forEach((d) =>
    Object.entries(d.projects).forEach(([name, x]) => (parts[name] = (parts[name] ?? 0) + x))
  );
  const covered = coveredFrom(block.accounts);
  const unread = unreadDays(block);
  const top = namedProjects(parts, usage.projects, colourOf);
  const anyUnread = days.some((d) => unread(d.day));

  // Accounts whose readings begin inside the range, each when it does.
  const late = block.accounts.filter(
    (a) => a.coveredFromMs !== null && a.coveredFromMs > usage.fromMs
  );
  const minutes = new Set(late.map((a) => Math.floor((a.coveredFromMs ?? 0) / 60_000)));
  const since =
    late.length === 0
      ? ''
      : late.length === block.accounts.length && minutes.size === 1
        ? t('quota_usage.range_since', { when: formatDayTime(late[0].coveredFromMs ?? 0, locale) })
        : t('quota_usage.range_since_accounts', {
            list: late
              .map((a) => `${a.label} ${formatDayTime(a.coveredFromMs ?? 0, locale)}`)
              .join(t('quota_usage.list_separator')),
          });

  const notes: string[] = [];
  if (!block.known) notes.push(t('quota_usage.range_unknown_note'));
  else if (anyUnread && covered) {
    const when = formatDayTime(covered, locale);
    notes.push(
      block.beforeLog > 0
        ? t('quota_usage.range_unread_before_note', { when, value: formatShare(block.beforeLog) })
        : t('quota_usage.range_unread_note', { when })
    );
  }
  if (block.known && block.unread.length > 0) {
    const label = (id: string) => block.accounts.find((a) => a.id === id)?.label ?? id;
    notes.push(
      t('quota_usage.range_unread_accounts_note', {
        accounts: block.unread.map(label).join(t('quota_usage.list_separator')),
      })
    );
  }
  if (block.unplaced > 0)
    notes.push(t('quota_usage.range_unplaced_note', { value: formatShare(block.unplaced) }));
  if (block.undated > 0)
    notes.push(t('quota_usage.range_undated_note', { value: formatShare(block.undated) }));
  // Nothing used is said only when every account was read and nothing lies outside the figure.
  if (
    block.known &&
    block.used === 0 &&
    !anyUnread &&
    block.unread.length === 0 &&
    block.unplaced === 0
  )
    notes.push(t('quota_usage.range_unused_note'));

  return (
    <>
      <BlockHead
        block={block}
        all={all}
        period={all ? '' : `${t(rangeKey(usage.range))} · ${periodText(usage.fromMs, now, locale)}`}
      />
      <div className={styles.big}>
        <span className={styles.bigLead}>{t('quota_usage.range_used')}</span>
        <span className={styles.bigValue}>{block.known ? formatShare(block.used) : '—'}</span>
        <span className={styles.bigHint}>
          {t('quota_usage.range_hint')}
          {since && <> · {since}</>}
        </span>
      </div>
      <Legend
        parts={parts}
        named={top}
        beforeLog={block.beforeLog}
        outside={block.outside}
        colourOf={colourOf}
      />
      <DailyChart usage={usage} block={block} named={top} colourOf={colourOf} />
      {notes.map((note) => (
        <p key={note} className={styles.foot}>
          {note}
        </p>
      ))}
    </>
  );
}

/**
 * Days wholly before the log could read any account of the block, or every day when no reading
 * fell in the block's period: only their tokens are known.
 */
function unreadDays(block: Block) {
  const covered = coveredFrom(block.accounts);
  return (day: string) =>
    !block.known || (covered !== null && dayStartMs(day) + 86_400_000 <= covered);
}

/**
 * A provider's days, each coloured by project as the block's legend is. Picking a day shows what
 * it used, by project; its largest sessions, each of which opens in the table below; and what its
 * requests ran.
 */
function DailyChart({
  usage,
  block,
  named,
  colourOf,
}: {
  usage: QuotaPilotUsage;
  block: Block;
  named: string[];
  colourOf: (name: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const days = usage.daily[block.provider] ?? [];
  const unread = unreadDays(block);
  const segmentsOf = (d: QuotaPilotUsageDay) =>
    [
      ...named.map((name) => ({
        name: projectLabel(t, name),
        project: true,
        colour: colourOf(name),
        x: d.projects[name] ?? 0,
      })),
      {
        name: t('quota_usage.other_projects'),
        project: false,
        colour: REST_COLOUR,
        x: Object.entries(d.projects)
          .filter(([name]) => !named.includes(name))
          .reduce((a, [, x]) => a + x, 0),
      },
      {
        name: t('quota_usage.outside'),
        project: false,
        colour: 'var(--usage-other)',
        x: d.outside,
      },
    ].filter((s) => s.x > 0);
  const totals = days.map((d) => segmentsOf(d).reduce((a, s) => a + s.x, 0));
  const peak = Math.max(...totals, 0);
  if (days.length === 0) return null;

  const figureOf = (i: number) =>
    !block.known
      ? t('quota_usage.day_no_reading')
      : unread(days[i].day)
        ? t('quota_usage.day_unread')
        : t('quota_usage.day_used', { value: formatShare(totals[i]) });
  // The day's projects largest first; the other projects and what no request explains last.
  const projectsOf = (d: QuotaPilotUsageDay) => {
    const segments = segmentsOf(d);
    return [
      ...segments.filter((s) => s.project).sort((a, b) => b.x - a.x),
      ...segments.filter((s) => !s.project),
    ]
      .map((s) => `${s.name} ${formatShare(s.x)}`)
      .join(t('quota_usage.list_separator'));
  };
  const sessionName = (s: QuotaPilotUsageDay['sessions'][number]) =>
    sessionLabel(t, s.id, s.title) + (s.used !== null ? ` ${formatShare(s.used)}` : '');
  const dateOf = (i: number) => formatDate(dayStartMs(days[i].day), locale);

  return (
    <PickableBars
      label={t('quota_usage.daily_label')}
      bars={days.map((d, i) => ({
        key: d.day,
        label: [
          `${dateOf(i)}: ${figureOf(i)}`,
          projectsOf(d),
          d.sessions.map(sessionName).join(t('quota_usage.list_separator')),
          ranLine(t, d.requests, d.tokens, locale),
        ]
          .filter((x) => x && x !== '—')
          .join(' · '),
        segments: segmentsOf(d),
        muted: unread(d.day),
      }))}
      peak={peak}
      axis={
        <div className={styles.chartAxis} aria-hidden="true">
          {days.map((d, i) => (
            <span key={d.day}>
              {days.length <= 7 || i === 0 || i % 5 === 4 || i === days.length - 1
                ? formatDay(dayStartMs(d.day), locale)
                : ''}
            </span>
          ))}
        </div>
      }
      detail={(i) => {
        const d = days[i];
        return (
          <BarCard
            title={dateOf(i)}
            figure={figureOf(i)}
            quiet={!block.known || unread(d.day)}
            rows={[
              { label: t('quota_usage.readout_projects'), value: projectsOf(d) },
              {
                label: t('quota_usage.readout_sessions'),
                value: d.sessions.map((x, j) => (
                  <Fragment key={x.id || '-'}>
                    {j > 0 && t('quota_usage.list_separator')}
                    <button
                      type="button"
                      className={styles.barCardLink}
                      title={sessionLabel(t, x.id, x.title)}
                      onClick={() => focusUsageSession(x.id)}
                    >
                      {sessionLabel(t, x.id, x.title)}
                    </button>
                    {x.used !== null && ` ${formatShare(x.used)}`}
                  </Fragment>
                )),
              },
              {
                label: t('quota_usage.readout_use'),
                value: ranLine(t, d.requests, d.tokens, locale),
              },
            ]}
          />
        );
      }}
    />
  );
}

/** A window's parts as a bar's segments: the block's named projects, the others, then outside. */
function windowSegments(
  w: QuotaPilotUsageWindow,
  named: string[],
  colourOf: (name: string) => string,
  t: TFunction
) {
  return [
    ...named.map((name) => ({
      name: projectLabel(t, name),
      project: true,
      colour: colourOf(name),
      x: w.projects[name] ?? 0,
    })),
    {
      name: t('quota_usage.other_projects'),
      project: false,
      colour: REST_COLOUR,
      x: Object.entries(w.projects)
        .filter(([name]) => !named.includes(name))
        .reduce((a, [, x]) => a + x, 0),
    },
    {
      name: t('quota_usage.before_log'),
      project: false,
      colour: 'var(--usage-hatch)',
      x: w.beforeLog,
    },
    { name: t('quota_usage.outside'), project: false, colour: 'var(--usage-other)', x: w.outside },
  ].filter((s) => s.x > 0);
}

/**
 * The 5-hour windows of the last day, one bar each on the scale of one window, coloured by project
 * as the block's legend is. Picking one shows when it ran, what it used by project, its largest
 * sessions (those of the running window open in the table below) and what its requests ran.
 */
function WindowsChart({
  usage,
  block,
  named,
  colourOf,
}: {
  usage: QuotaPilotUsage;
  block: Block;
  named: string[];
  colourOf: (name: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const windows = usage.windows[block.provider] ?? [];
  const labels = new Map(block.accounts.map((a) => [a.id, a.label]));
  const many = new Set(windows.map((w) => w.account)).size > 1;
  const listed = new Set(usage.projects.flatMap((p) => p.sessions.map((s) => s.id)));
  const since =
    usage.windowsFromMs !== null
      ? t('quota_usage.windows_from_note', { when: formatDayTime(usage.windowsFromMs, locale) })
      : '';
  if (windows.length === 0) return since ? <p className={styles.foot}>{since}</p> : null;

  const segmentsOf = (w: QuotaPilotUsageWindow) => windowSegments(w, named, colourOf, t);
  const spanOf = (w: QuotaPilotUsageWindow) =>
    `${formatDayTime(w.fromMs, locale)}–${formatTime(w.toMs, locale)}`;
  const titleOf = (w: QuotaPilotUsageWindow) =>
    [many ? labels.get(w.account) : '', spanOf(w), w.running ? t('quota_usage.window_running') : '']
      .filter(Boolean)
      .join(' · ');
  const figureOf = (w: QuotaPilotUsageWindow) =>
    t('quota_usage.window_used', { value: formatShare(w.used) });
  const projectsOf = (w: QuotaPilotUsageWindow) => {
    const segments = segmentsOf(w);
    return [
      ...segments.filter((s) => s.project).sort((a, b) => b.x - a.x),
      ...segments.filter((s) => !s.project),
    ]
      .map((s) => `${s.name} ${formatShare(s.x)}`)
      .join(t('quota_usage.list_separator'));
  };
  const sessionName = (s: QuotaPilotUsageWindow['sessions'][number]) =>
    sessionLabel(t, s.id, s.title) + (s.used !== null ? ` ${formatShare(s.used)}` : '');

  return (
    <>
      <PickableBars
        label={t('quota_usage.windows_label')}
        bars={windows.map((w) => ({
          key: `${w.account}-${w.fromMs}`,
          label: [
            `${titleOf(w)}: ${figureOf(w)}`,
            projectsOf(w),
            w.sessions.map(sessionName).join(t('quota_usage.list_separator')),
            ranLine(t, w.requests, w.tokens, locale),
          ]
            .filter((x) => x && x !== '—')
            .join(' · '),
          segments: segmentsOf(w),
        }))}
        peak={Math.max(1, ...windows.map((w) => w.used))}
        axis={
          <div className={styles.chartAxis} aria-hidden="true">
            {windows.map((w) => (
              <span key={`${w.account}-${w.fromMs}`}>{formatTime(w.fromMs, locale)}</span>
            ))}
          </div>
        }
        detail={(i) => {
          const w = windows[i];
          return (
            <BarCard
              title={titleOf(w)}
              figure={figureOf(w)}
              rows={[
                { label: t('quota_usage.readout_projects'), value: projectsOf(w) },
                {
                  label: t('quota_usage.readout_sessions'),
                  value: w.sessions.map((x, j) => (
                    <Fragment key={x.id || '-'}>
                      {j > 0 && t('quota_usage.list_separator')}
                      {w.running && listed.has(x.id) ? (
                        <button
                          type="button"
                          className={styles.barCardLink}
                          title={sessionLabel(t, x.id, x.title)}
                          onClick={() => focusUsageSession(x.id)}
                        >
                          {sessionLabel(t, x.id, x.title)}
                        </button>
                      ) : (
                        sessionLabel(t, x.id, x.title)
                      )}
                      {x.used !== null && ` ${formatShare(x.used)}`}
                    </Fragment>
                  )),
                },
                {
                  label: t('quota_usage.readout_use'),
                  value: ranLine(t, w.requests, w.tokens, locale),
                },
              ]}
            />
          );
        }}
      />
      {since && <p className={styles.foot}>{since}</p>}
    </>
  );
}

/** The block's projects, largest first, then what no project holds. */
function Legend({
  parts,
  named,
  beforeLog,
  outside,
  colourOf,
}: {
  parts: Record<string, number>;
  named: string[];
  beforeLog: number;
  outside: number;
  colourOf: (name: string) => string;
}) {
  const { t } = useTranslation();
  const rest = Object.entries(parts)
    .filter(([name]) => !named.includes(name))
    .reduce((sum, [, x]) => sum + x, 0);
  if (named.length === 0 && rest <= 0 && beforeLog <= 0 && outside <= 0) return null;
  return (
    <ul className={styles.legend}>
      {named.map((name) => (
        <li key={name || '-'}>
          <span className={styles.dot} style={{ background: colourOf(name) }} aria-hidden="true" />
          <span className={styles.legendName}>{projectLabel(t, name)}</span>
          <span className={styles.legendValue}>{formatShare(parts[name])}</span>
        </li>
      ))}
      {rest > 0 && (
        <li>
          <span className={styles.dot} style={{ background: REST_COLOUR }} aria-hidden="true" />
          {t('quota_usage.other_projects')}
          <span className={styles.legendValue}>{formatShare(rest)}</span>
        </li>
      )}
      {beforeLog > 0 && (
        <li>
          <span className={`${styles.dot} ${styles.hatch}`} aria-hidden="true" />
          {t('quota_usage.before_log')}
          <span className={styles.legendValue}>{formatShare(beforeLog)}</span>
        </li>
      )}
      {outside > 0 && (
        <li title={t('quota_usage.outside_hint')}>
          <span
            className={styles.dot}
            style={{ background: 'var(--usage-other)' }}
            aria-hidden="true"
          />
          {t('quota_usage.outside')}
          <span className={styles.legendValue}>{formatShare(outside)}</span>
        </li>
      )}
    </ul>
  );
}

const KINDS = ['cacheRead', 'cacheWrite', 'output', 'input'] as const;

/** Each kind of token: how many, and what part of the estimated use it makes. */
export function Composition({
  composition,
  note,
  noCacheWrite,
}: {
  composition: QuotaPilotComposition;
  note: string;
  noCacheWrite?: boolean;
}) {
  const { t } = useTranslation();
  const w = composition.weights;
  const total = w.input + w.output + w.cacheRead + w.cacheWrite;
  return (
    <div>
      <div className={styles.subhead}>
        {t('quota_usage.composition')}
        <span>{note}</span>
      </div>
      <div className={`${styles.kind} ${styles.kindHead}`} aria-hidden="true">
        <span />
        <span>{t('quota_usage.col_tokens')}</span>
        <span>{t('quota_usage.col_estimated')}</span>
      </div>
      {KINDS.map((kind) => {
        const share = total > 0 ? w[kind] / total : 0;
        const missing = kind === 'cacheWrite' && noCacheWrite;
        return (
          <div key={kind} className={styles.kind}>
            <span className={styles.kindName}>
              {t(`quota_usage.kind_${kind}`)}
              <small>{t(`quota_usage.kind_${kind}_hint`)}</small>
            </span>
            <span className={styles.kindCount}>
              {missing ? t('quota_usage.not_reported') : formatTokens(composition.tokens[kind])}
            </span>
            <span className={styles.kindBar} aria-hidden="true">
              {!missing && <span style={{ width: `${share * 100}%` }} />}
            </span>
            <span className={styles.kindShare}>{missing ? '—' : formatShare(share)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Efficiency({ composition }: { composition: QuotaPilotComposition }) {
  const { t, i18n } = useTranslation();
  const hit = cacheHitRate(composition.tokens);
  const context = averageContext(composition.tokens, composition.requests);
  return (
    <div>
      <div className={styles.subhead}>{t('quota_usage.efficiency')}</div>
      <div className={styles.kpis}>
        <div>
          <strong>{hit === null ? '—' : formatRate(hit)}</strong>
          <span>{t('quota_usage.hit_rate')}</span>
        </div>
        <div>
          <strong>{composition.requests.toLocaleString(i18n.resolvedLanguage)}</strong>
          <span>{t('quota_usage.requests_unit', { count: composition.requests })}</span>
        </div>
        <div>
          <strong>{context === null ? '—' : formatTokens(context)}</strong>
          <span>{t('quota_usage.avg_context')}</span>
        </div>
      </div>
      <p className={styles.foot}>{t('quota_usage.efficiency_hint')}</p>
    </div>
  );
}
