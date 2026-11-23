export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'nexofis:theme';
export const SIDEBAR_STORAGE_KEY = 'nexofis:sidebar-collapsed';

export function resolveInitialTheme(
  storedValue?: string | null,
  prefersDark = false
): ThemeMode {
  if (storedValue === 'dark' || storedValue === 'light') {
    return storedValue;
  }
  return prefersDark ? 'dark' : 'light';
}

export function getNextTheme(current: ThemeMode): ThemeMode {
  return current === 'dark' ? 'light' : 'dark';
}

export function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return resolveInitialTheme(stored, prefersDark);
  } catch {
    return 'light';
  }
}

export function applyThemeToDocument(theme: ThemeMode): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
      root.style.backgroundColor = '#061321';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
      root.style.backgroundColor = '#FAF9F5';
    }
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore restricted storage contexts
    }
  }
}

export function subscribeToThemeStorage(onChange: (theme: ThemeMode) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (event.newValue === 'dark' || event.newValue === 'light') {
      onChange(event.newValue);
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {
    // Ignore restricted storage contexts
  }
}
