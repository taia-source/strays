/**
 * On-chain addresses, in ONE place.
 *
 * `@taia/deploy`'s rule: a placeholder or a wrong-network address is the defect that ships silently.
 * Every value here was READ BACK from the deployed bytecode after deployment (see DEPLOYMENTS.md),
 * not copied from what we intended to send.
 */
export const CHAIN_ID = 4663;
export const CHAIN_NAME = "Robinhood Chain";
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** StrayVault — deployed and source-verified 2026-08-07. */
export const VAULT_ADDRESS = "0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33" as const;

/**
 * The block the vault was deployed in. Log scans start HERE, never at 0.
 *
 * Scanning from genesis on a chain at ~30M blocks is a multi-second request that returns nothing
 * for every block before this one. Measured during the build: it hung page loads for 30s.
 */
export const VAULT_DEPLOY_BLOCK = 30275947n;

export const PAD_API = "https://api.letscash.fun/api";
export const PAD_SITE = "https://www.letscash.fun";

/** Economics, mirrored from the contract's own constants. The contract is the source of truth. */
export const ENERGY_FEE_BPS = 2000;
export const PROFIT_RAKE_BPS = 1000;
export const MAX_POSITION_WEI = 10_000_000_000_000_000n;
export const MIN_ADOPT_WEI = 1_000_000_000_000_000n;
