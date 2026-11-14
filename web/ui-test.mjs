// Browser test of the wallet flow, with a FAKE wallet (no real wallet, no keys, nothing is sent to the chain).
// It loads the built site in headless Chrome, replaces the wallet library with a stub, and checks that the
// Claim button and the messages around it behave. Needs: `npm run build` first, Chrome or Chromium, network.
//   npm run test:ui                      uses the token in src/scripts/config.js
//   CLAIMED_ACCOUNT=<id> npm run test:ui also checks an account that has already claimed on that token, and the
//   "register a new recipient and send" flow (UNREGISTERED_ACCOUNT=<existing NEAR account not yet on the token>,
//   default dev.testnet)
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
if (!existsSync(join(root, "index.html"))) { console.error("dist/ not found. Run `npm run build` first."); process.exit(2); }
const chromePath = ["google-chrome", "chromium", "chromium-browser", "chrome"].find((c) => { try { execSync(`command -v ${c}`, { stdio: "ignore" }); return true; } catch { return false; } });
if (!chromePath) { console.log("SKIP  no Chrome or Chromium found"); process.exit(0); }

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = join(root, p);
  if (!extname(p)) f = join(f, "index.html");
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const STUB = `export class NearConnector {
  constructor(){ this.h = {}; } on(e, f){ this.h[e] = f; }
  async wallet(){ const a = globalThis.__mockAccount; if (!a) throw new Error("no wallet connected");
    return { getAccounts: async () => [{ accountId: a, publicKey: "ed25519:mock" }],
             signAndSendTransaction: async (x) => { (globalThis.__txs ||= []).push(JSON.parse(JSON.stringify(x))); const last = x.actions[x.actions.length - 1].params.methodName; return { transaction: { hash: "MOCKHASH" }, status: { SuccessValue: last === "transfer_all" ? btoa('"98765432100000000000"') : "" }, receipts_outcome: [] }; } }; }
  async connect(){ return this.wallet(); } async disconnect(){} }`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbg = (...a) => { if (process.env.UI_DEBUG) console.error("[ui]", ...a); };

async function session(account, expression, wait = 5000) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/worgl-ui-${port}`, "about:blank"], { stdio: "ignore" });
  let ws;
  for (let i = 0; i < 60 && !ws; i++) { try { const pg = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch {} await sleep(200); }
  dbg("devtools socket found");
  await new Promise((r) => (ws.readyState === 1 ? r() : (ws.onopen = r)));   // it may already be open
  dbg("socket open");
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === "Fetch.requestPaused") {
      if (d.params.request.url.startsWith("https://esm.sh/")) send("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/javascript" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(STUB).toString("base64") });
      else send("Fetch.continueRequest", { requestId: d.params.requestId }); } };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://esm.sh/*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (account) await send("Page.addScriptToEvaluateOnNewDocument", { source: `globalThis.__mockAccount = ${JSON.stringify(account)};` });
  dbg("navigating to", `${base}/try`);
  await send("Page.navigate", { url: `${base}/try` });
  dbg("navigated; waiting", wait, "ms");
  await sleep(wait);
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  dbg("evaluate returned", JSON.stringify(r.result?.exceptionDetails ?? "ok").slice(0, 200));
  ws.close(); chrome.kill();
  return r.result?.result?.value;
}

const snapshot = `(async () => { const $ = (id) => document.getElementById(id); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { mode: $("try").dataset.mode, claimVisible: getComputedStyle($("claim")).display !== "none", claimDisabled: $("claim").disabled, status: $("claim-status").textContent, note: $("mode-note").textContent };
  if (!out.claimDisabled && out.claimVisible) { $("claim").click(); await sleep(500); out.tx = (globalThis.__txs || [])[0] ?? null; out.after = $("claim-status").textContent; }
  $("mode-sim").click(); await sleep(300); out.simNote = $("mode-note").textContent;
  return out; })()`;

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  [" + detail + "]"}`); if (!ok) failed++; };

// storage deposit the contract expects, read straight from the chain
const cfg = readFileSync(join(root, "..", "src", "scripts", "config.js"), "utf8");
const token = /"([a-z0-9._-]+\.testnet)";?\s*$/m.exec(cfg.split("\n").find((l) => l.includes("TOKEN_ID")))?.[1] ?? "worgl-token.testnet";
const params = await (async () => { const r = await (await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: token, method_name: "get_params", args_base64: btoa("{}") } }) })).json(); return JSON.parse(Buffer.from(r.result.result).toString()); })();

