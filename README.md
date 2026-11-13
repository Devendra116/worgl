# Wörgl (WORGL)

A NEAR **testnet** token where every balance melts at one fixed rate and the melt goes to a community treasury.
In 1932 the Austrian town of Wörgl issued stamp-scrip that lost value unless stamped; people spent it instead of hoarding it.
Wörgl rebuilds that on NEAR: 1,000,000 coins exist, ever. Holding costs you, spending does not, and what melts funds a shared pot.
The pot pays out through a one-time faucet claim and through payouts approved by a DAO council.
**This is a budget that expires, not an investment.** Built for the NEAR HACKATHON memecoin track. Testnet only; the coins have no value.

## Try it

Prerequisites: Rust (with the `wasm32-unknown-unknown` target), `cargo-near`, Python 3 with `matplotlib` and `numpy`, Node 18+ (for the web check), Docker only if your glibc is older than 2.39 (the sandbox `neard` binary needs it; the scripts detect this and use an `ubuntu:24.04` container). Install: `cargo install cargo-near --locked` (needs `libudev-dev` and `pkg-config` on Linux), `cargo install near-cli-rs --locked` for the deploy scripts.

1. Build and test everything locally: `scripts/test.sh` → prints `ALL TESTS PASSED` (about 6 minutes from a fresh clone, longer if `neard` and the Sputnik wasm must be downloaded). It runs the Python reference maths, 30 Rust unit and property tests (two 100,000-step fuzz tests), builds the wasm with cargo-near, runs two near-workspaces sandbox tests, and checks the web page's maths against the contract's test vectors.
2. Build only the wasm: `scripts/build.sh` → prints the wasm's sha256; the file is `contract/target/near/worgl_token.wasm`.
3. Regenerate the chart: `python3 sim/simulate.py` → writes `sim/simulation.png`.
4. Run the page locally: `cd web && python3 -m http.server 8000`, then open `http://localhost:8000/?token=<token-account>` → you see treasury, circulating and the day's allowance ticking. Connect a testnet wallet, press **Claim 100 WORGL** → your balance appears and starts melting.
5. Check a deployment without any keys: `scripts/verify-testnet.sh <token-account> [<holder> ...]` → `ALL CHECKS PASSED` after recomputing the index, supply conservation, the daily cap and each holder's balance from raw chain state, all pinned to one block.
6. Slow test (about 22 minutes): `scripts/test.sh --slow` additionally runs the sandbox test that crosses a UTC midnight to show the daily cap resets.

### Live testnet demo

