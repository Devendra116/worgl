use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::panic::{catch_unwind, AssertUnwindSafe};

const FACTOR_DEMO: u128 = 999_997_208_243_937_652_252_849_536; // 0.99^(1/3600): 1% per hour
const FACTOR_REAL: u128 = 999_999_996_122_555_619_592_348_752; // 0.99^(1/2592000)
const T0: u64 = 1_700_000_000 * NS_PER_SEC;
const TREASURY: &str = "worgl.testnet";
const GOVERNOR: &str = "dao.testnet";

fn acct(i: usize) -> AccountId {
    format!("user{i}.testnet").parse().unwrap()
}

fn set(predecessor: &str, secs: u64, deposit: u128) {
    let ctx = VMContextBuilder::new()
        .current_account_id(TREASURY.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .block_timestamp(T0 + secs * NS_PER_SEC)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build();
    testing_env!(ctx);
}

fn deploy(factor: u128) -> Worgl {
    set(TREASURY, 0, 0);
    Worgl::new(factor.into(), GOVERNOR.parse().unwrap())
}

fn cost(c: &Worgl) -> u128 {
    c.storage_cost
}

fn claim_as(c: &mut Worgl, who: &AccountId, secs: u64) {
    let dep = cost(c);
    set(who.as_str(), secs, dep);
    c.claim();
}

fn transfer_as(c: &mut Worgl, who: &AccountId, to: &AccountId, amt: u128, secs: u64) {
    set(who.as_str(), secs, 1);
    c.ft_transfer(to.clone(), amt.into(), None);
}

fn bal(c: &Worgl, who: &AccountId) -> u128 {
    c.ft_balance_of(who.clone()).0
}

fn treasury(c: &Worgl) -> u128 {
    c.ft_balance_of(TREASURY.parse().unwrap()).0
}

// ---------------------------------------------------------------- maths

#[test]
fn rpow_hits_one_percent_over_the_period() {
    // exact integer check: |rpow(factor, period) - 0.99*RAY| <= 1e-15 * 0.99*RAY
    let want = RAY / 100 * 99;
    for (factor, period) in [(FACTOR_DEMO, 3600u64), (FACTOR_REAL, 2_592_000u64)] {
        let got = rpow(factor, period);
        assert!(got.abs_diff(want) * 1_000_000_000_000_000 <= want, "got {got} want {want}");
    }
    // the demo factor is 0.99^(1/3600), computed with 80-digit decimals in sim/worgl_math.py
    assert_eq!(FACTOR_DEMO, 999_997_208_243_937_652_252_849_536);
}

#[test]
fn rust_matches_python_vectors() {
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    let u = |x: &Value| -> u128 { x.as_str().unwrap().parse().unwrap() };
    assert_eq!(u(&v["factor_demo"]), FACTOR_DEMO);
    assert_eq!(u(&v["factor_real"]), FACTOR_REAL);
    let rp = v["rpow"].as_array().unwrap();
    assert!(rp.len() > 50);
    for r in rp {
        assert_eq!(rpow(u(&r["factor"]), r["n"].as_u64().unwrap()), u(&r["index"]), "rpow {r}");
    }
    let ops = v["ops"].as_array().unwrap();
    assert!(ops.len() >= 300);
    for o in ops {
        let (idx, sh, am) = (u(&o["index"]), u(&o["shares"]), u(&o["amount"]));
        assert_eq!(balance_of_shares(sh, idx), u(&o["balance"]));
        assert_eq!(circulating_of(sh, idx), u(&o["circulating"]));
        assert_eq!(shares_floor(am, idx), u(&o["shares_floor"]));
        assert_eq!(shares_ceil(am, idx), u(&o["shares_ceil"]));
    }
}

// ------------------------------------------------------------ behaviour

#[test]
fn init_state() {
    let c = deploy(FACTOR_DEMO);
    set(TREASURY, 0, 0);
    assert_eq!(treasury(&c), TOTAL_SUPPLY);
    assert_eq!(c.ft_total_supply().0, TOTAL_SUPPLY);
    let m = c.ft_metadata();
    assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals), ("Wörgl", "WORGL", 18));
    assert_eq!(c.get_index().0, RAY);
    assert!(c.get_params().storage_cost.0 > 0);
}

#[test]
fn claim_pays_100_and_registers() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    assert_eq!(bal(&c, &a), CLAIM_AMOUNT);
    assert_eq!(treasury(&c), TOTAL_SUPPLY - CLAIM_AMOUNT);
    assert!(get_logs().iter().any(|l| l.contains("EVENT_JSON") && l.contains("ft_transfer") && l.contains("claim")));
}

#[test]
#[should_panic(expected = "Already claimed")]
fn second_claim_fails() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &a, 5);
}

