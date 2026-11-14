import { TOKEN_ID, RPC_URL, EXPLORER, ACTIVITY_API, REPO, CONNECT_URL } from "./config.js";
import {
  Chain, ONE, RAY, TOTAL_SUPPLY, REAL_FACTOR, CLAIM_AMOUNT, MONTH, DAY, YEAR,
  rpow, indexAt, DEMO_FACTOR, balanceOfShares, circulatingOf, treasuryOf, formatCoins,
  secondsPerPercent, describeDuration, describeEvery, usableUntil, parseCoins, formatCoinsRound, formatNear, fetchWithTimeout,
} from "./worgl.js";
import { initNote } from "./note.js";
import { friendly, outcomeError, maxSendable, checkSend } from "./wallet-logic.js";
import { drawChart } from "./chart.js";
import { createSim } from "./sim-demo.js";

// Each page shows only some of the elements this script knows about. A missing id returns a throwaway
// element, so the shared code runs on every page without errors.
const $ = (id) => document.getElementById(id) ?? document.createElement("div");
const has = (id) => !!document.getElementById(id);
const chain = new Chain(RPC_URL, TOKEN_ID);
const GAS = "30000000000000";
const MAX_LEAD_SECS = 120n; // "Max" sends the balance as it will be this many seconds from now (see CONTRACT-QUESTIONS)

let params = null;           // get_params, fixed after init
let dao = null;              // Chain pointed at the governor
let sync = null;             // { chainNs, perf, stats, account, stale }
let accountId = null;
let connector = null;
let busy = false;
let lastSecond = -1n;
let who = "all";             // whose numbers the maths section shows: "all" or an account id
let note = null;
let deadlines = null;

// ---------------------------------------------------------------- small helpers
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("worgl:" + TOKEN_ID + ":" + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("worgl:" + TOKEN_ID + ":" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const withCommas = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function fraction(n, scale = 27, places = 6) {
  const base = 10n ** BigInt(scale);
  return `${n / base}.${(n % base).toString().padStart(scale, "0").slice(0, places)}`;
}
function link(text, href) {
  const a = document.createElement("a");
  a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener";
  return a;
}
function setStatus(id, msg, isError = false) {
  const e = $(id);
  e.textContent = msg;
  e.classList.toggle("err", isError);
}
function ledgerLine(label, value, gloss, valueClass = "") {
  const d = document.createElement("div");
  d.className = "line";
  const dt = document.createElement("dt"); dt.textContent = label;
  const dd = document.createElement("dd"); dd.className = "figure-cell " + valueClass;
  if (value instanceof Node) dd.append(value); else dd.textContent = value;
  d.append(dt, dd);
  if (gloss) { const g = document.createElement("dd"); g.className = "gloss"; g.textContent = gloss; d.append(g); }
  return d;
}

// ---------------------------------------------------------------- the loop drawing
function drawLoop() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = $("loop");
  const mk = (n, a = {}, t) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t != null) e.textContent = t; return e; };
  const defs = mk("defs");
  for (const [id, color] of [["m-treasury", "var(--meadow)"], ["m-melt", "var(--melt)"], ["m-trade", "var(--ink)"]]) {
    const m = mk("marker", { id, markerWidth: 11, markerHeight: 9, refX: 9, refY: 4.5, orient: "auto", markerUnits: "userSpaceOnUse" });
    m.append(mk("path", { d: "M0 0 L11 4.5 L0 9 z", fill: color }));
    defs.append(m);
  }
  svg.append(defs);
  svg.append(mk("rect", { x: 140, y: 24, width: 200, height: 70, fill: "none", stroke: "var(--meadow)", "stroke-width": 3 }));
  svg.append(mk("text", { class: "node", x: 240, y: 66, "text-anchor": "middle", fill: "var(--meadow)", style: "fill:var(--meadow)" }, "Town pot"));
  svg.append(mk("rect", { x: 140, y: 280, width: 200, height: 70, fill: "none", stroke: "var(--ink)", "stroke-width": 3 }));
  svg.append(mk("text", { class: "node", x: 240, y: 322, "text-anchor": "middle" }, "People"));
  svg.append(mk("path", { class: "p-treasury", d: "M175 96 L175 276", "marker-end": "url(#m-treasury)" }));
  svg.append(mk("path", { class: "p-melt", d: "M305 278 L305 98", "marker-end": "url(#m-melt)" }));
  svg.append(mk("path", { class: "p-trade", d: "M196 352 C 170 402, 310 402, 284 352", "marker-end": "url(#m-trade)" }));
  [["Faucet claims", 168], ["and DAO payouts", 190]].forEach(([t, y]) => svg.append(mk("text", { x: 160, y, "text-anchor": "end" }, t)));
  [["The melt:", 168], ["1% on a fixed", 190], ["schedule", 212]].forEach(([t, y]) => svg.append(mk("text", { x: 320, y, style: "fill:var(--melt)" }, t)));
  svg.append(mk("text", { x: 240, y: 424, "text-anchor": "middle" }, "People trade with each other"));
}

