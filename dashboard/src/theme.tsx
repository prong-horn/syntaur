import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_THEME_SLUG,
  isThemeSlug,
  type ThemeSlug,
} from './themes';
import {
  fetchThemeConfig,
  saveThemeConfig,
  resetThemeConfig,
} from './hooks/useThemeConfig';

type ThemePreference = 'light' | 'dark';

interface ThemeContextValue {
  resolvedTheme: ThemePreference;
  explicitTheme: ThemePreference | null;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  preset: ThemeSlug;
  setPreset: (slug: ThemeSlug) => Promise<void>;
  resetPreset: () => Promise<void>;
}

const SCHEME_STORAGE_KEY = 'syntaur-theme';
const PRESET_STORAGE_KEY = 'syntaur-preset';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredScheme(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(SCHEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function getStoredPreset(): ThemeSlug {
  try {
    const value = window.localStorage.getItem(PRESET_STORAGE_KEY);
    return isThemeSlug(value) ? value : DEFAULT_THEME_SLUG;
  } catch {
    return DEFAULT_THEME_SLUG;
  }
}

function getSystemTheme(): ThemePreference {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyScheme(scheme: ThemePreference): void {
  document.documentElement.classList.toggle('dark', scheme === 'dark');
}

function applyPreset(slug: ThemeSlug): void {
  document.documentElement.dataset.theme = slug;
}

export function initTheme(): void {
  if (typeof document === 'undefined') {
    return;
  }
  applyScheme(getStoredScheme() ?? getSystemTheme());
  applyPreset(getStoredPreset());
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [explicitTheme, setExplicitTheme] = useState<ThemePreference | null>(() => getStoredScheme());
  const [resolvedTheme, setResolvedTheme] = useState<ThemePreference>(() => getStoredScheme() ?? getSystemTheme());
  const [preset, setPresetState] = useState<ThemeSlug>(() => getStoredPreset());

  useEffect(() => {
    applyScheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    applyPreset(preset);
  }, [preset]);

  // Reconcile preset with server on mount; server wins if it differs.
  useEffect(() => {
    let cancelled = false;
    fetchThemeConfig().then((config) => {
      if (cancelled) return;
      if (config.preset !== preset) {
        setPresetState(config.preset);
        try {
          window.localStorage.setItem(PRESET_STORAGE_KEY, config.preset);
        } catch {
          // ignore
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // intentionally only on mount — server reconciliation is a one-shot bootstrap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      if (!explicitTheme) {
        setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');
      }
    };

    updateTheme();
    mediaQuery.addEventListener('change', updateTheme);
    return () => {
      mediaQuery.removeEventListener('change', updateTheme);
    };
  }, [explicitTheme]);

  async function setPreset(slug: ThemeSlug): Promise<void> {
    setPresetState(slug);
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, slug);
    } catch {
      // ignore
    }
    await saveThemeConfig(slug);
  }

  async function resetPreset(): Promise<void> {
    const config = await resetThemeConfig();
    setPresetState(config.preset);
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, config.preset);
    } catch {
      // ignore
    }
  }

  const value: ThemeContextValue = {
    resolvedTheme,
    explicitTheme,
    setTheme: (theme) => {
      window.localStorage.setItem(SCHEME_STORAGE_KEY, theme);
      setExplicitTheme(theme);
      setResolvedTheme(theme);
    },
    toggleTheme: () => {
      const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
      window.localStorage.setItem(SCHEME_STORAGE_KEY, nextTheme);
      setExplicitTheme(nextTheme);
      setResolvedTheme(nextTheme);
    },
    preset,
    setPreset,
    resetPreset,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
