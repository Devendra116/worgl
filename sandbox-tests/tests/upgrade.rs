//! Upgrade safety: deploy the NEW wasm over the state of the OLD (already deployed) wasm, without calling
//! init, and check that nothing stored has changed. Only the new method appears.
//!
//! It needs the old wasm, which is not in the repository. Build it from the commit that is deployed, then:
//!   WORGL_OLD_WASM=/path/to/old/worgl_token.wasm cargo test --test upgrade -- --nocapture
//! Without WORGL_OLD_WASM the test prints a note and passes, so `scripts/test.sh` is not affected.

use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

const FACTOR_DEMO: &str = "999997208243937652252849536"; // 0.99^(1/3600): 1% per hour
const ONE_COIN: u128 = 1_000_000_000_000_000_000;

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}
fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn deploying_the_new_wasm_over_the_old_state_changes_nothing_but_adds_transfer_all() -> anyhow::Result<()> {
    let Ok(old_path) = std::env::var("WORGL_OLD_WASM") else {
        eprintln!("SKIPPED: set WORGL_OLD_WASM=<the deployed wasm> to run the upgrade test");
        return Ok(());
    };
    let new_path = std::env::var("WORGL_WASM")
        .unwrap_or_else(|_| format!("{}/../contract/target/near/worgl_token.wasm", env!("CARGO_MANIFEST_DIR")));
    let (old_wasm, new_wasm) = (read(&old_path), read(&new_path));
    assert_ne!(old_wasm, new_wasm, "the old and the new wasm must differ");

    let worker = near_workspaces::sandbox().await?;
    let token = worker.dev_deploy(&old_wasm).await?;
    let governor = worker.dev_create_account().await?;
    let (alice, bob) = (worker.dev_create_account().await?, worker.dev_create_account().await?);
    token.call("new").args_json(json!({"factor": FACTOR_DEMO, "governor": governor.id()})).transact().await?.into_result()?;
    let params: Value = token.view("get_params").await?.json()?;
    let cost = NearToken::from_yoctonear(u(&params["storage_cost"]));

    // build up real state with the OLD code: claims, a transfer, a governor payout (day_paid), some melt
    for who in [&alice, &bob] {
        who.call(token.id(), "claim").deposit(cost).gas(Gas::from_tgas(30)).transact().await?.into_result()?;
    }
    alice.call(token.id(), "ft_transfer").args_json(json!({"receiver_id": bob.id(), "amount": (30 * ONE_COIN).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    governor.call(token.id(), "pay_out").args_json(json!({"recipient": bob.id(), "amount": (5 * ONE_COIN).to_string(), "memo": "x"}))
        .transact().await?.into_result()?;
    worker.fast_forward(500).await?;

    // the old code does not have the method
    let old_try = alice.call(token.id(), "transfer_all").args_json(json!({"receiver_id": bob.id()}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(old_try.is_failure(), "the old wasm must not know transfer_all");

    let acct = |who: &near_workspaces::Account| {
        let (token, id) = (token.clone(), who.id().clone());
        async move { token.view("get_account").args_json(json!({"account_id": id})).await.unwrap().json::<Value>().unwrap() }
    };
    let state_before = token.view_state().await?;
    let params_before: Value = token.view("get_params").await?.json()?;
    let stats_before: Value = token.view("get_stats").await?.json()?;
    let (alice_before, bob_before) = (acct(&alice).await, acct(&bob).await);

    // deploy the NEW wasm to the same account, WITHOUT calling init
    token.as_account().deploy(&new_wasm).await?.into_result()?;

    let state_after = token.view_state().await?;
    assert_eq!(state_before, state_after, "the raw stored state is byte-for-byte identical ({} keys)", state_before.len());
    let params_after: Value = token.view("get_params").await?.json()?;
    assert_eq!(params_before, params_after, "get_params is identical");
    let stats_after: Value = token.view("get_stats").await?.json()?;
    for k in ["total_shares", "holders", "day", "day_start_treasury", "day_paid", "day_cap"] {
        assert_eq!(stats_before[k], stats_after[k], "get_stats.{k} is identical (time only moves treasury, circulating and index)");
    }
    assert_eq!(alice_before["shares"], acct(&alice).await["shares"]);
    assert_eq!(bob_before["shares"], acct(&bob).await["shares"]);
    assert_eq!(alice_before["claimed"], acct(&alice).await["claimed"]);

    // init cannot be run again over the existing state
    let again = token.call("new").args_json(json!({"factor": FACTOR_DEMO, "governor": alice.id()})).transact().await?;
    assert!(again.is_failure() && format!("{:?}", again.failures()).contains("already been initialized"));

    // the new method works on the old state
    let sa = u(&alice_before["shares"]);
    let sb = u(&bob_before["shares"]);
    let res = alice.call(token.id(), "transfer_all").args_json(json!({"receiver_id": bob.id()}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(30)).transact().await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(u(&acct(&alice).await["shares"]), 0);
    assert_eq!(u(&acct(&bob).await["shares"]), sa + sb);
    let stats_end: Value = token.view("get_stats").await?.json()?;
    assert_eq!(stats_end["total_shares"], stats_before["total_shares"]);
    println!("upgrade OK: {} raw state keys identical, get_params identical, transfer_all works on the old state", state_before.len());
    Ok(())
}
