// dapp/src/lib/config.ts
// configuration with multi-endpoint support: the dapp accepts comma-separated
// lists for indexers and relayers, and falls through the list until one
// responds. defaults to localhost so a single-machine demo works out of the box.

export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  networkPassphrase: string;
  poolContract: string;
  verifierContract: string;
  complianceContract: string;
  xlmAssetId: string;
  xlmContract: string;
  usdcAssetId: string;
  usdcContract: string;
  eurcAssetId: string;
  eurcContract: string;
  /** Ordered list of indexer URLs the dapp will try in turn. */
  indexerUrls: string[];
  /** Ordered list of relayer URLs the user can pick from. */
  relayerUrls: string[];
  /** stellar.expert base URL for transaction links. */
  explorerBase: string;
}

function parseUrlList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const isMainnet =
  (import.meta.env.VITE_NETWORK_NAME || '').toLowerCase().includes('mainnet') ||
  (import.meta.env.VITE_NETWORK_PASSPHRASE || '').includes('Public Global');

// fail closed on mainnet: a real deployment must supply every contract address
// explicitly. the dummy fallbacks below are for local/testnet convenience only;
// silently shipping them on mainnet would point real funds at the wrong contract.
function required(name: string, value: string | undefined): string {
  if (isMainnet && (!value || value.trim() === '')) {
    throw new Error(`[config] ${name} must be set for mainnet — refusing to start with a placeholder`);
  }
  return value || '';
}

export const NETWORK: NetworkConfig = {
  name: import.meta.env.VITE_NETWORK_NAME || 'Stellar Testnet',
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  poolContract: required('VITE_POOL_CONTRACT',
    import.meta.env.VITE_POOL_CONTRACT) ||
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  verifierContract: required('VITE_VERIFIER_CONTRACT',
    import.meta.env.VITE_VERIFIER_CONTRACT) ||
    'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  complianceContract: required('VITE_COMPLIANCE_CONTRACT',
    import.meta.env.VITE_COMPLIANCE_CONTRACT) ||
    'CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  // xlm (native asset)
  xlmAssetId:
    import.meta.env.VITE_XLM_ASSET_ID ||
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  xlmContract:
    import.meta.env.VITE_XLM_CONTRACT ||
    'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',

  // usdc (circle)
  usdcAssetId:
    import.meta.env.VITE_USDC_ASSET_ID ||
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  usdcContract:
    import.meta.env.VITE_USDC_CONTRACT ||
    (isMainnet
      ? 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
      : 'CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7'),

  // eurc (circle)
  eurcAssetId:
    import.meta.env.VITE_EURC_ASSET_ID ||
    '0x0000000000000000000000000000000000000000000000000000000000000003',
  eurcContract:
    import.meta.env.VITE_EURC_CONTRACT ||
    (isMainnet
      ? 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV'
      : 'CC3VUZCA5P7SY4I3NUJTYZAQ54DFZBGA5NRFG76WHAKNGJ6VGWI6FKYE'),

  // multi-endpoint lists. anyone can run their own indexer / relayer; the
  // user picks one from the list in settings, or self-relays (relayerurls empty).
  indexerUrls: parseUrlList(import.meta.env.VITE_INDEXER_URLS, ['http://localhost:3001']),
  relayerUrls: parseUrlList(import.meta.env.VITE_RELAYER_URLS, ['http://localhost:3002']),
  /** stellar.expert base URL — use testnet or mainnet depending on network passphrase. */
  explorerBase: isMainnet
    ? 'https://stellar.expert/explorer/public'
    : 'https://stellar.expert/explorer/testnet',
};

