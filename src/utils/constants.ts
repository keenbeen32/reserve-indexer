// Ported from dtf-index-subgraph/src/utils/constants.ts.
// AssemblyScript BigInt/BigDecimal → native BigInt + envio BigDecimal.

import { BigDecimal } from "envio";

export const DEFAULT_DECIMALS = 18;
export const GENESIS_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export const SECONDS_PER_DAY = BigInt(60 * 60 * 24);
export const SECONDS_PER_HOUR = BigInt(60 * 60);
export const SECONDS_PER_MONTH = BigInt(60 * 60 * 24 * 30); // 30 day approximation

export const BIGINT_ZERO = BigInt(0);
export const BIGINT_ONE = BigInt(1);
export const BIGINT_TWO = BigInt(2);
export const BIGDECIMAL_ZERO = new BigDecimal(0);
export const BIGDECIMAL_ONE = new BigDecimal(1);

export const TokenType = {
  DTF: "DTF",
  VOTE: "VOTE",
  ASSET: "ASSET",
  BRIDGED_DTF: "BRIDGED_DTF",
} as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const TradeState = {
  APPROVED: "APPROVED",
  LAUNCHED: "LAUNCHED",
  CLOSED: "CLOSED",
} as const;
export type TradeState = (typeof TradeState)[keyof typeof TradeState];

export const ProposalState = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  CANCELED: "CANCELED",
  DEFEATED: "DEFEATED",
  SUCCEEDED: "SUCCEEDED",
  QUEUED: "QUEUED",
  EXPIRED: "EXPIRED",
  EXECUTED: "EXECUTED",
  VETOED: "VETOED",
} as const;
export type ProposalState = (typeof ProposalState)[keyof typeof ProposalState];

export const VoteChoice = {
  AGAINST_VALUE: 0,
  FOR_VALUE: 1,
  ABSTAIN_VALUE: 2,
  AGAINST: "AGAINST",
  FOR: "FOR",
  ABSTAIN: "ABSTAIN",
} as const;

export const GovernanceType = {
  OWNER: "OWNER",
  TRADING: "TRADING",
  VOTE_LOCKING: "VOTE_LOCKING",
} as const;

export const Role = {
  DEFAULT_ADMIN: "0x0000000000000000000000000000000000000000000000000000000000000000",
  BRAND_MANAGER: "0x2d8e650da9bd8c373ab2450d770f2ed39549bfc28d3630025cecc51511bcd374",
  // Subgraph stores this without a "0x" prefix; preserved verbatim. Compare with lowercase.
  REBALANCE_MANAGER: "4ff6ae4d6a29e79ca45c6441bdc89b93878ac6118485b33c8baa3749fc3cb130",
  AUCTION_LAUNCHER: "0x13ff1b2625181b311f257c723b5e6d366eb318b212d9dd694c48fcf227659df5",
  CANCELLER: "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783",
  OPTIMISTIC_PROPOSER: "0x26f49d08685d9cdd4951a7470bc8fbe9dd0f00419c1a44c1b89f845867ae12e0",
  // Deprecated v4.0 role
  AUCTION_APPROVER: "0x2be23b023f3eee571adc019cdcf3f0bcf041151e6ff405a4bf0c4bfc6faea8c9",
} as const;

// Normalize role hex for comparison (handles missing 0x prefix in REBALANCE_MANAGER).
export function normalizeRole(hex: string): string {
  const lower = hex.toLowerCase();
  return lower.startsWith("0x") ? lower : `0x${lower}`;
}

// Compose multichain entity ID: ${chainId}-${idPart}.
// Always lowercase addresses before composing.
export function chainId(chain: number, suffix: string): string {
  return `${chain}-${suffix.toLowerCase()}`;
}
