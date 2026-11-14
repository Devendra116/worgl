// Pure helpers for the wallet actions, kept separate so they can be tested without a browser.
import { indexAt, balanceOfShares, parseCoins } from "./worgl.js";

/** Turn a contract panic or wallet error into a sentence that says what happened and what to do. */
export function friendly(err) {
  const m = String(err?.message ?? err ?? "");
  const rules = [
    [/Already claimed/i, "You have already claimed. The faucet pays each account once."],
    [/Daily payout cap exceeded/i, "Today's payout allowance is used up. Try again after 00:00 UTC."],
    [/Treasury has insufficient funds/i, "The town pot does not hold enough to pay this."],
    [/Attach the storage deposit|less than the storage cost/i, "A new account must attach a small storage deposit. The page adds it; check your wallet shows it."],
    [/Not enough balance/i, "Your balance is lower than that amount. It melts every second, so try a smaller amount."],
    [/Receiver is not registered/i, "That account is not registered yet. Ask them to claim 100 coins first."],
    [/Sender is not registered/i, "Your account is not registered yet. Claim 100 coins first."],
    [/Index too small/i, "This demo copy has melted too far to move this amount. Balances still read correctly."],
    [/Index is zero/i, "This demo copy has fully melted, so nothing can be sent or claimed any more."],
    [/Sender and receiver should be different/i, "You cannot send coins to yourself."],
    [/Cannot transfer to the treasury/i, "You cannot send coins to the town pot account."],
    [/Requires attached deposit of exactly 1 yoctoNEAR/i, "The wallet did not attach the 1 yoctoNEAR a transfer needs. Try again."],
    [/reject|cancel|denied|closed|declin|user.*(abort|refus)/i, "The wallet request was cancelled. Nothing was sent."],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  const detail = m.replace(/^.*Smart contract panicked: /s, "").replace(/\s+/g, " ").slice(0, 160);
  return `The transaction failed${detail ? `: ${detail}` : ""}. Check the wallet and try again.`;
}

/** A function call can fail in a receipt even when the transaction was accepted. Returns the failure text or null. */
export function outcomeError(out) {
  for (const r of out?.receipts_outcome ?? []) {
    const f = r?.outcome?.status?.Failure;
    if (f) return JSON.stringify(f);
  }
  const f = out?.status?.Failure;
  return f ? JSON.stringify(f) : null;
}

/**
 * "Max": the balance melts while the wallet waits for approval, so ask for what the balance will be
 * `leadSecs` from now. It is still valid if the transaction lands before then. A little may stay behind.
 */
export function maxSendable({ shares, factor, startNs, nowNs, leadSecs }) {
  const idx = indexAt(factor, startNs, nowNs + leadSecs * 1_000_000_000n);
  return balanceOfShares(shares, idx);
}

/**
 * Check a send form. Returns { error } with a sentence for the visitor, or { to, amount } when it is fine.
 * `balance` is what the page thinks the balance is right now (it only ever shrinks).
 */
export function checkSend({ me, toText, amountText, balance }) {
  const to = (toText ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}$/.test(to)) return { error: "Enter the account to send to, such as friend.testnet." };
  if (to === me) return { error: "You cannot send coins to yourself." };
  const amount = parseCoins(amountText);
  if (amount == null || amount === 0n) return { error: "Enter an amount above zero, such as 10 or 2.5." };
  if (balance != null && amount > balance) return { error: "That is more than you hold right now. Your balance melts every second; try a smaller amount." };
  return { to, amount };
}
