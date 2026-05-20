// StakingToken + UnstakingManager handlers. Ported from subgraph
// src/staking-token/{mappings.ts, handlers.ts}.

import type { Entity } from "envio";
import { BigDecimal, indexer } from "envio";

import {
  BIGDECIMAL_ZERO,
  BIGINT_ONE,
  BIGINT_ZERO,
  GENESIS_ADDRESS,
  GovernanceType,
  TokenType,
  chainId as makeId,
} from "../utils/constants";
import {
  createGovernanceTimelock,
  getOrCreateStakingToken,
  getOrCreateToken,
} from "../utils/getters";
import { getOrCreateAccount, getOrCreateAccountBalance } from "./account";
import { processTransfer } from "./token";

function toDecimal(value: bigint, decimals = 18): BigDecimal {
  const factor = 10n ** BigInt(decimals);
  // BigDecimal arithmetic via string serialization to preserve precision.
  return new BigDecimal(value.toString()).div(new BigDecimal(factor.toString()));
}

// =====================================================
// StakingToken.RewardTokenAdded / RewardTokenRemoved
// =====================================================

async function getOrCreateStakingTokenReward(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stakingTokenAddress: string,
  rewardTokenAddress: string,
  blockNumber: number,
): Promise<Entity<"StakingTokenRewards">> {
  const id = makeId(chainId, `${stakingTokenAddress}-${rewardTokenAddress}`);
  const existing = await context.StakingTokenRewards.get(id);
  if (existing) return existing;
  const stToken = await getOrCreateStakingToken(
    context,
    chainId,
    stakingTokenAddress,
    blockNumber,
  );
  const rewardToken = await getOrCreateToken(
    context,
    chainId,
    rewardTokenAddress,
    TokenType.ASSET,
  );
  const fresh: Entity<"StakingTokenRewards"> = {
    id,
    stToken_id: stToken.id,
    rewardToken_id: rewardToken.id,
    active: true,
  };
  context.StakingTokenRewards.set(fresh);
  return fresh;
}

indexer.onEvent(
  { contract: "StakingToken", event: "RewardTokenAdded" },
  async ({ event, context }) => {
    const reward = await getOrCreateStakingTokenReward(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.rewardToken.toLowerCase(),
      event.block.number,
    );
    if (!reward.active) {
      context.StakingTokenRewards.set({ ...reward, active: true });
    }
  },
);

indexer.onEvent(
  { contract: "StakingToken", event: "RewardTokenRemoved" },
  async ({ event, context }) => {
    const reward = await getOrCreateStakingTokenReward(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.rewardToken.toLowerCase(),
      event.block.number,
    );
    if (reward.active) {
      context.StakingTokenRewards.set({ ...reward, active: false });
    }
  },
);

// =====================================================
// Delegate / Vote helpers
// =====================================================

async function getOrCreateDelegate(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stTokenEntityId: string,
  delegateAddress: string,
): Promise<Entity<"Delegate">> {
  const id = `${stTokenEntityId}-${delegateAddress.toLowerCase()}`;
  const existing = await context.Delegate.get(id);
  if (existing) return existing;
  const fresh: Entity<"Delegate"> = {
    id,
    address: delegateAddress.toLowerCase(),
    token_id: stTokenEntityId,
    delegatedVotesRaw: BIGINT_ZERO,
    delegatedVotes: BIGDECIMAL_ZERO,
    optimisticDelegatedVotesRaw: BIGINT_ZERO,
    optimisticDelegatedVotes: BIGDECIMAL_ZERO,
    hasBeenStandardDelegate: false,
    hasBeenOptimisticDelegate: false,
    tokenHoldersRepresentedAmount: 0,
    optimisticTokenHoldersRepresentedAmount: 0,
    numberVotes: 0,
    numberOptimisticVotes: 0,
  };
  context.Delegate.set(fresh);
  return fresh;
}

async function getOrCreateStandardDelegate(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stTokenAddress: string,
  delegateAddress: string,
  blockNumber: number,
): Promise<Entity<"Delegate">> {
  const stToken = await getOrCreateStakingToken(
    context,
    chainId,
    stTokenAddress,
    blockNumber,
  );
  let delegate = await getOrCreateDelegate(context, chainId, stToken.id, delegateAddress);
  if (
    !delegate.hasBeenStandardDelegate &&
    delegateAddress.toLowerCase() !== GENESIS_ADDRESS
  ) {
    context.StakingToken.set({
      ...stToken,
      totalDelegates: stToken.totalDelegates + BIGINT_ONE,
    });
    delegate = { ...delegate, hasBeenStandardDelegate: true };
    context.Delegate.set(delegate);
  }
  return delegate;
}

