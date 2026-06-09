import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { WalletProvider } from './hooks/WalletContext';
import { ThemeProvider } from './hooks/ThemeContext';
import { Buffer } from 'buffer';
import { dbgEnabled, dlog } from './lib/debugLog';

// polyfill buffer for browser (required by stellar-sdk).
(window as any).Buffer = Buffer;

// diagnostic (?debug=1): record every page load — a burst = a reload loop.
dbgEnabled();
dlog('PAGE-LOAD ' + location.pathname + location.search);
document.addEventListener('visibilitychange', () => dlog('visibility:' + document.visibilityState));
window.addEventListener('pagehide', () => dlog('pagehide'));

// responsive zoom: the desktop ui uses html{zoom:1.1} for polish, but that
// oversizes everything on tablets/phones and causes horizontal clipping. the
// css media query in index.html handles fresh loads, but is driven from js here
// too so it always wins even on an already-open tab that cached the old html
// (vite hmr swaps this bundle but not index.html). keep in sync with index.html.
function applyResponsiveZoom() {
  const compact = window.innerWidth <= 1023;
  document.documentElement.style.zoom = compact ? '1' : '1.1';
}
applyResponsiveZoom();
window.addEventListener('resize', applyResponsiveZoom);
window.addEventListener('orientationchange', applyResponsiveZoom);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <WalletProvider>
          <App />
        </WalletProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