// ---------------------------------------------------------------- reading the chain
let refreshing = false;
async function refresh() {
  if (refreshing) return;   // a slow answer must not pile up more requests behind it
  refreshing = true;
  try { await refreshOnce(); } finally { refreshing = false; }
}

/** What each live block says while the contract has not answered, instead of "Loading…" for ever. */
const UNAVAILABLE = "The contract did not answer. This page keeps trying.";
function showChainUnavailable() {
  if (has("rules") && !params) $("rules").replaceChildren(ledgerLine("Rules", "Not available yet", UNAVAILABLE));
  if (has("proposals") && !dao) { const li = document.createElement("li"); li.textContent = `Proposals could not be read. ${UNAVAILABLE}`; $("proposals").replaceChildren(li); }
  if (has("verify-out") && !sync) $("verify-out").replaceChildren(verifyRow(null, `The checks run when the contract answers. ${UNAVAILABLE}`));
  if (has("verify-summary") && !sync) $("verify-summary").textContent = "Waiting for the contract";
  if (has("notice") && !params) $("notice").textContent = `The demo-end dates appear when the contract answers. ${UNAVAILABLE}`;
  for (const id of ["life-d1", "life-d2", "life-d3"]) if (has(id) && $(id).textContent === "–") $(id).textContent = "Not available yet";
}

async function refreshOnce() {
  try {
    const h = await chain.finalHeight(); // pin every view to one block
    if (!params) await onParams(await chain.view("get_params", {}, h));
    const [stats, account] = await Promise.all([
      chain.view("get_stats", {}, h),
      accountId ? chain.view("get_account", { account_id: accountId }, h) : null,
    ]);
    sync = { chainNs: BigInt(stats.block_timestamp_ns), perf: performance.now(), stats, account, stale: false };
    store.set("last", { stats, savedAt: Date.now() });
    setStatus("data-status", "");
    if (has("verify-out")) runVerify();
  } catch (e) {
    const last = store.get("last");
    if (!params) {
      const cachedParams = store.get("params");
      if (cachedParams) await onParams(cachedParams);
      else if (has("note")) note = note ?? initNote({ demoFactor: DEMO_FACTOR });
    }
    if (!sync && last && params) {
      sync = { chainNs: BigInt(last.stats.block_timestamp_ns), perf: performance.now(), stats: last.stats, account: null, stale: true };
    }
    setStatus("data-status", last
      ? `Live data could not be read, so these are the last values from ${fmtTime(last.savedAt)}. The page will keep trying.`
      : "Live data could not be read. Check your connection; the page will keep trying.", true);
    showChainUnavailable();
  }
  renderAll(true);
}

async function onParams(p) {
  params = p;
  dao = new Chain(RPC_URL, p.governor);
  store.set("params", p);
  const factor = BigInt(p.factor), startNs = BigInt(p.start_ns);
  deadlines = usableUntil(factor, startNs);
  if (has("note")) note = initNote({ demoFactor: factor });
  renderRules();
  renderNotice();
  const dl = `${EXPLORER}/address/${p.governor}`;
  $("dao-link").href = dl; $("f-dao").href = dl; $("f-dao").textContent = p.governor;
  if (has("home-dao")) { $("home-dao").href = dl; $("home-dao").textContent = p.governor; }
  if (has("proposals")) loadProposals();
}

function renderRules() {
  const per = secondsPerPercent(BigInt(params.factor));
  const isDemo = per < 7 * 86400;
  const rows = [
    ledgerLine("Total supply", "1,000,000 WORGL", "Nothing is ever minted."),
    ledgerLine("Melt rate", `1% every ${describeEvery(per)}`, isDemo ? "The demo setting. The real setting is 1% every 30 days. Fixed when the contract starts." : "Fixed when the contract starts."),
    ledgerLine("Test faucet", "100 WORGL, once per account", `Testnet only. A real DAO pays out through proposals. A new account pays a ${formatNear(BigInt(params.storage_cost), 5)} NEAR storage deposit.`),
    ledgerLine("Daily payout cap", `${params.daily_cap_bps / 100}% of the town pot`, "Measured at the start of each UTC day. Test claims and payouts share it."),
  ];
  const gov = link(params.governor, `${EXPLORER}/address/${params.governor}`);
  rows.push(ledgerLine("Governor", gov, "Chosen at deployment, usually a DAO. It can call pay_out and nothing else."));
  $("rules").replaceChildren(...rows);
}

function renderNotice() {
  const factor = BigInt(params.factor);
  const per = secondsPerPercent(factor);
  const isDemo = per < 7 * 86400;
  const { accurate } = deadlines;
  $("notice").textContent = (isDemo
    ? `This demo melts 1% every ${describeEvery(per)} so you can watch it. The real setting is 1% a month. `
    : `This copy melts 1% every ${describeEvery(per)}, the real setting. `)
    + (accurate == null ? "At this rate the maths stays accurate for centuries." : "The red line marks today.");
  renderLife();
  applyPeriodText(per);
  fillRates(factor);
}

