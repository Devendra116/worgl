// Browser test of the wallet flow, with a FAKE wallet (no real wallet, no keys, nothing is sent to the chain).
// It loads the built site in headless Chrome, replaces the wallet library with a stub, and checks that the
// Claim button and the messages around it behave. Needs: `npm run build` first, Chrome or Chromium, network.
//   npm run test:ui                      uses the token in src/scripts/config.js
//   CLAIMED_ACCOUNT=<id> npm run test:ui also checks an account that has already claimed on that token
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
             signAndSendTransaction: async (x) => { (globalThis.__txs ||= []).push(JSON.parse(JSON.stringify(x))); return { transaction: { hash: "MOCKHASH" }, receipts_outcome: [] }; } }; }
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
const token = /"([a-z0-9._-]+\.testnet)";?\s*$/m.exec(cfg.split("\n").find((l) => l.includes("TOKEN_ID")))?.[1] ?? "worgl-demo.testnet";
const params = await (async () => { const r = await (await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: token, method_name: "get_params", args_base64: btoa("{}") } }) })).json(); return JSON.parse(Buffer.from(r.result.result).toString()); })();

const none = await session(null, snapshot);
check("no wallet: the page starts in the simulation and hides the real Claim button", none.mode === "sim" && !none.claimVisible, JSON.stringify(none));

const fresh = await session("ui-test-fresh.testnet", snapshot);
check("a connected account that has not claimed: real mode, Claim is enabled", fresh.mode === "real" && fresh.claimVisible && fresh.claimDisabled === false, JSON.stringify(fresh));
check("clicking Claim asks the wallet to call claim on the token with the storage deposit and 30 Tgas",
  fresh.tx?.receiverId === token && fresh.tx.actions[0].params.methodName === "claim" && fresh.tx.actions[0].params.deposit === params.storage_cost && fresh.tx.actions[0].params.gas === "30000000000000", JSON.stringify(fresh.tx));
check("after the wallet confirms, the page says the claim went through", /Claimed 100 coins/.test(fresh.after ?? ""), fresh.after);
check("with a wallet connected, choosing the simulation explains that nothing is sent", /connected, but this is the simulation/.test(fresh.simNote), fresh.simNote);

if (process.env.CLAIMED_ACCOUNT) {
  const claimed = await session(process.env.CLAIMED_ACCOUNT, snapshot);
  check("an account that already claimed: Claim is disabled and says why", claimed.mode === "real" && claimed.claimDisabled === true && /already claimed/.test(claimed.status), JSON.stringify(claimed));
} else console.log("SKIP  already-claimed account (set CLAIMED_ACCOUNT=<account that has claimed> to check it)");

server.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL UI CHECKS PASSED");
process.exit(failed ? 1 : 0);
