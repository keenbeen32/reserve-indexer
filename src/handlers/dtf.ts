// DTF template handlers — ported from dtf-index-subgraph/src/dtf/handlers.ts
// + mappings.ts. Covers Rebalance / Auction / AuctionBid / Fee / Role / Setting
// events plus the deprecated v1/v2 Trade lifecycle.

import type { Entity } from "envio";
import { indexer } from "envio";

import { getTxReceiptLogs, type RawLog } from "../effects/receiptLogs";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  GovernanceType,
  Role,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MONTH,
  TokenType,
  TradeState,
  chainId as makeId,
  normalizeRole,
} from "../utils/constants";
import {
  createGovernanceTimelock,
  getOrCreateRSRBurnGlobal,
  getOrCreateToken,
} from "../utils/getters";
import { parseAuctionBidsFromLogs } from "../utils/rebalance";
import { processTransfer } from "./token";
import { removeFromArrayAtIndex } from "../utils/arrays";

const ROLE_REBALANCE_MANAGER = normalizeRole(Role.REBALANCE_MANAGER);
const ROLE_AUCTION_APPROVER = normalizeRole(Role.AUCTION_APPROVER);
const ROLE_AUCTION_LAUNCHER = normalizeRole(Role.AUCTION_LAUNCHER);
const ROLE_BRAND_MANAGER = normalizeRole(Role.BRAND_MANAGER);
const ROLE_DEFAULT_ADMIN = normalizeRole(Role.DEFAULT_ADMIN);

function dtfId(chainId: number, addr: string): string {
  return makeId(chainId, addr);
}

function rebalanceId(chainId: number, dtfAddr: string, nonce: bigint): string {
  // Subgraph uses nonce.toHexString() — preserve.
  return `${makeId(chainId, dtfAddr)}-0x${nonce.toString(16)}`;
}

function auctionId(chainId: number, dtfAddr: string, aId: bigint): string {
  return `${makeId(chainId, dtfAddr)}-${aId}`;
}

// =====================================================
// RebalanceStarted V4
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RebalanceStartedV4" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const nonce = event.params.nonce;

    const tokenIds: string[] = [];
    const weightLowLimit: bigint[] = [];
    const weightSpotLimit: bigint[] = [];
    const weightHighLimit: bigint[] = [];
    const priceLowLimit: bigint[] = [];
    const priceHighLimit: bigint[] = [];

    for (let i = 0; i < event.params.tokens.length; i++) {
      const tokenAddr = event.params.tokens[i]!.toLowerCase();
      const tok = await getOrCreateToken(context, chainId, tokenAddr, TokenType.ASSET);
      tokenIds.push(tok.id);
      const w = event.params.weights[i]!;
      const p = event.params.prices[i]!;
      weightLowLimit.push(w[0]);
      weightSpotLimit.push(w[1]);
      weightHighLimit.push(w[2]);
      priceLowLimit.push(p[0]);
      priceHighLimit.push(p[1]);
    }

    const limits = event.params.limits;
    const rebalance: Entity<"Rebalance"> = {
      id: rebalanceId(chainId, dtfAddr, nonce),
      nonce,
      dtf_id: dtfId(chainId, dtfAddr),
      tokens: tokenIds,
      priceControl: event.params.priceControl.toString(),
      weightLowLimit,
      weightSpotLimit,
      weightHighLimit,
      rebalanceLowLimit: limits[0],
      rebalanceSpotLimit: limits[1],
      rebalanceHighLimit: limits[2],
      priceLowLimit,
      priceHighLimit,
      restrictedUntil: event.params.restrictedUntil,
      availableUntil: event.params.availableUntil,
      startedAt: undefined,
      bidsEnabled: undefined,
      maxAuctionSize: undefined,
      inRebalance: undefined,
      transactionHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    context.Rebalance.set(rebalance);

    if (nonce > BIGINT_ZERO) {
      await endRebalance(context, chainId, dtfAddr, nonce - BIGINT_ONE, BigInt(event.block.timestamp));
    }
  },
);