/** The lifetime bar: accurate, then claims only, then zero. Positions come from the contract's factor and start time. */
function renderLife() {
  const { accurate, claimsStop, zero } = deadlines;
  const box = $("life");
  if (accurate == null || claimsStop == null || zero == null) { box.hidden = true; return; }
  box.hidden = false;
  const start = Number(BigInt(params.start_ns) / 1_000_000n);
  const span = zero - start;
  const pct = (ms) => `${Math.max(0, Math.min(100, ((ms - start) / span) * 100)).toFixed(2)}%`;
  $("life-a").style.width = pct(accurate);
  $("life-b").style.width = `${((claimsStop - accurate) / span * 100).toFixed(2)}%`;
  $("life-c").style.width = `${((zero - claimsStop) / span * 100).toFixed(2)}%`;
  $("life-now").style.left = pct(Date.now());
  $("life-d1").textContent = fmtDate(accurate);
  $("life-d2").textContent = fmtDate(claimsStop);
  $("life-d3").textContent = fmtDate(zero);
}

/** What 100 coins become, at the demo and the real speed. Computed with the same integer maths as the contract. */
function fillRates(demoFactor) {
  const left = (factor, secs) => formatCoinsRound((100n * ONE * rpow(factor, secs)) / RAY, 2);
  const put = (sel, text) => document.querySelectorAll(sel).forEach((e) => { e.textContent = text; });
  put("[data-demo-day]", left(demoFactor, 86_400n));
  put("[data-demo-week]", left(demoFactor, 7n * 86_400n));
  put("[data-real-month]", left(REAL_FACTOR, MONTH));
  put("[data-real-year]", left(REAL_FACTOR, YEAR));
}

/** The two example uses on the home page, worked out at the real setting with the contract's integer maths. */
function fillUseCases() {
  const after = (coins, secs) => (coins * ONE * rpow(REAL_FACTOR, secs)) / RAY;
  const put = (sel, text) => document.querySelectorAll(sel).forEach((e) => { e.textContent = text; });
  const grant = after(5000n, 3n * MONTH);
  put("[data-grant-left]", formatCoinsRound(grant, 2));
  put("[data-grant-back]", formatCoinsRound(5000n * ONE - grant, 2));
  put("[data-credit-month]", formatCoinsRound(after(20n, MONTH), 2));
  put("[data-credit-six]", formatCoinsRound(after(20n, 6n * MONTH), 2));
}

/** Recompute the contract's key numbers in the browser, from one pinned block, and say what matches. */
function runVerify() {
  const list = $("verify-out");
  if (!sync || !params || sync.stale) {
    list.replaceChildren(verifyRow(null, "Waiting for the contract to answer. The checks run as soon as it does."));
    return;
  }
  const s = sync.stats;
  const factor = BigInt(params.factor), start = BigInt(params.start_ns), at = BigInt(s.block_timestamp_ns);
  const index = indexAt(factor, start, at);
  const circ = circulatingOf(BigInt(s.total_shares), index);
  const cap = (BigInt(s.day_start_treasury) * BigInt(params.daily_cap_bps)) / 10_000n;
  const rows = [
    [BigInt(s.index) === index, "The melt factor the contract reports matches the maths in your browser, to the last digit."],
    [BigInt(s.circulating) === circ, "The coins people hold equal their shares times that factor."],
    [BigInt(s.treasury) + BigInt(s.circulating) === TOTAL_SUPPLY, `The pot plus the coins people hold is exactly ${formatCoins(TOTAL_SUPPLY, 0)}.`],
    [BigInt(s.day_cap) === cap, `Today's payout limit is exactly ${params.daily_cap_bps / 100}% of the pot at the start of the day.`],
  ];
  list.replaceChildren(...rows.map(([ok, text]) => verifyRow(ok, text)));
  const passed = rows.filter(([ok]) => ok).length;
  $("verify-summary").textContent = passed === rows.length ? `All ${rows.length} checks pass` : `${passed} of ${rows.length} checks pass`;
}
function verifyRow(ok, text) {
  const li = document.createElement("li");
  const tag = document.createElement("span");
  tag.className = ok === false ? "fail" : "pass";
  tag.textContent = ok === null ? "…" : ok ? "Pass" : "Differs";
  const msg = document.createElement("span"); msg.textContent = text;
  li.append(tag, msg);
  return li;
}

/** Fill the "[data-period]" and "[data-accurate]" spans in the page copy from the contract's own numbers. */
function applyPeriodText(per) {
  document.querySelectorAll("[data-period]").forEach((e) => { e.textContent = describeEvery(per); });
  const months = deadlines?.accurate != null ? (deadlines.accurate - Number(BigInt(params.start_ns) / 1_000_000n)) / (30.44 * 86_400_000) : null;
  const text = months == null ? "centuries" : months >= 36 ? "years" : `${Math.floor(months * 2) / 2} months`;   // rounded down to the half month
  document.querySelectorAll("[data-accurate]").forEach((e) => { e.textContent = text; });
}

