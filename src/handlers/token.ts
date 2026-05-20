// Shared transfer pipeline — mirrors subgraph src/token/mappings.ts
// `_handleTransfer`. Exports a `processTransfer` helper consumed by:
//   - bridged-dtf.ts (BridgedDTF.Transfer)
//   - dtf.ts (DTF.Transfer)
//   - staking-token.ts (StakingToken.Transfer)
// NOTE: not registered to any event itself.

import type { Entity, EvmOnEventContext } from "envio";

import { getTxReceiptLogs, type RawLog } from "../effects/receiptLogs";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  GENESIS_ADDRESS,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MONTH,
  chainId as makeId,
} from "../utils/constants";
import { getOrCreateToken } from "../utils/getters";
import {
  decreaseAccountBalance,
  getOrCreateAccount,
  getOrCreateAccountBalance,
  increaseAccountBalance,
  isNewTokenHolder,
  updateAccountBalanceDailySnapshot,
} from "./account";

type Ctx = EvmOnEventContext;

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type ProcessTransferOptions = {
  // When true, fetch the tx receipt and inspect sibling Transfer logs to
  // resolve the "true minter" in router-mint flows. Only enabled for DTF.Transfer
  // to match subgraph's receipt:true scoping. Costs one RPC per mint when enabled.
  useReceiptForTrueMinter?: boolean;
};

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function dataToBigInt(data: string): bigint {
  if (!data || data === "0x") return 0n;
  return BigInt(data);
}

function findTrueMinter(
  destination: string,
  amount: bigint,
  logs: readonly RawLog[],
): string {
  const dest = destination.toLowerCase();
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    const from = topicToAddress(log.topics[1]!);
    if (from !== dest) continue;
    const decodedAmount = dataToBigInt(log.data);
    if (decodedAmount === amount) {
      return topicToAddress(log.topics[2]!);
    }
  }
  return dest;
}

