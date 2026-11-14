// Edit TOKEN_ID for your deployment, or open the page with ?token=<account>.
export const TOKEN_ID = new URLSearchParams(location.search).get("token") || "worgl-demo.testnet";
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io";
export const ACTIVITY_API = "https://api-testnet.nearblocks.io/v3"; // NearBlocks v3 (v1 was retired 2026-11-05)
export const REPO = "https://github.com/devendra116/worgl";
export const CONNECT_URL = "https://esm.sh/@hot-labs/near-connect@0.12.0"; // pinned
