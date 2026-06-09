import React, { createContext, useContext, useState, useEffect } from 'react';
import { NETWORK } from '../lib/config';

export interface Token {
  contractAddress: string;
  assetId: string; // The hex asset ID used in the protocol
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  isDefault?: boolean;
}

const DEFAULT_TOKENS: Token[] = [
  {
    contractAddress: NETWORK.xlmContract,
    assetId: NETWORK.xlmAssetId,
    symbol: 'XLM',
    name: 'Stellar Lumens',
    decimals: 7,
    isDefault: true,
  },
  {
    contractAddress: NETWORK.usdcContract,
    assetId: NETWORK.usdcAssetId,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 7,
    isDefault: true,
  },
  {
    contractAddress: NETWORK.eurcContract,
    assetId: NETWORK.eurcAssetId,
    symbol: 'EURC',
    name: 'Euro Coin',
    decimals: 7,
    isDefault: true,
  },
];

const STORAGE_KEY = 'shield-user-tokens';

interface TokenContextType {
  tokens: Token[];
  addToken: (token: Token) => void;
  removeToken: (contractAddress: string) => void;
}

const TokenContext = createContext<TokenContextType | null>(null);

export function TokenProvider({ children }: { children: React.ReactNode }) {
  const [tokens, setTokens] = useState<Token[]>(DEFAULT_TOKENS);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Token[];
        setTokens([...DEFAULT_TOKENS, ...parsed]);
      }
    } catch (e) {
      console.error('Failed to load user tokens', e);
    }
  }, []);

  const addToken = (token: Token) => {
    setTokens(prev => {
      if (prev.some(t => t.contractAddress === token.contractAddress)) return prev;
      const newTokens = [...prev, token];
      const customTokens = newTokens.filter(t => !t.isDefault);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customTokens));
      return newTokens;
    });
  };

  const removeToken = (contractAddress: string) => {
    setTokens(prev => {
      const newTokens = prev.filter(t => t.isDefault || t.contractAddress !== contractAddress);
      const customTokens = newTokens.filter(t => !t.isDefault);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customTokens));
      return newTokens;
    });
  };

  return (
    <TokenContext.Provider value={{ tokens, addToken, removeToken }}>
      {children}
    </TokenContext.Provider>
  );
}

export function useTokens() {
  const ctx = useContext(TokenContext);
  if (!ctx) throw new Error('useTokens must be used within TokenProvider');
  return ctx;
}
