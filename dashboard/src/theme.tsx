import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type ThemePreference = 'light' | 'dark';

interface ThemeContextValue {
  resolvedTheme: ThemePreference;
  explicitTheme: ThemePreference | null;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'syntaur-theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredTheme(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function getSystemTheme(): ThemePreference {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
}

export function initTheme(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const storedTheme = getStoredTheme();
  applyTheme(storedTheme ?? getSystemTheme());
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [explicitTheme, setExplicitTheme] = useState<ThemePreference | null>(() => getStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ThemePreference>(() => getStoredTheme() ?? getSystemTheme());

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

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

  const value: ThemeContextValue = {
    resolvedTheme,
    explicitTheme,
    setTheme: (theme) => {
      window.localStorage.setItem(STORAGE_KEY, theme);
      setExplicitTheme(theme);
      setResolvedTheme(theme);
    },
    toggleTheme: () => {
      const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
      window.localStorage.setItem(STORAGE_KEY, nextTheme);
      setExplicitTheme(nextTheme);
      setResolvedTheme(nextTheme);
    },
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