Token: [`devworgl-token.testnet`](https://testnet.nearblocks.io/address/devworgl-token.testnet), governed by the Sputnik DAO `devworgl-dao.sputnikv2.testnet` (3-member council, 2 approvals). The page defaults to this token; use `?token=` for another.

### Deploy your own (you run these; nothing here sends a transaction unless you remove `DRY_RUN=1`)

Keys never go in the repo. `near` signs from your OS keychain; create or import accounts with `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create` or `near account import-account`.

1. `DRY_RUN=1 scripts/create-dao.sh <dao-name> <signer> <c1> <c2> <c3>` → prints the call to the `sputnikv2.testnet` factory (6 NEAR deposit, 2-of-3 policy). Run it without `DRY_RUN=1` to send it.
2. `DRY_RUN=1 scripts/deploy-testnet.sh <token-account> <dao-name>.sputnikv2.testnet` → prints the deploy-and-init call with the demo factor.
3. A registered account claims: `near contract call-function as-transaction <token> claim json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as <account> network-config testnet sign-with-keychain send`.
4. `DRY_RUN=1 scripts/propose-payout.sh <dao>.sputnikv2.testnet <token> <recipient> <coins> <member1> <member2>` → prints the `add_proposal` and the two `act_proposal` votes.

## How NEAR is used

- A Rust contract (near-sdk 5.30.1) implementing NEP-141 (fungible token), NEP-145 (storage management) and NEP-148 (metadata). Claims and payouts emit NEP-141 `ft_transfer` events from the contract account.
- Governance is a standard **Sputnik DAO v2** created from the testnet factory `sputnikv2.testnet`. The token does not run its own vote and makes **no cross-contract calls**; the DAO calls `pay_out` as a normal `FunctionCall` proposal.
- Wallet sign-in on the page uses `@hot-labs/near-connect`; all reads are plain RPC view calls.
- Testnet: token `devworgl-token.testnet`, DAO `devworgl-dao.sputnikv2.testnet`.

## The mechanic

Nothing is updated per second. Each account stores only **shares**. A global **index** falls with time, and a balance is computed whenever it is read:

```
index   = factor ^ (whole seconds since start)        (RAY = 10^27 fixed point, rounded DOWN at each step)
balance = floor(shares × index / RAY)
```

`factor` is the per-second decay factor, fixed at init. The treasury is the contract's own account, and its balance is whatever the holders do not have:

```
circulating = ceil(total_shares × index / RAY)
treasury    = 1,000,000 coins − circulating       (the contract panics if circulating > supply; it never clamps)
```

Rounding rules, always in the contract's favour:
- Balances round **down**; circulating rounds **up**; so treasury + circulating is exactly 1,000,000 coins at every moment.
- A transfer removes `ceil(amount × RAY / index)` shares from the sender and gives the receiver `floor(...)`. Rounding dust stays with the treasury. A full-balance transfer moves all of the sender's shares. Amount 0 is rejected.
- All products use 256-bit integers (`uint` crate); results are range-checked back into `u128`.
- Elapsed time uses `block_timestamp` with saturating subtraction; every state change is refused if the index has reached 0.

**Conservation test.** `contract/src/tests.rs` and `math.rs` run random claims, transfers, payouts and time jumps and check after steps that supply is conserved, no balance exceeds circulating, and rounding only ever moves value to the treasury. A pure-maths test checks the invariants after **every** one of 5,000 steps; two VM-level fuzz tests run 100,000 steps each (demo and real factor). A Python reference model (`sim/worgl_math.py`) generates 409 test vectors the Rust and the web JavaScript must reproduce exactly.

**Simulation.** `sim/simulation.png` runs 60 days, 100 wallets, three scenarios, at an **illustrative 1% per day** (the real setting is 1% per 30 days) with payouts of 0.5% of the treasury per day. At day 60: treasury 796,966, circulation 203,034, an idle holder's 100 coins are down to 54.72. Treasury and circulation are identical across scenarios because transfers cannot avoid the melt.

![Simulation](sim/simulation.png)

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| Total supply | 1,000,000 WORGL (18 decimals) | fixed; nothing is minted |
| Melt rate, demo | 1% per 600 s (factor `0.99^(1/600)`) | what the testnet deployment uses |
| Melt rate, real | 1% per 30 days (factor `0.99^(1/2592000)`) | the intended setting |
| Faucet | 100 WORGL, once per account | needs the storage deposit attached (about 0.00126 NEAR; excess refunded) |
| Daily cap | 10% of the treasury at the start of the UTC day | shared by faucet claims and payouts |
| Transfer | exactly 1 yoctoNEAR attached | NEP-141 |
| Governor | set once at init (a Sputnik DAO here) | can only call `pay_out` |
| DAO policy | 3 council members, 2 approvals, 0.1 NEAR proposal bond, 7-day period | set by `create-dao.sh`; lives in the DAO, not the token |

**Nothing can change these.** The contract has no setter for the factor, the cap, the faucet amount or the governor. The governor can call `pay_out` and nothing else: it cannot move, freeze or burn anyone's coins, cannot mint, and cannot change a parameter. The only limit on a payout is the 10% daily cap plus the DAO's own vote. (A deployment's code can still be replaced by whoever holds a full-access key on the token account; see Limitations.)

## Limitations

- **Demo rate vs real rate.** At the demo rate the index reaches 0 after about 43 days, and the share maths for large amounts overflows `u128` after about **28 days**, so the demo deployment is only meaningful for weeks. Past that point reads (balances, stats, index) keep working, while `claim`, `ft_transfer` and `pay_out` fail with `Index too small ...` and, once the index is 0, `Index is zero ...`. Leaving still works: `storage_unregister` is allowed at index 0, so nobody's storage deposit is trapped. At the real rate (1% a month) precision lasts **centuries**. The simulation chart uses an illustrative 1% per day.
- **Not sybil-resistant.** Accounts are free, so one person can create many accounts and claim the faucet many times (limited only by the daily cap). A council seat or a holder is just an account; a holder can vote, move coins and vote again. Treat the faucet and the DAO vote as a demo, not one-person-one-vote.
- **Payout control is the DAO policy.** The token only enforces the cap; there is no quorum inside the token. Two of three council members can pay out up to the day's remaining cap.
- **`ft_transfer_call` is not implemented**, so the token cannot be sent into contracts that need a callback (no cross-contract calls by design).
- **Full-access key.** At the time of writing, `devworgl-token.testnet` still holds one full-access key, so its owner could redeploy different code. `deploy-testnet.sh` prints (does not run) the irreversible command that deletes it; do that only for a deployment you are finished with.
- **Decay emits no events.** Balances change with the clock, not with a transaction, so explorers and wallets show a new balance only when they re-read it.
- **A force-unregister resets the `claimed` flag**, so that account could claim again (still limited by the daily cap).
- **Storage deposits** are held by the contract and refunded on unregister (cost plus 1 yocto), using plain transfers, not cross-contract calls.
- **Not audited.** Testnet only. Do not use with real funds.
- **Reproducibility.** The wasm in the scripts is built with `cargo near build non-reproducible-wasm`; the `reproducible_build` metadata in `contract/Cargo.toml` is not yet exercised and its `repository` URL points at `github.com/devendra116/worgl`, which must exist before a reproducible build can use it.
- **Sandbox tests on older Linux.** On glibc < 2.39 they need Docker. The midnight test takes about 22 minutes because the sandbox cannot jump time.

## Built during NEAR HACKATHON

Libraries and tools: `near-sdk` 5.30.1, `near-contract-standards` 5.30.1, `uint` 0.10, `rand` 0.8 (tests), `near-workspaces` 0.24.0 with `tokio`, `anyhow`, `serde_json`, `base64` (sandbox tests), `cargo-near` 0.23, `near-cli-rs` 0.31, near-sandbox `neard` 2.14.1, Sputnik DAO v2 (the wasm the testnet factory deploys), `@hot-labs/near-connect` 0.12.0 (page), Python with `matplotlib` and `numpy` (simulation).

**AI disclosure.** Claude Code (Anthropic's CLI agent) wrote essentially all the code, tests, scripts, web page and this README under direction from the project owner, who reviewed each phase and specified the design (the shares/index maths, security requirements and the DAO governor). The deployment commands were run by the owner; the AI did not deploy, push or submit anything. Nothing here is audited, so review before trusting it.

## License

MIT. See [LICENSE](LICENSE).
