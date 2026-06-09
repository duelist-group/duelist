// sdk/src/scanner/merkletree.ts
// client-side poseidon2 merkle tree.
// used to: (1) compute the current pool root, (2) generate inclusion proofs.

import { poseidon2 } from '../crypto/poseidon.js';
import type { Field } from '../utils/types.js';

export const POOL_DEPTH = 32;

/** Pre-compute the zero subtree roots lazily (async). */
let zeroLeaves: Field[] | null = null;

async function getZeroLeaves(): Promise<Field[]> {
  if (zeroLeaves) return zeroLeaves;
  const arr: Field[] = [0n];
  for (let i = 1; i <= POOL_DEPTH; i++) {
    const prev = arr[i - 1]!;
    arr.push(await poseidon2([prev, prev]));
  }
  zeroLeaves = arr;
  return arr;
}

/**
 * Sparse Merkle tree of fixed depth. Stores only non-default subtree hashes
 * and recomputes the root on demand.
 */
export class IncrementalMerkleTree {
  private leaves: Field[] = [];
  private nodes: Map<string, Field> = new Map();

  constructor(public readonly depth: number = POOL_DEPTH) {}

  get size(): number {
    return this.leaves.length;
  }

  async getRoot(): Promise<Field> {
    return this.computeRoot();
  }

  insert(leaf: Field): number {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    return index;
  }

  /** Insert many leaves (used during initial sync). */
  insertBatch(leaves: Field[]) {
    for (const l of leaves) this.leaves.push(l);
  }

  private async computeRoot(): Promise<Field> {
    const zeros = await getZeroLeaves();
    let level: Field[] = [...this.leaves];
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const next: Field[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : zeros[lvl]!;
        next.push(await poseidon2([left, right]));
      }
      // pad to a single node if we ran out
      if (next.length === 0) {
        next.push(zeros[lvl + 1]!);
      }
      level = next;
    }
    return level[0] ?? zeros[this.depth]!;
  }

  /**
   * Generate the inclusion proof for the leaf at the given index.
   * Returns:
   *   path:    Field[depth] — the sibling at each level (leaf → root)
   *   indices: (0|1)[depth] — 0 if current is left, 1 if right
   */
  async getProof(leafIndex: number): Promise<{ path: Field[]; indices: (0 | 1)[] }> {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of range`);
    }
    const zeros = await getZeroLeaves();
    const path: Field[] = [];
    const indices: (0 | 1)[] = [];

    let level: Field[] = [...this.leaves];
    let idx = leafIndex;

    for (let lvl = 0; lvl < this.depth; lvl++) {
      const isRight = (idx & 1) === 1;
      indices.push(isRight ? 1 : 0);
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const sibling = siblingIdx < level.length ? level[siblingIdx]! : zeros[lvl]!;
      path.push(sibling);

      // compute next level
      const next: Field[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : zeros[lvl]!;
        next.push(await poseidon2([left, right]));
      }
      if (next.length === 0) next.push(zeros[lvl + 1]!);
      level = next;
      idx = idx >> 1;
    }

    return { path, indices };
  }

  /** Verify an inclusion proof. */
  static async verifyProof(
    leaf: Field,
    path: Field[],
    indices: (0 | 1)[],
    root: Field,
  ): Promise<boolean> {
    if (path.length !== indices.length) return false;
    let cur = leaf;
    for (let i = 0; i < path.length; i++) {
      const sibling = path[i]!;
      const idx = indices[i]!;
      cur = idx === 0 ? await poseidon2([cur, sibling]) : await poseidon2([sibling, cur]);
    }
    return cur === root;
  }
}