async function getOrCreateOptimisticDelegate(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stTokenAddress: string,
  delegateAddress: string,
  blockNumber: number,
): Promise<Entity<"Delegate">> {
  const stToken = await getOrCreateStakingToken(
    context,
    chainId,
    stTokenAddress,
    blockNumber,
  );
  let delegate = await getOrCreateDelegate(context, chainId, stToken.id, delegateAddress);
  if (
    !delegate.hasBeenOptimisticDelegate &&
    delegateAddress.toLowerCase() !== GENESIS_ADDRESS
  ) {
    context.StakingToken.set({
      ...stToken,
      totalOptimisticDelegates: stToken.totalOptimisticDelegates + BIGINT_ONE,
    });
    delegate = { ...delegate, hasBeenOptimisticDelegate: true };
    context.Delegate.set(delegate);
  }
  return delegate;
}

async function handleDelegateChange(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stTokenAddress: string,
  delegator: string,
  fromDelegate: string,
  toDelegate: string,
  isOptimistic: boolean,
  event: {
    block: { number: number; timestamp: number };
    transaction: { hash: string };
    logIndex: number;
  },
): Promise<void> {
  const account = await getOrCreateAccount(context, chainId, delegator);
  const voteToken = await getOrCreateToken(context, chainId, stTokenAddress, TokenType.VOTE);
  const tokenHolder = await getOrCreateAccountBalance(context, account, voteToken);

  const blockNumber = event.block.number;
  if (fromDelegate.toLowerCase() !== GENESIS_ADDRESS) {
    const prev = isOptimistic
      ? await getOrCreateOptimisticDelegate(context, chainId, stTokenAddress, fromDelegate, blockNumber)
      : await getOrCreateStandardDelegate(context, chainId, stTokenAddress, fromDelegate, blockNumber);
    context.Delegate.set({
      ...prev,
      optimisticTokenHoldersRepresentedAmount: isOptimistic
        ? prev.optimisticTokenHoldersRepresentedAmount - 1
        : prev.optimisticTokenHoldersRepresentedAmount,
      tokenHoldersRepresentedAmount: !isOptimistic
        ? prev.tokenHoldersRepresentedAmount - 1
        : prev.tokenHoldersRepresentedAmount,
    });
  }

  const next = isOptimistic
    ? await getOrCreateOptimisticDelegate(context, chainId, stTokenAddress, toDelegate, blockNumber)
    : await getOrCreateStandardDelegate(context, chainId, stTokenAddress, toDelegate, blockNumber);

  context.AccountBalance.set({
    ...tokenHolder,
    delegate_id: !isOptimistic ? next.id : tokenHolder.delegate_id,
    optimisticDelegate_id: isOptimistic ? next.id : tokenHolder.optimisticDelegate_id,
  });

  context.Delegate.set({
    ...next,
    optimisticTokenHoldersRepresentedAmount: isOptimistic
      ? next.optimisticTokenHoldersRepresentedAmount + 1
      : next.optimisticTokenHoldersRepresentedAmount,
    tokenHoldersRepresentedAmount: !isOptimistic
      ? next.tokenHoldersRepresentedAmount + 1
      : next.tokenHoldersRepresentedAmount,
  });

  const dc: Entity<"DelegateChange"> = {
    id: makeId(chainId, `${event.block.timestamp}-${event.logIndex}`),
    tokenAddress: stTokenAddress.toLowerCase(),
    delegator: delegator.toLowerCase(),
    delegate: toDelegate.toLowerCase(),
    previousDelegate: fromDelegate.toLowerCase(),
    isOptimistic,
    blockTimestamp: BigInt(event.block.timestamp),
    txnHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
    blockNumber: BigInt(event.block.number),
  };
  context.DelegateChange.set(dc);
}