// ---------------------------------------------------------------- the numbers on screen
function chainNowNs() { return sync.chainNs + BigInt(Math.round((performance.now() - sync.perf) * 1e6)); }

function figures() {
  if (!sync || !params) return null;
  const factor = BigInt(params.factor);
  const idx = sync.stale ? BigInt(sync.stats.index) : indexAt(factor, BigInt(params.start_ns), chainNowNs());
  const circ = circulatingOf(BigInt(sync.stats.total_shares), idx);
  return { idx, circ, treasury: treasuryOf(circ) };
}

function renderAll(force = false) {
  const f = figures();
  if (!f) { renderTry(null); return; }
  const second = sync.stale ? -2n : chainNowNs() / 1_000_000_000n;
  if (!force && second === lastSecond) return;
  lastSecond = second;
  const s = sync.stats;
  $("v-treasury").textContent = formatCoins(f.treasury, 4);
  $("v-circ").textContent = formatCoins(f.circ, 4);
  const cap = BigInt(s.day_cap), left = BigInt(s.day_remaining);
  $("v-allow").textContent = formatCoins(left, 2);
  $("v-allow-note").textContent = `The daily limit is ${formatCoins(cap, 2)} and resets at 00:00 UTC.`;
  $("v-index").textContent = fraction(f.idx);
  $("account").textContent = accountId ?? "No wallet connected";
  $("connect").textContent = accountId ? "Disconnect" : "Connect wallet";

  renderTry(f);
  if (note) note.render();
  renderCheck(f);
}

function updateButtons() {
  const claimed = !!sync?.account?.claimed;
  $("claim").disabled = busy || !accountId || !sync || claimed;
  $("send").disabled = busy || !accountId || !sync?.account;
  const el = $("claim-status");
  if (mode !== "real") return;
  const hint = !accountId ? CLAIM_HINTS[0] : !sync ? CLAIM_HINTS[2] : claimed ? CLAIM_HINTS[1] : "";
  if (!el.textContent || CLAIM_HINTS.includes(el.textContent)) { el.textContent = hint; el.classList.remove("err"); }
}
const CLAIM_HINTS = [
  "Wallet not connected. Connect a wallet to claim.",
  "You have already claimed. Each account can claim once. Send some coins, or try another account.",
  "Waiting for the chain to answer. This updates by itself in a few seconds.",
];

// ---------------------------------------------------------------- check the maths
let lookup = { id: null, acc: undefined };
async function setWho(next) {
  who = next;
  if (next !== "all") {
    try { lookup = { id: next, acc: await chain.view("get_account", { account_id: next }) }; }
    catch (e) { lookup = { id: next, acc: undefined, err: e }; }
  }
  renderCheck(figures());
}
function renderCheck(f) {
  if (!f || !sync) { $("check").replaceChildren(ledgerLine("Waiting for the chain", "…")); return; }
  const rows = [];
  if (who === "all") {
    const sh = BigInt(sync.stats.total_shares);
    rows.push(ledgerLine("Shares, all accounts", withCommas(sh), "The contract stores this. It changes only when someone claims, sends or is paid."));
    rows.push(ledgerLine("Index", fraction(f.idx, 27, 12), `${f.idx} ÷ 10^27. It falls every second.`));
    rows.push(ledgerLine("Circulating", `${formatCoins(f.circ, 6)} WORGL`, "ceil(shares × index ÷ 10^27). Rounded up, so the treasury never gets less than it should.", ""));
    $("check-note").textContent = "These are everyone's coins together, read live. Connect a wallet or look up an account to see one balance.";
  } else if (lookup.err) {
    rows.push(ledgerLine(who, "Could not read", "The account could not be looked up. Check the name and try again."));
    $("check-note").textContent = "";
  } else if (!lookup.acc) {
    rows.push(ledgerLine(who, "Not registered", "This account has no coins on this token. Claim 100 coins to register."));
    $("check-note").textContent = "";
  } else {
    const sh = BigInt(lookup.acc.shares);
    rows.push(ledgerLine(`Shares of ${who}`, withCommas(sh), "Only changes when this account claims, sends or is paid."));
    rows.push(ledgerLine("Index", fraction(f.idx, 27, 12), `${f.idx} ÷ 10^27. It falls every second.`));
    rows.push(ledgerLine("Balance", `${formatCoins(balanceOfShares(sh, f.idx), 6)} WORGL`, "floor(shares × index ÷ 10^27). The contract returns exactly this."));
    $("check-note").textContent = "Recomputed in your browser every second. The same sum runs inside ft_balance_of.";
  }
  $("check").replaceChildren(...rows);
}