const none = await session(null, snapshot);
check("no wallet: the page starts in the simulation and hides the real Claim button", none.mode === "sim" && !none.claimVisible, JSON.stringify(none));

const fresh = await session("ui-test-fresh.testnet", snapshot);
check("a connected account that has not claimed: real mode, Claim is enabled", fresh.mode === "real" && fresh.claimVisible && fresh.claimDisabled === false, JSON.stringify(fresh));
check("clicking Claim asks the wallet to call claim on the token with the storage deposit and 30 Tgas",
  fresh.tx?.receiverId === token && fresh.tx.actions[0].params.methodName === "claim" && fresh.tx.actions[0].params.deposit === params.storage_cost && fresh.tx.actions[0].params.gas === "30000000000000", JSON.stringify(fresh.tx));
check("after the wallet confirms, the page says the claim went through", /Claimed 100 coins/.test(fresh.after ?? ""), fresh.after);
check("with a wallet connected, choosing the simulation explains that nothing is sent", /connected, but this is the simulation/.test(fresh.simNote), fresh.simNote);

const registerFlow = `(async () => { const $ = (id) => document.getElementById(id); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fill = (to, amt) => { $("to").value = to; $("to").dispatchEvent(new Event("input", {bubbles:true})); $("amount").value = amt; $("amount").dispatchEvent(new Event("input", {bubbles:true})); };
  const state = () => ({ status: $("send-status").textContent, confirm: !$("register-row").hidden });
  const out = {};
  fill("this-account-does-not-exist-xyz.testnet", "1"); $("send-form").requestSubmit(); await sleep(2500); out.typo = state();
  fill(${JSON.stringify(process.env.UNREGISTERED_ACCOUNT ?? "dev.testnet")}, "1"); $("send-form").requestSubmit(); await sleep(2500); out.ask = state(); out.txsBefore = (globalThis.__txs || []).length;
  $("send-register-cancel").click(); await sleep(100); out.cancelled = state();
  $("send-form").requestSubmit(); await sleep(2500); $("send-register").click(); await sleep(800);
  out.done = state(); out.tx = (globalThis.__txs || [])[0] ?? null; return out; })()`;

