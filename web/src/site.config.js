// Facts that are baked into the HTML at build time, so they are visible before any script runs.
// Keep TOKEN_ID and DAO_ID in step with the deployment. At run time the page still reads the live
// contract, and `?token=<account>` in the address overrides TOKEN_ID (see src/scripts/config.js).
export const SITE = {
  TOKEN_ID: "worgl-token.testnet",
  DAO_ID: "devworgl-dao.sputnikv2.testnet",
  EXPLORER: "https://testnet.nearblocks.io",
  REPO: "https://github.com/Devendra116/worgl",
};