function initCalculator() {
  const run = () => {
    const out = $("calc-out");
    const coins = parseCoins($("calc-coins").value);
    const t = Number($("calc-time").value);
    if (coins == null || coins === 0n || coins > TOTAL_SUPPLY) { out.textContent = "Enter a number of coins between 0 and 1,000,000, such as 100."; return; }
    if (!Number.isFinite(t) || t < 0 || t > 1000) { out.textContent = "Enter a time between 0 and 1,000, such as 1."; return; }
    const unit = { d: DAY, m: MONTH, y: YEAR }[$("calc-unit").value];
    const secs = BigInt(Math.round(t * Number(unit)));
    const left = (coins * rpow(REAL_FACTOR, secs)) / RAY;
    const name = { d: "day", m: "month", y: "year" }[$("calc-unit").value];
    out.textContent = `${formatCoins(coins, 2)} coins after ${t} ${name}${t === 1 ? "" : "s"} at the real rate: ${formatCoinsRound(left, 4)} left, ${formatCoinsRound(coins - left, 4)} went to the town pot.`;
  };
  for (const id of ["calc-coins", "calc-time", "calc-unit"]) $(id).addEventListener("input", run);
  $("calc").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  run();
}

// ---------------------------------------------------------------- the access-key limit, read live
async function loadKeyStatus() {
  const el = $("key-status");
  try {
    const res = await fetchWithTimeout(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: TOKEN_ID } }) });
    const keys = (await res.json()).result?.keys;
    if (!keys) throw new Error("no keys in answer");
    const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
    el.textContent = full > 0
      ? `Right now ${TOKEN_ID} has ${full} full-access key${full === 1 ? "" : "s"}, so its owner could replace the code. Deleting the keys would make it permanent.`
      : `${TOKEN_ID} has no full-access keys, so the code can no longer change.`;
  } catch {
    el.textContent = "The key list could not be read just now. Check the account on NearBlocks.";
  }
}

// ---------------------------------------------------------------- activity and proposals
async function loadActivity() {
  const list = $("activity");
  try {
    const res = await fetchWithTimeout(`${ACTIVITY_API}/fts/${encodeURIComponent(TOKEN_ID)}/txns?per_page=25`);
    if (!res.ok) throw new Error(`NearBlocks answered ${res.status}`);
    const rows = (await res.json()).data ?? [];
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      const inward = r.event_type === 1;
      const from = inward ? r.involved_account_id : r.affected_account_id;
      const to = inward ? r.affected_account_id : r.involved_account_id;
      const amount = String(r.delta_amount ?? "0").replace("-", "");
      const key = [r.receipt_id, r.event_index, from, to, amount].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ from, to, amount, ts: Number(BigInt(r.block_timestamp) / 1_000_000n), tx: r.transaction_hash });
    }
    items.sort((a, b) => b.ts - a.ts);
    store.set("activity", items);
    drawActivity(items, false);
  } catch {
    const cached = store.get("activity");
    drawActivity(cached ?? [], true);
  }
}
function drawActivity(items, failed) {
  const list = $("activity");
  const out = [];
  if (failed) {
    const li = document.createElement("li");
    li.textContent = items.length ? "Recent activity could not be loaded from NearBlocks. Showing the last list." : "Recent activity could not be loaded from NearBlocks. Try again in a minute.";
    out.push(li);
  }
  if (!items.length && !failed) {
    const li = document.createElement("li");
    li.textContent = "No activity yet. Claim 100 coins to be the first.";
    out.push(li);
  }
  for (const it of items.slice(0, 12)) {
    const li = document.createElement("li");
    const t = document.createElement("time"); t.textContent = fmtTime(it.ts);
    const who = it.from === TOKEN_ID ? "The town pot paid" : `${it.from} sent`;
    const span = document.createElement("span");
    span.append(`${who} ${formatCoins(BigInt(it.amount), 2)} coins to ${it.to}. `);
    if (it.tx) span.append(link("Transaction", `${EXPLORER}/txns/${it.tx}`));
    li.append(t, span);
    out.push(li);
  }
  list.replaceChildren(...out);
}

async function loadProposals() {
  const list = $("proposals");
  if (!dao) return;
  try {
    const next = Number(await dao.view("get_last_proposal_id")); // the next id, so there are `next` proposals
    const from = Math.max(0, next - 5);
    const props = next === 0 ? [] : await dao.view("get_proposals", { from_index: from, limit: 5 });
    props.sort((a, b) => b.id - a.id);
    const out = props.map((p) => {
      const li = document.createElement("li");
      const t = document.createElement("time"); t.textContent = fmtTime(Number(BigInt(p.submission_time) / 1_000_000n));
      const votes = p.vote_counts?.council ?? [0, 0, 0];
      const status = String(p.status).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      li.append(t, `Proposal ${p.id}, ${status}: ${p.description} (${votes[0]} approve, ${votes[1]} reject)`);
      return li;
    });
    if (!out.length) { const li = document.createElement("li"); li.textContent = "No proposals yet on the demo DAO. They are made with scripts/propose-payout.sh."; out.push(li); }
    list.replaceChildren(...out);
  } catch {
    const li = document.createElement("li");
    li.textContent = "Proposals could not be read from the DAO. Open the DAO on NearBlocks instead.";
    list.replaceChildren(li);
  }
}