if (process.env.CLAIMED_ACCOUNT) {
  const claimed = await session(process.env.CLAIMED_ACCOUNT, snapshot);
  check("an account that already claimed: Claim is disabled and says why", claimed.mode === "real" && claimed.claimDisabled === true && /already claimed/.test(claimed.status), JSON.stringify(claimed));

  // The recipient must be a real NEAR account that has not set up the token. The token's live state changes
  // (visitors register accounts), so pick one now: UNREGISTERED_ACCOUNT if given, else the first candidate that fits.
  const rpc = async (body) => (await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: body }) })).json();
  const unregistered = async (a) => {
    const exists = !(await rpc({ request_type: "view_account", finality: "final", account_id: a })).error;
    const r = await rpc({ request_type: "call_function", finality: "final", account_id: token, method_name: "get_account", args_base64: Buffer.from(JSON.stringify({ account_id: a })).toString("base64") });
    return exists && JSON.parse(Buffer.from(r.result.result).toString()) === null;
  };
  let to = null;
  for (const a of process.env.UNREGISTERED_ACCOUNT ? [process.env.UNREGISTERED_ACCOUNT] : ["devworgl-c1.testnet", "devworgl-c2.testnet", "devworgl-c3.testnet", "devworgl-signer.testnet", "dev.testnet"]) { if (await unregistered(a)) { to = a; break; } }
  if (!to) console.log("SKIP  register-and-send checks: no existing account without the token was found (set UNREGISTERED_ACCOUNT=<one>)");
  else {
    const registerFlowFor = registerFlow.replace(JSON.stringify(process.env.UNREGISTERED_ACCOUNT ?? "dev.testnet"), JSON.stringify(to));
    const reg = await session(process.env.CLAIMED_ACCOUNT, registerFlowFor, 6500);
    check("sending to a name that is not a NEAR account is caught before anyone pays", /No testnet account called/.test(reg.typo.status) && !reg.typo.confirm, JSON.stringify(reg.typo));
    check("sending to an existing account that has not set up the token asks first, and sends nothing yet", reg.ask.confirm && /has not set up WORGL/.test(reg.ask.status) && reg.txsBefore === 0, JSON.stringify(reg.ask));
    check("Cancel hides the confirmation", reg.cancelled.confirm === false, JSON.stringify(reg.cancelled));
    const acts = reg.tx?.actions?.map((a) => a.params) ?? [];
    check("confirming signs ONE transaction: register the recipient (deposit paid by the sender), then send with 1 yocto",
      acts.length === 2 && acts[0].methodName === "storage_deposit" && acts[0].args.account_id === to && acts[0].deposit === params.storage_cost
        && acts[1].methodName === "ft_transfer" && acts[1].args.receiver_id === to && acts[1].deposit === "1", JSON.stringify(acts));
    check("then the page says the recipient was registered and paid", /Registered .* and sent/.test(reg.done.status), reg.done.status);
  }

  // ---- Max: send everything with transfer_all (no typed amount, no margin)
  const maxFlow = (toName, thenType) => `(async () => { const $ = (id) => document.getElementById(id); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const set = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event("input", {bubbles:true})); };
    set("to", ${JSON.stringify(toName)}); $("max").click(); await sleep(200); const afterMax = { amountField: $("amount").value, status: $("send-status").textContent };
    ${thenType ? 'set("amount", "1");' : ""}
    $("send-form").requestSubmit(); await sleep(2500);
    const asked = { confirm: !$("register-row").hidden, status: $("send-status").textContent };
    if (asked.confirm) { $("send-register").click(); await sleep(800); }
    return { afterMax, asked, done: $("send-status").textContent, tx: (globalThis.__txs || [])[0] ?? null }; })()`;
  const registeredRecipient = async (a) => !(await unregistered(a)) && !(await rpc({ request_type: "view_account", finality: "final", account_id: a })).error
    && JSON.parse(Buffer.from((await rpc({ request_type: "call_function", finality: "final", account_id: token, method_name: "get_account", args_base64: Buffer.from(JSON.stringify({ account_id: a })).toString("base64") })).result.result).toString()) !== null;
  const regd = process.env.REGISTERED_RECIPIENT ?? "dev.testnet";
  if (await registeredRecipient(regd)) {
    const m = await session(process.env.CLAIMED_ACCOUNT, maxFlow(regd, false), 6500);
    const a = m.tx?.actions?.map((x) => x.params) ?? [];
    check("Max puts your balance in the box and says it sends everything", /^\d+\.\d+$/.test(m.afterMax.amountField) && /everything you hold/.test(m.afterMax.status), JSON.stringify(m.afterMax));
    check("Max then Send calls transfer_all (no amount, 1 yocto), not ft_transfer", a.length === 1 && a[0].methodName === "transfer_all" && a[0].args.receiver_id === regd && !("amount" in a[0].args) && a[0].deposit === "1", JSON.stringify(a));
    check("the page shows the amount the transaction reports", /Sent 98\.7654 coins to/.test(m.done), m.done);
    const typed = await session(process.env.CLAIMED_ACCOUNT, maxFlow(regd, true), 6500);
    const ta = typed.tx?.actions?.map((x) => x.params) ?? [];
    check("typing an amount after Max goes back to a normal ft_transfer of that amount", ta.length === 1 && ta[0].methodName === "ft_transfer" && ta[0].args.amount === "1000000000000000000", JSON.stringify(ta));
  } else console.log(`SKIP  Max to a registered recipient (${regd} is not registered; set REGISTERED_RECIPIENT=<one>)`);
  if (to) {
    const m2 = await session(process.env.CLAIMED_ACCOUNT, maxFlow(to, false), 6500);
    const a2 = m2.tx?.actions?.map((x) => x.params) ?? [];
    check("Max to an unregistered account: asks first, then registers and sends everything in one transaction",
      m2.asked.confirm && /everything you hold/.test(m2.asked.status) && a2.length === 2 && a2[0].methodName === "storage_deposit" && a2[1].methodName === "transfer_all" && a2[1].args.receiver_id === to && a2[1].deposit === "1", JSON.stringify({ asked: m2.asked, a2 }));
    check("and reports the amount sent", /Registered .* and sent 98\.7654 coins/.test(m2.done), m2.done);
  }
} else console.log("SKIP  already-claimed account (set CLAIMED_ACCOUNT=<account that has claimed> to check it)");

server.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL UI CHECKS PASSED");
process.exit(failed ? 1 : 0);