async function handleDelegateVotesChange(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  stTokenAddress: string,
  delegateAddress: string,
  previousBalance: bigint,
  newBalance: bigint,
  isOptimistic: boolean,
  event: {
    block: { number: number; timestamp: number };
    transaction: { hash: string };
    logIndex: number;
  },
): Promise<void> {
  const votesDifference = newBalance - previousBalance;
  const blockNumber = event.block.number;

  const delegate = isOptimistic
    ? await getOrCreateOptimisticDelegate(context, chainId, stTokenAddress, delegateAddress, blockNumber)
    : await getOrCreateStandardDelegate(context, chainId, stTokenAddress, delegateAddress, blockNumber);

  context.Delegate.set({
    ...delegate,
    optimisticDelegatedVotesRaw: isOptimistic ? newBalance : delegate.optimisticDelegatedVotesRaw,
    optimisticDelegatedVotes: isOptimistic ? toDecimal(newBalance) : delegate.optimisticDelegatedVotes,
    delegatedVotesRaw: !isOptimistic ? newBalance : delegate.delegatedVotesRaw,
    delegatedVotes: !isOptimistic ? toDecimal(newBalance) : delegate.delegatedVotes,
  });

  const vpc: Entity<"DelegateVotingPowerChange"> = {
    id: makeId(chainId, `${event.block.timestamp}-${event.logIndex}`),
    tokenAddress: stTokenAddress.toLowerCase(),
    delegate: delegateAddress.toLowerCase(),
    previousBalance,
    newBalance,
    isOptimistic,
    blockTimestamp: BigInt(event.block.timestamp),
    txnHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
    blockNumber: BigInt(event.block.number),
  };
  context.DelegateVotingPowerChange.set(vpc);

  const stToken = await getOrCreateStakingToken(
    context,
    chainId,
    stTokenAddress,
    blockNumber,
  );
  let nextStToken: Entity<"StakingToken"> = { ...stToken };
  if (isOptimistic) {
    if (previousBalance === BIGINT_ZERO && newBalance > BIGINT_ZERO) {
      nextStToken = {
        ...nextStToken,
        currentOptimisticDelegates: nextStToken.currentOptimisticDelegates + BIGINT_ONE,
      };
    }
    if (newBalance === BIGINT_ZERO) {
      nextStToken = {
        ...nextStToken,
        currentOptimisticDelegates: nextStToken.currentOptimisticDelegates - BIGINT_ONE,
      };
    }
    nextStToken = {
      ...nextStToken,
      optimisticDelegatedVotesRaw: nextStToken.optimisticDelegatedVotesRaw + votesDifference,
      optimisticDelegatedVotes: toDecimal(
        nextStToken.optimisticDelegatedVotesRaw + votesDifference,
      ),
    };
  } else {
    if (previousBalance === BIGINT_ZERO && newBalance > BIGINT_ZERO) {
      nextStToken = {
        ...nextStToken,
        currentDelegates: nextStToken.currentDelegates + BIGINT_ONE,
      };
    }
    if (newBalance === BIGINT_ZERO) {
      nextStToken = {
        ...nextStToken,
        currentDelegates: nextStToken.currentDelegates - BIGINT_ONE,
      };
    }
    nextStToken = {
      ...nextStToken,
      delegatedVotesRaw: nextStToken.delegatedVotesRaw + votesDifference,
      delegatedVotes: toDecimal(nextStToken.delegatedVotesRaw + votesDifference),
    };
  }
  context.StakingToken.set(nextStToken);
}

// =====================================================
// DelegateChanged / DelegateVotesChanged (standard + optimistic)
// =====================================================

indexer.onEvent(
  { contract: "StakingToken", event: "DelegateChanged" },
  async ({ event, context }) => {
    await handleDelegateChange(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.delegator.toLowerCase(),
      event.params.fromDelegate.toLowerCase(),
      event.params.toDelegate.toLowerCase(),
      false,
      event,
    );
  },
);

indexer.onEvent(
  { contract: "StakingToken", event: "DelegateVotesChanged" },
  async ({ event, context }) => {
    await handleDelegateVotesChange(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.delegate.toLowerCase(),
      event.params.previousVotes,
      event.params.newVotes,
      false,
      event,
    );
  },
);

indexer.onEvent(
  { contract: "StakingToken", event: "OptimisticDelegateChanged" },
  async ({ event, context }) => {
    await handleDelegateChange(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.delegator.toLowerCase(),
      event.params.fromDelegate.toLowerCase(),
      event.params.toDelegate.toLowerCase(),
      true,
      event,
    );
  },
);

indexer.onEvent(
  { contract: "StakingToken", event: "OptimisticDelegateVotesChanged" },
  async ({ event, context }) => {
    await handleDelegateVotesChange(
      context,
      event.chainId,
      event.srcAddress.toLowerCase(),
      event.params.delegate.toLowerCase(),
      event.params.previousVotes,
      event.params.newVotes,
      true,
      event,
    );
  },
);

// =====================================================
// Transfer — share movement for the staking token (VOTE type)
// =====================================================

indexer.onEvent(
  { contract: "StakingToken", event: "Transfer" },
  async ({ event, context }) => {
    await processTransfer(
      context,
      event.chainId,
      event.srcAddress,
      "VOTE",
      event.params.from,
      event.params.to,
      event.params.value,
      event.transaction.hash,
      event.logIndex,
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
    );
  },
);

