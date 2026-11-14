//! Fixed-point maths. Every multiplication goes through 256-bit integers.
//! Mirrors `sim/worgl_math.py` exactly (rounding directions included).

use uint::construct_uint;

construct_uint! {
    /// 256-bit unsigned integer used for all intermediate products.
    pub struct U256(4);
}

/// Fixed-point scale: 10^27.
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
pub const DECIMALS: u8 = 18;
pub const ONE_COIN: u128 = 1_000_000_000_000_000_000;
pub const TOTAL_SUPPLY: u128 = 1_000_000 * ONE_COIN;

fn to_u128(x: U256) -> u128 {
    if x > U256::from(u128::MAX) {
        panic!("arithmetic overflow: result does not fit u128");
    }
    x.low_u128()
}

/// floor(a * b / c)
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> u128 {
    assert!(c != 0, "division by zero");
    to_u128(U256::from(a) * U256::from(b) / U256::from(c))
}

/// ceil(a * b / c)
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> u128 {
    assert!(c != 0, "division by zero");
    let prod = U256::from(a) * U256::from(b);
    let c = U256::from(c);
    let q = prod / c;
    let r = prod % c;
    to_u128(if r.is_zero() { q } else { q + U256::one() })
}

/// factor^n in RAY fixed point, exponentiation by squaring, rounding DOWN at every step.
/// `factor` must be <= RAY so every intermediate fits in u128.
pub fn rpow(factor: u128, mut n: u64) -> u128 {
    let mut result = RAY;
    let mut base = factor;
    while n > 0 {
        if n & 1 == 1 {
            result = mul_div_floor(result, base, RAY);
        }
        n >>= 1;
        if n > 0 {
            base = mul_div_floor(base, base, RAY);
        }
    }
    result
}

/// balance = floor(shares * index / RAY)
pub fn balance_of_shares(shares: u128, index: u128) -> u128 {
    mul_div_floor(shares, index, RAY)
}

/// circulating = ceil(total_shares * index / RAY)
pub fn circulating_of(total_shares: u128, index: u128) -> u128 {
    mul_div_ceil(total_shares, index, RAY)
}

/// Shown when the index has decayed so far that `amount` coins no longer fit in u128 shares
/// (about 177 days at the demo rate of 1% per hour; centuries at the real rate). Reads still work.
pub const TOO_DECAYED: &str =
    "Index too small: the token has decayed too far to represent this amount in shares";

/// shares for `amount` coins, rounded down (what a receiver gets)
pub fn shares_floor(amount: u128, index: u128) -> u128 {
    let q = U256::from(amount) * U256::from(RAY) / U256::from(index);
    if q > U256::from(u128::MAX) {
        panic!("{TOO_DECAYED}");
    }
    q.low_u128()
}

/// shares for `amount` coins, rounded up (what a sender loses)
pub fn shares_ceil(amount: u128, index: u128) -> u128 {
    let (prod, idx) = (U256::from(amount) * U256::from(RAY), U256::from(index));
    let q = prod / idx;
    let q = if (prod % idx).is_zero() { q } else { q + U256::one() };
    if q > U256::from(u128::MAX) {
        panic!("{TOO_DECAYED}");
    }
    q.low_u128()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpow_zero_is_ray() {
        assert_eq!(rpow(999_983_249_580_534_007_019_381_142, 0), RAY);
    }

    #[test]
    fn mul_div_no_overflow_on_big_products() {
        // u128::MAX * u128::MAX would overflow u128 badly; U256 handles it.
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    }

    #[test]
    #[should_panic(expected = "overflow")]
    fn mul_div_result_overflow_panics() {
        mul_div_floor(u128::MAX, 2, 1);
    }

    /// Pure-maths model of the contract (no VM context): ~5,000 random claims,
    /// transfers and treasury payouts with every invariant checked after EVERY step.
    #[test]
    fn pure_maths_model_invariants_every_step() {
        use rand::{rngs::StdRng, Rng, SeedableRng};
        const FACTOR: u128 = 999_997_208_243_937_652_252_849_536; // demo: 1% per hour
        const N: usize = 50;
        let mut rng = StdRng::seed_from_u64(7);
        let mut shares = [0u128; N];
        let mut claimed = [false; N];
        let mut total_shares = 0u128;
        let mut t = 0u64;
        let (mut claims, mut transfers, mut payouts) = (0, 0, 0);
        for step in 0..5_000 {
            t += rng.gen_range(0..=240); // up to 4 minutes a step: ~170 hours in total, about the same decay range as before
            let idx = rpow(FACTOR, t);
            assert!(idx > 0);
            let treasury = TOTAL_SUPPLY - circulating_of(total_shares, idx);
            match rng.gen_range(0..10) {
                0 => {
                    // claim 100 coins, once per account
                    let i = rng.gen_range(0..N);
                    if !claimed[i] && 100 * ONE_COIN <= treasury {
                        let g = shares_floor(100 * ONE_COIN, idx);
                        shares[i] += g;
                        total_shares += g;
                        claimed[i] = true;
                        claims += 1;
                    }
                }
                1 | 2 => {
                    // treasury payout of a random amount up to 1% of the treasury
                    let i = rng.gen_range(0..N);
                    let amt = rng.gen_range(1..=treasury / 100 + 1).min(treasury);
                    if amt > 0 {
                        let g = shares_floor(amt, idx);
                        shares[i] += g;
                        total_shares += g;
                        payouts += 1;
                    }
                }
                _ => {
                    let (i, j) = (rng.gen_range(0..N), rng.gen_range(0..N));
                    let bal = balance_of_shares(shares[i], idx);
                    if i != j && bal > 0 {
                        let amt = match rng.gen_range(0..4) {
                            0 => bal,
                            1 => rng.gen_range(1..=bal.min(1_000)),
                            _ => rng.gen_range(1..=bal),
                        };
                        let gain = shares_floor(amt, idx);
                        let loss = if amt == bal { shares[i] } else { shares_ceil(amt, idx) };
                        assert!(loss <= shares[i] && gain <= loss, "step {step}");
                        shares[i] -= loss;
                        shares[j] += gain;
                        total_shares -= loss - gain;
                        if amt == bal {
                            assert_eq!(balance_of_shares(shares[i], idx), 0, "step {step}");
                            assert_eq!(shares[i], 0);
                        }
                        transfers += 1;
                    }
                }
            }
            // ---- invariants after EVERY step ----
            let sum_shares: u128 = shares.iter().sum();
            assert_eq!(sum_shares, total_shares, "step {step}: total_shares drift");
            let sum_bal: u128 = shares.iter().map(|s| balance_of_shares(*s, idx)).sum();
            let circ = circulating_of(total_shares, idx);
            assert!(circ <= TOTAL_SUPPLY, "step {step}: circulating > supply");
            let treasury = TOTAL_SUPPLY - circ;
            assert!(sum_bal + treasury <= TOTAL_SUPPLY, "step {step}: over supply");
            let holders = shares.iter().filter(|s| **s > 0).count() as u128;
            assert!(
                TOTAL_SUPPLY - (sum_bal + treasury) <= holders + 1,
                "step {step}: gap too large"
            );
        }
        assert!(claims >= 40 && transfers > 1_000 && payouts > 500, "{claims} {transfers} {payouts}");
    }
}