// =====================================================
// RebalanceStarted V5
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RebalanceStartedV5" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const nonce = event.params.nonce;

    const tokenIds: string[] = [];
    const weightLowLimit: bigint[] = [];
    const weightSpotLimit: bigint[] = [];
    const weightHighLimit: bigint[] = [];
    const priceLowLimit: bigint[] = [];
    const priceHighLimit: bigint[] = [];
    const maxAuctionSizes: bigint[] = [];
    const inRebalanceFlags: string[] = [];

    for (const t of event.params.tokens) {
      const tokenAddr = (t[0] as string).toLowerCase();
      const tok = await getOrCreateToken(context, chainId, tokenAddr, TokenType.ASSET);
      tokenIds.push(tok.id);
      weightLowLimit.push(t[1][0]);
      weightSpotLimit.push(t[1][1]);
      weightHighLimit.push(t[1][2]);
      priceLowLimit.push(t[2][0]);
      priceHighLimit.push(t[2][1]);
      maxAuctionSizes.push(t[3]);
      inRebalanceFlags.push(String(t[4]));
    }

    const limits = event.params.limits;
    const rebalance: Entity<"Rebalance"> = {
      id: rebalanceId(chainId, dtfAddr, nonce),
      nonce,
      dtf_id: dtfId(chainId, dtfAddr),
      tokens: tokenIds,
      priceControl: event.params.priceControl.toString(),
      weightLowLimit,
      weightSpotLimit,
      weightHighLimit,
      rebalanceLowLimit: limits[0],
      rebalanceSpotLimit: limits[1],
      rebalanceHighLimit: limits[2],
      priceLowLimit,
      priceHighLimit,
      restrictedUntil: event.params.restrictedUntil,
      availableUntil: event.params.availableUntil,
      startedAt: event.params.startedAt,
      bidsEnabled: event.params.bidsEnabled,
      maxAuctionSize: maxAuctionSizes,
      inRebalance: inRebalanceFlags,
      transactionHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    context.Rebalance.set(rebalance);

    if (nonce > BIGINT_ZERO) {
      await endRebalance(context, chainId, dtfAddr, nonce - BIGINT_ONE, BigInt(event.block.timestamp));
    }
  },
);

// =====================================================
// RebalanceEnded
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RebalanceEnded" },
  async ({ event, context }) => {
    await endRebalance(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.nonce,
      BigInt(event.block.timestamp),
    );
  },
);

async function endRebalance(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  dtfAddr: string,
  nonce: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  const id = rebalanceId(chainId, dtfAddr, nonce);
  const rebalance = await context.Rebalance.get(id);
  if (rebalance && rebalance.availableUntil > blockTimestamp) {
    context.Rebalance.set({ ...rebalance, availableUntil: blockTimestamp });
  }
}

// =====================================================
// RebalanceControlSet
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RebalanceControlSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({
      ...dtf,
      weightControl: event.params.newControl[0],
      priceControl: Number(event.params.newControl[1]),
    });
  },
);

// =====================================================
// v5.0 BidsEnabledSet
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "BidsEnabledSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({ ...dtf, bidsEnabled: event.params.bidsEnabled });
  },
);

// =====================================================
// v5.0 NameSet — updates Token entity
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "NameSet" },
  async ({ event, context }) => {
    const token = await getOrCreateToken(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      TokenType.DTF,
    );
    context.Token.set({ ...token, name: event.params.newName });
  },
);

// =====================================================
// v5.0 TrustedFillerRegistrySet
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "TrustedFillerRegistrySet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({
      ...dtf,
      trustedFillerRegistry: event.params.trustedFillerRegistry.toLowerCase(),
      trustedFillerEnabled: event.params.isEnabled,
    });
  },
);