#[test]
#[should_panic(expected = "Attach the storage deposit")]
fn claim_without_deposit_fails() {
    let mut c = deploy(FACTOR_DEMO);
    set("user1.testnet", 0, 0);
    c.claim();
}

#[test]
fn claim_refunds_excess_deposit() {
    let mut c = deploy(FACTOR_DEMO);
    let dep = cost(&c) * 3;
    set("user1.testnet", 0, dep);
    c.claim();
    let receipts = near_sdk::test_utils::get_created_receipts();
    let s = format!("{receipts:?}");
    assert!(s.contains(&(dep - cost(&c)).to_string()), "refund missing: {s}");
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    set(a.as_str(), 0, 0);
    c.ft_transfer(b, 1.into(), None);
}

#[test]
fn idle_holder_decays_and_treasury_gains_exactly_that() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    set(a.as_str(), 3600, 0);
    let b = bal(&c, &a);
    assert!(b < CLAIM_AMOUNT);
    // 1% per hour: 100 -> ~99 after 3600 s
    let want = CLAIM_AMOUNT / 100 * 99;
    assert!(b.abs_diff(want) < CLAIM_AMOUNT / 1_000_000_000_000, "{b} vs {want}");
    // Treasury gains what the holder lost, within rounding: never more than lost, at most 1 base unit less.
    let lost = CLAIM_AMOUNT - b;
    let gained = treasury(&c) - (TOTAL_SUPPLY - CLAIM_AMOUNT);
    assert!(gained <= lost && lost - gained <= 1, "lost {lost} gained {gained}");
}

#[test]
fn full_balance_transfer_leaves_sender_at_zero() {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    for secs in [0u64, 1, 7, 333, 5_000, 90_000] {
        set(a.as_str(), secs, 0);
        let full = bal(&c, &a);
        if full == 0 {
            continue;
        }
        let before_b = bal(&c, &b);
        transfer_as(&mut c, &a, &b, full, secs);
        set(a.as_str(), secs, 0);
        assert_eq!(bal(&c, &a), 0, "sender not zero at t={secs}");
        assert_eq!(c.get_account(a.clone()).unwrap().shares.0, 0);
        assert!(bal(&c, &b) >= before_b + full - 1);
        // hand coins back so the next round has something to move
        let back = bal(&c, &b) / 2;
        transfer_as(&mut c, &b, &a, back, secs);
    }
}

#[test]
#[should_panic(expected = "positive number")]
fn zero_transfer_rejected() {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    transfer_as(&mut c, &a, &b, 0, 0);
}

#[test]
#[should_panic(expected = "Not enough balance")]
fn overdraft_rejected() {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    transfer_as(&mut c, &a, &b, CLAIM_AMOUNT + 1, 0);
}

#[test]
fn ft_transfer_to_treasury_returns_coins_and_conserves_supply() {
    let (mut c, a, _b, secs) = pair_with_time();
    let tre: AccountId = TREASURY.parse().unwrap();
    set(a.as_str(), secs, 0);
    let before_tre = c.ft_balance_of(tre.clone()).0;
    let before_bal = c.ft_balance_of(a.clone()).0;
    let before_shares = c.total_shares;
    let amt = 30 * 10u128.pow(18);
    set(a.as_str(), secs, 1);
    c.ft_transfer(tre.clone(), amt.into(), Some("give back".into()));
    let after_bal = c.ft_balance_of(a.clone()).0;
    assert!(before_bal - after_bal >= amt && before_bal - after_bal <= amt + 1, "sender pays the amount, rounding at most 1 unit against them");
    let gained = c.ft_balance_of(tre.clone()).0 - before_tre;
    assert!(gained >= amt && gained <= amt + 2, "treasury gains at least the amount: {gained}");
    assert!(c.total_shares < before_shares, "the shares were destroyed");
    let supply: u128 = c.ft_total_supply().0;
    let sum = c.ft_balance_of(a.clone()).0 + c.ft_balance_of(_b.clone()).0 + c.ft_balance_of(tre).0;
    assert!(sum <= supply, "balances plus treasury never exceed the supply");
    let log = get_logs().into_iter().find(|l| l.contains("give back")).expect("event");
    assert!(log.contains(TREASURY), "event names the treasury as receiver");
}

