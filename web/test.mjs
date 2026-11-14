// Node check of web/worgl.js. Offline part: the contract's own vectors. Online part
// (read-only, skipped if TOKEN is unset): JS index == contract index at the same block.
//   node web/test.mjs                       # offline
//   TOKEN=<token>.testnet node web/test.mjs # + live check
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createSim } from "./src/scripts/sim-demo.js";
import { parseCoins } from "./src/scripts/worgl.js";
import { friendly, outcomeError, maxSendable, checkSend } from "./src/scripts/wallet-logic.js";
import { rpow, balanceOfShares, circulatingOf, indexAt, formatCoins, Chain, ONE, usableUntil, describeEvery, secondsPerPercent, DEMO_FACTOR, parseChainJson, formatNear, formatCoinsRound, formatUnits, fetchWithTimeout } from "./src/scripts/worgl.js";
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
check("elapsed time saturates before start", indexAt(999997208243937652252849536n, 10n ** 18n, 5n) === 10n ** 27n);

// ---- wallet logic (no wallet needed)
check("friendly: already claimed", friendly(new Error("Smart contract panicked: Already claimed")).startsWith("You have already claimed"));
check("friendly: cap", friendly("Smart contract panicked: Daily payout cap exceeded").includes("00:00 UTC"));
check("friendly: cancelled wallet", friendly(new Error("User rejected the request")).includes("cancelled"));
check("friendly: unknown error is still a sentence with a next step", /^The transaction failed: weird thing\. Check the wallet/.test(friendly("Smart contract panicked: weird thing")));
check("outcomeError finds a failed receipt", outcomeError({ receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { Failure: { ActionError: "x" } } } }] }) !== null);
check("outcomeError is null on success", outcomeError({ receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }], status: { SuccessValue: "" } }) === null);
{
  const F = 999997208243937652252849536n, start = 10n ** 18n;
  const now = start + 1000n * 1_000_000_000n, shares = 100n * ONE;
  const nowBal = balanceOfShares(shares, indexAt(F, start, now));
  const max = maxSendable({ shares, factor: F, startNs: start, nowNs: now, leadSecs: 120n });
  check("Max is below the balance now and above the balance 121 s later", max < nowBal && max >= balanceOfShares(shares, indexAt(F, start, now + 121n * 1_000_000_000n)) - 1n);
  const later = balanceOfShares(shares, indexAt(F, start, now + 90n * 1_000_000_000n));
  check("Max is still affordable if the transaction lands 90 s later", max <= later);
  check("send form: bad account", checkSend({ me: "a.testnet", toText: "A B", amountText: "1", balance: 10n * ONE }).error.includes("account"));
  check("send form: to self", checkSend({ me: "a.testnet", toText: "a.testnet", amountText: "1", balance: 10n * ONE }).error.includes("yourself"));
  check("send form: zero", checkSend({ me: "a.testnet", toText: "b.testnet", amountText: "0", balance: 10n * ONE }).error.includes("above zero"));
  check("send form: too much", checkSend({ me: "a.testnet", toText: "b.testnet", amountText: "11", balance: 10n * ONE }).error.includes("more than you hold"));
  const ok = checkSend({ me: "a.testnet", toText: " B.testnet ", amountText: "2.5", balance: 10n * ONE });
  check("send form: valid input is normalised", ok.to === "b.testnet" && ok.amount === 25n * ONE / 10n);
}

// ---- the no-wallet simulation (same rounding rules as the contract)
{
  const F = 999997208243937652252849536n, SUPPLY = 1_000_000n * ONE;
  const s = createSim(F);
  s.join(); s.claim();
  check("sim: claim gives 100 coins", s.balance("You") === 100n * ONE);
  let again = false; try { s.claim(); } catch { again = true; }
  check("sim: a second claim is refused", again);
  s.send(10n * ONE);
  check("sim: send moves 10 coins to Sam", s.balance("Sam") === 10n * ONE && s.balance("You") === 90n * ONE);
  check("sim: pot + circulating is exactly the supply", s.pot() + s.circulating() === SUPPLY);
  s.skip(86_400);
  check("sim: a day of skipping melts 90 coins to ~70.7 (0.99^24)", s.balance("You") < 71n * ONE && s.balance("You") > 70n * ONE);
  check("sim: supply still conserved after melting", s.pot() + s.circulating() === SUPPLY);
  check("sim: the melt from You is positive and below what came in", s.meltedFromYou() > 0n && s.meltedFromYou() < 100n * ONE);
  let over = false; try { s.send(500n * ONE); } catch { over = true; }
  check("sim: sending more than you hold is refused", over);
}

// ---- the demo rate: 1% per hour, and the lifetime that follows from it (checked against Python, 80-digit decimals)
{
  const F = 999997208243937652252849536n;
  check("DEMO_FACTOR is 0.99^(1/3600)", DEMO_FACTOR === F);
  const within = (a, b) => (a > b ? a - b : b - a) * 10n ** 15n <= b;
  check("rpow(factor, 3600) is within 1e-15 of 0.99", within(rpow(F, 3600n), 99n * 10n ** 25n));
  check("the melt period is 1 hour and reads as 'hour'", Math.round(secondsPerPercent(F)) === 3600 && describeEvery(3600) === "hour" && describeEvery(600) === "10 minutes");
  const u = usableUntil(F, 0n);
  check("every amount up to the full supply fits for 11,985,557 s (138.7 days)", u.accurate === 11_985_557_000);
  check("100-coin claims keep working until 15,284,673 s (176.9 days)", u.claimsStop === 15_284_673_000);
  check("every balance reads zero from 22,269,034 s (257.7 days)", u.zero === 22_269_034_000);
}