// ---------------------------------------------------------------- try it: simulate, or use a real wallet
let mode = "sim";            // "sim" runs in the browser; "real" uses the wallet and the chain
let modeChosen = false;
let sim = null;
let simSent = false, realSent = false;
const simFactor = () => (params ? BigInt(params.factor) : DEMO_FACTOR);
const getSim = () => (sim ??= createSim(simFactor()));

function updateModeNote() {
  $("mode-note").textContent = mode === "real"
    ? "Real testnet transactions, signed in your wallet. The numbers come from the live contract."
    : accountId
      ? `Your wallet (${accountId}) is connected, but this is the simulation, so nothing is sent to the chain. Choose "My testnet wallet" to claim for real.`
      : "Simulated in your browser with the real maths. Nothing is sent to the chain.";
}

function setMode(next, byUser = true) {
  mode = next; if (byUser) modeChosen = true;
  $("try").dataset.mode = mode;
  $("mode-sim").setAttribute("aria-pressed", String(mode === "sim"));
  $("mode-real").setAttribute("aria-pressed", String(mode === "real"));
  updateModeNote();
  for (const id of ["s1-status", "claim-status", "send-status"]) setStatus(id, "");
  lastSecond = -1n;
  renderAll(true);
  if (mode === "sim" || !sync) renderTry(figures());
}

function markStep(n, done) { $("step-" + n).classList.toggle("done", !!done); }

function renderTry(f) {
  updateModeNote();
  const s = getSim();
  const fmt = (v) => `${formatCoinsRound(v, 4)} WORGL`;
  if (mode === "sim") {
    const joined = s.joined();
    $("sim-join").disabled = joined;
    $("sim-claim").disabled = !joined || s.claimed;
    $("sim-send").disabled = !s.claimed || simSent || s.balance("You") < 10n * ONE;
    for (const id of ["ff-1", "ff-2", "ff-3"]) $(id).disabled = !joined;
    markStep(1, joined); markStep(2, s.claimed); markStep(3, simSent); markStep(4, simSent);
    $("r-balance").textContent = joined ? fmt(s.balance("You")) : "–";
    $("r-friend").textContent = joined ? fmt(s.balance("Sam")) : "–";
    $("r-pot").textContent = fmt(s.pot());
    $("r-explain").textContent = !joined ? "Create your demo account to start."
      : !s.claimed ? "Claim your 100 test coins. They come out of the town pot."
      : s.meltedFromYou() < 10n ** 14n ? `You received 100 coins${simSent ? " and sent 10 to Sam" : ""}. Nothing has melted yet. Skip time forward to watch it.`
      : `You received 100 coins${simSent ? " and sent 10 to Sam" : ""}. ${formatCoinsRound(s.meltedFromYou(), 4)} of your coins have melted so far, and all of it went back to the pot.`;
    return;
  }
  // real mode
  const acc = sync?.account;
  const claimed = !!acc?.claimed;
  updateButtons();
  $("connect-step").disabled = !!accountId || !connector;
  $("connect-step").textContent = accountId ? "Connected" : "Connect wallet";
  setStatus("s1-status", accountId ? `Connected as ${accountId}.` : connector ? "" : "The wallet connector could not load, so real mode is unavailable. Try the simulation.");
  markStep(1, accountId); markStep(2, claimed); markStep(3, realSent); markStep(4, realSent);
  const mine = f && acc ? balanceOfShares(BigInt(acc.shares), f.idx) : 0n;
  $("r-balance").textContent = accountId && f ? fmt(mine) : "–";
  $("r-pot").textContent = f ? fmt(f.treasury) : "–";
  $("r-explain").textContent = !accountId ? "Connect a wallet to begin. The pot figure below is live from the chain."
    : !acc ? "Claiming registers your account and attaches a small storage deposit that the contract refunds if you leave."
    : claimed ? "Your balance melts every second. What melts goes to the pot, so the pot grows by the same amount."
    : "You are registered but have not claimed yet.";
}