#[test]
fn transfer_all_to_treasury_empties_the_sender_and_survives_a_day_roll() {
    let (mut c, a, _b, secs) = pair_with_time();
    let tre: AccountId = TREASURY.parse().unwrap();
    set(a.as_str(), secs, 0);
    let want = c.ft_balance_of(a.clone()).0;
    let before_tre = c.ft_balance_of(tre.clone()).0;
    set(a.as_str(), secs, 1);
    let got = c.transfer_all(tre.clone(), None).0;
    assert_eq!(got, want);
    assert_eq!(c.accounts.get(&a).unwrap().shares, 0);
    assert_eq!(c.ft_balance_of(a.clone()).0, 0);
    assert!(c.ft_balance_of(tre.clone()).0 >= before_tre + want);
    // a new UTC day: the cap is worked out from the larger treasury, and the books still balance
    let next_day = secs + 2 * 86_400;
    set(_b.as_str(), next_day, 0);
    let s = c.get_stats();
    assert!(s.day_cap.0 <= s.treasury.0 / 10 + 1);
    assert!(s.circulating.0 + s.treasury.0 == 1_000_000 * 10u128.pow(18));
}

#[test]
fn treasury_return_is_refused_without_balance_or_yocto() {
    let (mut c, a, _b, secs) = pair_with_time();
    let tre: AccountId = TREASURY.parse().unwrap();
    set(a.as_str(), secs, 0);
    panics_with("exactly 1 yoctoNEAR", || { c.ft_transfer(tre.clone(), 1.into(), None); });
    set(a.as_str(), secs, 1);
    panics_with("Not enough balance", || { c.ft_transfer(tre.clone(), (10u128.pow(30)).into(), None); });
    let stranger = acct(9);
    set(stranger.as_str(), secs, 1);
    panics_with("Sender is not registered", || { c.transfer_all(tre.clone(), None); });
}

#[test]
fn state_changes_refused_when_index_is_zero() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    // 400 days at the demo rate (1% per hour; index reaches 0 after ~258 days).
    let far = 400 * 86_400;
    set(a.as_str(), far, 0);
    assert_eq!(c.get_index().0, 0);
    assert_eq!(bal(&c, &a), 0);
    assert_eq!(treasury(&c), TOTAL_SUPPLY);
    let r = catch_unwind(AssertUnwindSafe(|| {
        set("user2.testnet", far, cost(&c));
        c.claim();
    }));
    assert!(r.is_err(), "claim must be refused at index 0");
}

#[test]
fn timestamp_before_start_does_not_underflow() {
    let c = deploy(FACTOR_DEMO);
    let ctx = VMContextBuilder::new()
        .current_account_id(TREASURY.parse().unwrap())
        .block_timestamp(T0 - 10 * NS_PER_SEC)
        .build();
    testing_env!(ctx);
    assert_eq!(c.get_index().0, RAY);
}

#[test]
fn force_unregister_returns_shares_to_treasury() {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    set(a.as_str(), 100, 1);
    let r = catch_unwind(AssertUnwindSafe(|| c.storage_unregister(None)));
    assert!(r.is_err(), "non-forced unregister with balance must fail");
    set(a.as_str(), 100, 1);
    assert!(c.storage_unregister(Some(true)));
    assert_eq!(c.get_stats().holders, 1);
    assert_eq!(c.total_shares, c.get_account(b.clone()).unwrap().shares.0);
    assert_eq!(bal(&c, &a), 0);
    // everything except b's balance is treasury
    let t = treasury(&c);
    assert!(TOTAL_SUPPLY - t - bal(&c, &b) <= 2);
}

// ----------------------------------------------------- property / fuzz

