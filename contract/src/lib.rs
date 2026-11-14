//! Wörgl: a fixed-supply token whose balances decay at one fixed rate.
//! Whatever decays belongs to the treasury (this contract's own account).
//! There is no owner, no admin method and no upgrade method.

pub mod math;

use math::*;
use near_contract_standards::fungible_token::events::FtTransfer;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FT_METADATA_SPEC};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, NearToken, PanicOnDefault, Promise,
};

/// Faucet: coins paid out by `claim()`, once per account.
pub const CLAIM_AMOUNT: u128 = 100 * ONE_COIN;
const NS_PER_SEC: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400 * NS_PER_SEC;

// ---- fixed rules (compile-time constants: nothing can change them) ----
/// Max paid out of the treasury per UTC day (faucet claims + `pay_out`), as basis
/// points of the treasury balance at the start of that day.
pub const DAILY_CAP_BPS: u128 = 1_000; // 10%
/// The test faucet never takes the treasury below this share of the supply (basis points), so it cannot
/// drain the pot that payouts draw from. Faucet claims do NOT count against the daily payout cap.
pub const FAUCET_RESERVE_BPS: u128 = 5_000; // 50%
/// Max length of the memo of a pay_out (the memo only goes into the event log).
pub const MAX_MEMO_BYTES: usize = 140;

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub struct Account {
    pub shares: u128,
    pub claimed: bool,
}

#[near(serializers = [json])]
pub struct Params {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: U128,
    /// Per-second decay factor, RAY (10^27) scale.
    pub factor: U128,
    pub ray: U128,
    /// Block time at init, in nanoseconds. A `U64` (a JSON string): it is above 2^53, which JavaScript
    /// cannot hold exactly as a JSON number.
    pub start_ns: U64,
    pub claim_amount: U128,
    /// yoctoNEAR a new account must attach to register (contract never pays storage).
    pub storage_cost: U128,
    pub daily_cap_bps: u32,
    /// The only account allowed to call `pay_out`. Fixed at init, never changeable.
    pub governor: AccountId,
}

#[near(serializers = [json])]
pub struct Stats {
    pub treasury: U128,
    pub circulating: U128,
    pub total_shares: U128,
    pub index: U128,
    pub holders: u64,
    /// Time of the block being read, in nanoseconds. A `U64` (JSON string) for the same reason as `start_ns`.
    pub block_timestamp_ns: U64,
    /// UTC day number (block_timestamp / 86400s)
    pub day: u64,
    /// treasury balance at the start of this UTC day
    pub day_start_treasury: U128,
    pub day_cap: U128,
    pub day_paid: U128,
    pub day_remaining: U128,
}