$("mode-sim").addEventListener("click", () => setMode("sim"));
$("mode-real").addEventListener("click", () => setMode("real"));
$("connect-step").addEventListener("click", () => $("connect").click());
$("sim-join").addEventListener("click", () => { getSim().join(); setStatus("s1-status", "Created. You are You, and your friend is Sam."); renderTry(figures()); });
$("sim-claim").addEventListener("click", () => {
  try { getSim().claim(); setStatus("claim-status", "Claimed 100 coins from the town pot."); }
  catch (e) { setStatus("claim-status", friendly(e), true); }
  renderTry(figures());
});
$("sim-send").addEventListener("click", () => {
  try { getSim().send(10n * ONE); simSent = true; setStatus("send-status", "Sent 10 coins to Sam."); }
  catch (e) { setStatus("send-status", friendly(e), true); }
  renderTry(figures());
});
// "Skip" buttons move the simulation forward by 1, 24 and 168 melt steps (1 hour, 1 day and 7 days at the demo rate).
{
  const perSim = Math.max(1, Math.round(secondsPerPercent(simFactor())));
  for (const [id, steps] of [["ff-1", 1], ["ff-2", 24], ["ff-3", 168]]) {
    const secs = steps * perSim;
    $(id).textContent = `Skip ${describeDuration(secs)}`;
    $(id).addEventListener("click", () => { getSim().skip(secs); setStatus("send-status", ""); renderTry(figures()); });
  }
}

/** What 100 coins become at the real rate. */
function drawShelfLife() {
  const rows = [["1 month (30 days)", MONTH], ["3 months (90 days)", 3n * MONTH], ["6 months (180 days)", 6n * MONTH], ["1 year (365 days)", YEAR], ["5 years (1,825 days)", 5n * YEAR]];
  const head = document.createElement("thead");
  head.innerHTML = "<tr><th scope='col'>After</th><th scope='col'>You hold</th><th scope='col'>Melted, into the pot</th></tr>";
  const body = document.createElement("tbody");
  for (const [label, secs] of rows) {
    const left = (100n * ONE * rpow(REAL_FACTOR, secs)) / RAY;
    const tr = document.createElement("tr");
    const cells = [label, formatCoinsRound(left, 2), formatCoinsRound(100n * ONE - left, 2)];
    cells.forEach((c, i) => { const td = document.createElement("td"); td.textContent = c; if (i === 2) td.className = "melt"; tr.append(td); });
    body.append(tr);
  }
  $("shelf").append(head, body);
}

// ---------------------------------------------------------------- wallet
async function setAccountFromWallet() {
  try {
    const wallet = await connector.wallet();
    const accts = await wallet.getAccounts();
    accountId = accts[0]?.accountId ?? null;
  } catch { accountId = null; }
  if (accountId && !modeChosen && mode === "sim") setMode("real", false);
  if (accountId && who === "all") await setWho(accountId);
  if (!accountId && who !== "all") await setWho("all");
  await refresh();
}

async function initWallet() {
  try {
    const { NearConnector } = await import(/* @vite-ignore */ CONNECT_URL);
    connector = new NearConnector({ network: "testnet", features: { testnet: true, signAndSendTransaction: true } });
    connector.on("wallet:signIn", setAccountFromWallet);
    connector.on("wallet:signOut", async () => { accountId = null; if (sync) sync.account = null; await setWho("all"); renderAll(true); });
    await setAccountFromWallet();
  } catch (e) {
    $("connect").disabled = true;
    $("account").textContent = "The wallet connector could not load, so this page is read-only.";
  }
}

$("connect").addEventListener("click", async () => {
  if (!connector) return;
  try { accountId ? await connector.disconnect(await connector.wallet()) : await connector.connect(); }
  catch (e) { setStatus("claim-status", friendly(e), true); }
});

/** One wallet transaction to the token with one or more function calls, in order. */
async function sendActions(calls) {
  const wallet = await connector.wallet();
  const out = await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: TOKEN_ID,
    actions: calls.map(([methodName, args, deposit]) => ({ type: "FunctionCall", params: { methodName, args, gas: GAS, deposit } })),
  });
  const failure = outcomeError(out);
  if (failure) throw new Error(failure);
  return out;
}
const sendCall = (methodName, args, deposit) => sendActions([[methodName, args, deposit]]);
const txOf = (out) => out?.transaction?.hash ?? out?.transaction_outcome?.id ?? "";

$("claim").addEventListener("click", async () => {
  if (!connector || !accountId || !params) { setStatus("claim-status", "Wallet not connected. Connect a wallet first.", true); return; }
  busy = true; updateButtons();
  setStatus("claim-status", "Waiting for your wallet to confirm…");
  try {
    const registered = !!sync?.account;
    const out = await sendCall("claim", {}, registered ? "0" : params.storage_cost);
    const hash = txOf(out);
    const el = $("claim-status");
    el.classList.remove("err");
    el.textContent = "Claimed 100 coins. ";
    if (hash) el.append(link("Transaction", `${EXPLORER}/txns/${hash}`));
    setTimeout(() => { refresh(); loadActivity(); }, 2500);
  } catch (e) { setStatus("claim-status", friendly(e), true); }
  finally { busy = false; updateButtons(); }
});