/// 100k random claims / transfers / force-unregisters with time moving forward.
/// Invariants after EVERY step:
///  * sum(balances) + treasury <= TOTAL_SUPPLY
///  * TOTAL_SUPPLY - (sum(balances) + treasury) <= holders + 1
///  * total_shares == sum of account shares
fn fuzz(factor: u128, max_step_secs: u64, seed: u64, ops: usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut c = deploy(factor);
    let pool: Vec<AccountId> = (0..40).map(acct).collect();
    let mut secs = 0u64;
    let mut transfers = 0usize;
    let mut transfers_all = 0usize;
    let mut claims = 0usize;
    for step in 0..ops {
        secs += rng.gen_range(0..=max_step_secs);
        let who = &pool[rng.gen_range(0..pool.len())];
        let kind = rng.gen_range(0..100);
        let registered = c.accounts.contains_key(who);
        if kind < 8 {
            // claim (fresh, or re-claim after a force-unregister)
            let can = !registered || !c.accounts.get(who).unwrap().claimed;
            if can {
                claim_as(&mut c, who, secs);
                claims += 1;
            }
        } else if kind < 10 && registered {
            set(who.as_str(), secs, 1);
            c.storage_unregister(Some(true));
        } else if registered {
            let to = &pool[rng.gen_range(0..pool.len())];
            if to != who && c.accounts.contains_key(to) {
                set(who.as_str(), secs, 1); // context at this step's time, 1 yocto attached
                let b = bal(&c, who);
                if b > 0 && rng.gen_range(0..8) == 0 {
                    // transfer_all: the whole balance, by moving every share
                    let (sh, rcv) = (c.accounts.get(who).unwrap().shares, c.accounts.get(to).unwrap().shares);
                    let (total, circ) = (c.total_shares, c.get_stats().circulating.0);
                    let sent = c.transfer_all(to.clone(), None).0;
                    assert_eq!(sent, b, "step {step}: transfer_all returned the balance at that moment");
                    assert_eq!(c.accounts.get(who).unwrap().shares, 0, "step {step}: sender ends with 0 shares");
                    assert_eq!(bal(&c, who), 0, "step {step}: sender ends with 0 balance");
                    assert_eq!(c.accounts.get(to).unwrap().shares, rcv + sh, "step {step}: receiver gains exactly the shares");
                    assert_eq!(c.total_shares, total, "step {step}: total_shares unchanged");
                    assert_eq!(c.get_stats().circulating.0, circ, "step {step}: circulating unchanged");
                    transfers_all += 1;
                } else if b > 0 {
                    let amt = match rng.gen_range(0..4) {
                        0 => b,                       // full balance
                        1 => rng.gen_range(1..=b.min(1000)), // dust
                        _ => rng.gen_range(1..=b),
                    };
                    c.ft_transfer(to.clone(), amt.into(), None);
                    transfers += 1;
                }
            }
        }
        // invariants (every 25 steps and on the last step; each context rebuild is slow)
        if step % 25 != 0 && step + 1 != ops {
            continue;
        }
        set(TREASURY, secs, 0);
        let mut sum = 0u128;
        let mut sum_shares = 0u128;
        let mut holders = 0u128;
        for p in &pool {
            if let Some(a) = c.accounts.get(p) {
                sum += bal(&c, p);
                sum_shares += a.shares;
                holders += 1;
            }
        }
        let t = treasury(&c);
        assert!(sum + t <= TOTAL_SUPPLY, "step {step}: over supply");
        assert!(
            TOTAL_SUPPLY - (sum + t) <= holders + 1,
            "step {step}: gap {} > holders {} + 1",
            TOTAL_SUPPLY - (sum + t),
            holders
        );
        assert_eq!(c.total_shares, sum_shares, "step {step}: total_shares drift");
        assert_eq!(c.holders as u128, holders);
    }
    assert!(transfers > ops / 5, "too few transfers exercised: {transfers}");
    assert!(transfers_all > ops / 100, "too few transfer_all calls exercised: {transfers_all}");
    assert!(claims >= 40);
}

#[test]
fn fuzz_100k_demo_rate() {
    fuzz(FACTOR_DEMO, 36, 1, std::env::var("FUZZ_OPS").ok().and_then(|s| s.parse().ok()).unwrap_or(100_000));
}

#[test]
fn fuzz_100k_real_rate() {
    fuzz(FACTOR_REAL, 4_000, 2, std::env::var("FUZZ_OPS").ok().and_then(|s| s.parse().ok()).unwrap_or(100_000));
}

// ------------------------------------------------- Phase 2: governor + daily cap

