// poseidon2.nr - local poseidon2 sponge hash wrapper.
// the stdlib poseidon2 struct is pub(crate) and not accessible from external
// packages. we re-implement the same sponge construction here, using the
// public `std::hash::poseidon2_permutation` primitive.
// this produces byte-identical outputs to std::hash::poseidon2::poseidon2::hash().

global RATE: u32 = 3;

pub fn hash<let N: u32>(input: [Field; N], message_size: u32) -> Field {
    hash_internal(input, message_size, message_size != N)
}

fn hash_internal<let N: u32>(
    input: [Field; N],
    in_len: u32,
    is_variable_length: bool,
) -> Field {
    let two_pow_64: Field = 18446744073709551616;
    let iv: Field = (in_len as Field) * two_pow_64;

    // sponge state: [s0, s1, s2, s3] with s3 = iv (capacity)
    let mut state: [Field; 4] = [0, 0, 0, iv];
    let mut cache: [Field; 3] = [0; 3];
    let mut cache_size: u32 = 0;

    // absorb
    for i in 0..N {
        if i < in_len {
            if cache_size == RATE {
                // perform duplex: add cache into state, then permute
                for j in 0..RATE {
                    state[j] += cache[j];
                }
                state = std::hash::poseidon2_permutation(state, 4);
                cache = [0; 3];
                cache[0] = input[i];
                cache_size = 1;
            } else {
                cache[cache_size] = input[i];
                cache_size += 1;
            }
        }
    }

    // variable-length padding
    if is_variable_length {
        if cache_size == RATE {
            for j in 0..RATE {
                state[j] += cache[j];
            }
            state = std::hash::poseidon2_permutation(state, 4);
            cache = [0; 3];
            cache[0] = 1;
            cache_size = 1;
        } else {
            cache[cache_size] = 1;
            cache_size += 1;
        }
    }

    // squeeze: final duplex
    for j in 0..RATE {
        if j < cache_size {
            state[j] += cache[j];
        }
    }
    state = std::hash::poseidon2_permutation(state, 4);

    state[0]
}
