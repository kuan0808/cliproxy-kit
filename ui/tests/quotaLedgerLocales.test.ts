import { describe, expect, test } from 'bun:test';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ru from '../src/i18n/locales/ru.json';

const variables = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();
// i18next plural forms differ per language (en: one/other, ru: one/few/many/other, zh: none).
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');
const baseKeys = (doc: Record<string, string>) => [...new Set(Object.keys(doc).map(base))].sort();

for (const section of ['quota_pilot', 'quota_ledger', 'quota_usage'] as const) describe(`${section} translations`, () => {
  const reference = en[section] as Record<string, string>;

  for (const [locale, document] of Object.entries({ zhCN, zhTW, ru })) {
    test(`${locale} has every key with matching interpolation`, () => {
      const translated = document[section] as Record<string, string>;
      expect(baseKeys(translated)).toEqual(baseKeys(reference));
      for (const [key, text] of Object.entries(translated)) {
        const english = reference[key] ?? reference[`${base(key)}_other`] ?? reference[base(key)];
        expect(text.trim().length).toBeGreaterThan(0);
        expect(variables(text)).toEqual(variables(english));
      }
    });
  }
});
