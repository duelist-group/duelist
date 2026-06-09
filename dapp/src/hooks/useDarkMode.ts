import { useTheme } from './ThemeContext';

export function useDarkMode() {
  const { theme } = useTheme();
  return { dark: theme === 'dark' };
}