// =====================================================
// OwnershipTransferred
// =====================================================
indexer.onEvent(
  { contract: "StakingToken", event: "OwnershipTransferred" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const blockNumber = event.block.number;
    const stTokenAddress = event.srcAddress.toLowerCase();
    const stToken = await getOrCreateStakingToken(
      context,
      chainId,
      stTokenAddress,
      blockNumber,
    );
    const oldOwner = event.params.previousOwner.toLowerCase();
    const newOwner = event.params.newOwner.toLowerCase();

    let updatedLegacy = stToken.legacyGovernance;
    if (oldOwner !== GENESIS_ADDRESS) {
      const tl = await context.GovernanceTimelock.get(makeId(chainId, oldOwner));
      const gov = tl && tl.governance_id ? tl.governance_id : makeId(chainId, oldOwner);
      updatedLegacy = [...updatedLegacy, gov];
    }
    context.StakingToken.set({ ...stToken, legacyGovernance: updatedLegacy });

    await createGovernanceTimelock(
      context,
      chainId,
      newOwner,
      stToken.id,
      GovernanceType.VOTE_LOCKING,
      blockNumber,
    );
  },
);

// =====================================================
// RewardsClaimed
// =====================================================
indexer.onEvent(
  { contract: "StakingToken", event: "RewardsClaimed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const stTokenAddress = event.srcAddress.toLowerCase();
    const stToken = await getOrCreateStakingToken(
      context,
      chainId,
      stTokenAddress,
      event.block.number,
    );
    const account = await getOrCreateAccount(
      context,
      chainId,
      event.params.user.toLowerCase(),
    );
    const rewardToken = await getOrCreateToken(
      context,
      chainId,
      event.params.rewardToken.toLowerCase(),
      TokenType.ASSET,
    );
    const id = makeId(
      chainId,
      `${stTokenAddress}-${event.transaction.hash}-${event.logIndex}`,
    );
    const claim: Entity<"RewardClaim"> = {
      id,
      token_id: stToken.id,
      account_id: account.id,
      rewardToken_id: rewardToken.id,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      txnHash: event.transaction.hash,
    };
    context.RewardClaim.set(claim);
  },
);

// =====================================================
// UnstakingManager: LockCreated / LockCancelled / LockClaimed
// =====================================================

async function getTokenFromManager(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  managerAddress: string,
): Promise<string | undefined> {
  const um = await context.UnstakingManager.get(makeId(chainId, managerAddress));
  return um?.token_id;
}

indexer.onEvent(
  { contract: "UnstakingManager", event: "LockCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const managerAddress = event.srcAddress.toLowerCase();
    const stTokenId = await getTokenFromManager(context, chainId, managerAddress);
    if (!stTokenId) return;

    const account = await getOrCreateAccount(
      context,
      chainId,
      event.params.user.toLowerCase(),
    );

    const lock: Entity<"Lock"> = {
      id: makeId(chainId, `${managerAddress}-${event.params.lockId}`),
      lockId: event.params.lockId,
      token_id: stTokenId,
      account_id: account.id,
      amount: event.params.amount,
      unlockTime: event.params.unlockTime,
      createdBlock: BigInt(event.block.number),
      createdTimestamp: BigInt(event.block.timestamp),
      createdTxnHash: event.transaction.hash,
      cancelledBlock: undefined,
      cancelledTimestamp: undefined,
      cancelledTxnHash: undefined,
      claimedBlock: undefined,
      claimedTimestamp: undefined,
      claimedTxnHash: undefined,
    };
    context.Lock.set(lock);
  },
);

indexer.onEvent(
  { contract: "UnstakingManager", event: "LockCancelled" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const managerAddress = event.srcAddress.toLowerCase();
    const id = makeId(chainId, `${managerAddress}-${event.params.lockId}`);
    const lock = await context.Lock.get(id);
    if (!lock) return;
    context.Lock.set({
      ...lock,
      cancelledBlock: BigInt(event.block.number),
      cancelledTimestamp: BigInt(event.block.timestamp),
      cancelledTxnHash: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "UnstakingManager", event: "LockClaimed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const managerAddress = event.srcAddress.toLowerCase();
    const id = makeId(chainId, `${managerAddress}-${event.params.lockId}`);
    const lock = await context.Lock.get(id);
    if (!lock) return;
    context.Lock.set({
      ...lock,
      claimedBlock: BigInt(event.block.number),
      claimedTimestamp: BigInt(event.block.timestamp),
      claimedTxnHash: event.transaction.hash,
    });
  },
);
