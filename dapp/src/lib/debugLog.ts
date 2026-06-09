// dapp/src/lib/debugLog.ts
// Persistent, cross-reload diagnostic log. Survives page reloads (localStorage),
// so we can see what happened right before a mobile reload. Enable with ?debug=1
// in the URL (sticks until cleared). REMOVE once the mobile flow is fixed.

const LOG_KEY = 'duelist-dbg-log';
const FLAG_KEY = 'duelist-dbg';
const MAX = 60;

export function dbgEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && /[?&]debug=1/.test(location.search)) {
      localStorage.setItem(FLAG_KEY, '1');
    }
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function dlog(tag: string): void {
  try {
    if (localStorage.getItem(FLAG_KEY) !== '1') return;
    const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    arr.push({ t: new Date().toISOString().slice(11, 23), tag });
    while (arr.length > MAX) arr.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch { /* noop */ }
}

export function dlogGet(): Array<{ t: string; tag: string }> {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
}

export function dlogClear(): void {
  try { localStorage.removeItem(LOG_KEY); } catch { /* noop */ }
}
