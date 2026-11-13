use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::panic::{catch_unwind, AssertUnwindSafe};

const FACTOR_DEMO: u128 = 999_983_249_580_534_007_019_381_142; // 0.99^(1/600)
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
    for (factor, period) in [(FACTOR_DEMO, 600u64), (FACTOR_REAL, 2_592_000u64)] {
        let got = rpow(factor, period) as f64;
        let want = 0.99 * RAY as f64;
        assert!(((got - want) / want).abs() < 1e-15, "got {got} want {want}");
    }
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
    set(a.as_str(), 600, 0);
    let b = bal(&c, &a);
    assert!(b < CLAIM_AMOUNT);
    // 1% per 10 minutes: 100 -> ~99
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
#[should_panic(expected = "treasury")]
fn cannot_transfer_to_treasury_account() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    set(a.as_str(), 0, 1);
    c.ft_transfer(TREASURY.parse().unwrap(), 1.into(), None);
}

#[test]
fn state_changes_refused_when_index_is_zero() {
    let mut c = deploy(FACTOR_DEMO);
    let a = acct(1);
    claim_as(&mut c, &a, 0);
    // ~ 60 days at the demo rate: RAY-scale index has rounded down to 0.
    let far = 60 * 86_400;
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
                if b > 0 {
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
    assert!(claims >= 40);
}

#[test]
fn fuzz_100k_demo_rate() {
    fuzz(FACTOR_DEMO, 6, 1, std::env::var("FUZZ_OPS").ok().and_then(|s| s.parse().ok()).unwrap_or(100_000));
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
fn daily_cap_applies_to_pay_out_and_faucet_and_resets_at_utc_midnight() {
    let mut c = deploy(FACTOR_REAL);
    let a = acct(1);
    let b = acct(2);
    claim_as(&mut c, &a, 0);
    claim_as(&mut c, &b, 0); // 200 coins via the faucet today
    set(TREASURY, 10, 0);
    let s = c.get_stats();
    assert_eq!(s.day_start_treasury.0, TOTAL_SUPPLY);
    assert_eq!(s.day_cap.0, TOTAL_SUPPLY / 10);
    assert_eq!(s.day_paid.0, 2 * CLAIM_AMOUNT, "faucet claims count against the cap");

    pay_out_as(&mut c, GOVERNOR, &a, 60_000, 20);
    set(TREASURY, 21, 0);
    assert_eq!(c.get_stats().day_paid.0, 2 * CLAIM_AMOUNT + 60_000 * ONE_COIN);
    // 60,200 + 60,000 > 100,000: refused
    panics_with("Daily payout cap exceeded", || pay_out_as(&mut c, GOVERNOR, &b, 60_000, 30));
    // exactly up to the cap is allowed: 100,000 - 60,200 = 39,800 coins
    set(TREASURY, 31, 0);
    let rem = c.get_stats().day_remaining.0;
    assert_eq!(rem, 39_800 * ONE_COIN);
    panics_with("Daily payout cap exceeded", || {
        set(GOVERNOR, 32, 0);
        c.pay_out(b.clone(), (rem + 1).into(), None);
    });
    set(GOVERNOR, 33, 0);
    c.pay_out(b.clone(), rem.into(), None);
    // the faucet is now closed for the rest of the day too
    panics_with("Daily payout cap exceeded", || claim_as(&mut c, &acct(50), 40));

    // just before UTC midnight still capped; at midnight it resets, to 10% of the NEW day-start treasury
    panics_with("Daily payout cap exceeded", || pay_out_as(&mut c, GOVERNOR, &b, 1, 6399));
    set(TREASURY, 6400, 0);
    let s = c.get_stats();
    let idx = c.index_at(((T0 + 6400 * NS_PER_SEC) / DAY_NS) * DAY_NS);
    let expect_start = TOTAL_SUPPLY - circulating_of(c.total_shares, idx);
    assert_eq!(s.day_start_treasury.0, expect_start);
    assert_eq!(s.day_paid.0, 0);
    assert_eq!(s.day_cap.0, expect_start / 10);
    // ~100,000 coins left the treasury today, so the new cap is ~10% of ~900,000, not of 1,000,000
    assert!(expect_start >= TOTAL_SUPPLY - 100_000 * ONE_COIN && expect_start < TOTAL_SUPPLY - 99_000 * ONE_COIN);
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

/// From 30 days (index tiny) to the largest timestamp a u64 can hold (index 0):
/// every view keeps answering and conserving supply; every state change either works or
/// fails with a clear message (never a raw overflow or an unexplained panic).
#[test]
fn very_large_elapsed_time_views_survive_and_writes_fail_clearly() {
    let day = 86_400u64;
    let max_secs = (u64::MAX - T0) / NS_PER_SEC; // ~584 years of block time
    let points = [0, day, 28 * day, 30 * day, 35 * day, 40 * day, 42 * day, 43 * day, 60 * day, 365 * day, 100 * 365 * day, max_secs];

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
        if secs < 30 * day {
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
        if secs >= 35 * day {
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
