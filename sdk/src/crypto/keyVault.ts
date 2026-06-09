// sdk/src/crypto/keyvault.ts
// encrypted spending-key vault using argon2id + chacha20-poly1305.
// the vault stores the spending key encrypted under a user-chosen passphrase.
// key derivation: argon2id(passphrase, salt, time=3, mem=64mb, parallelism=1) → 32-byte key
// encryption: chacha20-poly1305(derived_key, random_nonce, spending_key_bytes)
// storage format (json):
// { version: 1, salt: hex, nonce: hex, ciphertext: hex }
// security note:
// argon2id is memory-hard, resisting gpu/asic brute-force on the passphrase.
// the salt is randomly generated per vault and stored alongside the ciphertext.
// the nonce is randomly generated per encryption.
// if the user loses the passphrase and their backup spending key, funds are gone.
// this replaces plaintext localstorage storage from v1.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { fieldToBytes32, bytes32ToField } from '../utils/encoding.js';
import type { Field } from '../utils/types.js';

const VAULT_VERSION = 1;
const ARGON2_TIME_COST = 3;
const ARGON2_MEM_COST = 65536;  // 64 MB
const ARGON2_PARALLELISM = 1;
const SALT_LENGTH = 32;
const NONCE_LENGTH = 12;

export interface VaultData {
  version: number;
  salt: string;    // hex
  nonce: string;   // hex
  ciphertext: string; // hex
}

/**
 * Encrypt a spending key with a passphrase and return storable vault data.
 */
export function encryptSpendingKey(
  spendingKey: Field,
  passphrase: string,
): VaultData {
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);

  const derived = argon2id(
    new TextEncoder().encode(passphrase),
    salt,
    {
      t: ARGON2_TIME_COST,
      m: ARGON2_MEM_COST,
      p: ARGON2_PARALLELISM,
      dkLen: 32,
    },
  );

  const plaintext = fieldToBytes32(spendingKey);
  const cipher = chacha20poly1305(derived, nonce);
  const ct = cipher.encrypt(plaintext);

  return {
    version: VAULT_VERSION,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ct),
  };
}

/**
 * Decrypt a spending key from vault data using the passphrase.
 * Returns null if the passphrase is wrong (MAC check fails).
 */
export function decryptSpendingKey(
  vault: VaultData,
  passphrase: string,
): Field | null {
  if (vault.version !== VAULT_VERSION) {
    throw new Error(`Unsupported vault version: ${vault.version}`);
  }

  const salt = hexToBytes(vault.salt);
  const nonce = hexToBytes(vault.nonce);
  const ct = hexToBytes(vault.ciphertext);

  const derived = argon2id(
    new TextEncoder().encode(passphrase),
    salt,
    {
      t: ARGON2_TIME_COST,
      m: ARGON2_MEM_COST,
      p: ARGON2_PARALLELISM,
      dkLen: 32,
    },
  );

  try {
    const cipher = chacha20poly1305(derived, nonce);
    const plaintext = cipher.decrypt(ct);
    return bytes32ToField(plaintext);
  } catch {
    return null;  // Wrong passphrase → MAC failure
  }
}

/**
 * Save vault to browser localStorage.
 */
export function saveVault(storageKey: string, vault: VaultData): void {
  localStorage.setItem(storageKey, JSON.stringify(vault));
}

/**
 * Load vault from browser localStorage.
 */
export function loadVault(storageKey: string): VaultData | null {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === 'number' && typeof parsed.salt === 'string' && typeof parsed.nonce === 'string' && typeof parsed.ciphertext === 'string') {
      return parsed as VaultData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clear vault from browser localStorage.
 */
export function clearVault(storageKey: string): void {
  localStorage.removeItem(storageKey);
}