// =====================================================
// AuctionOpenedV5 (singleton)
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "AuctionOpenedV5" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const tokenIds: string[] = [];
    const weightLowLimit: bigint[] = [];
    const weightSpotLimit: bigint[] = [];
    const weightHighLimit: bigint[] = [];
    const priceLowLimit: bigint[] = [];
    const priceHighLimit: bigint[] = [];

    for (let i = 0; i < event.params.tokens.length; i++) {
      const tokenAddr = event.params.tokens[i]!.toLowerCase();
      const tok = await getOrCreateToken(context, chainId, tokenAddr, TokenType.ASSET);
      tokenIds.push(tok.id);
      const w = event.params.weights[i]!;
      const p = event.params.prices[i]!;
      weightLowLimit.push(w[0]);
      weightSpotLimit.push(w[1]);
      weightHighLimit.push(w[2]);
      priceLowLimit.push(p[0]);
      priceHighLimit.push(p[1]);
    }

    const limits = event.params.limits;
    const auction: Entity<"Auction"> = {
      id: auctionId(chainId, dtfAddr, event.params.auctionId),
      dtf_id: dtfId(chainId, dtfAddr),
      rebalance_id: rebalanceId(chainId, dtfAddr, event.params.rebalanceNonce),
      tokens: tokenIds,
      weightLowLimit,
      weightSpotLimit,
      weightHighLimit,
      rebalanceLowLimit: limits[0],
      rebalanceSpotLimit: limits[1],
      rebalanceHighLimit: limits[2],
      priceLowLimit,
      priceHighLimit,
      startTime: event.params.startTime,
      endTime: event.params.endTime,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      transactionHash: event.transaction.hash,
    };
    context.Auction.set(auction);
  },
);

// =====================================================
// AuctionBidV5 (singleton)
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "AuctionBidV5" },
  async ({ event, context }) => {
    await writeRebalanceAuctionBid(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.auctionId,
      event.params.sellToken.toLowerCase(),
      event.params.buyToken.toLowerCase(),
      event.params.sellAmount,
      event.params.buyAmount,
      event.transaction.from
        ? (event.transaction.from as string).toLowerCase()
        : "0x0000000000000000000000000000000000000000",
      undefined,
      event.transaction.hash,
      event.logIndex,
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
    );
  },
);

async function writeRebalanceAuctionBid(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  dtfAddr: string,
  aId: bigint,
  sellTokenAddr: string,
  buyTokenAddr: string,
  sellAmount: bigint,
  buyAmount: bigint,
  bidder: string,
  filler: string | undefined,
  txHash: string,
  logIndex: number,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const sellToken = await getOrCreateToken(context, chainId, sellTokenAddr, TokenType.ASSET);
  const buyToken = await getOrCreateToken(context, chainId, buyTokenAddr, TokenType.ASSET);
  const id = makeId(chainId, `${dtfAddr}-${aId}-${bidder}-${blockNumber}-${logIndex}`);
  const bid: Entity<"RebalanceAuctionBid"> = {
    id,
    dtf_id: dtfId(chainId, dtfAddr),
    auction_id: auctionId(chainId, dtfAddr, aId),
    bidder,
    filler,
    sellToken_id: sellToken.id,
    buyToken_id: buyToken.id,
    sellAmount,
    buyAmount,
    blockNumber,
    timestamp,
    transactionHash: txHash,
  };
  context.RebalanceAuctionBid.set(bid);
}

// =====================================================
// AuctionTrustedFillCreated
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "AuctionTrustedFillCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const filler = event.params.filler.toLowerCase();
    // Effect throws (uncached) on RPC failure; fall back to [] (no bids parsed)
    // so a transient blip retries on the next run instead of caching empty logs.
    const logs = await context
      .effect(getTxReceiptLogs, {
        chainId,
        txHash: event.transaction.hash,
      })
      .catch((): RawLog[] => []);
    const bids = parseAuctionBidsFromLogs(dtfAddr, logs);
    const bidder = event.transaction.from
      ? (event.transaction.from as string).toLowerCase()
      : filler;

    for (const b of bids) {
      await writeRebalanceAuctionBid(
        context,
        chainId,
        dtfAddr,
        event.params.auctionId,
        b.sellToken,
        b.buyToken,
        b.sellAmount,
        b.buyAmount,
        bidder,
        filler,
        event.transaction.hash,
        event.logIndex,
        BigInt(event.block.number),
        BigInt(event.block.timestamp),
      );
    }
  },
);

// =====================================================
// Transfer — share-token mint/burn/transfer
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "Transfer" },
  async ({ event, context }) => {
    await processTransfer(
      context,
      event.chainId,
      event.srcAddress,
      "DTF",
      event.params.from,
      event.params.to,
      event.params.value,
      event.transaction.hash,
      event.logIndex,
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
      { useReceiptForTrueMinter: true },
    );
  },
);

