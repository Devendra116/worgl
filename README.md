<div align="center">

<img src="assets/logo.svg" width="112" alt="Wörgl logo: a banknote rosette inside a double rule, with a carmine ring that has a gap in it">

# Wörgl

**Money with a shelf life.**

A memecoin on NEAR where every balance melts on a fixed schedule,<br>
and the melt funds a treasury that a DAO pays out again.

[![NEAR testnet](https://img.shields.io/badge/NEAR-testnet-16202C?style=flat-square)](https://testnet.nearblocks.io/address/worgl-token.testnet)
[![NEAR HACKATHON](https://img.shields.io/badge/NEAR%20HACKATHON-memecoins%20track-B0243A?style=flat-square)](https://nearhackathon.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-2F6A35?style=flat-square)](LICENSE)

[Token on NearBlocks](https://testnet.nearblocks.io/address/worgl-token.testnet) ·
[DAO on NearBlocks](https://testnet.nearblocks.io/address/devworgl-dao.sputnikv2.testnet) ·
[Source](https://github.com/Devendra116/worgl) ·
[@devendra_116](https://x.com/devendra_116)

<!-- Add the hosted website here once it is published: [Website](https://...) -->

<img src="assets/screenshot-home.png" width="860" alt="The Wörgl home page: a headline, and a live window with a banknote that melts in real time next to the live pot, the coins in people's hands and the in-browser checks">

</div>

---

## Contents

[At a glance](#at-a-glance) · [The idea](#the-idea-in-30-seconds) · [Try it](#try-it) · [How it works](#how-it-works) · [Parameters](#parameters) · [Who can do what](#who-can-do-what) · [Contract interface](#contract-interface) · [Repository map](#repository-map) · [Testing](#testing-and-verification) · [Deploy your own](#deploy-your-own) · [Limits](#limits-and-honest-notes) · [Hackathon](#built-at-near-hackathon) · [License](#license)

---

## At a glance

| | |
|---|---|
| **What it is** | A **tokenomics proposal with a working reference implementation** on NEAR **testnet**: a fixed supply whose balances lose a fixed percentage on a schedule, with the melt flowing to a treasury that a governor pays out again under a hard daily limit. |
| **Name / symbol** | Wörgl / `WORGL`, 18 decimals |
| **Supply** | 1,000,000 coins. Fixed. Nothing is ever minted. |
| **Melt rate** | Demo: **1% per hour** (so you can watch it). Intended real setting: **1% per month**. Chosen once at deployment, never changeable. |
| **Token contract** | [`worgl-token.testnet`](https://testnet.nearblocks.io/address/worgl-token.testnet), Rust, `near-sdk` 5.30.1 |
| **Governor** | Any account chosen at deployment, normally a DAO of your choice with **any approval rule**. It can call exactly one method, `pay_out`. The demo deployment uses the Sputnik DAO [`devworgl-dao.sputnikv2.testnet`](https://testnet.nearblocks.io/address/devworgl-dao.sputnikv2.testnet) purely as an example; the token does not care how the governor decides. |
| **Payout limit** | At most **10% of the treasury per UTC day**, enforced by the contract. |
| **Standards** | NEP-141 core (`ft_transfer`, `ft_balance_of`, `ft_total_supply`), NEP-145 storage management, NEP-148 metadata. No `ft_transfer_call`, by design. |
| **Verified by** | 39 Rust unit and property tests (two 100,000-step fuzz tests), sandbox tests on a local NEAR node (including an example Sputnik DAO governing `pay_out`, and an upgrade test over the deployed wasm), 47 web checks, and a keyless on-chain verifier. |
| **Website** | A six-page [Astro](https://astro.build) static site in [`web/`](web/) with a live note, a no-wallet simulation, wallet claim and send, and in-browser checks. |
| **Track** | NEAR HACKATHON, **memecoins**. Testnet only; the coins have no value. |

---

## The idea in 30 seconds

In 1932 the Austrian town of **Wörgl**, about 4,200 people in the Great Depression, issued local notes that lost 1% of their value every month unless a stamp was bought. Holding a note cost money, so people spent it. The experiment was ended in 1933 because only the national bank could issue money.

Wörgl rebuilds that loop as a token on NEAR, with no stamps: the melt happens by itself, every second, and the contract does the sums.

```mermaid
flowchart LR
    T[("Town pot<br/>the treasury")] -- "payouts<br/>(and a test faucet on testnet)" --> P(("People"))
    P -- "spend and trade" --> P
    P -- "melt: 1% on a fixed schedule" --> T
    D["Governor<br/>any DAO, any approval rule"] -. "pay_out, capped at 10% a day" .-> T
```

- **A fixed pot of 1,000,000 coins** starts in the treasury.
- **Holding costs a little**, so coins are made to be used.
- **What melts is not burned.** It returns to the treasury, which the DAO can pay out again.
- **The governor decides who gets paid. The contract decides how much can be paid.** The governor can be any DAO, with any approval rule.

### The proposal in four rules

1. **Fixed supply.** 1,000,000 coins exist from the start, all in the treasury. Nothing is ever minted.
2. **One melt rate.** Every balance loses the same percentage on the same schedule. What melts returns to the treasury.
3. **One way out.** The treasury pays out only through `pay_out`, which only the governor can call.
4. **A hard daily limit.** Payouts are capped at 10% of the treasury per UTC day, whoever the governor is.

Who the governor is, how it votes and what it funds are left to whoever deploys it. Any DAO, with any number of approvals, can work on top of this token.

> *A budget that expires, not an investment.* Two natural uses: grant money that returns to the pot if unspent, and community or event credits that fade afterwards.

---

## Try it

### 1. See it in the browser (needs only Node 18+)

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:4321/>. You see a banknote whose value counts down in real time, the live pot and the coins in people's hands, and four checks that your browser recomputes from the contract. The **Try it** page walks through claim, send and skip-ahead, either as a simulation (no wallet) or with your own testnet wallet.

### 2. Check the live token, no keys needed (needs Python 3)

```bash
scripts/verify-testnet.sh worgl-token.testnet
```

You see `ALL CHECKS PASSED` after the script recomputes the melt index, the conservation of supply, the daily cap and any holder's balance from raw chain state, all pinned to one block.

### 3. Run every test (about 6 minutes)

```bash
scripts/test.sh
```

You see `ALL TESTS PASSED`. It runs the Python reference maths, the 39 Rust tests, builds the wasm with `cargo-near`, runs the sandbox tests and checks the website's maths against the contract's test vectors. It needs Rust with the `wasm32-unknown-unknown` target, `cargo-near`, Python 3 with `matplotlib` and `numpy`, and Node. Docker is needed only if your glibc is older than 2.39 (the scripts detect this and run the sandbox node in an `ubuntu:24.04` container).

### 4. Build the website for hosting

```bash
cd web && npm run build      # plain files in web/dist/
```

On Vercel, Netlify or Cloudflare Pages: root directory `web`, build command `npm run build`, output directory `dist`. For a sub-path host such as a GitHub Pages project site, set `base` in `web/astro.config.mjs`. Point the site at your own token by setting `TOKEN_ID` in `web/src/scripts/config.js`, or open any page with `?token=<account>`.

---

## How it works

### Nothing updates every second

The contract stores only **shares** per account. One global **index** falls with time. A balance is worked out whenever somebody reads it:

```text
index       = factor ^ (whole seconds since start)      fixed point, RAY = 10^27, rounded down at every step
balance     = floor(shares × index ÷ RAY)
circulating = ceil(total_shares × index ÷ RAY)           what people hold, rounded up
treasury    = 1,000,000 coins − circulating              the contract's own account holds the rest
```

`factor` is the per-second melt factor, set once at deployment. Because the index depends only on the clock, there is nothing to run, nothing to keep in sync and no way for two calls in the same second to disagree.

### Rounding always favours the treasury

- Balances round **down** and the total in circulation rounds **up**, so `treasury + circulating` is exactly 1,000,000 coins at every moment.
- A transfer takes `ceil(amount × RAY ÷ index)` shares from the sender and gives the receiver `floor(…)`. The leftover dust stays with the treasury. Sending your whole balance moves all of your shares.
- **`transfer_all` moves every share**, so nothing is rounded and nothing is left behind (see below). Every other product uses **256-bit integers** and is range-checked back into `u128`. Overflow checks are on in the release build.
- Time uses `block_timestamp`, never block height. Claims, transfers and payouts are refused once the index reaches zero; leaving the token still works.

### How it was checked

- **Conservation:** two 100,000-step fuzz tests (demo and real factor) and a pure-maths model run random claims, transfers, payouts and time jumps and check the invariants. The pure-maths test checks them after every one of 5,000 steps.
- **Three implementations of the same algorithm agree.** A Python reference model, the Rust contract and the website's JavaScript match on 409 shared test vectors, and the JavaScript matches the live contract at the same block.
- **Against exact decimals.** The integer index was compared with exact 100-digit decimal values of `0.99^(t/period)`: it is never above the exact value, never rises with time, and its worst relative error is about 9e-16 over the first 115 days at the demo rate.

### Simulation

[`sim/simulate.py`](sim/simulate.py) runs 60 days with 100 wallets, using the contract's integer maths at an **illustrative 1% per day**. The treasury falls only because the DAO pays coins out (0.5% of the pot a day); the melt returns coins to it more slowly than they go out. With no payouts nothing would leave the treasury and treasury plus holdings would stay at exactly 1,000,000.

![Simulation: 60 days, 100 wallets](sim/simulation.png)

---

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| Total supply | 1,000,000 WORGL | Fixed. No mint. |
| Demo melt rate | 1% per hour | Factor `0.99^(1/3600)` = `999997208243937652252849536`. |
| Real melt rate | 1% per month (30 days) | Factor `0.99^(1/2592000)` = `999999996122555619592348752`. |
| Daily payout limit | 10% of the treasury at the start of the UTC day | Applies to DAO payouts only. The test faucet is separate and does not use it. |
| Test faucet | 100 WORGL, once per account | Testnet only. The caller pays a storage deposit of about 0.00126 NEAR; any excess is refunded. |
| Transfers | exactly 1 yoctoNEAR attached | NEP-141 convention; keeps function-call keys out. |
| Pay-out memo | at most 140 bytes | |
| Governor's own rules | Not part of the token | Any DAO or account can govern: any number of approvals, any voting period. The demo's example DAO ([`scripts/create-dao.sh`](scripts/create-dao.sh)) has 3 members, 2 approvals, a 0.1 NEAR proposal bond and a 7-day period. |

**Nothing can change these.** The contract has no setter for the factor, the limit, the faucet or the governor.

**How long a deployed copy runs.** The share maths needs `amount × 10^27 ÷ index` to fit in `u128`, so a copy has a finite life that follows from its melt rate. At 1% per hour: every amount up to the whole supply is accurate for about **4.5 months** (138 days), 100-coin claims keep working until about 5.8 months (177 days), and every balance reads zero from about 8.5 months (258 days). At 1% per month this lasts for centuries. Reads always keep working; the website works the dates out from the contract's own factor and start time.

---

## Who can do what

| Who | Can | Cannot |
|---|---|---|
| **Any account** | Read everything. Claim the test faucet once. Send coins it owns (1 yoctoNEAR attached), or send its whole balance with `transfer_all`. Register and unregister for storage. | Mint, or touch anyone else's coins. |
| **The governor** (the DAO) | Call `pay_out(recipient, amount, memo)` to a registered account, within the daily limit. | Change any parameter, move, freeze or burn anyone's coins, or mint. |
| **The governor's own process** (a DAO, any approval rule) | Decide who is paid and how much, however it votes. | Exceed the 10% daily limit: the contract enforces it whatever the governor decides. |
| **Whoever holds the token account's key** | Replace the contract code while a full-access key exists. | Nothing, once the full-access keys are deleted. See [Limits](#limits-and-honest-notes). |

The contract has **no admin, upgrade or mint method**, makes **no cross-contract calls** (only plain NEAR transfers for deposit refunds), and has one storage collection, so no prefix can collide.

---

## Contract interface

| Method | Who | What it does |
|---|---|---|
| `new(factor, governor)` | once, at deployment | Sets the melt factor and the governor. Deployed and initialised in one transaction. |
| `get_params()` | view | Name, supply, factor, start time, claim amount, storage cost, daily limit, governor. |
| `get_index()` | view | The current melt index. |
| `get_stats()` | view | Treasury, circulating, total shares, index, holders, and today's limit, paid and remaining. |
| `get_account(account_id)` | view | One account's shares, balance and whether it has claimed. |
| `ft_balance_of`, `ft_total_supply`, `ft_metadata` | view | NEP-141 and NEP-148. The contract's own account id reports the treasury. |
| `ft_transfer(receiver_id, amount, memo)` | account owner | Send coins; requires exactly 1 yoctoNEAR; the receiver must be registered. Sending to the contract's own account returns the coins to the treasury: the sender's shares are destroyed, so the treasury grows by that amount (rounding favours the treasury). Today's daily cap is not raised until the next UTC day. |
| `transfer_all(receiver_id, memo)` | account owner | Send the **whole** balance and return the amount sent. Requires exactly 1 yoctoNEAR. Because a balance melts every second, no typed amount can be exact; this moves every share instead, so the sender ends at exactly 0 and no dust is created. The receiver must be registered and must not be the sender, unless it is the contract itself: sending to the contract returns the coins to the treasury (see `ft_transfer`). It emits the same `ft_transfer` event, with the amount worked out at that moment. |
| `claim()` | account owner | Test faucet, 100 coins once per account; attaches the storage deposit for a new account. |
| `pay_out(recipient, amount, memo)` | governor only | Pay from the treasury to a registered account, within the daily limit. |
| `storage_deposit`, `storage_balance_of`, `storage_balance_bounds`, `storage_withdraw`, `storage_unregister` | NEP-145 | Registration and leaving. Leaving with `force` returns any balance to the treasury. |

Nanosecond timestamps (`start_ns`, `block_timestamp_ns`) are returned as strings so JavaScript clients do not round them.

---

## Repository map

```text
contract/          The token contract (crate `worgl-token`)
  src/lib.rs         Contract: claim, transfer, pay_out, storage, daily limit
  src/math.rs        256-bit fixed-point maths: rpow, balance, shares, rounding
  src/tests.rs       Unit, property and fuzz tests
  tests/vectors.json 409 shared test vectors generated by the Python reference
sandbox-tests/     near-workspaces tests on a local NEAR node
  tests/worgl.rs     Token flow, governor rules, daily limit across UTC midnight (slow)
  tests/dao.rs       An example Sputnik DAO (3 members, 2 approvals) governs pay_out
scripts/           Everything you run, with DRY_RUN=1 to print instead of send
  build.sh test.sh   Build the wasm; run every test
  create-dao.sh      Create an example Sputnik DAO to use as the governor
  deploy-testnet.sh  Deploy and initialise the token with the demo factor
  propose-payout.sh  Propose a payout through the DAO and vote
  verify-testnet.sh  Keyless on-chain check of a deployed token
sim/               Python reference maths, vector generator, 60-day simulation
web/               The Astro website (six pages, no backend)
  src/pages/         Home, the idea, try it, the numbers, the maths, FAQ
  src/scripts/       Live reads, wallet actions, the note, the simulation, the checks
  test.mjs           Web checks against the contract's vectors and the live token
assets/            Logo and screenshots used by this README
```

---

## Testing and verification

| Layer | What | How many |
|---|---|---|
| Rust unit and property tests | Maths, claims, transfers, returning coins to the treasury, `transfer_all` (success, every refusal, fuzzed), payouts, daily limit, index-zero behaviour, JSON interface, and the stored-state layout (compared byte for byte with the deployed contract) | 39 |
| Fuzz tests | Random operations and time jumps, invariants checked throughout | 2 × 100,000 steps |
| Sandbox tests (local NEAR node) | Token flow, governor-only payouts, registering a new recipient and paying them in one transaction, `transfer_all` on a real node, an example Sputnik DAO governing `pay_out` | 4 (+1 slow) |
| Upgrade test (optional) | Deploys the previously deployed wasm, builds state, deploys the new wasm over it with no init, and checks the raw stored state is byte-for-byte identical: `WORGL_OLD_WASM=<old wasm> cargo test --test upgrade` in `sandbox-tests/` | 1 |
| Slow sandbox test | The daily limit holds and resets across a UTC midnight | about 22 minutes, `scripts/test.sh --slow` |
| Web checks | JavaScript maths, amount and timestamp handling, the simulation, wallet-error wording, the amount a transfer reports | 47 |
| Wallet flow in a browser | A fake wallet connects, and the Claim button, its deposit and its messages are checked in headless Chrome: `npm run test:ui` (optional; needs Chrome and `npm run build`) | 5 (11 with `CLAIMED_ACCOUNT=<account>`) |
| On-chain verifier | Recomputes a deployed token's numbers from raw chain state | `scripts/verify-testnet.sh` |

The deployed wasm's code hash on testnet matches a fresh `scripts/build.sh` of this repository.

---

## Deploy your own

You run these. Nothing sends a transaction unless you remove `DRY_RUN=1`. Keys never go in the repository: `near` signs from your OS keychain.

```bash
export TOKEN=my-worgl.testnet        # a NEW account for the token
export DAO=my-dao                    # becomes my-dao.sputnikv2.testnet

# 1. Create the accounts (keys are saved to your keychain; keep the seed phrases)
near account create-account sponsor-by-faucet-service $TOKEN \
  autogenerate-new-keypair save-to-keychain network-config testnet create

# 2. Create a governor. Any DAO or account works; this script makes an example Sputnik DAO
#    (a council of three accounts, two approvals needed). Skip it if you already have a governor.
DRY_RUN=1 scripts/create-dao.sh $DAO <signer>.testnet <c1>.testnet <c2>.testnet <c3>.testnet
scripts/create-dao.sh            $DAO <signer>.testnet <c1>.testnet <c2>.testnet <c3>.testnet

# 3. Build, then deploy and initialise the token in one transaction
scripts/build.sh
scripts/deploy-testnet.sh $TOKEN $DAO.sputnikv2.testnet

# 4. Check it, then try a claim and a payout
scripts/verify-testnet.sh $TOKEN
near contract call-function as-transaction $TOKEN claim json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as <account>.testnet network-config testnet sign-with-keychain send
scripts/propose-payout.sh $DAO.sputnikv2.testnet $TOKEN <recipient>.testnet 10 <member1>.testnet <member2>.testnet
```

`deploy-testnet.sh` also prints, but never runs, the irreversible command that deletes the account's full-access key.

---

## Limits and honest notes

- **Testnet and a demo.** The coins have no value. The code has not been audited.
- **The demo runs fast on purpose.** 1% per hour lets you watch it; a real DAO would use 1% per month. A deployed copy has a finite life, described under [Parameters](#parameters).
- **The test faucet is open to everyone.** Accounts are free, so one person can claim many times, but the faucet is separate from payouts and has no limit of its own. It exists only for testing and would be removed in a real deployment. A real DAO would have no open claim and would pay out only through approved proposals.
- **Payouts depend on the governor.** The contract enforces the daily limit and nothing about recipients. Whoever governs the token decides who is paid, up to the day's remaining limit.
- **The token account still has a full-access key,** so its owner could replace the code. Deleting it is optional and irreversible; it makes the code permanent and means a bug could never be fixed. The website reads this live.
- **No `ft_transfer_call`.** The token does not make cross-contract calls, so it cannot be sent into contracts that need a callback.
- **Balances change with the clock, not with transactions,** so explorers and wallets show a new balance only when they read it again, and melting emits no events.
- **A force-unregister resets the `claimed` flag,** so that account could claim again, within the daily limit.
- **Recent activity on the website** comes from the free NearBlocks API, which rate-limits. The page shows a message and the last list when it does.

---

## Built at NEAR HACKATHON

**Track: memecoins.** The mechanic is the meme: a fixed supply whose balances melt on a schedule into a treasury that a DAO pays out under a daily limit. All code here was written during the hackathon window (from 1 November 2026). There is no pre-hackathon baseline, and this is the only NEAR project in the repository.

**Libraries and tools.** `near-sdk` 5.30.1, `near-contract-standards` 5.30.1, `uint` 0.10, `rand` 0.8 (tests), `near-workspaces` 0.24.0 with `tokio`, `anyhow`, `serde_json` and `base64` (sandbox tests), `cargo-near` 0.23, `near-cli-rs` 0.31, near-sandbox `neard` 2.14.1, Sputnik DAO v2 (the wasm the testnet factory deploys), Astro 7.4.12 (website), `@hot-labs/near-connect` 0.12.0 (wallet sign-in), Python with `matplotlib` and `numpy` (simulation). The website uses Jost and Source Serif 4 under the SIL Open Font License, self-hosted in `web/public/fonts/`.

**AI disclosure.** Claude Code (Anthropic's CLI agent) wrote essentially all the code, tests, scripts, website and this README under direction from the project owner, who reviewed each phase and specified the design: the shares and index maths, the security requirements and the DAO governor. The owner ran the deployment commands; the AI did not deploy, push or submit anything. Nothing here has been audited, so review it before trusting it.

**History.** The Wörgl story is based on the Wikipedia articles [Wörgl](https://en.wikipedia.org/wiki/W%C3%B6rgl), [Demurrage (currency)](https://en.wikipedia.org/wiki/Demurrage_(currency)) and [Wörgler Schwundgeld](https://de.wikipedia.org/wiki/W%C3%B6rgler_Schwundgeld).

---

## License

[MIT](LICENSE). Made with ♥ by [devendra_116](https://x.com/devendra_116).