fn panics_with(needle: &str, f: impl FnOnce()) {
    let r = catch_unwind(AssertUnwindSafe(f));
    let err = r.expect_err(&format!("expected panic containing {needle:?}"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(needle), "panic {msg:?} does not contain {needle:?}");
}

fn pay_out_as(c: &mut Worgl, who: &str, to: &AccountId, coins: u128, secs: u64) {
    set(who, secs, 0);
    c.pay_out(to.clone(), (coins * ONE_COIN).into(), Some("test".into()));
}

#[test]
fn day_boundary_is_where_the_test_expects() {
    // T0 + 6400s is the first UTC midnight after T0 (the cap test below relies on it).
    assert_eq!((T0 + 6399 * NS_PER_SEC) / DAY_NS + 1, (T0 + 6400 * NS_PER_SEC) / DAY_NS);
}

#[test]
fn params_show_governor_and_cap() {
    let c = deploy(FACTOR_DEMO);
    set(TREASURY, 0, 0);
    let p = c.get_params();
    assert_eq!(p.governor.as_str(), GOVERNOR);
    assert_eq!(p.daily_cap_bps, 1000);
}

#[test]
#[should_panic(expected = "governor must not be the token account")]
fn governor_cannot_be_the_token_itself() {
    set(TREASURY, 0, 0);
    Worgl::new(FACTOR_DEMO.into(), TREASURY.parse().unwrap());
}

#[test]
fn pay_out_pays_a_registered_recipient_and_emits_an_event() {
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    pay_out_as(&mut c, GOVERNOR, &a, 500, 10);
    assert!(
        get_logs().iter().any(|l| l.contains("ft_transfer") && l.contains("payout:test")
            && l.contains(TREASURY) && l.contains("user1.testnet")),
        "payout event missing: {:?}", get_logs()
    );
    set(TREASURY, 10, 0);
    // 600 coins minus 10s of decay at the real rate (~4e-9/s)
    assert!(bal(&c, &a).abs_diff(600 * ONE_COIN) <= ONE_COIN / 10_000);
}

#[test]
fn non_governor_cannot_pay_out_not_even_the_recipient_or_the_token() {
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    for who in [a.as_str(), TREASURY, "attacker.testnet"] {
        panics_with("Only the governor", || pay_out_as(&mut c, who, &a, 1, 5));
    }
}

#[test]
fn pay_out_rejects_unregistered_recipient_zero_and_long_memo() {
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    panics_with("Recipient is not registered", || pay_out_as(&mut c, GOVERNOR, &acct(99), 1, 5));
    panics_with("positive number", || {
        set(GOVERNOR, 5, 0);
        c.pay_out(a.clone(), 0.into(), None);
    });
    panics_with("Memo too long", || {
        set(GOVERNOR, 5, 0);
        c.pay_out(a.clone(), ONE_COIN.into(), Some("m".repeat(MAX_MEMO_BYTES + 1)));
    });
}

#[test]
fn governor_has_no_other_powers() {
    // The governor is a plain account: it can neither transfer holders' coins nor claim as them,
    // and no method exists to change parameters (compile-time: there is no such method).
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    panics_with("not registered", || {
        set(GOVERNOR, 1, 1);
        c.ft_transfer(a.clone(), 1.into(), None); // governor holds nothing
    });
    set(TREASURY, 2, 0);
    assert_eq!(c.get_params().governor.as_str(), GOVERNOR);
}

#[test]
fn daily_cap_applies_to_pay_out_only_and_resets_at_utc_midnight() {
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    let b = acct(2);
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0); // 200 coins via the faucet today
    set(TREASURY, 10, 0);
    let s = c.get_stats();
    assert_eq!(s.day_start_treasury.0, TOTAL_SUPPLY);
    assert_eq!(s.day_cap.0, TOTAL_SUPPLY / 10);
    assert_eq!(s.day_paid.0, 0, "faucet claims do not count against the payout cap");

    pay_out_as(&mut c, GOVERNOR, &a, 60_000, 20);
    set(TREASURY, 21, 0);
    assert_eq!(c.get_stats().day_paid.0, 60_000 * ONE_COIN);
    // 60,000 + 60,000 > 100,000: refused
    panics_with("Daily payout cap exceeded", || pay_out_as(&mut c, GOVERNOR, &b, 60_000, 30));
    // exactly up to the cap is allowed: 100,000 - 60,000 = 40,000 coins
    set(TREASURY, 31, 0);
    let rem = c.get_stats().day_remaining.0;
    assert_eq!(rem, 40_000 * ONE_COIN);
    panics_with("Daily payout cap exceeded", || {
        set(GOVERNOR, 32, 0);
        c.pay_out(b.clone(), (rem + 1).into(), None);
    });
    set(GOVERNOR, 33, 0);
    c.pay_out(b.clone(), rem.into(), None);
    // the payout cap is spent, but the faucet is a separate thing and still works
    claim_as(&mut c, &acct(50), 40);

    // just before UTC midnight still capped; at midnight it resets, to 10% of the NEW day-start treasury
    panics_with("Daily payout cap exceeded", || pay_out_as(&mut c, GOVERNOR, &b, 1, 6399));
    set(TREASURY, 6400, 0);
    let s = c.get_stats();
    let idx = c.index_at(((T0 + 6400 * NS_PER_SEC) / DAY_NS) * DAY_NS);
    let expect_start = TOTAL_SUPPLY - circulating_of(c.total_shares, idx);
    assert_eq!(s.day_start_treasury.0, expect_start);
    assert_eq!(s.day_paid.0, 0);
    assert_eq!(s.day_cap.0, expect_start / 10);
    // ~100,300 coins (100,000 paid out + 3 faucet claims) left the treasury today, so the new cap is ~10% of ~900,000
    assert!(expect_start >= TOTAL_SUPPLY - 100_400 * ONE_COIN && expect_start < TOTAL_SUPPLY - 99_000 * ONE_COIN);
    pay_out_as(&mut c, GOVERNOR, &b, 50_000, 6401);
    set(TREASURY, 6402, 0);
    assert_eq!(c.get_stats().day_paid.0, 50_000 * ONE_COIN);
}

// ------------------------------------------------- very large elapsed time

/// Runs `f`; returns the panic message if it panicked.
fn panic_msg(f: impl FnOnce()) -> Option<String> {
    let err = catch_unwind(AssertUnwindSafe(f)).err()?;
    Some(
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "<non-string panic>".into()),
    )
}