// =====================================================
// FolioFeePaid
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "FolioFeePaid" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const id = dtfId(chainId, dtfAddr);
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    const amount = event.params.amount;
    const recipient = event.params.recipient.toLowerCase();

    let isGovernanceToken = false;
    if (dtf.ownerGovernance_id) {
      const gov = await context.Governance.get(dtf.ownerGovernance_id);
      if (gov) {
        // gov.token_id is namespaced "chainId-addr"; extract address.
        const govTokenAddr = gov.token_id.split("-")[1];
        isGovernanceToken = govTokenAddr === recipient;
      }
    }

    const newTotal = dtf.totalRevenue + amount;
    let next: Entity<"DTF"> = { ...dtf, totalRevenue: newTotal };
    if (isGovernanceToken) {
      next = { ...next, governanceRevenue: dtf.governanceRevenue + amount };
    } else {
      next = { ...next, externalRevenue: dtf.externalRevenue + amount };
    }
    context.DTF.set(next);

    const token = await getOrCreateToken(context, chainId, dtfAddr, TokenType.DTF);
    const blockNumber = BigInt(event.block.number);
    const timestamp = BigInt(event.block.timestamp);

    await applyRevenueToSnapshots(
      context,
      token,
      amount,
      isGovernanceToken ? "governance" : "external",
      next,
      blockNumber,
      timestamp,
    );
  },
);

// =====================================================
// ProtocolFeePaid
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "ProtocolFeePaid" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const id = dtfId(chainId, dtfAddr);
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    const amount = event.params.amount;
    const newDtf: Entity<"DTF"> = {
      ...dtf,
      totalRevenue: dtf.totalRevenue + amount,
      protocolRevenue: dtf.protocolRevenue + amount,
    };
    context.DTF.set(newDtf);

    const token = await getOrCreateToken(context, chainId, dtfAddr, TokenType.DTF);
    await applyRevenueToSnapshots(
      context,
      token,
      amount,
      "protocol",
      newDtf,
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
    );
  },
);