#[near(serializers = [json])]
pub struct AccountView {
    pub shares: U128,
    pub balance: U128,
    pub claimed: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Worgl {
    accounts: LookupMap<AccountId, Account>,
    total_shares: u128,
    factor: u128,
    start_ns: u64,
    holders: u64,
    storage_cost: u128,
    // daily payout cap bookkeeping
    day: u64,
    day_start_treasury: u128,
    day_paid: u128,
    governor: AccountId,
}

#[near]
impl Worgl {
    /// `factor`: per-second decay factor in RAY scale (see sim/worgl_math.py).
    #[init]
    pub fn new(factor: U128, governor: AccountId) -> Self {
        let factor: u128 = factor.into();
        require!(
            factor > RAY / 2 && factor < RAY,
            "factor must be in (0.5, 1) RAY"
        );
        require!(
            governor != env::current_account_id(),
            "The governor must not be the token account itself"
        );
        let mut accounts = LookupMap::new(b"a");
        // Measure the worst-case (64 char id) storage cost of one account record.
        let before = env::storage_usage();
        let tmp: AccountId = "a".repeat(64).parse().unwrap();
        accounts.insert(tmp.clone(), Account { shares: 0, claimed: false });
        accounts.flush();
        let used = env::storage_usage() - before;
        accounts.remove(&tmp);
        accounts.flush();
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        Self {
            accounts,
            total_shares: 0,
            factor,
            start_ns: env::block_timestamp(),
            holders: 0,
            storage_cost: used as u128 * byte_cost,
            day: env::block_timestamp() / DAY_NS,
            day_start_treasury: TOTAL_SUPPLY,
            day_paid: 0,
            governor,
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_params(&self) -> Params {
        Params {
            name: "Wörgl".into(),
            symbol: "WORGL".into(),
            decimals: DECIMALS,
            total_supply: TOTAL_SUPPLY.into(),
            factor: self.factor.into(),
            ray: RAY.into(),
            start_ns: self.start_ns.into(),
            claim_amount: CLAIM_AMOUNT.into(),
            storage_cost: self.storage_cost.into(),
            daily_cap_bps: DAILY_CAP_BPS as u32,
            governor: self.governor.clone(),
        }
    }

    pub fn get_index(&self) -> U128 {
        self.index_now().into()
    }

    pub fn get_stats(&self) -> Stats {
        let index = self.index_now();
        let circ = circulating_of(self.total_shares, index);
        let (day, start_treasury, paid) = self.day_view();
        let cap = Self::cap_of(start_treasury);
        Stats {
            day,
            day_start_treasury: start_treasury.into(),
            day_cap: cap.into(),
            day_paid: paid.into(),
            day_remaining: cap.saturating_sub(paid).into(),
            treasury: self.treasury_from(circ).into(),
            circulating: circ.into(),
            total_shares: self.total_shares.into(),
            index: index.into(),
            holders: self.holders,
            block_timestamp_ns: env::block_timestamp().into(),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let index = self.index_now();
        self.accounts.get(&account_id).map(|a| AccountView {
            shares: a.shares.into(),
            balance: balance_of_shares(a.shares, index).into(),
            claimed: a.claimed,
        })
    }

    // -------------------------------------------------------------- NEP-141

    pub fn ft_total_supply(&self) -> U128 {
        TOTAL_SUPPLY.into()
    }

    /// The contract's own account id reports the treasury.
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        let index = self.index_now();
        if account_id == env::current_account_id() {
            let circ = circulating_of(self.total_shares, index);
            return self.treasury_from(circ).into();
        }
        match self.accounts.get(&account_id) {
            Some(a) => balance_of_shares(a.shares, index).into(),
            None => 0.into(),
        }
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Wörgl".to_string(),
            symbol: "WORGL".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let index = self.live_index();
        self.roll_day();
        let sender_id = env::predecessor_account_id();
        let amount: u128 = amount.into();
        require!(amount > 0, "The amount should be a positive number");
        require!(sender_id != receiver_id, "Sender and receiver should be different");
        let mut sender = self.accounts.get(&sender_id).copied().unwrap_or_else(|| {
            env::panic_str("Sender is not registered")
        });
        if receiver_id == env::current_account_id() {
            // Returning coins to the treasury: the sender's shares are destroyed, so the treasury
            // (supply - circulating) grows. Rounding is in the treasury's favour.
            let bal = balance_of_shares(sender.shares, index);
            require!(amount <= bal, "Not enough balance");
            let loss = if amount == bal { sender.shares } else { shares_ceil(amount, index) };
            require!(loss <= sender.shares, "Not enough balance");
            sender.shares -= loss;
            self.total_shares -= loss;
            self.accounts.insert(sender_id.clone(), sender);
            FtTransfer { old_owner_id: &sender_id, new_owner_id: &receiver_id, amount: amount.into(), memo: memo.as_deref() }.emit();
            return;
        }
        let mut receiver = self.accounts.get(&receiver_id).copied().unwrap_or_else(|| {
            env::panic_str("Receiver is not registered")
        });

        let bal = balance_of_shares(sender.shares, index);
        require!(amount <= bal, "Not enough balance");
        let gain = shares_floor(amount, index);
        let loss = if amount == bal {
            sender.shares // full balance: move everything, sender ends at exactly 0
        } else {
            shares_ceil(amount, index)
        };
        require!(loss <= sender.shares, "Not enough balance");
        require!(gain <= loss, "internal: gain exceeds loss");
        sender.shares -= loss;
        receiver.shares += gain;
        // Rounding dust (loss - gain) goes back to the treasury: total_shares always
        // equals the sum of all account shares.
        self.total_shares -= loss - gain;
        self.accounts.insert(sender_id.clone(), sender);
        self.accounts.insert(receiver_id.clone(), receiver);

        FtTransfer {
            old_owner_id: &sender_id,
            new_owner_id: &receiver_id,
            amount: amount.into(),
            memo: memo.as_deref(),
        }
        .emit();
    }

    /// Send the caller's WHOLE balance to `receiver_id` and return the amount sent, in coins' base units.
    ///
    /// Balances melt every second, so a wallet cannot know the exact amount that will be left when a
    /// transaction lands. This moves every one of the caller's shares instead of a fixed amount, so the
    /// sender ends at exactly 0 and nothing is left behind. No share is rounded, created or destroyed:
    /// `total_shares` does not change, so no stored field other than the two accounts is touched.
    ///
    /// Requires exactly 1 yoctoNEAR. The receiver must be registered and must not be the caller. If the
    /// receiver is this contract's own account (the treasury), the caller's shares are destroyed and the
    /// coins return to the treasury. Refused once the index has reached zero, and when there is nothing
    /// to send. Emits the same NEP-141 `ft_transfer` event as `ft_transfer`, with the amount worked out
    /// at this moment.
    #[payable]
    pub fn transfer_all(&mut self, receiver_id: AccountId, memo: Option<String>) -> U128 {
        assert_one_yocto();
        let index = self.live_index();
        self.roll_day(); // before any change to total_shares, so the day-start treasury stays exact
        let sender_id = env::predecessor_account_id();
        require!(sender_id != receiver_id, "Sender and receiver should be different");
        let mut sender = self
            .accounts
            .get(&sender_id)
            .copied()
            .unwrap_or_else(|| env::panic_str("Sender is not registered"));
        if receiver_id == env::current_account_id() {
            // Return the whole balance to the treasury: destroy every share the caller holds.
            require!(sender.shares > 0, "Nothing to send: you hold no coins");
            let amount = balance_of_shares(sender.shares, index);
            require!(amount > 0, "Nothing to send: your balance is zero");
            self.total_shares -= sender.shares;
            sender.shares = 0;
            self.accounts.insert(sender_id.clone(), sender);
            FtTransfer { old_owner_id: &sender_id, new_owner_id: &receiver_id, amount: amount.into(), memo: memo.as_deref() }.emit();
            return amount.into();
        }
        let mut receiver = self
            .accounts
            .get(&receiver_id)
            .copied()
            .unwrap_or_else(|| env::panic_str("Receiver is not registered"));
        require!(sender.shares > 0, "Nothing to send: you hold no coins");
        let amount = balance_of_shares(sender.shares, index);
        require!(amount > 0, "Nothing to send: your balance is zero");

        receiver.shares += sender.shares; // overflow checks are on: this cannot wrap
        sender.shares = 0;
        self.accounts.insert(sender_id.clone(), sender);
        self.accounts.insert(receiver_id.clone(), receiver);

        FtTransfer {
            old_owner_id: &sender_id,
            new_owner_id: &receiver_id,
            amount: amount.into(),
            memo: memo.as_deref(),
        }
        .emit();
        amount.into()
    }

    // ---------------------------------------------------------------- faucet

    /// One-time faucet. A new account must attach the storage deposit; the contract
    /// never pays storage for users. Excess deposit is refunded.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        let index = self.live_index();
        self.roll_day();
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();

        let refund = if self.accounts.contains_key(&caller) {
            deposit
        } else {
            require!(
                deposit >= self.storage_cost,
                "Attach the storage deposit (see get_params().storage_cost) to register"
            );
            self.register(&caller);
            deposit - self.storage_cost
        };
        let acc = self.accounts.get(&caller).copied().unwrap();
        require!(!acc.claimed, "Already claimed");

        require!(
            self.treasury_now(index) >= TOTAL_SUPPLY / 10_000 * FAUCET_RESERVE_BPS + CLAIM_AMOUNT,
            "Faucet is closed: the treasury is kept for payouts"
        );
        self.pay_from_treasury(&caller, CLAIM_AMOUNT, index, Some("claim"), false);
        let mut acc = self.accounts.get(&caller).copied().unwrap();
        acc.claimed = true;
        self.accounts.insert(caller.clone(), acc);

        if refund > 0 {
            Promise::new(caller).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        CLAIM_AMOUNT.into()
    }

    // -------------------------------------------------------------- governor

    /// Pay `amount` out of the treasury to a registered account.
    ///
    /// ONLY the `governor` (set once at init, never changeable) may call this, and it is
    /// the governor's ONLY power: it cannot change any parameter, cannot move, freeze or
    /// burn any holder's coins, and cannot mint (the supply is fixed). A payout comes out
    /// of the treasury and counts against the daily cap (10% of the treasury balance at
    /// the start of the UTC day). Faucet claims are separate and do not count against it.
    pub fn pay_out(&mut self, recipient: AccountId, amount: U128, memo: Option<String>) {
        require!(
            env::predecessor_account_id() == self.governor,
            "Only the governor can call pay_out"
        );
        let index = self.live_index();
        self.roll_day();
        let memo = memo.unwrap_or_default();
        require!(memo.len() <= MAX_MEMO_BYTES, "Memo too long");
        let note = format!("payout:{memo}");
        self.pay_from_treasury(&recipient, amount.into(), index, Some(&note), true);
    }

    // ------------------------------------------------------ NEP-145 storage

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // always registration-only: no excess is kept
        let payer = env::predecessor_account_id();
        let account_id = account_id.unwrap_or_else(|| payer.clone());
        require!(
            account_id != env::current_account_id(),
            "The treasury cannot be registered"
        );
        let deposit = env::attached_deposit().as_yoctonear();
        let refund = if self.accounts.contains_key(&account_id) {
            deposit
        } else {
            require!(deposit >= self.storage_cost, "Attached deposit is less than the storage cost");
            self.register(&account_id);
            deposit - self.storage_cost
        };
        if refund > 0 {
            Promise::new(payer).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        self.storage_balance(&account_id).unwrap()
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let bal = self
            .storage_balance(&id)
            .unwrap_or_else(|| env::panic_str("Account is not registered"));
        require!(
            amount.map(|a| a.0).unwrap_or(0) == 0,
            "Nothing is withdrawable: available storage balance is 0"
        );
        bal
    }

    /// With `force`, any remaining balance is returned to the treasury (total_shares shrinks).
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let Some(acc) = self.accounts.get(&id).copied() else {
            return false;
        };
        self.roll_day();
        // Index may be 0 after total decay; unregistering is still allowed then.
        let index = self.index_now();
        let bal = balance_of_shares(acc.shares, index);
        require!(
            bal == 0 || force == Some(true),
            "Account has a balance; pass force=true to return it to the treasury"
        );
        self.total_shares -= acc.shares;
        self.accounts.remove(&id);
        self.holders -= 1;
        if bal > 0 {
            FtTransfer {
                old_owner_id: &id,
                new_owner_id: &env::current_account_id(),
                amount: bal.into(),
                memo: Some("storage_unregister"),
            }
            .emit();
        }
        Promise::new(id).transfer(NearToken::from_yoctonear(self.storage_cost + 1)).detach();
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: NearToken::from_yoctonear(self.storage_cost),
            max: Some(NearToken::from_yoctonear(self.storage_cost)),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_balance(&account_id)
    }
}

// ------------------------------------------------------------------ internals
impl Worgl {
    fn storage_balance(&self, id: &AccountId) -> Option<StorageBalance> {
        self.accounts.contains_key(id).then(|| StorageBalance {
            total: NearToken::from_yoctonear(self.storage_cost),
            available: NearToken::from_yoctonear(0),
        })
    }

