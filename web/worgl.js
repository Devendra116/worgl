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

/** 100000000000000000000n -> "100.0000" (truncated, never rounded up). */
export function formatCoins(units, places = 4) {
  const neg = units < 0n;
  if (neg) units = -units;
  const whole = units / ONE;
  const frac = (units % ONE).toString().padStart(Number(DECIMALS), "0").slice(0, places);
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (places ? "." + frac : "");
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
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
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
