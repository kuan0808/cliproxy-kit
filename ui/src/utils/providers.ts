import type { TFunction } from 'i18next';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconMeta from '@/assets/icons/meta.svg';
import iconDevin from '@/assets/icons/devin.svg';
import iconDevinDark from '@/assets/icons/devin-dark.svg';
import iconGemini from '@/assets/icons/gemini.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconIflow from '@/assets/icons/iflow.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import type { ResolvedTheme } from '@/host';

/** Provider names, icons and labels as the management panel shows them. */

const PROVIDER_ALIASES: Record<string, string> = {
  'anti-gravity': 'antigravity',
  grok: 'xai',
  muse: 'meta',
  'x-ai': 'xai',
  'x.ai': 'xai',
};

export const normalizeProviderKey = (value: string): string => {
  const key = value.trim().toLowerCase().replace(/_/g, '-');
  return PROVIDER_ALIASES[key] ?? key;
};

type IconAsset = string | { light: string; dark: string };

const PROVIDER_ICONS: Record<string, IconAsset> = {
  antigravity: iconAntigravity,
  aistudio: iconGemini,
  claude: iconClaude,
  codex: iconCodex,
  meta: iconMeta,
  devin: { light: iconDevin, dark: iconDevinDark },
  gemini: iconGemini,
  xai: { light: iconGrok, dark: iconGrokDark },
  iflow: iconIflow,
  kimi: { light: iconKimiDark, dark: iconKimiLight },
  qwen: iconQwen,
  vertex: iconVertex,
};

export const getTypeLabel = (t: TFunction, type: string): string => {
  const providerKey = normalizeProviderKey(type);
  const key = `auth_files.filter_${providerKey}`;
  const translated = t(key);
  if (translated !== key) return translated;
  if (providerKey === 'iflow') return 'iFlow';
  return type.charAt(0).toUpperCase() + type.slice(1);
};

export const getAuthFileIcon = (type: string, resolvedTheme: ResolvedTheme): string | null => {
  const icon = PROVIDER_ICONS[normalizeProviderKey(type)];
  if (!icon) return null;
  return typeof icon === 'string' ? icon : resolvedTheme === 'dark' ? icon.dark : icon.light;
};

// These providers' icons sit on a base that follows the theme: black when light, white when dark.
const THEME_SURFACE_ICON_PROVIDERS = new Set(['kimi']);

export const isThemeSurfaceIconProvider = (type: string): boolean =>
  THEME_SURFACE_ICON_PROVIDERS.has(normalizeProviderKey(type));

export const getThemeSurfaceIconBackground = (resolvedTheme: ResolvedTheme): string =>
  resolvedTheme === 'dark' ? '#ffffff' : '#000000';
export type { ResolvedTheme } from '@/host';