    fn cap_of(day_start_treasury: u128) -> u128 {
        mul_div_floor(day_start_treasury, DAILY_CAP_BPS, 10_000)
    }

    /// Start a new UTC day if needed. Called at the top of every method that changes
    /// total_shares, so total_shares has not changed since the day began and the
    /// day-start treasury can be recomputed exactly at the day boundary's index.
    fn roll_day(&mut self) {
        let day = env::block_timestamp() / DAY_NS;
        if day != self.day {
            let idx = self.index_at(day * DAY_NS);
            self.day_start_treasury = self.treasury_now(idx);
            self.day = day;
            self.day_paid = 0;
        }
    }

    /// (day, day-start treasury, paid) as roll_day would leave them; for views.
    fn day_view(&self) -> (u64, u128, u128) {
        let day = env::block_timestamp() / DAY_NS;
        if day != self.day {
            let idx = self.index_at(day * DAY_NS);
            (day, self.treasury_now(idx), 0)
        } else {
            (day, self.day_start_treasury, self.day_paid)
        }
    }

    fn register(&mut self, id: &AccountId) {
        self.accounts.insert(id.clone(), Account { shares: 0, claimed: false });
        self.holders += 1;
    }

    /// Index at an arbitrary timestamp. Uses block_timestamp (never block height) and
    /// saturating subtraction so a timestamp before start cannot underflow.
    fn index_at(&self, ts_ns: u64) -> u128 {
        let secs = ts_ns.saturating_sub(self.start_ns) / NS_PER_SEC;
        rpow(self.factor, secs)
    }

