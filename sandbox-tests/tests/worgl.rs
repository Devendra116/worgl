//! End-to-end tests against a local NEAR sandbox (near-workspaces).
//! Build the wasm first: `scripts/build.sh` (done for you by `scripts/test.sh`).
//! A plain account plays the governor; no DAO is involved here.

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const FACTOR_DEMO: &str = "999997208243937652252849536"; // 0.99^(1/3600): 1% per hour
const ONE_COIN: u128 = 1_000_000_000_000_000_000;
const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// ~0.298 s of block time per block in the sandbox, measured with fast_forward(1000).
const BLOCKS_PER_SEC: f64 = 3.5; // deliberately a little high: overshooting is harmless

fn wasm() -> Vec<u8> {
    let path = std::env::var("WORGL_WASM")
        .unwrap_or_else(|_| format!("{}/../contract/target/near/worgl_token.wasm", env!("CARGO_MANIFEST_DIR")));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}. Run scripts/build.sh first"))
}

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    token: Contract,
    governor: Account,
    alice: Account,
    bob: Account,
    mallory: Account,
    storage_cost: u128,
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let token = worker.dev_deploy(&wasm()).await?;
    let governor = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;
    token
        .call("new")
        .args_json(json!({"factor": FACTOR_DEMO, "governor": governor.id()}))
        .transact()
        .await?
        .into_result()?;
    let params: Value = token.view("get_params").await?.json()?;
    assert_eq!(params["governor"], json!(governor.id().to_string()));
    let storage_cost = u(&params["storage_cost"]);
    Ok(Env { worker, token, governor, alice, bob, mallory, storage_cost })
}

