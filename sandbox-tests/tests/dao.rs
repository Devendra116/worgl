//! The real governance path in a local sandbox: a Sputnik DAO (the exact contract the testnet
//! factory deploys, see scripts/fetch-sputnik-wasm.sh) with a 3-member council and a policy that
//! needs 2 approvals is the token's `governor`. A FunctionCall proposal calls `pay_out`.
//! The JSON below is the same as in scripts/create-dao.sh and scripts/propose-payout.sh.

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const FACTOR_DEMO: &str = "999983249580534007019381142";
const ONE_COIN: u128 = 1_000_000_000_000_000_000;

fn read(env: &str, default_rel: &str) -> Vec<u8> {
    let path = std::env::var(env).unwrap_or_else(|_| format!("{}/{}", env!("CARGO_MANIFEST_DIR"), default_rel));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}. Run scripts/build.sh and scripts/fetch-sputnik-wasm.sh"))
}

fn policy(council: &[&Account]) -> Value {
    let ids: Vec<String> = council.iter().map(|a| a.id().to_string()).collect();
    json!({
        "roles": [{
            "name": "council",
            "kind": {"Group": ids},
            "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
            "vote_policy": {}
        }],
        // RoleWeight: every council member weighs 1, so threshold "2" = exactly two approvals.
        "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "2"},
        "proposal_bond": "100000000000000000000000",          // 0.1 NEAR
        "proposal_period": "604800000000000",                  // 7 days in ns
        "bounty_bond": "100000000000000000000000",
        "bounty_forgiveness_period": "86400000000000"
    })
}

async fn call(who: &Account, to: &near_workspaces::AccountId, method: &str, args: Value, deposit_yocto: u128) -> Result<(), String> {
    let r = who
        .call(to, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit_yocto))
        .gas(Gas::from_tgas(200))
        .transact()
        .await
        .map_err(|e| e.to_string())?;
    r.into_result().map(|_| ()).map_err(|e| format!("{e:?}"))
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn sputnik_dao_council_with_two_approvals_governs_pay_out() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let council: Vec<Account> = vec![
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
    ];
    let outsider = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;

    // DAO
    let dao = worker.dev_deploy(&read("SPUTNIK_WASM", "../.sandbox/sputnik/sputnikdao2-testnet.wasm")).await?;
    dao.call("new")
        .args_json(json!({
            "config": {"name": "worgl-dao", "purpose": "Governs WORGL treasury payouts", "metadata": ""},
            "policy": policy(&council.iter().collect::<Vec<_>>()),
        }))
        .transact().await?.into_result()?;

    // Token with the DAO as governor
    let token = worker.dev_deploy(&read("WORGL_WASM", "../contract/target/near/worgl_token.wasm")).await?;
    token.call("new").args_json(json!({"factor": FACTOR_DEMO, "governor": dao.id()})).transact().await?.into_result()?;
    let params: Value = token.view("get_params").await?.json()?;
    assert_eq!(params["governor"], json!(dao.id().to_string()));
    let storage_cost = u(&params["storage_cost"]);
    alice.call(token.id(), "claim").deposit(NearToken::from_yoctonear(storage_cost)).gas(Gas::from_tgas(30)).transact().await?.into_result()?;
    let bal = |who: &Account| {
        let token = token.clone();
        let id = who.id().clone();
        async move {
            let v: Value = token.view("ft_balance_of").args_json(json!({"account_id": id})).await.unwrap().json().unwrap();
            u(&v)
        }
    };
    let before = bal(&alice).await;

    // FunctionCall proposal: pay_out(alice, 500 coins)
    let pay_out_args = json!({"recipient": alice.id(), "amount": (500 * ONE_COIN).to_string(), "memo": "dao-proposal"});
    use base64::Engine as _;
    let args_b64 = base64::engine::general_purpose::STANDARD.encode(pay_out_args.to_string());
    let kind = json!({"FunctionCall": {
        "receiver_id": token.id(),
        "actions": [{"method_name": "pay_out", "args": args_b64, "deposit": "0", "gas": "30000000000000"}]
    }});
    let proposal = json!({"description": "WORGL payout: 500 coins to alice", "kind": kind});

    // a non-council member cannot even propose
    let e = call(&outsider, dao.id(), "add_proposal", json!({"proposal": proposal}), 100_000_000_000_000_000_000_000).await.unwrap_err();
    assert!(e.contains("ERR_PERMISSION_DENIED"), "{e}");
    // wrong bond is refused
    let e = call(&council[0], dao.id(), "add_proposal", json!({"proposal": proposal}), 1).await.unwrap_err();
    assert!(e.contains("ERR_MIN_BOND"), "{e}");
    // council proposes with the bond
    call(&council[0], dao.id(), "add_proposal", json!({"proposal": proposal}), 100_000_000_000_000_000_000_000).await.unwrap();
    let last: Value = dao.view("get_last_proposal_id").await?.json()?;
    let id = last.as_u64().unwrap() - 1; // get_last_proposal_id returns the NEXT id
    assert_eq!(id, 0);

    // one approval is not enough: nothing is paid
    let act = json!({"id": id, "action": "VoteApprove", "proposal": kind});
    call(&council[0], dao.id(), "act_proposal", act.clone(), 0).await.unwrap();
    assert_eq!(bal(&alice).await.abs_diff(before) < ONE_COIN / 10, true, "one approval must not pay");
    // the same member voting twice is refused
    assert!(call(&council[0], dao.id(), "act_proposal", act.clone(), 0).await.is_err());
    // an outsider cannot vote
    assert!(call(&outsider, dao.id(), "act_proposal", act.clone(), 0).await.is_err());

    // the second approval executes the proposal: DAO -> token.pay_out
    call(&council[1], dao.id(), "act_proposal", act.clone(), 0).await.unwrap();
    worker.fast_forward(5).await?; // let the cross-contract receipt settle
    let after = bal(&alice).await;
    let gained = after as f64 - before as f64;
    assert!((gained - 500.0 * ONE_COIN as f64).abs() < ONE_COIN as f64 / 10.0, "alice gained {gained}");
    let p: Value = dao.view("get_proposal").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(p["status"], json!("Approved"), "{p}");
    Ok(())
}
