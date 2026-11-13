// Node check of web/worgl.js. Offline part: the contract's own vectors. Online part
// (read-only, skipped if TOKEN is unset): JS index == contract index at the same block.
//   node web/test.mjs                       # offline
//   TOKEN=<token>.testnet node web/test.mjs # + live check
import { readFileSync } from "node:fs";
import { rpow, balanceOfShares, circulatingOf, indexAt, formatCoins, Chain, ONE } from "./worgl.js";
const v = JSON.parse(readFileSync(new URL("../contract/tests/vectors.json", import.meta.url)));
let bad = 0;
const check = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); bad += !ok; };

let ok = true;
for (const r of v.rpow) ok &&= rpow(BigInt(r.factor), BigInt(r.n)).toString() === r.index;
check(`rpow matches ${v.rpow.length} contract vectors`, ok);
ok = true;
for (const o of v.ops) {
  const idx = BigInt(o.index);
  ok &&= balanceOfShares(BigInt(o.shares), idx).toString() === o.balance;
  ok &&= circulatingOf(BigInt(o.shares), idx).toString() === o.circulating;
}
check(`balance/circulating match ${v.ops.length} contract vectors`, ok);
check("formatCoins truncates", formatCoins(1234567n * ONE + 5n * 10n ** 13n) === "1,234,567.0000" && formatCoins(100n * ONE) === "100.0000");
check("elapsed time saturates before start", indexAt(999983249580534007019381142n, 10n ** 18n, 5n) === 10n ** 27n);

if (process.env.TOKEN) {
  const c = new Chain(process.env.RPC ?? "https://rpc.testnet.fastnear.com", process.env.TOKEN);
  const h = await c.finalHeight();
  const [p, s] = [await c.view("get_params", {}, h), await c.view("get_stats", {}, h)];
  const idx = indexAt(BigInt(p.factor), BigInt(p.start_ns), BigInt(s.block_timestamp_ns));
  check(`live: JS index == contract index at block ${h}`, idx.toString() === s.index);
  check("live: JS circulating == contract circulating", circulatingOf(BigInt(s.total_shares), idx).toString() === s.circulating);
}
process.exit(bad ? 1 : 0);
