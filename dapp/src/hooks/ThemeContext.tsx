import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'duelist-theme';

interface ThemeCtx { theme: Theme; setTheme: (t: Theme) => void; }
const Ctx = createContext<ThemeCtx>({ theme: 'light', setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const s = localStorage.getItem(KEY);
    if (s === 'dark') return 'dark';
    if (localStorage.getItem('duelist-dark-mode') === 'true') return 'dark';
    return 'light';
  });

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'glass');
    if (theme === 'dark') document.documentElement.classList.add('dark');
    localStorage.setItem(KEY, theme);
    localStorage.removeItem('duelist-dark-mode');
  }, [theme]);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme() { return useContext(Ctx); }