// ---- decimals and big numbers: everything that is money is a BigInt integer
{
  const raw = '{"start_ns":1794587405531738269,"block_timestamp_ns":1794588943763038952,"treasury":"999890519193570289949060","holders":3}';
  const naive = JSON.parse(raw);
  const exact = parseChainJson(raw);
  check("JSON.parse alone would round a nanosecond timestamp (why parseChainJson exists)", BigInt(naive.start_ns) !== 1794587405531738269n);
  check("parseChainJson keeps start_ns and block_timestamp_ns exact", BigInt(exact.start_ns) === 1794587405531738269n && BigInt(exact.block_timestamp_ns) === 1794588943763038952n);
  const already = parseChainJson('{"start_ns":"1794587405531738269","block_timestamp_ns":"1794588943763038952"}');
  check("parseChainJson also accepts timestamps the contract already sends as U64 strings", BigInt(already.start_ns) === 1794587405531738269n && BigInt(already.block_timestamp_ns) === 1794588943763038952n);
  check("parseChainJson leaves U128 strings and small numbers alone", exact.treasury === "999890519193570289949060" && exact.holders === 3);
  check("formatNear is exact: 1.26e21 yocto = 0.00126 NEAR", formatNear(1260000000000000000000n) === "0.00126" && formatNear(10n ** 24n) === "1.00000");
  check("formatCoins: 0, 1 unit, negative and a 24-digit pot", formatCoins(0n) === "0.0000" && formatCoins(1n) === "0.0000" && formatCoins(-5n * ONE) === "-5.0000" && formatCoins(999890519193570289949060n) === "999,890.5191");
  check("formatCoins at full 18 decimals shows the last unit", formatCoins(1n, 18) === "0.000000000000000001" && formatCoinsRound(1n, 18) === "0.000000000000000001");
  check("formatCoinsRound rounds half up and formatCoins truncates", formatCoinsRound(99_99996n * 10n ** 13n, 4) === "100.0000" && formatCoins(99_99996n * 10n ** 13n, 4) === "99.9999");
  // a balance the contract would hold: 123456789012345678901 base units, no float anywhere
  check("a 21-digit amount round-trips through parseCoins and formatCoins without loss", formatCoins(123456789012345678901n, 18) === "123.456789012345678901" && parseCoins("123.456789012345678901") === 123456789012345678901n);
}

// ---- a request that never answers must not leave the page waiting for ever
{
  const srv = createServer(() => {});               // accepts the connection and never replies
  await new Promise((r) => srv.listen(0, r));
  const started = Date.now();
  let message = "";
  try { await fetchWithTimeout(`http://127.0.0.1:${srv.address().port}/`, {}, 300); } catch (e) { message = e.message; }
  srv.closeAllConnections?.(); srv.close();
  check("a request that never answers gives up at its deadline, with a clear message", /Timed out after 0\.3 s/.test(message) && Date.now() - started < 3000, message);
}

// ---- the built pages carry their links in the HTML itself (checked only if `npm run build` has been run)
{
  const dist = new URL("./dist/", import.meta.url);
  const pages = ["index.html", "idea/index.html", "try/index.html", "numbers/index.html", "maths/index.html", "faq/index.html"];
  if (existsSync(new URL("index.html", dist))) {
    const html = Object.fromEntries(pages.map((p) => [p, readFileSync(new URL(p, dist), "utf8")]));
    const empty = pages.filter((p) => /<a [^>]*href="#"/.test(html[p]));
    check("no page has an empty '#' link before scripts run", empty.length === 0, empty.join(", "));
    check("every page footer names the token and the DAO, linked to the explorer", pages.every((p) => /id="f-token" href="https:\/\/[^"]+\/address\/[^"]+"/.test(html[p]) && /id="f-dao" href="https:\/\/[^"]+\/address\/[^"]+"/.test(html[p])));
    check("the maths page links the real test and maths files", /link-tests" href="https:\/\/github\.com\/[^"]+\/contract\/src\/tests\.rs"/.test(html["maths/index.html"]) && /link-math" href="https:\/\/github\.com\/[^"]+\/contract\/src\/math\.rs"/.test(html["maths/index.html"]));
    check("the formula reads 10^27 to a text reader", /10<span class="sr-only">\^<\/span><sup>27<\/sup>/.test(html["maths/index.html"]));
  } else console.log("SKIP  built-page checks (run `npm run build` first)");
}

if (process.env.TOKEN) {
  const c = new Chain(process.env.RPC ?? "https://rpc.testnet.fastnear.com", process.env.TOKEN);
  const h = await c.finalHeight();
  const [p, s] = [await c.view("get_params", {}, h), await c.view("get_stats", {}, h)];
  const idx = indexAt(BigInt(p.factor), BigInt(p.start_ns), BigInt(s.block_timestamp_ns));
  check(`live: JS index == contract index at block ${h}`, idx.toString() === s.index);
  check("live: JS circulating == contract circulating", circulatingOf(BigInt(s.total_shares), idx).toString() === s.circulating);
}
process.exit(bad ? 1 : 0);