    pub(crate) fn index_now(&self) -> u128 {
        self.index_at(env::block_timestamp())
    }

    /// Index for state-changing calls: refuse if fully decayed.
    fn live_index(&self) -> u128 {
        let i = self.index_now();
        require!(i > 0, "Index is zero: the token has fully decayed");
        i
    }

    /// treasury = TOTAL_SUPPLY - circulating; panics (never clamps) if circulating > supply.
    fn treasury_from(&self, circulating: u128) -> u128 {
        TOTAL_SUPPLY
            .checked_sub(circulating)
            .unwrap_or_else(|| env::panic_str("Invariant broken: circulating > total supply"))
    }

    pub(crate) fn treasury_now(&self, index: u128) -> u128 {
        self.treasury_from(circulating_of(self.total_shares, index))
    }

    /// Treasury pays `amount` to a registered account.
    pub(crate) fn pay_from_treasury(
        &mut self,
        to: &AccountId,
        amount: u128,
        index: u128,
        memo: Option<&str>,
        counts_toward_cap: bool,
    ) {
        require!(amount > 0, "The amount should be a positive number");
        require!(amount <= self.treasury_now(index), "Treasury has insufficient funds");
        self.roll_day();
        if counts_toward_cap {
            let cap = Self::cap_of(self.day_start_treasury);
            require!(
                self.day_paid.checked_add(amount).map_or(false, |t| t <= cap),
                "Daily payout cap exceeded"
            );
            self.day_paid += amount;
        }
        let gain = shares_floor(amount, index);
        let mut acc = self
            .accounts
            .get(to)
            .copied()
            .unwrap_or_else(|| env::panic_str("Recipient is not registered"));
        acc.shares += gain;
        self.total_shares += gain;
        self.accounts.insert(to.clone(), acc);
        // Conservation check: circulating must still fit in the supply (panics otherwise).
        let _ = self.treasury_now(index);
        FtTransfer {
            old_owner_id: &env::current_account_id(),
            new_owner_id: to,
            amount: amount.into(),
            memo,
        }
        .emit();
    }
}

#[cfg(test)]
mod tests;