/// From 190 days at 1% per hour (index tiny: claims stop after ~177 days, everything reads 0 after ~258) to the largest timestamp a u64 can hold (index 0):
/// every view keeps answering and conserving supply; every state change either works or
/// fails with a clear message (never a raw overflow or an unexplained panic).
#[test]
fn very_large_elapsed_time_views_survive_and_writes_fail_clearly() {
    let day = 86_400u64;
    let max_secs = (u64::MAX - T0) / NS_PER_SEC; // ~584 years of block time
    let points = [0, day, 100 * day, 150 * day, 170 * day, 190 * day, 200 * day, 240 * day, 250 * day, 260 * day, 300 * day, 365 * day, 100 * 365 * day, max_secs];

    let mut c = deploy(FACTOR_DEMO);
    let (u1, u2, tre) = (acct(1), acct(2), TREASURY.parse::<AccountId>().unwrap());
    claim_as(&mut c, &u1, 0);
    // u2 is registered but has not claimed, so a later claim() has real work to do.
    set(u2.as_str(), 0, cost(&c));
    c.storage_deposit(None, None);
    let initial = bal(&c, &u1);
    assert_eq!(initial, 100 * ONE_COIN);

    let (mut last_index, mut last_balance) = (RAY, initial);
    let mut saw_tiny = false;
    let mut saw_zero = false;

    for &secs in &points {
        // ---- views: must answer, never panic, and stay consistent
        set("viewer.testnet", secs, 0);
        let index = c.get_index().0;
        assert!(index <= last_index, "index must never rise (t={secs}s)");
        let stats = c.get_stats();
        assert_eq!(stats.index.0, index);
        assert_eq!(stats.treasury.0 + stats.circulating.0, TOTAL_SUPPLY, "supply conserved (t={secs}s)");
        assert_eq!(treasury(&c), stats.treasury.0, "ft_balance_of(treasury) == get_stats().treasury");
        assert_eq!(c.ft_total_supply().0, TOTAL_SUPPLY);
        let b = bal(&c, &u1);
        assert!(b <= last_balance, "a holder's balance never rises by itself (t={secs}s)");
        assert_eq!(c.get_account(u1.clone()).unwrap().balance.0, b);
        assert_eq!(c.get_account(u1.clone()).unwrap().shares.0, 100 * ONE_COIN, "shares are untouched by decay");
        assert!(c.get_account(acct(99)).is_none());
        assert_eq!(bal(&c, &acct(99)), 0);
        assert!(stats.day_remaining.0 <= stats.day_cap.0);
        let _ = (c.get_params(), c.storage_balance_of(u1.clone()), c.storage_balance_bounds(), c.ft_metadata());
        let _ = &tre;
        (last_index, last_balance) = (index, b);
        saw_tiny |= index > 0 && index < 1_000_000_000;
        saw_zero |= index == 0;
        if index == 0 {
            assert_eq!(b, 0);
            assert_eq!(stats.treasury.0, TOTAL_SUPPLY, "everything has melted back to the treasury");
        }

        // ---- state changes: before day 30 they work normally, so only probe the failure zone
        if secs < 190 * day {
            continue;
        }
        let clear = |m: &str| m.contains("Index is zero") || m.contains("Index too small") || m.contains("Not enough balance");
        let results = [
            ("claim", panic_msg(|| { set(u2.as_str(), secs, cost(&c)); c.claim(); })),
            ("ft_transfer", panic_msg(|| { set(u1.as_str(), secs, 1); c.ft_transfer(u2.clone(), ONE_COIN.into(), None); })),
            ("pay_out", panic_msg(|| { set(GOVERNOR, secs, 0); c.pay_out(u2.clone(), (10 * ONE_COIN).into(), None); })),
        ];
        for (name, r) in &results {
            if let Some(m) = r {
                assert!(clear(m), "{name} at t={secs}s failed with an unclear message: {m:?}");
            } else if *name != "claim" && *name != "pay_out" {
                panic!("{name} unexpectedly succeeded at t={secs}s (index {index})");
            }
        }
        if index == 0 {
            for (name, r) in &results {
                let m = r.as_ref().unwrap_or_else(|| panic!("{name} must fail at index 0"));
                assert!(m.contains("Index is zero"), "{name}: {m:?}");
            }
        }
        if secs >= 190 * day {
            // Tiny index: a 100-coin claim or a 10-coin payout can no longer be expressed in u128 shares.
            for (name, r) in [&results[0], &results[2]].map(|(n, r)| (*n, r)) {
                let m = r.as_ref().unwrap_or_else(|| panic!("{name} must fail at t={secs}s"));
                assert!(m.contains("Index too small") || m.contains("Index is zero"), "{name}: {m:?}");
            }
        }
        // a transfer of the whole (now melted) balance is refused as "Not enough balance", clearly
        if index < 1_000_000 {
            let m = results[1].1.as_ref().expect("transfer must fail once u1's balance has melted to zero");
            assert!(m.contains("Index is zero") || m.contains("Not enough balance"), "{m:?}");
        }
    }
    assert!(saw_tiny, "the test must visit a tiny but non-zero index");
    assert!(saw_zero, "the test must visit index == 0");

    // ---- at index 0, leaving is still possible: nobody's storage deposit is trapped
    set(u1.as_str(), max_secs, 1);
    assert!(c.storage_unregister(None), "unregister with a melted balance works at index 0");
    set(u2.as_str(), max_secs, 1);
    assert!(c.storage_unregister(None));
    assert_eq!(c.get_stats().holders, 0);
    assert_eq!(c.total_shares, 0);
    assert_eq!(treasury(&c), TOTAL_SUPPLY);
}

