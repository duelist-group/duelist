// dapp/src/hooks/usepricehistory.ts
import { useState, useEffect } from 'react';
import { NETWORK } from '../lib/config';

export type Period = '24H' | '7D' | '30D';

const PERIOD_DAYS: Record<Period, number> = { '24H': 1, '7D': 7, '30D': 30 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min fresh
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 h stale-ok

interface CacheEntry {
  ts: number;
  prices: [number, number][]; // [timestamp_ms, price]
}

function cacheKey(coinId: string, days: number, vsCurrency: string) {
  return `duelist-price-history-${coinId}-${days}d-${vsCurrency}`;
}

function readCache(key: string): { prices: [number, number][]; stale: boolean } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    const age = Date.now() - entry.ts;
    if (age > STALE_TTL) return null; // too old, discard
    return { prices: entry.prices, stale: age > CACHE_TTL };
  } catch { return null; }
}

function writeCache(key: string, prices: [number, number][]) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), prices } satisfies CacheEntry));
  } catch { /* noop */ }
}

async function fetchPrices(days: number, vsCurrency: string): Promise<[number, number][]> {
  // via our cached indexer proxy (not CoinGecko/Binance directly) — reliability + privacy.
  // The indexer does the CoinGecko→Binance fallback server-side.
  const url = `${NETWORK.indexerUrls[0]}/price/history?days=${days}&vs=${vsCurrency}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`price history ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data.prices) || data.prices.length === 0) throw new Error('empty');
  return data.prices as [number, number][];
}

export function usePriceHistory(period: Period, vsCurrency: string) {
  const [xlmHistory, setXlmHistory] = useState<[number, number][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const days = PERIOD_DAYS[period];
    const key = cacheKey('stellar', days, vsCurrency);

    const cached = readCache(key);
    if (cached) {
      setXlmHistory(cached.prices);
      setLoading(false);
      setError(null);
      if (!cached.stale) return; // fresh — no network call needed
      // stale — refresh in background without showing loading/error
      fetchPrices(days, vsCurrency)
        .then(prices => { if (!cancelled) { writeCache(key, prices); setXlmHistory(prices); } })
        .catch(() => { /* keep showing stale data silently */ });
      return () => { cancelled = true; };
    }

    setLoading(true);
    setError(null);

    fetchPrices(days, vsCurrency)
      .then(prices => {
        if (cancelled) return;
        writeCache(key, prices);
        setXlmHistory(prices);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [period, vsCurrency]);

  return { xlmHistory, loading, error };
}
