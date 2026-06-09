# Credits and Acknowledgments

Duelist is built on a lot of generous open-source work. This is what it leans on, and
the people and teams behind it. If something is missing here it is an oversight, not
intent, open an issue and we will add it.

## Zero-knowledge

- **Noir**, the circuit language Duelist's circuits are written in.
  noir-lang / Aztec. https://github.com/noir-lang/noir
- **Barretenberg (UltraHonk)** via `@aztec/bb.js`, the proving backend that runs in the
  browser. Aztec. https://github.com/AztecProtocol/aztec-packages
- **rs-soroban-ultrahonk**, the on-chain UltraHonk verifier that lets Soroban check our
  proofs. yugocabrio. https://github.com/yugocabrio/rs-soroban-ultrahonk
  (See Special Thanks below.)
- **Poseidon2**, from the Noir standard library, used as the hash across the circuits,
  the SDK, and the indexer so the Merkle roots agree.
- **Noble cryptography** (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`), used for
  note encryption and key handling. Paul Miller. https://github.com/paulmillr

## Stellar and Soroban

- **Soroban SDK** (`rs-soroban-sdk`), the contract framework.
  Stellar Development Foundation. https://github.com/stellar/rs-soroban-sdk
- **Stellar JS SDK** (`@stellar/stellar-sdk`), used by the dapp, indexer, and relayer.
  Stellar Development Foundation. https://github.com/stellar/js-stellar-sdk
- **Stellar Wallets Kit**, the wallet connection layer.
  Creit Tech. https://github.com/Creit-Tech/Stellar-Wallets-Kit
- **Freighter API** (`@stellar/freighter-api`).
  Stellar Development Foundation. https://github.com/stellar/freighter
- Wallets reachable from the app: **Freighter**, **Albedo** (https://albedo.link), and
  **WalletConnect / Reown** (https://reown.com).

## Frontend and tooling

- **React** and React DOM. Meta. https://github.com/facebook/react
- **React Router** (`react-router-dom`). Remix. https://github.com/remix-run/react-router
- **Vite** and `@vitejs/plugin-react`, plus `vite-plugin-wasm`,
  `vite-plugin-top-level-await`, and `vite-plugin-node-polyfills`.
  https://github.com/vitejs/vite
- **TypeScript**. Microsoft. https://github.com/microsoft/TypeScript
- **sonner**, the toast notifications. Emil Kowalski. https://github.com/emilkowalski/sonner
- **qrcode.react**, the shielded-address QR codes. https://github.com/zpao/qrcode.react
- **Lucide**, the icon set (vendored as local SVGs). https://github.com/lucide-icons/lucide

## Special Thanks

### yugocabrio

The single piece that makes Duelist possible on Stellar is on-chain proof verification, and
that comes from **yugocabrio's `rs-soroban-ultrahonk`**, a Rust implementation of an UltraHonk
verifier that runs inside Soroban. Getting a Honk verifier to fit and run under Soroban's
constraints is genuinely hard, low-level work, and Duelist's entire privacy model rests on it.
Every shielded transaction the protocol settles is checked by his verifier.

yugocabrio is a zero-knowledge researcher based in Kyoto whose other work includes folding
schemes like Sonobe and Nova. He built this in the open and was generous with it, and Duelist
would not verify a single proof on Stellar without him. Thank you, truly.

- GitHub: https://github.com/yugocabrio
- Verifier: https://github.com/yugocabrio/rs-soroban-ultrahonk

### And the teams behind the rest

The Aztec and Noir teams for Noir and Barretenberg, the Stellar Development Foundation and the
Soroban team for the chain and the SDKs, and the wider Stellar and zero-knowledge communities
whose tools, examples, and answers shaped this project.

## A note on licenses

Everything Duelist ships is permissively licensed (MIT, ISC, BSD, Apache-2.0). Where a license
asks for it, the original copyright and license notice are preserved, including yugocabrio's MIT
notice for the verifier. Duelist's own license is BUSL 1.1 
