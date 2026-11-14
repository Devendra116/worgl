// Wörgl client maths and read-only RPC. No dependencies; runs in browsers and Node.
// Mirrors contract/src/math.rs exactly (BigInt instead of U256), so the page shows the same
// number the contract would return for ft_balance_of at that block timestamp.
export const RAY = 10n ** 27n;
export const DECIMALS = 18n;
export const ONE = 10n ** DECIMALS;
export const TOTAL_SUPPLY = 1_000_000n * ONE;

export const mulDivFloor = (a, b, c) => (a * b) / c;
export const mulDivCeil = (a, b, c) => (a * b + c - 1n) / c;

/** x^n in RAY fixed point, rounding DOWN at each step (same as the contract). */
export function rpow(x, n) {
  let r = RAY;
  while (n > 0n) {
    if (n & 1n) r = (r * x) / RAY;
    x = (x * x) / RAY;
    n >>= 1n;
  }
  return r;
}

/** index at chain time `nowNs`; elapsed time saturates at 0 like the contract. */
export function indexAt(factor, startNs, nowNs) {
  const secs = nowNs > startNs ? (nowNs - startNs) / 1_000_000_000n : 0n;
  return rpow(factor, secs);
}
export const balanceOfShares = (shares, index) => mulDivFloor(shares, index, RAY);
export const circulatingOf = (totalShares, index) => mulDivCeil(totalShares, index, RAY);
export const treasuryOf = (circulating) => TOTAL_SUPPLY - circulating;

/** Integer `units` with `decimals` decimals -> "1,234.5678", truncated (never rounded up). BigInt only. */
export function formatUnits(units, decimals, places = 4) {
  const neg = units < 0n;
  if (neg) units = -units;
  const unit = 10n ** decimals;
  const frac = (units % unit).toString().padStart(Number(decimals), "0").slice(0, places);
  const w = (units / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (places ? "." + frac : "");
}

/** 100000000000000000000n -> "100.0000" (truncated, never rounded up). */
export const formatCoins = (units, places = 4) => formatUnits(units, DECIMALS, places);

/** yoctoNEAR -> "0.00126" NEAR (truncated). */
export const formatNear = (yocto, places = 5) => formatUnits(yocto, 24n, places);

/** Like formatCoins but rounds to the nearest unit of the last place; for display figures, not for checks. */
export function formatCoinsRound(units, places = 4) {
  if (places >= Number(DECIMALS)) return formatCoins(units, places);   // nothing to round at full precision
  return formatCoins(units + 5n * 10n ** (DECIMALS - BigInt(places) - 1n), places);
}

/**
 * Parse a view result. The current contract sends the nanosecond timestamps (`start_ns`, `block_timestamp_ns`)
 * as strings (U64). An earlier deployment sent them as plain JSON numbers above 2^53, which JSON.parse rounds
 * to a multiple of 256, so those are quoted first and stay exact. Either way they arrive exact.
 * Every money amount is a string (U128) and is never a JSON number.
 */
export function parseChainJson(text) {
  return JSON.parse(text.replace(/"(start_ns|block_timestamp_ns)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}

export class Chain {
  constructor(rpcUrl, tokenId) {
    this.rpcUrl = rpcUrl;
    this.tokenId = tokenId;
  }
  async view(method, args = {}, blockId) {
    const params = {
      request_type: "call_function",
      account_id: this.tokenId,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
      ...(blockId ? { block_id: blockId } : { finality: "final" }),
    };
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }),
    });
    const j = await res.json();
    if (j.error || j.result?.error) throw new Error(`${method}: ${JSON.stringify(j.error ?? j.result.error)}`);
    return parseChainJson(new TextDecoder().decode(new Uint8Array(j.result.result)));
  }
  async finalHeight() {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }),
    });
    return (await res.json()).result.header.height;
  }
}

// ---------------------------------------------------------------- helpers used by the page
/** Real setting: 0.99^(1/2592000) per second, i.e. 1% every 30 days. */
export const REAL_FACTOR = 999999996122555619592348752n;
export const DAY = 86_400n;
export const MONTH = 30n * DAY;
export const YEAR = 365n * DAY;
export const U128_MAX = (1n << 128n) - 1n;
export const CLAIM_AMOUNT = 100n * ONE;

/** index after `secs` whole seconds */
export const indexAfter = (factor, secs) => rpow(factor, secs);

/** Seconds for the balance to lose 1% (float; display only). */
export function secondsPerPercent(factor) {
  return Math.log(0.99) / Math.log(Number(factor) / Number(RAY));
}

/** First whole second at which `isDone(index)` holds. The index only falls, so this bisects. */
export function firstSecond(factor, isDone, maxSecs = 10n ** 11n) {
  let lo = 0n, hi = maxSecs;
  if (!isDone(rpow(factor, hi))) return null;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (isDone(rpow(factor, mid))) hi = mid; else lo = mid + 1n;
  }
  return lo;
}

/**
 * When this copy of the token stops being usable, computed from its own parameters:
 *  - claimsStop: a 100-coin claim no longer fits in u128 shares (the contract then says "Index too small")
 *  - zero: the index has rounded to 0 and every balance reads 0
 * Returns epoch milliseconds (Number) or null if beyond the search horizon.
 */
export function usableUntil(factor, startNs) {
  // An amount needs shares = amount * RAY / index to fit in u128, so it stops working once index < this.
  const minIndex = (amount) => (amount * RAY + U128_MAX - 1n) / U128_MAX;
  const toMs = (s) => (s == null ? null : Number((startNs + s * 1_000_000_000n) / 1_000_000n));
  const stopsFor = (amount) => toMs(firstSecond(factor, (i) => i < minIndex(amount)));
  return {
    accurate: stopsFor(TOTAL_SUPPLY),    // every amount up to the whole supply still fits until here
    claimsStop: stopsFor(CLAIM_AMOUNT),  // a 100-coin claim stops fitting here
    zero: toMs(firstSecond(factor, (i) => i === 0n)),   // every balance reads 0 from here
  };
}

/** "every hour" / "every 10 minutes": the duration without a leading "1 ". */
export const describeEvery = (secs) => { const d = describeDuration(secs); return d.startsWith("1 ") ? d.slice(2) : d; };

/** "10 minutes", "1 hour", "30 days" for a number of seconds (rounded for display). */
export function describeDuration(secs) {
  const units = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3600], ["minute", 60], ["second", 1]];
  for (const [name, n] of units) {
    if (secs >= n * 0.95) {
      const v = Math.round(secs / n);
      return `${v} ${name}${v === 1 ? "" : "s"}`;
    }
  }
  return `${secs.toFixed(1)} seconds`;
}

/** "12.5" -> 12500000000000000000n; null if not a valid amount with at most 18 decimals. */
export function parseCoins(text) {
  const m = /^\s*(\d+)(?:\.(\d{1,18}))?\s*$/.exec(text ?? "");
  if (!m) return null;
  return BigInt(m[1]) * ONE + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

/** The demo factor, 0.99^(1/3600). Used only to draw the sample note when the chain cannot be read. */
export const DEMO_FACTOR = 999997208243937652252849536n;