export async function processTransfer(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  tokenType: "DTF" | "VOTE" | "ASSET" | "BRIDGED_DTF",
  from: string,
  to: string,
  amount: bigint,
  txHash: string,
  logIndex: number,
  blockNumber: bigint,
  timestamp: bigint,
  opts: ProcessTransferOptions = {},
): Promise<void> {
  if (amount === BIGINT_ZERO) return;

  const token = await getOrCreateToken(context, chainId, tokenAddress, tokenType);

  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const isBurn = toLower === GENESIS_ADDRESS;
  const isMint = fromLower === GENESIS_ADDRESS;
  const isTransfer = !isBurn && !isMint;

  // Side-effect flags for the token entity that survive across burn/mint/transfer paths.
  let nextToken: Entity<"Token"> = { ...token };
  const eventId = makeId(chainId, `${tokenAddress}-${txHash}-${logIndex}`);

  if (isBurn) {
    const burnerAcc = await getOrCreateAccount(context, chainId, fromLower);
    const burnerBal = await getOrCreateAccountBalance(context, burnerAcc, token);
    const burnerBecomesNonHolder = burnerBal.amount === amount ? BIGINT_ONE : BIGINT_ZERO;

    nextToken = {
      ...nextToken,
      totalSupply: nextToken.totalSupply - amount,
      burnCount: nextToken.burnCount + BIGINT_ONE,
      totalBurned: nextToken.totalBurned + amount,
      currentHolderCount: nextToken.currentHolderCount - burnerBecomesNonHolder,
    };

    await upsertDailyOnBurn(context, nextToken, amount, blockNumber, timestamp);
    await upsertHourlyOnBurn(context, nextToken, amount, blockNumber, timestamp);
    await upsertMonthlyOnBurn(context, nextToken, amount, blockNumber, timestamp);

    const ev: Entity<"TransferEvent"> = {
      id: eventId,
      hash: txHash,
      logIndex,
      token_id: nextToken.id,
      nonce: 0,
      amount,
      from_id: makeId(chainId, fromLower),
      to_id: undefined,
      blockNumber,
      type: "REDEEM",
      timestamp,
    };
    context.TransferEvent.set(ev);
  } else if (isMint) {
    let trueMinter = toLower;
    if (opts.useReceiptForTrueMinter) {
      // Effect throws (uncached) on RPC failure; fall back to [] so findTrueMinter
      // returns the destination — same as the non-receipt path.
      const logs = await context
        .effect(getTxReceiptLogs, { chainId, txHash })
        .catch((): RawLog[] => []);
      trueMinter = findTrueMinter(toLower, amount, logs);
    }

    // Minting entity: track cumulative mints to a given (account, token).
    const minterAcc = await getOrCreateAccount(context, chainId, trueMinter);
    const mintingId = `${minterAcc.id}-${nextToken.id}`;
    const existingMinting = await context.Minting.get(mintingId);
    if (existingMinting) {
      context.Minting.set({
        ...existingMinting,
        amount: existingMinting.amount + amount,
      });
    } else {
      const fresh: Entity<"Minting"> = {
        id: mintingId,
        account_id: minterAcc.id,
        token_id: nextToken.id,
        amount,
        firstMintTimestamp: timestamp,
      };
      context.Minting.set(fresh);
    }

    const receiverIsFirstHold = await isNewTokenHolder(
      context,
      makeId(chainId, toLower),
      nextToken.id,
    );
    const receiverBal = await getOrCreateAccountBalance(
      context,
      await getOrCreateAccount(context, chainId, toLower),
      token,
    );
    const receiverBecomesHolder =
      receiverBal.amount === BIGINT_ZERO ? BIGINT_ONE : BIGINT_ZERO;

    nextToken = {
      ...nextToken,
      cumulativeHolderCount: receiverIsFirstHold
        ? nextToken.cumulativeHolderCount + BIGINT_ONE
        : nextToken.cumulativeHolderCount,
      totalSupply: nextToken.totalSupply + amount,
      mintCount: nextToken.mintCount + BIGINT_ONE,
      totalMinted: nextToken.totalMinted + amount,
      currentHolderCount: nextToken.currentHolderCount + receiverBecomesHolder,
    };

    await upsertDailyOnMint(context, nextToken, amount, blockNumber, timestamp);
    await upsertHourlyOnMint(context, nextToken, amount, blockNumber, timestamp);
    await upsertMonthlyOnMint(
      context,
      nextToken,
      amount,
      receiverIsFirstHold,
      blockNumber,
      timestamp,
    );

    const ev: Entity<"TransferEvent"> = {
      id: eventId,
      hash: txHash,
      logIndex,
      token_id: nextToken.id,
      nonce: 0,
      amount,
      from_id: undefined,
      to_id: makeId(chainId, trueMinter),
      blockNumber,
      type: "MINT",
      timestamp,
    };
    context.TransferEvent.set(ev);
  } else {
    // Plain transfer
    const senderBal = await getOrCreateAccountBalance(
      context,
      await getOrCreateAccount(context, chainId, fromLower),
      token,
    );
    const senderBecomesNonHolder = senderBal.amount === amount ? BIGINT_ONE : BIGINT_ZERO;

    const receiverIsFirstHold = await isNewTokenHolder(
      context,
      makeId(chainId, toLower),
      nextToken.id,
    );
    const receiverBal = await getOrCreateAccountBalance(
      context,
      await getOrCreateAccount(context, chainId, toLower),
      token,
    );
    const receiverBecomesHolder =
      receiverBal.amount === BIGINT_ZERO ? BIGINT_ONE : BIGINT_ZERO;
    const newHolderDelta = receiverIsFirstHold ? BIGINT_ONE : BIGINT_ZERO;

    nextToken = {
      ...nextToken,
      currentHolderCount:
        nextToken.currentHolderCount - senderBecomesNonHolder + receiverBecomesHolder,
      cumulativeHolderCount: nextToken.cumulativeHolderCount + newHolderDelta,
      transferCount: nextToken.transferCount + BIGINT_ONE,
    };

    await upsertDailyOnTransfer(context, nextToken, amount, newHolderDelta, blockNumber, timestamp);
    await upsertHourlyOnTransfer(context, nextToken, amount, newHolderDelta, blockNumber, timestamp);
    await upsertMonthlyOnTransfer(
      context,
      nextToken,
      amount,
      newHolderDelta,
      blockNumber,
      timestamp,
    );

    const ev: Entity<"TransferEvent"> = {
      id: eventId,
      hash: txHash,
      logIndex,
      token_id: nextToken.id,
      nonce: 0,
      amount,
      from_id: makeId(chainId, fromLower),
      to_id: makeId(chainId, toLower),
      blockNumber,
      type: "TRANSFER",
      timestamp,
    };
    context.TransferEvent.set(ev);
  }

  context.Token.set(nextToken);

  // Update balances of source and destination
  if (isTransfer || isBurn) {
    const sourceAccount = await getOrCreateAccount(context, chainId, fromLower);
    let bal = await decreaseAccountBalance(context, sourceAccount, token, amount);
    bal = { ...bal, blockNumber, timestamp };
    context.AccountBalance.set(bal);
    updateAccountBalanceDailySnapshot(context, chainId, bal, blockNumber, timestamp);
  }
  if (isTransfer || isMint) {
    const destAccount = await getOrCreateAccount(context, chainId, toLower);
    let bal = await increaseAccountBalance(context, destAccount, token, amount, timestamp);
    bal = { ...bal, blockNumber, timestamp };
    context.AccountBalance.set(bal);
    updateAccountBalanceDailySnapshot(context, chainId, bal, blockNumber, timestamp);
  }
}

