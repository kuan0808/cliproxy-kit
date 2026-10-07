/**
 * quota-pilot's page in the management panel: the ledger (each account's quota in routing order)
 * and the usage report (what each session used), under one header with provider tabs, a search
 * and a refresh. Without a management key it asks for one.
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderTabs } from '@/components/ProviderTabs';
import { IconRefreshCw, IconSearch, IconX } from '@/components/ui/icons';
import { useResolvedTheme, type ResolvedTheme } from '@/host';
import { submitKey, useKeyRefused, useManagementKey } from '@/services/api';
import { QuotaLedger } from '@/features/quota/components/QuotaLedger';
import { QuotaUsage } from '@/features/quota/components/QuotaUsage';
import { QUOTA_TAB_ORDER, QUOTA_VIEWS, type QuotaView } from '@/features/quota/constants';
import { useQuotaPilotSnapshot } from '@/features/quota/hooks/useQuotaPilotSnapshot';
import { readQuotaUiState, writeQuotaUiState } from '@/features/quota/uiState';
import { refreshUsage } from '@/features/quota/usageRefresh';
import pageStyles from '@/features/quota/QuotaPage.module.scss';
import headerStyles from '@/features/quota/components/QuotaHeader.module.scss';
import styles from './App.module.scss';

export function App() {
  const key = useManagementKey();
  const resolvedTheme = useResolvedTheme();
  return (
    <main className={styles.page}>
      <div className={styles.topFade} aria-hidden="true" />
      {key ? <QuotaPilotPage resolvedTheme={resolvedTheme} /> : <KeyPrompt />}
    </main>
  );
}

const tabRank = (provider: string) => {
  const index = QUOTA_TAB_ORDER.indexOf(provider);
  return index === -1 ? QUOTA_TAB_ORDER.length : index;
};

function QuotaPilotPage({ resolvedTheme }: { resolvedTheme: ResolvedTheme }) {
  const { t } = useTranslation();
  const snapshot = useQuotaPilotSnapshot();
  const live = snapshot.status === 'live' ? snapshot.snapshot : null;
  const [view, setView] = useState<QuotaView>(() => readQuotaUiState()?.view ?? 'ledger');
  const [pickedTab, setPickedTab] = useState(() => readQuotaUiState()?.tab ?? 'all');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const { types, counts, accounts, sessions, attention } = useMemo(() => {
    const providers = Object.entries(live?.providers ?? {}).filter(
      ([, provider]) => provider.credentials.length > 0
    );
    const credentials = providers.flatMap(([, provider]) => provider.credentials);
    const tabCounts: Record<string, number> = { all: credentials.length };
    providers.forEach(([name, provider]) => (tabCounts[name] = provider.credentials.length));
    return {
      types: [
        'all',
        ...providers.map(([name]) => name).sort((a, b) => tabRank(a) - tabRank(b) || a.localeCompare(b)),
      ],
      counts: tabCounts,
      accounts: credentials.length,
      sessions: credentials.reduce((sum, credential) => sum + credential.sessions, 0),
      attention: credentials.filter((credential) => credential.unavailable).length,
    };
  }, [live]);
  // A remembered tab whose provider is gone falls back to all; while loading it is kept.
  const tab = !live || types.includes(pickedTab) ? pickedTab : 'all';

  const pickTab = (next: string) => {
    setPickedTab(next);
    writeQuotaUiState({ tab: next });
  };
  const pickView = (next: QuotaView) => {
    setView(next);
    writeQuotaUiState({ view: next });
  };
  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      const result = await refreshUsage();
      // The accounts it could not read say why; their figures are the last ones read.
      if (!result.complete) setError(t('quota_pilot.refresh_incomplete'));
      else if (result.failed.length > 0)
        setError(
          t('quota_pilot.refresh_partial', {
            count: result.failed.length,
            list: result.failed
              .map((f) =>
                t('quota_pilot.refresh_account', {
                  account: f.label || f.account,
                  why: t(`quota_pilot.refresh_why_${f.failure}`, {
                    status: f.status,
                    defaultValue: f.failure,
                  }),
                })
              )
              .join(t('quota_usage.list_separator')),
          })
        );
    } catch (err: unknown) {
      setError(
        `${t('quota_pilot.refresh_failed')}${err instanceof Error && err.message ? `: ${err.message}` : ''}`
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={pageStyles.page}>
      <header className={headerStyles.header}>
        <div className={headerStyles.copy}>
          <h1 className={headerStyles.title}>{t('quota_pilot.title')}</h1>
          <p className={headerStyles.meta}>
            {live ? (
              <>
                <span className={headerStyles.metaTotal}>
                  {t('quota_pilot.meta_accounts', { count: accounts })}
                </span>
                <span className={headerStyles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={sessions > 0 ? headerStyles.metaLoaded : headerStyles.metaMuted}>
                  {t('quota_pilot.meta_sessions', { count: sessions })}
                </span>
                {attention > 0 && (
                  <>
                    <span className={headerStyles.metaDot} aria-hidden="true">
                      ·
                    </span>
                    <span className={headerStyles.metaAttention}>
                      {t('quota_pilot.meta_attention', { count: attention })}
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className={headerStyles.metaMuted}>
                {snapshot.status === 'loading' ? t('quota_ledger.source_loading') : t('quota_ledger.source_unavailable')}
              </span>
            )}
          </p>
        </div>
        <div className={headerStyles.actions}>
          <button
            type="button"
            className={headerStyles.primaryAction}
            onClick={() => void refresh()}
            disabled={refreshing}
            title={t('quota_pilot.refresh_title')}
          >
            <IconRefreshCw size={14} className={refreshing ? headerStyles.spinning : undefined} />
            {t('quota_pilot.refresh')}
          </button>
        </div>
      </header>

      <section className={pageStyles.workbench}>
        <div className={pageStyles.tabsRow}>
          <ProviderTabs
            types={types}
            counts={counts}
            active={tab}
            resolvedTheme={resolvedTheme}
            onChange={pickTab}
          />
        </div>

        <div className={pageStyles.toolbar}>
          <div className={pageStyles.search}>
            <IconSearch size={16} className={pageStyles.searchIcon} aria-hidden="true" />
            <input
              ref={searchRef}
              className={pageStyles.searchInput}
              name="search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(`quota_management.search_placeholder_${view}`)}
              aria-label={t(`quota_management.search_label_${view}`)}
            />
            {search && (
              <button
                type="button"
                className={pageStyles.clearSearch}
                aria-label={t('quota_management.search_clear')}
                title={t('quota_management.search_clear')}
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={pageStyles.toolbarEnd}>
            <div className={pageStyles.viewSwitch} role="group" aria-label={t('quota_ledger.view_label')}>
              {QUOTA_VIEWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => pickView(value)}
                >
                  {t(`quota_ledger.view_${value}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className={pageStyles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {view === 'usage' ? (
          <QuotaUsage
            snapshot={snapshot}
            tab={tab}
            search={search}
            onClearSearch={() => setSearch('')}
            resolvedTheme={resolvedTheme}
          />
        ) : (
          <QuotaLedger snapshot={snapshot} tab={tab} search={search} resolvedTheme={resolvedTheme} />
        )}
      </section>
    </div>
  );
}

/** Asks for the management key when the panel did not save one, or the one in use was refused. */
function KeyPrompt() {
  const { t } = useTranslation();
  const refused = useKeyRefused();
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) submitKey(value.trim());
  };
  return (
    <form className={styles.prompt} onSubmit={submit}>
      <h1 className={styles.promptTitle}>{t('quota_pilot.key_title')}</h1>
      <p className={styles.promptText}>{t('quota_pilot.key_desc')}</p>
      <label className={styles.promptField}>
        <span>{t('quota_pilot.key_label')}</span>
        <input
          className="input"
          name="management-key"
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {refused && (
        <p className={styles.promptError} role="alert">
          {t('quota_pilot.key_refused')}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
        {t('quota_pilot.key_submit')}
      </button>
    </form>
  );
}