async function applyRevenueToSnapshots(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  token: Entity<"Token">,
  amount: bigint,
  kind: "protocol" | "governance" | "external",
  dtf: Entity<"DTF">,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const dailyId = `${token.id}-${timestamp / SECONDS_PER_DAY}`;
  const hourlyId = `${token.id}-${timestamp / SECONDS_PER_HOUR}`;
  const monthlyId = `${token.id}-${timestamp / SECONDS_PER_MONTH}`;

  const daily = (await context.TokenDailySnapshot.get(dailyId)) ?? {
    id: dailyId,
    token_id: token.id,
    dailyTotalSupply: token.totalSupply,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: token.cumulativeHolderCount,
    dailyEventCount: 0,
    dailyTransferCount: 0,
    dailyTransferAmount: BIGINT_ZERO,
    dailyMintCount: 0,
    dailyMintAmount: BIGINT_ZERO,
    dailyBurnCount: 0,
    dailyBurnAmount: BIGINT_ZERO,
    dailyRevenue: BIGINT_ZERO,
    dailyProtocolRevenue: BIGINT_ZERO,
    dailyGovernanceRevenue: BIGINT_ZERO,
    dailyExternalRevenue: BIGINT_ZERO,
    blockNumber,
    timestamp,
  };
  const hourly = (await context.TokenHourlySnapshot.get(hourlyId)) ?? {
    id: hourlyId,
    token_id: token.id,
    hourlyTotalSupply: token.totalSupply,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: token.cumulativeHolderCount,
    hourlyEventCount: 0,
    hourlyTransferCount: 0,
    hourlyTransferAmount: BIGINT_ZERO,
    hourlyMintCount: 0,
    hourlyMintAmount: BIGINT_ZERO,
    hourlyBurnCount: 0,
    hourlyBurnAmount: BIGINT_ZERO,
    hourlyRevenue: BIGINT_ZERO,
    hourlyProtocolRevenue: BIGINT_ZERO,
    hourlyGovernanceRevenue: BIGINT_ZERO,
    hourlyExternalRevenue: BIGINT_ZERO,
    blockNumber,
    timestamp,
  };
  const monthly = (await context.TokenMonthlySnapshot.get(monthlyId)) ?? {
    id: monthlyId,
    token_id: token.id,
    monthlyTotalSupply: token.totalSupply,
    monthlyMintAmount: BIGINT_ZERO,
    monthlyMintCount: 0,
    monthlyBurnAmount: BIGINT_ZERO,
    monthlyBurnCount: 0,
    monthlyTransferCount: 0,
    monthlyTransferAmount: BIGINT_ZERO,
    monthlyEventCount: 0,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: token.cumulativeHolderCount,
    monthlyRevenue: BIGINT_ZERO,
    monthlyProtocolRevenue: BIGINT_ZERO,
    monthlyGovernanceRevenue: BIGINT_ZERO,
    monthlyExternalRevenue: BIGINT_ZERO,
    cumulativeRevenue: BIGINT_ZERO,
    cumulativeProtocolRevenue: BIGINT_ZERO,
    cumulativeGovernanceRevenue: BIGINT_ZERO,
    cumulativeExternalRevenue: BIGINT_ZERO,
    cumulativeMintAmount: token.totalMinted,
    cumulativeBurnAmount: token.totalBurned,
    blockNumber,
    timestamp,
  };

  const isProtocol = kind === "protocol";
  const isGovernance = kind === "governance";

  context.TokenDailySnapshot.set({
    ...daily,
    dailyRevenue: daily.dailyRevenue + amount,
    dailyProtocolRevenue: isProtocol
      ? daily.dailyProtocolRevenue + amount
      : daily.dailyProtocolRevenue,
    dailyGovernanceRevenue: isGovernance
      ? daily.dailyGovernanceRevenue + amount
      : daily.dailyGovernanceRevenue,
    dailyExternalRevenue:
      !isProtocol && !isGovernance
        ? daily.dailyExternalRevenue + amount
        : daily.dailyExternalRevenue,
  });

  context.TokenHourlySnapshot.set({
    ...hourly,
    hourlyRevenue: hourly.hourlyRevenue + amount,
    hourlyProtocolRevenue: isProtocol
      ? hourly.hourlyProtocolRevenue + amount
      : hourly.hourlyProtocolRevenue,
    hourlyGovernanceRevenue: isGovernance
      ? hourly.hourlyGovernanceRevenue + amount
      : hourly.hourlyGovernanceRevenue,
    hourlyExternalRevenue:
      !isProtocol && !isGovernance
        ? hourly.hourlyExternalRevenue + amount
        : hourly.hourlyExternalRevenue,
  });

  context.TokenMonthlySnapshot.set({
    ...monthly,
    monthlyRevenue: monthly.monthlyRevenue + amount,
    monthlyProtocolRevenue: isProtocol
      ? monthly.monthlyProtocolRevenue + amount
      : monthly.monthlyProtocolRevenue,
    monthlyGovernanceRevenue: isGovernance
      ? monthly.monthlyGovernanceRevenue + amount
      : monthly.monthlyGovernanceRevenue,
    monthlyExternalRevenue:
      !isProtocol && !isGovernance
        ? monthly.monthlyExternalRevenue + amount
        : monthly.monthlyExternalRevenue,
    cumulativeRevenue: dtf.totalRevenue,
    cumulativeProtocolRevenue: isProtocol ? dtf.protocolRevenue : monthly.cumulativeProtocolRevenue,
    cumulativeGovernanceRevenue: isGovernance
      ? dtf.governanceRevenue
      : monthly.cumulativeGovernanceRevenue,
    cumulativeExternalRevenue:
      !isProtocol && !isGovernance ? dtf.externalRevenue : monthly.cumulativeExternalRevenue,
  });
}

// =====================================================
// RoleGranted
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RoleGranted" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const id = dtfId(chainId, dtfAddr);
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    const role = normalizeRole(event.params.role);
    const account = event.params.account.toLowerCase();

    const blockNumber = event.block.number;
    let next: Entity<"DTF"> = { ...dtf };
    if (role === ROLE_REBALANCE_MANAGER || role === ROLE_AUCTION_APPROVER) {
      next = { ...next, auctionApprovers: [...dtf.auctionApprovers, account] };
      await createGovernanceTimelock(
        context,
        chainId,
        account,
        id,
        GovernanceType.TRADING,
        blockNumber,
      );
    } else if (role === ROLE_AUCTION_LAUNCHER) {
      next = { ...next, auctionLaunchers: [...dtf.auctionLaunchers, account] };
    } else if (role === ROLE_BRAND_MANAGER) {
      next = { ...next, brandManagers: [...dtf.brandManagers, account] };
    } else if (role === ROLE_DEFAULT_ADMIN) {
      next = { ...next, admins: [...dtf.admins, account] };
      await createGovernanceTimelock(
        context,
        chainId,
        account,
        id,
        GovernanceType.OWNER,
        blockNumber,
      );
    }
    context.DTF.set(next);
  },
);

