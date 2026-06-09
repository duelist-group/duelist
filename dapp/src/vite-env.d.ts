/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK_NAME?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_NETWORK_PASSPHRASE?: string;
  readonly VITE_POOL_CONTRACT?: string;
  readonly VITE_VERIFIER_CONTRACT?: string;
  readonly VITE_COMPLIANCE_CONTRACT?: string;
  readonly VITE_XLM_ASSET_ID?: string;
  readonly VITE_XLM_CONTRACT?: string;
  readonly VITE_USDC_ASSET_ID?: string;
  readonly VITE_USDC_CONTRACT?: string;
  readonly VITE_EURC_ASSET_ID?: string;
  readonly VITE_EURC_CONTRACT?: string;
  readonly VITE_INDEXER_URLS?: string;
  readonly VITE_RELAYER_URLS?: string;
  readonly VITE_ENGINE_DEPOSIT?: string;
  readonly VITE_ENGINE_TRANSFER?: string;
  readonly VITE_ENGINE_WITHDRAW?: string;
  readonly VITE_UH_ENGINE_CONTRACT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
