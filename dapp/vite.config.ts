import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const noirAlias = {
  '@noir-lang/acvm_js': '@noir-lang/acvm_js/web/acvm_js.js',
};

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: noirAlias,
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'path', 'os', 'process'],
      globals: { Buffer: true, global: true, process: true },
    }),
    {
      name: 'wasm-mime',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.wasm') || req.url?.includes('.wasm?')) {
            res.setHeader('Content-Type', 'application/wasm');
          }
          next();
        });
      },
    },
  ],
  server: {
    // expose on the LAN so a phone (or a cloudflared tunnel) can reach the dev
    // server. allowedHosts:true lets the random *.trycloudflare.com host through
    // Vite's host check. proxy keeps the indexer/relayer same-origin under the
    // single tunnel URL — no mixed-content, no CORS, no extra tunnels. (dev-only;
    // production uses absolute VITE_*_URLS host env vars.)
    host: true,
    allowedHosts: true,
    // HMR off while testing over the cloudflared tunnel on mobile: WalletConnect
    // deep-links background the tab, the HMR websocket drops, and Vite force-reloads
    // on every reconnect — that's the "reloads again and again" loop on phones.
    // (Re-enable for local desktop dev if you want hot-reload back.)
    hmr: false,
    fs: { strict: false },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless (not require-corp) keeps crossOriginIsolated true for
      // SharedArrayBuffer/bb.js proving while still allowing the cross-origin
      // resources WalletConnect/Reown loads (require-corp would block them).
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/_indexer': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/_indexer/, ''),
      },
      '/_relayer': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/_relayer/, ''),
      },
    },
  },
  preview: {
    // production build served over the tunnel: no Vite dev client / HMR at all,
    // so there's nothing to force a reload. Mirrors the dev server's host/proxy so
    // the same single-tunnel + /_indexer,/_relayer setup works on the prod bundle.
    host: true,
    allowedHosts: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless (not require-corp) keeps crossOriginIsolated true for
      // SharedArrayBuffer/bb.js proving while still allowing the cross-origin
      // resources WalletConnect/Reown loads (require-corp would block them).
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/_indexer': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/_indexer/, ''),
      },
      '/_relayer': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/_relayer/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: [
      '@aztec/bb.js',
      '@shield-protocol/sdk',
      '@noir-lang/noir_js',
      '@noir-lang/acvm_js',
      '@noir-lang/noirc_abi',
      '@noir-lang/types',
    ],
    force: true,
  },
  build: {
    target: 'esnext',
    // Reown AppKit / WalletConnect ship mixed CJS/ESM; without this the rollup
    // build mangles their interop → "TypeError: <x> is not a function" in the
    // wallet-connect chunk at runtime (worked in dev via esbuild per-module).
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        // Force all Reown AppKit / WalletConnect / Lit code into ONE chunk. When
        // rollup auto-splits it, the Lit decorators (property/state) land in a
        // different chunk than the components that use them at module-init time →
        // "TypeError: f is not a function" in prod (works in dev). Co-locating fixes it.
        manualChunks(id) {
          if (id.includes('@aztec/bb.js')) return 'bb';
          if (id.includes('@stellar/stellar-sdk')) return 'stellar';
          if (
            id.includes('node_modules/@reown') ||
            id.includes('node_modules/@walletconnect') ||
            id.includes('node_modules/valtio') ||
            id.includes('node_modules/lit') ||
            id.includes('node_modules/lit-html') ||
            id.includes('node_modules/lit-element') ||
            id.includes('node_modules/@lit') ||
            id.includes('node_modules/@creit.tech/stellar-wallets-kit')
          ) return 'walletconnect';
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
    resolve: {
      preserveSymlinks: true,
      alias: noirAlias,
    },
    // NOTE: do NOT set rollupOptions.output.inlineDynamicImports here — it makes a
    // single-file worker (which would fix the iOS-standalone "Importing a module
    // script failed"), but it forces the barretenberg wasm to base64-inline into a
    // ~5 MB worker that loads eagerly and can't stream-compile → slower first load
    // for ALL (browser) users. Not worth it for an iOS-standalone-only edge case.
  },
});