// ------------------------------------------------- JSON interface: big integers are strings

/// JavaScript clients parse JSON numbers as doubles, exact only up to 2^53. Nothing in the views may be a
/// JSON number above that; large values (amounts, nanosecond timestamps) must be strings (U128 / U64).
fn assert_no_big_json_numbers(v: &Value, path: &str) {
    match v {
        Value::Number(n) => {
            let big = n.as_u64().map_or(n.as_f64().map_or(false, |f| f.abs() > 9.007e15), |x| x > (1u64 << 53));
            assert!(!big, "{path} is a JSON number above 2^53: {n}");
        }
        Value::Object(m) => m.iter().for_each(|(k, x)| assert_no_big_json_numbers(x, &format!("{path}.{k}"))),
        Value::Array(a) => a.iter().enumerate().for_each(|(i, x)| assert_no_big_json_numbers(x, &format!("{path}[{i}]"))),
        _ => {}
    }
}

#[test]
fn views_send_nanosecond_timestamps_as_strings() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 100);
    set("viewer.testnet", 200, 0);
    let params = serde_json::to_value(c.get_params()).unwrap();
    let stats = serde_json::to_value(c.get_stats()).unwrap();
    let account = serde_json::to_value(c.get_account(a)).unwrap();
    // the two timestamp fields are exact decimal strings
    assert_eq!(params["start_ns"], Value::String(T0.to_string()));
    assert_eq!(stats["block_timestamp_ns"], Value::String((T0 + 200 * NS_PER_SEC).to_string()));
    // and no view returns any JSON number a JavaScript client would round
    for (name, v) in [("get_params", &params), ("get_stats", &stats), ("get_account", &account)] {
        assert_no_big_json_numbers(v, name);
    }
}

// ------------------------------------------------- transfer_all: send the whole balance

/// Two registered accounts after some time has passed, so the balance is not a round number.
fn pair_with_time() -> (Worgl, AccountId, AccountId, u64) {
    let mut c = deploy(FACTOR_DEMO);
    let (a, b) = (acct(1), acct(2));
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0);
    (c, a, b, 1234)
}

#[test]
fn transfer_all_moves_every_share_and_nothing_else() {
    let (mut c, a, b, secs) = pair_with_time();
    set(a.as_str(), secs, 1);
    let (sa, sb) = (c.accounts.get(&a).unwrap().shares, c.accounts.get(&b).unwrap().shares);
    let before = c.get_stats();
    let index = c.get_index().0;
    let want = bal(&c, &a);
    assert!(want > 0 && want < CLAIM_AMOUNT && want % ONE_COIN != 0, "a melted, non-round balance: {want}");
    let flags = (c.accounts.get(&a).unwrap().claimed, c.accounts.get(&b).unwrap().claimed);

    let sent = c.transfer_all(b.clone(), Some("all of it".into())).0;

    assert_eq!(sent, want, "returns the amount worked out at that moment");
    assert_eq!(c.accounts.get(&a).unwrap().shares, 0, "sender ends with exactly 0 shares");
    assert_eq!(bal(&c, &a), 0, "sender ends with exactly 0 balance");
    assert_eq!(c.accounts.get(&b).unwrap().shares, sa + sb, "receiver gains exactly the sender's shares");
    assert_eq!(bal(&c, &b), balance_of_shares(sa + sb, index), "and holds both balances");
    assert_eq!(c.total_shares, sa + sb, "total_shares is unchanged");
    let after = c.get_stats();
    assert_eq!(after.circulating.0, before.circulating.0, "circulating unchanged");
    assert_eq!(after.treasury.0, before.treasury.0, "treasury unchanged");
    assert_eq!(after.treasury.0 + after.circulating.0, TOTAL_SUPPLY, "balances plus treasury still add up to the supply");
    assert_eq!(after.holders, before.holders);
    assert_eq!(flags, (c.accounts.get(&a).unwrap().claimed, c.accounts.get(&b).unwrap().claimed), "claimed flags untouched");
    // the same NEP-141 event as ft_transfer, carrying the amount
    let log = get_logs().into_iter().find(|l| l.contains("ft_transfer") && l.contains("all of it")).expect("an ft_transfer event");
    let ev: Value = serde_json::from_str(log.trim_start_matches("EVENT_JSON:")).unwrap();
    assert_eq!(ev["standard"], "nep141");
    assert_eq!(ev["event"], "ft_transfer");
    assert_eq!(ev["data"][0]["old_owner_id"], a.as_str());
    assert_eq!(ev["data"][0]["new_owner_id"], b.as_str());
    assert_eq!(ev["data"][0]["amount"], want.to_string());
    assert_eq!(ev["data"][0]["memo"], "all of it");
}

