// merkle.nr
// poseidon2-based merkle inclusion proofs (depth-32 binary tree).
// leaves are note commitments. internal node = poseidon2([left, right]).
// indices[i] = 0 -> current node is left child at level i,
// indices[i] = 1 -> current node is right child.

use crate::poseidon2;

/// verify a merkle inclusion proof: leaf in tree(root).
pub fn verify_merkle_inclusion<let DEPTH: u32>(
    leaf: Field,
    path: [Field; DEPTH],
    indices: [bool; DEPTH],
    root: Field,
) {
    let computed = compute_merkle_root(leaf, path, indices);
    assert(computed == root, "Merkle inclusion: root mismatch");
}

/// reconstruct the integer leaf index from the authentication-path direction
/// bits. `indices[i]` is the position bit at level `i`, least-significant first
/// (`indices[0]` = leaf level), matching how the indexer and worker number
/// leaves: leaf_index = sum(indices[i] * 2^i).
/// binding the nullifiers index to this value is what prevents a prover from
/// deriving multiple distinct nullifiers for a single note (double-spend).
pub fn index_from_path<let DEPTH: u32>(indices: [bool; DEPTH]) -> Field {
    let mut index: Field = 0;
    let mut pow: Field = 1;
    for i in 0..DEPTH {
        index += (indices[i] as Field) * pow;
        pow *= 2;
    }
    index
}

/// compute the merkle root from a leaf and its authentication path.
pub fn compute_merkle_root<let DEPTH: u32>(
    leaf: Field,
    path: [Field; DEPTH],
    indices: [bool; DEPTH],
) -> Field {
    let mut current = leaf;
    for i in 0..DEPTH {
        let sibling = path[i];
        let index_field = indices[i] as Field;
        let left  = current + index_field * (sibling - current);
        let right = sibling + index_field * (current - sibling);
        current = poseidon2::hash([left, right], 2);
    }
    current
}
