import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { readLanguage } from '@/host';
import en from './locales/en.json';
import ru from './locales/ru.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

// The panel's languages, its fallback and its interpolation settings (src/i18n there).
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'zh-TW': { translation: zhTW },
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: readLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
