// A tiny in-browser copy of the token, for people with no wallet. It uses the same integer maths and
// rounding rules as the contract (rpow, shares rounded the contract's way, dust back to the pot), at the
// demo rate. "Skip" buttons move its clock forward; nothing here touches the chain.
import { ONE, RAY, TOTAL_SUPPLY, rpow, mulDivFloor, mulDivCeil, circulatingOf, balanceOfShares } from "./worgl.js";

export function createSim(factor) {
  const t0 = performance.now();
  let skipped = 0n;                       // seconds the visitor has skipped forward
  const shares = new Map();               // account -> shares
  let total = 0n;                         // total shares (all accounts)
  let received = 0n, sent = 0n;           // coins in and out of "You" (not counting melt)

  const secs = () => BigInt(Math.floor((performance.now() - t0) / 1000)) + skipped;
  const index = () => rpow(factor, secs());
  const bal = (who) => balanceOfShares(shares.get(who) ?? 0n, index());

  return {
    secs,
    skip(s) { skipped += BigInt(s); },
    join() { shares.set("You", 0n); shares.set("Sam", 0n); },
    joined: () => shares.has("You"),
    claimed: false,
    claim() {
      if (this.claimed) throw new Error("You have already claimed.");
      const amount = 100n * ONE, idx = index();
      const gain = mulDivFloor(amount, RAY, idx);
      shares.set("You", shares.get("You") + gain); total += gain;
      received += amount; this.claimed = true;
    },
    send(amount) {
      const idx = index(), have = bal("You");
      if (amount > have) throw new Error("Not enough balance");
      const mine = shares.get("You");
      const loss = amount === have ? mine : mulDivCeil(amount, RAY, idx);
      const gain = mulDivFloor(amount, RAY, idx);
      shares.set("You", mine - loss);
      shares.set("Sam", shares.get("Sam") + gain);
      total -= loss - gain;               // rounding dust goes back to the pot
      sent += amount;
    },
    balance: bal,
    pot() { return TOTAL_SUPPLY - circulatingOf(total, index()); },
    circulating() { return circulatingOf(total, index()); },
    /** coins that melted out of "You": everything that came in, minus what went out, minus what is left */
    meltedFromYou() { const m = received - sent - bal("You"); return m > 0n ? m : 0n; },
  };
}