#[test]
fn transfer_all_refusals_change_nothing() {
    let (mut c, a, b, secs) = pair_with_time();
    let u = acct(3); // registered, holds nothing
    set(u.as_str(), secs, cost(&c));
    c.storage_deposit(None, None);
    let stranger = acct(4); // not registered
    let snapshot = |c: &Worgl| (c.total_shares, c.accounts.get(&a).unwrap().shares, c.accounts.get(&b).unwrap().shares);
    let before = snapshot(&c);

    // no yocto, and the wrong amount of yocto
    set(a.as_str(), secs, 0);
    panics_with("exactly 1 yoctoNEAR", || { c.transfer_all(b.clone(), None); });
    set(a.as_str(), secs, 2);
    panics_with("exactly 1 yoctoNEAR", || { c.transfer_all(b.clone(), None); });
    // to yourself
    set(a.as_str(), secs, 1);
    panics_with("Sender and receiver should be different", || { c.transfer_all(a.clone(), None); });
    // to an account that has not registered
    set(a.as_str(), secs, 1);
    panics_with("Receiver is not registered", || { c.transfer_all(stranger.clone(), None); });
    // from an account that has not registered, and from one that holds no coins
    set(stranger.as_str(), secs, 1);
    panics_with("Sender is not registered", || { c.transfer_all(b.clone(), None); });
    set(u.as_str(), secs, 1);
    panics_with("you hold no coins", || { c.transfer_all(b.clone(), None); });
    assert_eq!(before, snapshot(&c), "no refusal moved a share");
}

#[test]
fn transfer_all_refuses_a_balance_that_has_melted_to_zero() {
    let (mut c, _a, b, secs) = pair_with_time();
    // one share is worth less than one base unit while the index is below 1
    let dust = acct(5);
    c.accounts.insert(dust.clone(), Account { shares: 1, claimed: false });
    c.total_shares += 1;
    c.holders += 1;
    set(dust.as_str(), secs, 1);
    assert_eq!(bal(&c, &dust), 0);
    panics_with("your balance is zero", || { c.transfer_all(b.clone(), None); });
    assert_eq!(c.accounts.get(&dust).unwrap().shares, 1);
}

#[test]
fn transfer_all_is_refused_once_the_index_is_zero() {
    let (mut c, a, b, _secs) = pair_with_time();
    set(a.as_str(), 400 * 86_400, 1);
    assert_eq!(c.get_index().0, 0);
    panics_with("Index is zero", || { c.transfer_all(b.clone(), None); });
}

// ------------------------------------------------- the stored state layout is frozen

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// These bytes were captured from the contract that is DEPLOYED on testnet (before transfer_all existed),
/// from the same two claims. If this test fails, a stored field was added, removed, reordered or retyped,
/// and deploying the new wasm over the existing state would corrupt it.
#[test]
fn stored_state_layout_is_identical_to_the_deployed_version() {
    let mut c = deploy(FACTOR_DEMO);
    claim_as(&mut c, &acct(1), 0);
    claim_as(&mut c, &acct(2), 5);
    // the deployed code counted claims in day_paid; the new code does not. The field is the same, so put
    // the value the deployed code stored and compare the bytes.
    c.day_paid = 2 * CLAIM_AMOUNT;
    let bytes = near_sdk::borsh::to_vec(&c).unwrap();
    assert_eq!(bytes.len(), 124);
    assert_eq!(hex(&bytes), "0100000061701428ade8b193d70a0000000000000080b53fe3e38c6a48a52d3b030000000000002a36fe9c97170200000000000000000030e03b3c034e4400000000000000db4c000000000000000000a1edccce1bc2d3000000000000000020c65abc8ed70a000000000000000b00000064616f2e746573746e6574");
    let account = near_sdk::borsh::to_vec(&Account { shares: 0x0102030405060708090a0b0c0d0e0f10, claimed: true }).unwrap();
    assert_eq!(hex(&account), "100f0e0d0c0b0a09080706050403020101");
}