impl Env {
    async fn claim(&self, who: &Account) -> anyhow::Result<()> {
        who.call(self.token.id(), "claim")
            .deposit(NearToken::from_yoctonear(self.storage_cost))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }
    async fn transfer(&self, from: &Account, to: &Account, amount: u128) -> anyhow::Result<()> {
        from.call(self.token.id(), "ft_transfer")
            .args_json(json!({"receiver_id": to.id(), "amount": amount.to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }
    /// Ok(()) or the failure text.
    async fn pay_out(&self, caller: &Account, to: &Account, amount: u128) -> Result<(), String> {
        let r = caller
            .call(self.token.id(), "pay_out")
            .args_json(json!({"recipient": to.id(), "amount": amount.to_string(), "memo": "sandbox"}))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .map_err(|e| e.to_string())?;
        r.into_result().map(|_| ()).map_err(|e| format!("{e:?}"))
    }
    async fn bal(&self, who: &Account) -> u128 {
        let v: Value = self.token.view("ft_balance_of").args_json(json!({"account_id": who.id()})).await.unwrap().json().unwrap();
        u(&v)
    }
    async fn treasury(&self) -> u128 {
        let v: Value = self.token.view("ft_balance_of").args_json(json!({"account_id": self.token.id()})).await.unwrap().json().unwrap();
        u(&v)
    }
    async fn stats(&self) -> Value {
        self.token.view("get_stats").await.unwrap().json().unwrap()
    }
}

/// claim -> transfer -> time passes -> pay_out, plus access control on pay_out.
#[tokio::test]
async fn claim_transfer_time_passes_pay_out() -> anyhow::Result<()> {
    let e = setup().await?;

    // claim
    e.claim(&e.alice).await?;
    e.claim(&e.bob).await?;
    let near = |x: u128, coins: f64| (x as f64 - coins * ONE_COIN as f64).abs() < 0.05 * ONE_COIN as f64;
    assert!(near(e.bal(&e.bob).await, 100.0), "bob after claim");
    // a second claim is refused
    assert!(e.alice.call(e.token.id(), "claim").deposit(NearToken::from_yoctonear(e.storage_cost)).transact().await?.is_failure());

    // transfer 30 alice -> bob
    e.transfer(&e.alice, &e.bob, 30 * ONE_COIN).await?;
    assert!(near(e.bal(&e.alice).await, 70.0));
    assert!(near(e.bal(&e.bob).await, 130.0));
    // transfer without exactly 1 yocto is refused
    let r = e.alice.call(e.token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": e.bob.id(), "amount": "1"})).transact().await?;
    assert!(r.is_failure());

    // time passes: ~20 minutes of sandbox time (demo rate: ~2% decay)
    let alice_before = e.bal(&e.alice).await;
    let treasury_before = e.treasury().await;
    let t0 = e.stats().await["block_timestamp_ns"].as_u64().unwrap();
    e.worker.fast_forward(4_000).await?;
    let st = e.stats().await;
    let elapsed_s = (st["block_timestamp_ns"].as_u64().unwrap() - t0) as f64 / 1e9;
    assert!(elapsed_s > 600.0, "fast_forward must advance block_timestamp (advanced {elapsed_s}s)");
    let alice_after = e.bal(&e.alice).await;
    assert!(alice_after < alice_before, "an idle holder must have less after time passes");
    let treasury_after = e.treasury().await;
    assert!(treasury_after > treasury_before, "the treasury must have gained what decayed");
    // two holders lost (alice_before - alice_after) + (bob's share); treasury gained at least alice's loss
    assert!(treasury_after - treasury_before >= alice_before - alice_after);

    // pay_out by a non-governor fails (anyone: a holder, the recipient, a stranger)
    for who in [&e.alice, &e.bob, &e.mallory] {
        let err = e.pay_out(who, &e.bob, ONE_COIN).await.unwrap_err();
        assert!(err.contains("Only the governor"), "unexpected error: {err}");
    }
    // pay_out by the governor works
    let bob_before = e.bal(&e.bob).await;
    e.pay_out(&e.governor, &e.bob, 500 * ONE_COIN).await.expect("governor pay_out");
    let gained = e.bal(&e.bob).await as f64 - bob_before as f64;
    assert!((gained - 500.0 * ONE_COIN as f64).abs() < 0.05 * ONE_COIN as f64, "bob gained {gained}");
    // recipient must already be registered
    let err = e.pay_out(&e.governor, &e.mallory, ONE_COIN).await.unwrap_err();
    assert!(err.contains("not registered"), "unexpected error: {err}");
    Ok(())
}

/// The daily cap (faucet + pay_out, 10% of the treasury at the start of the UTC day)
/// holds, and resets across a UTC day boundary.
///
/// SLOW (~20 minutes: measured 22 min): the sandbox clock starts at wall-clock time and `fast_forward` costs
/// about 2ms per block (~0.3s of chain time each), so reaching the next UTC midnight can take
/// up to ~290k blocks. Run it with `scripts/test.sh --slow` (or `cargo test -- --ignored`).
/// The exact day-boundary arithmetic is also covered, instantly, by the unit test
/// `daily_cap_applies_to_pay_out_and_faucet_and_resets_at_utc_midnight` with a mocked clock.
#[tokio::test]
#[ignore = "slow: crosses a UTC midnight in the sandbox (~20 min)"]
async fn daily_cap_holds_and_resets_across_a_day_boundary() -> anyhow::Result<()> {
    let e = setup().await?;
    e.claim(&e.alice).await?;
    e.claim(&e.bob).await?;

    let st = e.stats().await;
    let day0 = st["day"].as_u64().unwrap();
    let cap0 = u(&st["day_cap"]);
    assert_eq!(cap0, u(&st["day_start_treasury"]) / 10);
    let remaining = u(&st["day_remaining"]);
    assert_eq!(u(&st["day_paid"]), 2 * 100 * ONE_COIN, "two faucet claims counted");

    // spend the whole allowance, then one base unit more is refused
    e.pay_out(&e.governor, &e.alice, remaining).await.expect("pay_out up to the cap");
    assert_eq!(u(&e.stats().await["day_remaining"]), 0);
    let err = e.pay_out(&e.governor, &e.alice, 1).await.unwrap_err();
    assert!(err.contains("Daily payout cap exceeded"), "unexpected error: {err}");
    // the faucet shares the same cap
    let carol = e.worker.dev_create_account().await?;
    let r = carol.call(e.token.id(), "claim").deposit(NearToken::from_yoctonear(e.storage_cost)).gas(Gas::from_tgas(30)).transact().await?;
    assert!(r.is_failure() && format!("{:?}", r.failures()).contains("Daily payout cap exceeded"));

    // cross the next UTC midnight (the day is read from the chain, not assumed)
    let now = e.stats().await["block_timestamp_ns"].as_u64().unwrap();
    let secs_to_midnight = (DAY_NS - now % DAY_NS) as f64 / 1e9;
    let blocks = (secs_to_midnight * BLOCKS_PER_SEC) as u64 + 2_000;
    e.worker.fast_forward(blocks).await?;

    let st = e.stats().await;
    assert!(st["day"].as_u64().unwrap() > day0, "a new UTC day must have started");
    assert_eq!(u(&st["day_paid"]), 0);
    let new_start = u(&st["day_start_treasury"]);
    assert_eq!(u(&st["day_cap"]), new_start / 10);
    // the allowance is 10% of the (smaller) treasury of the new day, not of the old one
    assert!(new_start < cap0 * 10, "treasury at the start of the new day is smaller");
    let remaining = u(&st["day_remaining"]);
    assert!(remaining > 0);
    e.pay_out(&e.governor, &e.bob, remaining).await.expect("cap reset after midnight");
    let err = e.pay_out(&e.governor, &e.bob, 1).await.unwrap_err();
    assert!(err.contains("Daily payout cap exceeded"), "unexpected error: {err}");
    Ok(())
}