// =====================================================
// RoleRevoked
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "RoleRevoked" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const id = dtfId(chainId, dtfAddr);
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    const role = normalizeRole(event.params.role);
    const account = event.params.account.toLowerCase();
    let next: Entity<"DTF"> = { ...dtf };

    async function pushLegacy(
      currentLegacy: readonly string[],
      target: string,
    ): Promise<string[]> {
      const tl = await context.GovernanceTimelock.get(makeId(chainId, target));
      const gov = tl && tl.governance_id ? tl.governance_id : makeId(chainId, target);
      if (currentLegacy.includes(gov)) return [...currentLegacy];
      return [...currentLegacy, gov];
    }

    if (role === ROLE_REBALANCE_MANAGER || role === ROLE_AUCTION_APPROVER) {
      const idx = dtf.auctionApprovers.indexOf(account);
      if (idx !== -1) {
        next = { ...next, auctionApprovers: removeFromArrayAtIndex(dtf.auctionApprovers, idx) };
      }
      next = { ...next, legacyAuctionApprovers: await pushLegacy(dtf.legacyAuctionApprovers, account) };
    } else if (role === ROLE_AUCTION_LAUNCHER) {
      const idx = dtf.auctionLaunchers.indexOf(account);
      if (idx !== -1) {
        next = { ...next, auctionLaunchers: removeFromArrayAtIndex(dtf.auctionLaunchers, idx) };
      }
    } else if (role === ROLE_BRAND_MANAGER) {
      const idx = dtf.brandManagers.indexOf(account);
      if (idx !== -1) {
        next = { ...next, brandManagers: removeFromArrayAtIndex(dtf.brandManagers, idx) };
      }
    } else if (role === ROLE_DEFAULT_ADMIN) {
      const idx = dtf.admins.indexOf(account);
      if (idx !== -1) {
        next = { ...next, admins: removeFromArrayAtIndex(dtf.admins, idx) };
      }
      next = { ...next, legacyAdmins: await pushLegacy(dtf.legacyAdmins, account) };
    }
    context.DTF.set(next);
  },
);

// =====================================================
// MintFeeSet
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "MintFeeSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({ ...dtf, mintingFee: event.params.newFee });
  },
);

// =====================================================
// TVLFeeSet
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "TVLFeeSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({
      ...dtf,
      tvlFee: event.params.newFee,
      annualizedTvlFee: event.params.feeAnnually,
    });
  },
);

indexer.onEvent(
  { contract: "DTF", event: "AuctionDelaySet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({ ...dtf, auctionDelay: event.params.newAuctionDelay });
  },
);

indexer.onEvent(
  { contract: "DTF", event: "AuctionLengthSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({ ...dtf, auctionLength: event.params.newAuctionLength });
  },
);

indexer.onEvent(
  { contract: "DTF", event: "MandateSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    context.DTF.set({ ...dtf, mandate: event.params.newMandate });
  },
);

// =====================================================
// FeeRecipientsSet — encode tuple array to "addr:portion,addr:portion" string
// =====================================================
indexer.onEvent(
  { contract: "DTF", event: "FeeRecipientsSet" },
  async ({ event, context }) => {
    const id = dtfId(event.chainId, event.srcAddress.toLowerCase());
    const dtf = await context.DTF.get(id);
    if (!dtf) return;
    const encoded = event.params.recipients
      .map((r) => `${(r[0] as string).toLowerCase()}:${r[1].toString()}`)
      .join(",");
    context.DTF.set({ ...dtf, feeRecipients: encoded });
  },
);

// =====================================================
// Deprecated v1.0 / v2.0 Trade lifecycle
// =====================================================

function tradeId(chainId: number, dtfAddr: string, tId: bigint): string {
  return `${makeId(chainId, dtfAddr)}-${tId}`;
}