$("max").addEventListener("click", () => {
  if (!figures() || !sync?.account) { setStatus("send-status", "Claim 100 coins first. There is nothing to send yet.", true); return; }
  const amount = maxSendable({
    shares: BigInt(sync.account.shares), factor: BigInt(params.factor), startNs: BigInt(params.start_ns),
    nowNs: chainNowNs(), leadSecs: MAX_LEAD_SECS,
  });
  $("amount").value = formatCoins(amount, 18).replace(/,/g, "").replace(/\.?0+$/, "") || "0";
  setStatus("send-status", `Max is your balance as it will be in ${MAX_LEAD_SECS} seconds, so the wallet has time to confirm. A little may stay behind.`);
});

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!connector || !accountId) { setStatus("send-status", "Wallet not connected. Connect a wallet first.", true); return; }
  const f = figures();
  const balance = f && sync.account ? balanceOfShares(BigInt(sync.account.shares), f.idx) : null;
  const check = checkSend({ me: accountId, toText: $("to").value, amountText: $("amount").value, balance });
  if (check.error) { setStatus("send-status", check.error, true); return; }
  const { to, amount } = check;
  busy = true; updateButtons();
  setStatus("send-status", "Checking the recipient…");
  try {
    const recipient = await chain.view("get_account", { account_id: to });
    if (!recipient) {
      // Not set up for WORGL yet. A typo must never be paid for, so check the NEAR account exists first.
      if (!(await chain.accountExists(to))) { setStatus("send-status", `No testnet account called ${to} exists. Check the spelling.`, true); return; }
      pendingSend = { to, amount };
      setStatus("send-status", `${to} has not set up WORGL yet. You can register them for ${formatNear(BigInt(params.storage_cost), 5)} NEAR, paid by you, and send ${formatCoins(amount, 4)} coins in the same step.`);
      $("register-row").hidden = false;
      return;
    }
    setStatus("send-status", "Waiting for your wallet to confirm…");
    const out = await sendCall("ft_transfer", { receiver_id: to, amount: amount.toString() }, "1");
    showSent(out, `Sent ${formatCoins(amount, 4)} coins to ${to}. `);
  } catch (err) { setStatus("send-status", friendly(err), true); }
  finally { busy = false; updateButtons(); }
});

let pendingSend = null;   // a send to an account that still needs registering, waiting for the visitor to confirm
function clearPendingSend() { pendingSend = null; $("register-row").hidden = true; }
function showSent(out, text) {
  const hash = txOf(out);
  const el = $("send-status");
  el.classList.remove("err");
  realSent = true;
  clearPendingSend();
  el.textContent = text;
  if (hash) el.append(link("Transaction", `${EXPLORER}/txns/${hash}`));
  setTimeout(() => { refresh(); loadActivity(); }, 2500);
}
$("send-register").addEventListener("click", async () => {
  if (!pendingSend || !connector || !accountId) return;
  const { to, amount } = pendingSend;
  busy = true; updateButtons();
  setStatus("send-status", "Waiting for your wallet to confirm…");
  try {
    // one transaction: register the recipient (the sender pays the storage deposit), then send
    const out = await sendActions([
      ["storage_deposit", { account_id: to, registration_only: true }, params.storage_cost],
      ["ft_transfer", { receiver_id: to, amount: amount.toString() }, "1"],
    ]);
    showSent(out, `Registered ${to} and sent ${formatCoins(amount, 4)} coins. `);
  } catch (err) { setStatus("send-status", friendly(err), true); }
  finally { busy = false; updateButtons(); }
});
$("send-register-cancel").addEventListener("click", () => { clearPendingSend(); setStatus("send-status", ""); });
for (const id of ["to", "amount"]) $(id).addEventListener("input", () => { if (pendingSend) { clearPendingSend(); setStatus("send-status", ""); } });

$("who-go").addEventListener("click", () => { const v = $("who-input").value.trim().toLowerCase(); if (v) setWho(v); });
$("who-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("who-go").click(); } });
$("who-all").addEventListener("click", () => { $("who-input").value = ""; setWho("all"); });

// ---------------------------------------------------------------- start
$("f-token").href = `${EXPLORER}/address/${TOKEN_ID}`; $("f-token").textContent = TOKEN_ID;
$("f-repo").href = REPO;
if (has("home-token")) { $("home-token").href = `${EXPLORER}/address/${TOKEN_ID}`; $("home-token").textContent = TOKEN_ID; $("home-repo").href = REPO; }
$("link-tests").href = `${REPO}/blob/main/contract/src/tests.rs`;
$("link-math").href = `${REPO}/blob/main/contract/src/math.rs`;
if (has("loop")) drawLoop();
if (has("shelf")) drawShelfLife();
fillRates(DEMO_FACTOR);
fillUseCases();
if (has("verify-run")) $("verify-run").addEventListener("click", () => { runVerify(); });
setMode("sim", false);
initCalculator();
if (has("chart")) drawChart($("chart")).catch(() => { $("chart-fallback").hidden = false; });
if (has("key-status")) loadKeyStatus();
refresh();
if (has("activity")) loadActivity();
setInterval(() => renderAll(false), 250);
setInterval(refresh, 10000);
if (has("activity")) setInterval(loadActivity, 30000);
if (has("proposals")) setInterval(loadProposals, 30000);
initWallet();