// ======================== snapshot helpers ========================

async function getOrSeedTokenDailySnapshot(
  context: Ctx,
  token: Entity<"Token">,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"TokenDailySnapshot">> {
  const id = `${token.id}-${timestamp / SECONDS_PER_DAY}`;
  const existing = await context.TokenDailySnapshot.get(id);
  if (existing) return existing;
  const fresh: Entity<"TokenDailySnapshot"> = {
    id,
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
  return fresh;
}

async function getOrSeedTokenHourlySnapshot(
  context: Ctx,
  token: Entity<"Token">,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"TokenHourlySnapshot">> {
  const id = `${token.id}-${timestamp / SECONDS_PER_HOUR}`;
  const existing = await context.TokenHourlySnapshot.get(id);
  if (existing) return existing;
  const fresh: Entity<"TokenHourlySnapshot"> = {
    id,
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
  return fresh;
}

async function getOrSeedTokenMonthlySnapshot(
  context: Ctx,
  token: Entity<"Token">,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"TokenMonthlySnapshot">> {
  const id = `${token.id}-${timestamp / SECONDS_PER_MONTH}`;
  const existing = await context.TokenMonthlySnapshot.get(id);
  if (existing) return existing;
  // Subgraph seeds cumulatives from DTF when token type is DTF (so months
  // without fee events still carry lifetime totals).
  let cumulativeRevenue = BIGINT_ZERO;
  let cumulativeProtocolRevenue = BIGINT_ZERO;
  let cumulativeGovernanceRevenue = BIGINT_ZERO;
  let cumulativeExternalRevenue = BIGINT_ZERO;
  if (token.type === "DTF") {
    const dtf = await context.DTF.get(token.id);
    if (dtf) {
      cumulativeRevenue = dtf.totalRevenue;
      cumulativeProtocolRevenue = dtf.protocolRevenue;
      cumulativeGovernanceRevenue = dtf.governanceRevenue;
      cumulativeExternalRevenue = dtf.externalRevenue;
    }
  }
  const fresh: Entity<"TokenMonthlySnapshot"> = {
    id,
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
    cumulativeRevenue,
    cumulativeProtocolRevenue,
    cumulativeGovernanceRevenue,
    cumulativeExternalRevenue,
    cumulativeMintAmount: token.totalMinted,
    cumulativeBurnAmount: token.totalBurned,
    blockNumber,
    timestamp,
  };
  return fresh;
}

async function upsertDailyOnBurn(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenDailySnapshot(context, token, blockNumber, timestamp);
  context.TokenDailySnapshot.set({
    ...snap,
    dailyTotalSupply: token.totalSupply,
    dailyEventCount: snap.dailyEventCount + 1,
    dailyBurnCount: snap.dailyBurnCount + 1,
    dailyBurnAmount: snap.dailyBurnAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertHourlyOnBurn(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenHourlySnapshot(context, token, blockNumber, timestamp);
  context.TokenHourlySnapshot.set({
    ...snap,
    hourlyTotalSupply: token.totalSupply,
    hourlyEventCount: snap.hourlyEventCount + 1,
    hourlyBurnCount: snap.hourlyBurnCount + 1,
    hourlyBurnAmount: snap.hourlyBurnAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertMonthlyOnBurn(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenMonthlySnapshot(context, token, blockNumber, timestamp);
  context.TokenMonthlySnapshot.set({
    ...snap,
    monthlyTotalSupply: token.totalSupply,
    monthlyBurnAmount: snap.monthlyBurnAmount + amount,
    monthlyBurnCount: snap.monthlyBurnCount + 1,
    monthlyEventCount: snap.monthlyEventCount + 1,
    currentHolderCount: token.currentHolderCount,
    cumulativeBurnAmount: token.totalBurned,
    blockNumber,
    timestamp,
  });
}

async function upsertDailyOnMint(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenDailySnapshot(context, token, blockNumber, timestamp);
  context.TokenDailySnapshot.set({
    ...snap,
    dailyTotalSupply: token.totalSupply,
    dailyEventCount: snap.dailyEventCount + 1,
    dailyMintCount: snap.dailyMintCount + 1,
    dailyMintAmount: snap.dailyMintAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertHourlyOnMint(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenHourlySnapshot(context, token, blockNumber, timestamp);
  context.TokenHourlySnapshot.set({
    ...snap,
    hourlyTotalSupply: token.totalSupply,
    hourlyEventCount: snap.hourlyEventCount + 1,
    hourlyMintCount: snap.hourlyMintCount + 1,
    hourlyMintAmount: snap.hourlyMintAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertMonthlyOnMint(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  receiverIsFirstHold: boolean,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenMonthlySnapshot(context, token, blockNumber, timestamp);
  context.TokenMonthlySnapshot.set({
    ...snap,
    monthlyTotalSupply: token.totalSupply,
    monthlyMintAmount: snap.monthlyMintAmount + amount,
    monthlyMintCount: snap.monthlyMintCount + 1,
    monthlyEventCount: snap.monthlyEventCount + 1,
    cumulativeMintAmount: token.totalMinted,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: receiverIsFirstHold
      ? snap.cumulativeHolderCount + BIGINT_ONE
      : snap.cumulativeHolderCount,
    blockNumber,
    timestamp,
  });
}

async function upsertDailyOnTransfer(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  newHolderDelta: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenDailySnapshot(context, token, blockNumber, timestamp);
  context.TokenDailySnapshot.set({
    ...snap,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: snap.cumulativeHolderCount + newHolderDelta,
    dailyEventCount: snap.dailyEventCount + 1,
    dailyTransferCount: snap.dailyTransferCount + 1,
    dailyTransferAmount: snap.dailyTransferAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertHourlyOnTransfer(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  newHolderDelta: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenHourlySnapshot(context, token, blockNumber, timestamp);
  context.TokenHourlySnapshot.set({
    ...snap,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: snap.cumulativeHolderCount + newHolderDelta,
    hourlyEventCount: snap.hourlyEventCount + 1,
    hourlyTransferCount: snap.hourlyTransferCount + 1,
    hourlyTransferAmount: snap.hourlyTransferAmount + amount,
    blockNumber,
    timestamp,
  });
}

async function upsertMonthlyOnTransfer(
  context: Ctx,
  token: Entity<"Token">,
  amount: bigint,
  newHolderDelta: bigint,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<void> {
  const snap = await getOrSeedTokenMonthlySnapshot(context, token, blockNumber, timestamp);
  context.TokenMonthlySnapshot.set({
    ...snap,
    currentHolderCount: token.currentHolderCount,
    cumulativeHolderCount: snap.cumulativeHolderCount + newHolderDelta,
    monthlyEventCount: snap.monthlyEventCount + 1,
    monthlyTransferCount: snap.monthlyTransferCount + 1,
    monthlyTransferAmount: snap.monthlyTransferAmount + amount,
    blockNumber,
    timestamp,
  });
}
