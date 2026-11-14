// Run-time settings for the page scripts. The defaults come from src/site.config.js (shared with the HTML).
// Open any page with ?token=<account> to point it at another token.
import { SITE } from "../site.config.js";
export const TOKEN_ID = new URLSearchParams(location.search).get("token") || SITE.TOKEN_ID;
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const EXPLORER = SITE.EXPLORER;
export const ACTIVITY_API = "https://api-testnet.nearblocks.io/v3"; // NearBlocks v3 (v1 was retired 2026-11-05)
export const REPO = SITE.REPO;
export const CONNECT_URL = "https://esm.sh/@hot-labs/near-connect@0.12.0"; // pinned
