import { TOKEN_ID, RPC_URL, EXPLORER_TX, EXPLORER_ACCOUNT } from "./config.js";
import { Chain, indexAt, balanceOfShares, circulatingOf, treasuryOf, formatCoins } from "./worgl.js";

const $ = (id) => document.getElementById(id);
const chain = new Chain(RPC_URL, TOKEN_ID);
const CONNECT_URL = "https://esm.sh/@hot-labs/near-connect@0.12.0"; // pinned version

let params = null;                 // get_params (fixed after init)
let sync = null;                   // { chainNs, perf, stats, account }
let accountId = null;
let connector = null;
let busy = false;

$("token-link").textContent = TOKEN_ID;
$("token-link").href = EXPLORER_ACCOUNT + TOKEN_ID;

// ---------------------------------------------------------------- activity log
function log(html) {
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<time>${t}</time>${html}`;
  $("log").prepend(li);
  while ($("log").children.length > 100) $("log").lastChild.remove();
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const txLink = (h) => `<a href="${EXPLORER_TX}${encodeURIComponent(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 8))}…</a>`;

// ---------------------------------------------------------------- chain sync
async function refresh() {
  try {
    const h = await chain.finalHeight(); // pin all views to one block
    if (!params) {
      params = await chain.view("get_params", {}, h);
      log(`Connected to <code>${esc(TOKEN_ID)}</code>. Governor: <code>${esc(params.governor)}</code>.`);
    }
    const [stats, account] = await Promise.all([
      chain.view("get_stats", {}, h),
      accountId ? chain.view("get_account", { account_id: accountId }, h) : null,
    ]);
    const prev = sync?.stats;
    if (prev) {
      const paid = BigInt(stats.day_paid) - BigInt(prev.day_paid);
      if (stats.day === prev.day && paid > 0n) log(`Treasury paid out ${formatCoins(paid, 2)} WORGL (faucet claim or DAO payout).`);
      if (stats.holders !== prev.holders) log(`Registered accounts: ${stats.holders}.`);
    }
    sync = { chainNs: BigInt(stats.block_timestamp_ns), perf: performance.now(), stats, account };
    $("balance-note").textContent = accountId
      ? account ? `${accountId} · ${account.claimed ? "faucet already claimed" : "faucet not claimed yet"}` : `${accountId} is not registered yet. Claiming registers it.`
      : "Connect a wallet to see your balance.";
    updateClaimButton();
  } catch (e) {
    $("claim-status").textContent = "";
    log(`<span style="color:var(--bad)">Could not read the chain: ${esc(e.message)}</span>`);
  }
}

// ---------------------------------------------------------------- ticking numbers
function chainNowNs() {
  return sync.chainNs + BigInt(Math.round((performance.now() - sync.perf) * 1e6));
}
function tick() {
  if (!sync || !params) return;
  const idx = indexAt(BigInt(params.factor), BigInt(params.start_ns), chainNowNs());
  const circ = circulatingOf(BigInt(sync.stats.total_shares), idx);
  $("circulating").textContent = formatCoins(circ, 4);
  $("treasury").textContent = formatCoins(treasuryOf(circ), 4);
  $("balance").textContent = sync.account ? formatCoins(balanceOfShares(BigInt(sync.account.shares), idx), 4) + " WORGL" : accountId ? "0.0000 WORGL" : "–";
  const cap = BigInt(sync.stats.day_cap), left = BigInt(sync.stats.day_remaining);
  $("allowance").textContent = formatCoins(left, 2);
  $("allowance-bar").style.width = cap > 0n ? `${Number((left * 1000n) / cap) / 10}%` : "0%";
  $("allowance-note").textContent = `of ${formatCoins(cap, 2)} for UTC day ${sync.stats.day}. Faucet claims and payouts share this cap (10% of the treasury at the start of the day).`;
}

// ---------------------------------------------------------------- wallet
function updateClaimButton() {
  const b = $("claim");
  const claimed = sync?.account?.claimed;
  b.disabled = busy || !accountId || !sync || !!claimed;
  b.textContent = claimed ? "Already claimed" : "Claim 100 WORGL";
  $("connect").textContent = accountId ? "Disconnect" : "Connect wallet";
  $("account").textContent = accountId ?? "Not connected";
}

async function setAccountFromWallet() {
  try {
    const wallet = await connector.wallet();
    const accts = await wallet.getAccounts();
    accountId = accts[0]?.accountId ?? null;
  } catch { accountId = null; }
  if (accountId) log(`Wallet connected: <code>${esc(accountId)}</code>.`);
  await refresh();
}

async function initWallet() {
  try {
    const { NearConnector } = await import(CONNECT_URL);
    connector = new NearConnector({ network: "testnet", features: { testnet: true } });
    connector.on("wallet:signIn", setAccountFromWallet);
    connector.on("wallet:signOut", () => { accountId = null; sync && (sync.account = null); log("Wallet disconnected."); refresh(); });
    await setAccountFromWallet(); // restores a previous session if there is one
  } catch (e) {
    $("connect").disabled = true;
    $("account").textContent = "Wallet connector unavailable (read-only mode)";
    log(`Wallet connector could not load: ${esc(e.message)}. Balances still update.`);
  }
}

$("connect").addEventListener("click", async () => {
  if (!connector) return;
  try {
    if (accountId) await connector.disconnect();
    else await connector.connect();
  } catch (e) { log(`Wallet: ${esc(e.message ?? e)}`); }
});

$("claim").addEventListener("click", async () => {
  if (!connector || !accountId || !params) return;
  busy = true; updateClaimButton();
  $("claim-status").className = "status";
  $("claim-status").textContent = "Waiting for your wallet…";
  try {
    const registered = !!sync?.account;
    const wallet = await connector.wallet();
    const out = await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: TOKEN_ID,
      actions: [{ type: "FunctionCall", params: {
        methodName: "claim", args: {}, gas: "30000000000000",
        // A new account attaches the storage deposit; the contract refunds any excess.
        deposit: registered ? "0" : params.storage_cost,
      } }],
    });
    const hash = out?.transaction?.hash ?? out?.transaction_outcome?.id ?? "";
    log(`Claim sent${hash ? " " + txLink(hash) : ""}.`);
    $("claim-status").textContent = "Claimed. Updating…";
    await new Promise((r) => setTimeout(r, 2500));
    await refresh();
    $("claim-status").textContent = "";
  } catch (e) {
    $("claim-status").className = "status err";
    $("claim-status").textContent = String(e.message ?? e).slice(0, 200);
    log(`Claim failed: ${esc(String(e.message ?? e).slice(0, 200))}`);
  } finally { busy = false; updateClaimButton(); }
});

// ---------------------------------------------------------------- start
await refresh();
setInterval(tick, 250);
setInterval(refresh, 8000);
tick();
initWallet();