indexer.onEvent(
  { contract: "DTF", event: "AuctionApprovedV1" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const a = event.params.auction;
    // tuple positions (v1): [id, sell, buy, sellLimit, buyLimit, prices, availableAt, launchTimeout, start, end, k]
    const sellAddr = (a[1] as string).toLowerCase();
    const buyAddr = (a[2] as string).toLowerCase();
    const sellLimit = a[3];
    const buyLimit = a[4];
    const prices = a[5];
    const availableAt = a[6];
    const launchTimeout = a[7];
    const sell = await getOrCreateToken(context, chainId, sellAddr, TokenType.ASSET);
    const buy = await getOrCreateToken(context, chainId, buyAddr, TokenType.ASSET);

    const trade: Entity<"Trade"> = {
      id: tradeId(chainId, dtfAddr, event.params.auctionId),
      dtf_id: dtfId(chainId, dtfAddr),
      sell_id: sell.id,
      buy_id: buy.id,
      soldAmount: BIGINT_ZERO,
      boughtAmount: BIGINT_ZERO,
      startPrice: prices[0],
      endPrice: prices[1],
      sellLimitSpot: sellLimit[0],
      sellLimitHigh: sellLimit[2],
      sellLimitLow: sellLimit[1],
      buyLimitSpot: buyLimit[0],
      buyLimitHigh: buyLimit[2],
      buyLimitLow: buyLimit[1],
      approvedSellLimitSpot: sellLimit[0],
      approvedBuyLimitSpot: buyLimit[0],
      approvedStartPrice: prices[0],
      approvedEndPrice: prices[1],
      availableAt,
      launchTimeout,
      start: BIGINT_ZERO,
      end: BIGINT_ZERO,
      approvedTimestamp: BigInt(event.block.timestamp),
      approvedBlockNumber: BigInt(event.block.number),
      approvedTransactionHash: event.transaction.hash,
      launchedTimestamp: BIGINT_ZERO,
      launchedBlockNumber: BIGINT_ZERO,
      launchedTransactionHash: "",
      closedTimestamp: BIGINT_ZERO,
      closedBlockNumber: BIGINT_ZERO,
      closedTransactionHash: "",
      isKilled: false,
      availableRuns: BIGINT_ONE,
      state: TradeState.APPROVED,
    };
    context.Trade.set(trade);
  },
);

indexer.onEvent(
  { contract: "DTF", event: "AuctionApprovedV2" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const a = event.params.auction;
    const d = event.params.details;
    // tuple positions (v2): [id, sellToken, buyToken, sellLimit, buyLimit, prices, restrictedUntil, launchDeadline, startTime, endTime, k]
    const sellAddr = (a[1] as string).toLowerCase();
    const buyAddr = (a[2] as string).toLowerCase();
    const sellLimit = a[3];
    const buyLimit = a[4];
    // Position 5 (prices) ignored — v2 takes initial prices from `details`.
    const restrictedUntil = a[6];
    const launchDeadline = a[7];
    const initialPrices = d[0];
    const availableRuns = d[1];

    const sell = await getOrCreateToken(context, chainId, sellAddr, TokenType.ASSET);
    const buy = await getOrCreateToken(context, chainId, buyAddr, TokenType.ASSET);

    const trade: Entity<"Trade"> = {
      id: tradeId(chainId, dtfAddr, event.params.auctionId),
      dtf_id: dtfId(chainId, dtfAddr),
      sell_id: sell.id,
      buy_id: buy.id,
      soldAmount: BIGINT_ZERO,
      boughtAmount: BIGINT_ZERO,
      startPrice: initialPrices[0],
      endPrice: initialPrices[1],
      sellLimitSpot: sellLimit[0],
      sellLimitHigh: sellLimit[2],
      sellLimitLow: sellLimit[1],
      buyLimitSpot: buyLimit[0],
      buyLimitHigh: buyLimit[2],
      buyLimitLow: buyLimit[1],
      approvedSellLimitSpot: sellLimit[0],
      approvedBuyLimitSpot: buyLimit[0],
      approvedStartPrice: initialPrices[0],
      approvedEndPrice: initialPrices[1],
      availableAt: restrictedUntil,
      launchTimeout: launchDeadline,
      start: BIGINT_ZERO,
      end: BIGINT_ZERO,
      approvedTimestamp: BigInt(event.block.timestamp),
      approvedBlockNumber: BigInt(event.block.number),
      approvedTransactionHash: event.transaction.hash,
      launchedTimestamp: BIGINT_ZERO,
      launchedBlockNumber: BIGINT_ZERO,
      launchedTransactionHash: "",
      closedTimestamp: BIGINT_ZERO,
      closedBlockNumber: BIGINT_ZERO,
      closedTransactionHash: "",
      isKilled: false,
      availableRuns,
      state: TradeState.APPROVED,
    };
    context.Trade.set(trade);
  },
);

