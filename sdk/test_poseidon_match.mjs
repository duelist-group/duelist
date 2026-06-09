import { poseidon2 } from './src/crypto/poseidon.js';
async function main() {
  const h1 = await poseidon2([1n, 2n]);
  console.log('poseidon2([1,2])  =', '0x' + h1.toString(16).padStart(64,'0'));

  const h2 = await poseidon2([0n, 0n]);
  console.log('poseidon2([0,0])  =', '0x' + h2.toString(16).padStart(64,'0'));

  const h3 = await poseidon2([1n, 2n, 100n, 1000n, 42n]);
  console.log('poseidon2([1,2,100,1000,42]) =', '0x' + h3.toString(16).padStart(64,'0'));
}
main().catch(e => { console.error(e); process.exit(1); });
