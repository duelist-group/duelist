// sdk/src/crypto/__tests__/schnorr.test.ts
// schnorr sign + verify self-test over grumpkin.
// run with: npx tsx src/crypto/__tests__/schnorr.test.ts

import { signSchnorr, verifySchnorr, deriveGrumpkinPubkey, GRUMPKIN_ORDER } from '../schnorr.js';
import { fieldToBytes32 } from '../../utils/encoding.js';

// known test vector: sk=1, message=all-zeros
const TEST_SK = 1n;
const TEST_MSG = new Uint8Array(32);

async function testSignVerifyRoundtrip(sk: bigint, msg: Uint8Array, label: string) {
  const pk = await deriveGrumpkinPubkey(sk);
  const sig = await signSchnorr(sk, msg);

  // signature must be 64 bytes
  if (sig.length !== 64) throw new Error(`${label}: sig length ${sig.length} !== 64`);

  // self-verify
  const valid = await verifySchnorr(pk.x, pk.y, sig, msg);
  if (!valid) throw new Error(`${label}: self-verification FAILED`);

  // verify with wrong message should fail
  const wrongMsg = new Uint8Array(32);
  wrongMsg[0] = 0xff;
  const invalidCheck = await verifySchnorr(pk.x, pk.y, sig, wrongMsg);
  if (invalidCheck) throw new Error(`${label}: wrong-message check passed (should have failed)`);

  // verify with wrong key should fail
  const wrongPk = await deriveGrumpkinPubkey(sk + 1n < GRUMPKIN_ORDER ? sk + 1n : 1n);
  const wrongKeyCheck = await verifySchnorr(wrongPk.x, wrongPk.y, sig, msg);
  if (wrongKeyCheck) throw new Error(`${label}: wrong-key check passed (should have failed)`);

  console.log(`  ✓ ${label}`);
}

async function runTests() {
  console.log('Schnorr self-test over Grumpkin (Barretenberg WASM):');

  // test 1: minimal sk
  await testSignVerifyRoundtrip(1n, TEST_MSG, 'sk=1, msg=zeros');

  // test 2: larger sk
  await testSignVerifyRoundtrip(123456789n, new Uint8Array(32).fill(0xab), 'sk=123456789, msg=0xab*32');

  // test 3: sk near order boundary
  await testSignVerifyRoundtrip(GRUMPKIN_ORDER - 1n, fieldToBytes32(42n), 'sk=order-1, msg=42');

  // test 4: random-ish sk
  const randomSk = 0x1234567890abcdef1234567890abcdef1234567890abcdefn % (GRUMPKIN_ORDER - 1n) + 1n;
  await testSignVerifyRoundtrip(randomSk, fieldToBytes32(0xdeadbeefn), 'sk=random, msg=deadbeef');

  // test 5: message longer than 32 bytes
  const longMsg = new Uint8Array(100).fill(0x42);
  await testSignVerifyRoundtrip(7n, longMsg, 'sk=7, msg=100bytes');

  console.log('\nAll Schnorr self-tests passed.');
}

// run immediately
runTests();