indexer.onEvent(
  { contract: "DTF", event: "AuctionOpenedV1" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const a = event.params.auction;
    const sellLimit = a[3];
    const buyLimit = a[4];
    const prices = a[5];
    const start = a[8];
    const end = a[9];
    const tId = tradeId(chainId, dtfAddr, event.params.auctionId);
    const trade = await context.Trade.get(tId);
    if (!trade) return;
    context.Trade.set({
      ...trade,
      startPrice: prices[0],
      endPrice: prices[1],
      sellLimitSpot: sellLimit[0],
      buyLimitSpot: buyLimit[0],
      launchedTimestamp: BigInt(event.block.timestamp),
      launchedBlockNumber: BigInt(event.block.number),
      launchedTransactionHash: event.transaction.hash,
      availableRuns: BIGINT_ZERO,
      state: TradeState.LAUNCHED,
      start,
      end,
    });
  },
);

indexer.onEvent(
  { contract: "DTF", event: "AuctionOpenedV2" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const a = event.params.auction;
    const sellLimit = a[3];
    const buyLimit = a[4];
    const prices = a[5];
    const startTime = a[8];
    const endTime = a[9];
    const tId = tradeId(chainId, dtfAddr, event.params.auctionId);
    const trade = await context.Trade.get(tId);
    if (!trade) return;
    context.Trade.set({
      ...trade,
      startPrice: prices[0],
      endPrice: prices[1],
      sellLimitSpot: sellLimit[0],
      buyLimitSpot: buyLimit[0],
      launchedTimestamp: BigInt(event.block.timestamp),
      launchedBlockNumber: BigInt(event.block.number),
      launchedTransactionHash: event.transaction.hash,
      availableRuns: event.params.runsRemaining,
      state: TradeState.LAUNCHED,
      start: startTime,
      end: endTime,
    });
  },
);

// AuctionClosed — kills both v5 Auction (truncate endTime) and legacy Trade.
indexer.onEvent(
  { contract: "DTF", event: "AuctionClosed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const aId = event.params.auctionId;
    const auction = await context.Auction.get(auctionId(chainId, dtfAddr, aId));
    if (auction) {
      context.Auction.set({ ...auction, endTime: BigInt(event.block.timestamp) });
      return;
    }
    const trade = await context.Trade.get(tradeId(chainId, dtfAddr, aId));
    if (trade) {
      context.Trade.set({
        ...trade,
        closedTimestamp: BigInt(event.block.timestamp),
        closedBlockNumber: BigInt(event.block.number),
        closedTransactionHash: event.transaction.hash,
        isKilled: true,
        state: TradeState.CLOSED,
      });
    }
  },
);

// AuctionBidV1 — legacy bid against the deprecated Trade.
indexer.onEvent(
  { contract: "DTF", event: "AuctionBidV1" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddr = event.srcAddress.toLowerCase();
    const aId = event.params.auctionId;
    const tId = tradeId(chainId, dtfAddr, aId);
    const trade = await context.Trade.get(tId);
    if (trade) {
      context.Trade.set({
        ...trade,
        soldAmount: trade.soldAmount + event.params.sellAmount,
        boughtAmount: trade.boughtAmount + event.params.buyAmount,
      });
    }
    const bidderAddr = event.transaction.from
      ? (event.transaction.from as string).toLowerCase()
      : "0x0000000000000000000000000000000000000000";
    const id = makeId(
      chainId,
      `${dtfAddr}-${aId}-${bidderAddr}-${event.transaction.hash}-${event.logIndex}`,
    );
    const bid: Entity<"AuctionBid"> = {
      id,
      dtf_id: dtfId(chainId, dtfAddr),
      auction_id: tId,
      bidder: bidderAddr,
      sellAmount: event.params.sellAmount,
      buyAmount: event.params.buyAmount,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      transactionHash: event.transaction.hash,
    };
    context.AuctionBid.set(bid);
  },
);

// Suppress unused
void getOrCreateRSRBurnGlobal;
