// dapp/src/pages/faqpage.tsx
import { useState } from 'react';
import { card, cardClass, heading, subHeading } from '../components/Layout';

interface FAQItem {
  q: string;
  a: string;
}

const faqs: FAQItem[] = [
  {
    q: 'Why do I need to connect a Stellar wallet AND create a shielded wallet?',
    a: 'Duelist uses two separate systems. Your Stellar wallet (Freighter, xBull, LOBSTR) is your public wallet — it pays the tiny network fees required to submit transactions to the Stellar blockchain. Your shielded wallet is a separate, privacy-focused wallet that lives inside your browser. It uses advanced Zero-Knowledge cryptography that your Stellar wallet cannot understand. The two work together: your shielded wallet generates ZK proofs, and your Stellar wallet signs and submits them to the network.',
  },
  {
    q: 'What is a Spending Key?',
    a: 'Your Spending Key is the master key to your shielded wallet. It is a long hexadecimal string (starting with 0x) that is generated when you create a new shielded wallet. From this single key, everything else is derived: your shielded address (safu1...), your viewing key, and the ability to generate ZK proofs for spending. If you have the spending key, you have full control of the wallet. If you lose it, the wallet cannot be recovered.',
  },
  {
    q: 'How do I back up my shielded wallet?',
    a: 'When you first create a wallet, the app shows your Spending Key. Write it down and store it somewhere safe (a password manager, a piece of paper in a safe, etc). If you need to see it again later, go to Settings → Reveal Spending Key. You will need to enter your passphrase to confirm. With this key, you can always import your wallet on any device.',
  },
  {
    q: 'Can I use the same shielded wallet on multiple devices?',
    a: 'Yes. Go to the other device, open the Shield dapp, choose "Import existing", paste your Spending Key, and set a password for that device. The password can be different on each device — it only encrypts the key locally. Your shielded balance is the same because it is stored on the blockchain, not on your device.',
  },
  {
    q: 'What is my passphrase/password used for?',
    a: 'Your passphrase encrypts your Spending Key in this browser\'s local storage using Argon2id + ChaCha20-Poly1305 encryption. It never leaves your browser and is never sent to any server. It is only used to lock and unlock the wallet on this specific device.',
  },
  {
    q: 'What happens if I forget my passphrase?',
    a: 'If you have your Spending Key backed up, you can reset the wallet and import it again with a new passphrase. If you lost both your passphrase AND your Spending Key, your funds are permanently inaccessible. There is no recovery mechanism — this is by design for maximum security.',
  },
  {
    q: 'What is a shielded address (safu1...)?',
    a: 'Your shielded address encodes your viewing key and other public parameters into one convenient string. You share it with people who want to send you funds. They use it to encrypt a "note" that only you can decrypt and spend. It is completely safe to share publicly — it reveals nothing about your balance or transaction history.',
  },
  {
    q: 'How does privacy work?',
    a: 'When you deposit funds, they enter a shared "shielded pool" on the Stellar blockchain. When you send or withdraw, the app generates a Zero-Knowledge proof that mathematically proves you own the funds without revealing which specific deposit was yours. This breaks the on-chain link between sender and recipient. An observer can see that someone deposited and someone withdrew, but they cannot tell who sent what to whom.',
  },
  {
    q: 'Is this safe to use with real money?',
    a: 'Not yet. This is testnet software. The ZK circuits and smart contracts have not been formally audited. Do NOT use real funds until a formal audit is completed and announced. Note: Duelist uses UltraHonk (Barretenberg), which reuses one universal powers-of-tau setup across all circuits — there is no separate per-circuit trusted-setup ceremony (unlike Groth16 systems such as RAILGUN or Tornado).',
  },
  {
    q: 'What wallets are supported?',
    a: 'On desktop: Freighter, xBull, and LOBSTR (browser extensions), plus Albedo (web signer). On mobile: connect via WalletConnect to deep-link straight into your wallet app (LOBSTR, xBull), or use Albedo right in the browser — no extension needed. Any of these pay transaction fees and sign on-chain operations.',
  },
];

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '16px 0',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          cursor: 'pointer',
          color: 'var(--text)',
        }}
      >
        <span style={{ fontWeight: 400, fontSize: 14, lineHeight: 1.4 }}>{item.q}</span>
        <span style={{
          fontSize: 18,
          color: 'var(--muted)',
          transition: 'transform 0.2s ease',
          transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
          flexShrink: 0,
        }}>
          +
        </span>
      </button>
      {open && (
        <p style={{
          margin: '12px 0 0',
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.7,
        }}>
          {item.a}
        </p>
      )}
    </div>
  );
}

export function FAQPage() {
  return (
    <div>
      <div style={card} className={cardClass}>
        <h1 style={heading}>Frequently Asked Questions</h1>
        <p style={subHeading}>
          Everything you need to know about Duelist, shielded wallets, and privacy on Stellar.
        </p>
        <div>
          {faqs.map((item, i) => (
            <FAQAccordion key={i} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}
