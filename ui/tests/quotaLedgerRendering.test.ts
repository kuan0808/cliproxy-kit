import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import {
  QuotaLedgerView,
  type QuotaLedgerViewProps,
} from '@/features/quota/components/QuotaLedger';
import { normalizeQuotaPilotSnapshot } from '@/services/api/quotaPilot';
import { NOW_MS, rawSnapshot } from './fixtures/quotaPilotSnapshot';

const snapshot = normalizeQuotaPilotSnapshot(rawSnapshot)!;

const baseProps: QuotaLedgerViewProps = {
  tab: 'all',
  search: '',
  resolvedTheme: 'light',
  snapshot: { status: 'live', snapshot },
  showEmails: false,
  onShowEmailsChange: () => {},
  now: NOW_MS,
};

const render = (props: Partial<QuotaLedgerViewProps> = {}) =>
  renderToStaticMarkup(createElement(QuotaLedgerView, { ...baseProps, ...props }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('QuotaLedger rendering', () => {
  test('live: overview, routing markers, stale marker and the footer line', () => {
    const markup = render();
    expect(markup).toContain('Live routing from the quota-pilot plugin');
    expect(markup).toContain('title="Sessions bound now: 2"');
    expect(markup).toContain('title="A new session gets this account"');
    // Read as used, as the band and the usage view do, and said so.
    expect(markup).toContain('>Weekly used<');
    expect(markup).toContain('>137%<');
    expect(markup).toContain('of 200%');
    expect(markup).toContain('2 credentials');
    expect(markup).toContain('1 credential<');
    expect(markup).toContain('claude-a•••@e•••.com.json');
    expect(markup).toContain('In use by 2 sessions');
    expect(markup).toContain('>Max 20x<');
    expect(markup).toContain('First for new sessions');
    expect(markup).toContain('Weekly Fable');
    expect(markup).toContain('0% used<span aria-hidden="true">~</span>');
    expect(markup).toContain('>100% used<');
    expect(markup).toContain('>5-hour used<');
    expect(markup).toContain('weekly quota used up');
    expect(markup).toContain('When Claude is used up: gpt-6-sol (Codex)');
    expect(markup).toContain('Automatic switch: off<');
    expect(markup).toContain('Not reported'); // claude-b has no Fable window, claude-a does
    expect(markup).toContain('Updated 12 s ago');
    expect(markup).not.toContain('Seq ');
    expect(markup).toContain('>Plugin settings<');
  });

  test('masks identities unless emails are shown', () => {
    expect(render()).not.toContain('alice@example.com');
    expect(render({ showEmails: true })).toContain('alice@example.com');
  });

  test('says so when the plugin does not answer, with no rows and no footer', () => {
    const markup = render({ snapshot: { status: 'unavailable' } });
    expect(markup).toContain('Cannot read quota-pilot');
    expect(markup).not.toContain('Sessions bound now');
    expect(markup).not.toContain('Plugin settings');
  });

  test('with no account at all, says how to add one; with a filter, that nothing matches', () => {
    const none = { ...snapshot, providers: {} };
    expect(render({ snapshot: { status: 'live', snapshot: none } })).toContain(
      'No Claude or Codex account is logged in to the proxy yet.'
    );
    expect(render({ search: 'nobody@' })).toContain('quota-pilot reports no credentials for this provider or search.');
  });

  test('waits for the first snapshot', () => {
    const markup = render({ snapshot: { status: 'loading' } });
    expect(markup).toContain('Reading the quota-pilot snapshot');
    expect(markup).not.toContain('Cannot read quota-pilot');
    expect(markup).not.toContain('Weekly left, summed');
  });
});
