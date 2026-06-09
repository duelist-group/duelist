// dapp/src/hooks/currencycontext.tsx
// fetches xlm price in every display currency. stablecoin rates are derived
// from cross-rates (no extra api calls): usdcprice = xlm_x / xlm_usd.
// refreshes every 60 s in the background so prices are always current.
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { NETWORK } from '../lib/config';

export interface CurrencyInfo {
  code: string;
  symbol: string;
  name: string;
  noDecimals?: boolean; // e.g. JPY, KRW — display as whole numbers
}

export const SUPPORTED_CURRENCIES: CurrencyInfo[] = [
  { code: 'usd', symbol: '$',   name: 'US Dollar' },
  { code: 'eur', symbol: '€',   name: 'Euro' },
  { code: 'gbp', symbol: '£',   name: 'British Pound' },
  { code: 'jpy', symbol: '¥',   name: 'Japanese Yen',    noDecimals: true },
  { code: 'aud', symbol: 'A$',  name: 'Australian Dollar' },
  { code: 'cad', symbol: 'C$',  name: 'Canadian Dollar' },
  { code: 'inr', symbol: '₹',   name: 'Indian Rupee',    noDecimals: true },
];

const STORAGE_KEY      = 'shield-display-currency';
const CACHE_KEY        = 'shield-price-cache-v3';
const CACHE_TTL_MS     = 60_000;  // 60 s
const REFRESH_INTERVAL = 60_000;  // poll every 60 s

// xlm price per currency code, e.g. prices[usd] = 0.12
type PriceMap = Record<string, number>;

interface CurrencyContextType {
  currency: CurrencyInfo;
  setCurrency: (code: string) => void;
  xlmPrice: number;
  usdcPrice: number;
  eurcPrice: number;
  priceLoaded: boolean;
  refreshPrice: () => void;
  formatFiat: (amount: number) => string;
}

const CurrencyContext = createContext<CurrencyContextType | null>(null);

function loadCache(): PriceMap | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { prices, ts } = JSON.parse(raw);
    return Date.now() - ts < CACHE_TTL_MS ? prices : null;
  } catch { return null; }
}

function saveCache(prices: PriceMap) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ prices, ts: Date.now() })); } catch { /* noop */ }
}

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currencyCode, setCurrencyCode] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'usd'; } catch { return 'usd'; }
  });
  const [prices, setPrices] = useState<PriceMap>(() => loadCache() ?? {});
  const [priceLoaded, setPriceLoaded] = useState(() => Object.keys(loadCache() ?? {}).length > 0);
  const fetchingRef = useRef(false);

  const currency = SUPPORTED_CURRENCIES.find(c => c.code === currencyCode) ?? SUPPORTED_CURRENCIES[0]!;

  const doFetch = useCallback(async (force = false) => {
    if (fetchingRef.current) return;
    if (!force) {
      const cached = loadCache();
      if (cached) { setPrices(cached); setPriceLoaded(true); return; }
    }
    fetchingRef.current = true;
    const vs = SUPPORTED_CURRENCIES.map(c => c.code).join(',');
    try {
      // via our cached indexer proxy (not CoinGecko directly) — reliability + privacy
      const r = await fetch(
        `${NETWORK.indexerUrls[0]}/price?vs=${vs}`
      );
      if (!r.ok) throw new Error('non-ok');
      const d = await r.json();
      const map: PriceMap = {};
      for (const c of SUPPORTED_CURRENCIES) map[c.code] = d.stellar?.[c.code] ?? 0;
      setPrices(map);
      saveCache(map);
      setPriceLoaded(true);
    } catch {
      if (Object.keys(prices).length > 0) setPriceLoaded(true);
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  // initial load + interval refresh
  useEffect(() => {
    doFetch();
    const id = setInterval(() => doFetch(true), REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [doFetch]);

  const setCurrency = useCallback((code: string) => {
    setCurrencyCode(code);
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* noop */ }
  }, []);

  // xlm price in selected currency
  const xlmPrice = prices[currencyCode] ?? 0;

  // stablecoin cross-rates derived from xlm cross-rates — no extra api calls.
  // usdcprice_x = xlm_x / xlm_usd (1 usd expressed in currency x)
  // eurcprice_x = xlm_x / xlm_eur (1 eur expressed in currency x)
  const xlmUsd = prices['usd'] ?? 0;
  const xlmEur = prices['eur'] ?? 0;
  const usdcPrice = xlmUsd > 0 ? xlmPrice / xlmUsd : currencyCode === 'usd' ? 1 : 0;
  const eurcPrice = xlmEur > 0 ? xlmPrice / xlmEur : currencyCode === 'eur' ? 1 : 0;

  const formatFiat = useCallback((amount: number): string => {
    const decimals = currency.noDecimals ? 0 : 2;
    return `${currency.symbol}${amount.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }, [currencyCode, currency]);

  return (
    <CurrencyContext.Provider value={{
      currency, setCurrency,
      xlmPrice, usdcPrice, eurcPrice,
      priceLoaded,
      refreshPrice: () => doFetch(true),
      formatFiat,
    }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider');
  return ctx;
}
