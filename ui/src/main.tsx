import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { followHost } from '@/host';
import i18n from '@/i18n';
import { App } from './App';
import '@/styles/global.scss';

followHost((language) => {
  document.documentElement.lang = language;
  if (i18n.language !== language) void i18n.changeLanguage(language);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
