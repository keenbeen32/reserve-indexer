// Governor + Timelock template handlers. Ported from subgraph
// src/governance/{mappings.ts, handlers.ts}.

import type { Entity } from "envio";
import { BigDecimal, indexer } from "envio";

import { getGovernorQuorum } from "../effects/governor";
import {
  BIGDECIMAL_ZERO,
  BIGINT_ONE,
  BIGINT_ZERO,
  GENESIS_ADDRESS,
  ProposalState,
  Role,
  SECONDS_PER_DAY,
  VoteChoice,
  chainId as makeId,
  normalizeRole,
} from "../utils/constants";
import { attachGovernanceToTimelock } from "../utils/getters";
import { removeFromArrayAtIndex } from "../utils/arrays";
import { getOrCreateAccount } from "./account";

type Ctx = Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"];

function bigintToDecimal(value: bigint, decimals = 18): BigDecimal {
  const factor = 10n ** BigInt(decimals);
  return new BigDecimal(value.toString()).div(new BigDecimal(factor.toString()));
}

function delegateId(stTokenId: string, address: string): string {
  return `${stTokenId}-${address.toLowerCase()}`;
}

async function getOrCreateDelegate(
  context: Ctx,
  stTokenEntityId: string,
  address: string,
): Promise<Entity<"Delegate">> {
  const id = delegateId(stTokenEntityId, address);
  const existing = await context.Delegate.get(id);
  if (existing) return existing;
  const fresh: Entity<"Delegate"> = {
    id,
    address: address.toLowerCase(),
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

// =====================================================
// Governance: ProposalCreated
// =====================================================
indexer.onEvent(
  { contract: "Governance", event: "ProposalCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const governorAddress = event.srcAddress.toLowerCase();
    const govId = makeId(chainId, governorAddress);
    const governance = await context.Governance.get(govId);
    if (!governance) return;

    const proposalId = event.params.proposalId.toString();
    const id = `${govId}-${proposalId}`;

    // Quorum at vote-start - 1. The effect throws (and is not cached) on RPC
    // failure; fall back to "0" so a transient blip retries on the next run.
    const quorumStr = await context
      .effect(getGovernorQuorum, {
        chainId,
        address: governorAddress,
        blockNumber: (BigInt(event.block.timestamp) - BIGINT_ONE).toString(),
      })
      .catch(() => "0");
    const quorumVotes = BigInt(quorumStr);
    context.Governance.set({ ...governance, quorumVotes });

    const proposer = await getOrCreateDelegate(
      context,
      governance.token_id,
      event.params.proposer.toLowerCase(),
    );

    const proposal: Entity<"Proposal"> = {
      id,
      txnHash: event.transaction.hash,
      description: event.params.description,
      governance_id: governance.id,
      proposer_id: proposer.id,
      state:
        BigInt(event.block.timestamp) >= event.params.voteStart
          ? ProposalState.ACTIVE
          : ProposalState.PENDING,
      isOptimistic: undefined,
      vetoThreshold: undefined,
      quorumVotes,
      tokenHoldersAtStart: BIGINT_ZERO,
      delegatesAtStart: BIGINT_ZERO,
      againstDelegateVotes: BIGINT_ZERO,
      forDelegateVotes: BIGINT_ZERO,
      abstainDelegateVotes: BIGINT_ZERO,
      totalDelegateVotes: BIGINT_ZERO,
      againstWeightedVotes: BIGINT_ZERO,
      forWeightedVotes: BIGINT_ZERO,
      abstainWeightedVotes: BIGINT_ZERO,
      totalWeightedVotes: BIGINT_ZERO,
      creationBlock: BigInt(event.block.number),
      creationTime: BigInt(event.block.timestamp),
      voteStart: event.params.voteStart,
      voteEnd: event.params.voteEnd,
      queueTxnHash: undefined,
      queueAccount_id: undefined,
      queueBlock: undefined,
      queueTime: undefined,
      executionETA: undefined,
      executionTxnHash: undefined,
      executionAccount_id: undefined,
      executionBlock: undefined,
      executionTime: undefined,
      cancellationTxnHash: undefined,
      cancellationAccount_id: undefined,
      cancellationBlock: undefined,
      cancellationTime: undefined,
      timelockId: undefined,
      targets: event.params.targets.map((t) => (t as string).toLowerCase()),
      values: [...event.params.values],
      signatures: [...event.params.signatures],
      calldatas: [...event.params.calldatas],
    };
    context.Proposal.set(proposal);

    context.Governance.set({
      ...governance,
      quorumVotes,
      proposalCount: governance.proposalCount + BIGINT_ONE,
    });
  },
);

// =====================================================
// ProposalCanceled
// =====================================================
indexer.onEvent(
  { contract: "Governance", event: "ProposalCanceled" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const govId = makeId(chainId, event.srcAddress.toLowerCase());
    const governance = await context.Governance.get(govId);
    if (!governance) return;
    const proposalEntityId = `${govId}-${event.params.proposalId.toString()}`;
    const proposal = await context.Proposal.get(proposalEntityId);
    if (proposal) {
      const cancellationAccount = event.transaction.from
        ? await getOrCreateAccount(
            context,
            chainId,
            (event.transaction.from as string).toLowerCase(),
          )
        : undefined;
      context.Proposal.set({
        ...proposal,
        state: ProposalState.CANCELED,
        cancellationTxnHash: event.transaction.hash,
        cancellationAccount_id: cancellationAccount?.id,
        cancellationBlock: BigInt(event.block.number),
        cancellationTime: BigInt(event.block.timestamp),
      });
    }
    context.Governance.set({
      ...governance,
      proposalsCanceled: governance.proposalsCanceled + BIGINT_ONE,
    });
  },
);

// =====================================================
// ProposalExecuted
// =====================================================
indexer.onEvent(
  { contract: "Governance", event: "ProposalExecuted" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const govId = makeId(chainId, event.srcAddress.toLowerCase());
    const governance = await context.Governance.get(govId);
    if (!governance) return;
    const proposalEntityId = `${govId}-${event.params.proposalId.toString()}`;
    const proposal = await context.Proposal.get(proposalEntityId);
    if (proposal) {
      const executionAccount = event.transaction.from
        ? await getOrCreateAccount(
            context,
            chainId,
            (event.transaction.from as string).toLowerCase(),
          )
        : undefined;
      context.Proposal.set({
        ...proposal,
        state: ProposalState.EXECUTED,
        executionTxnHash: event.transaction.hash,
        executionAccount_id: executionAccount?.id,
        executionBlock: BigInt(event.block.number),
        executionTime: BigInt(event.block.timestamp),
      });
    }
    context.Governance.set({
      ...governance,
      proposalsQueued:
        governance.proposalsQueued > BIGINT_ZERO
          ? governance.proposalsQueued - BIGINT_ONE
          : BIGINT_ZERO,
      proposalsExecuted: governance.proposalsExecuted + BIGINT_ONE,
    });
  },
);

// =====================================================
// ProposalQueued
// =====================================================
indexer.onEvent(
  { contract: "Governance", event: "ProposalQueued" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const govId = makeId(chainId, event.srcAddress.toLowerCase());
    const governance = await context.Governance.get(govId);
    if (!governance) return;

    const proposalEntityId = `${govId}-${event.params.proposalId.toString()}`;
    const proposal = await context.Proposal.get(proposalEntityId);
    if (!proposal) return;

    const queueAccount = event.transaction.from
      ? await getOrCreateAccount(
          context,
          chainId,
          (event.transaction.from as string).toLowerCase(),
        )
      : undefined;

    // Link Proposal to TimelockOperation via TimelockOperationByTx mapping.
    const opByTxId = makeId(chainId, event.transaction.hash);
    const operationByTx = await context.TimelockOperationByTx.get(opByTxId);

    let next: Entity<"Proposal"> = {
      ...proposal,
      state: ProposalState.QUEUED,
      queueTxnHash: event.transaction.hash,
      queueAccount_id: queueAccount?.id,
      queueBlock: BigInt(event.block.number),
      queueTime: BigInt(event.block.timestamp),
      executionETA: event.params.etaSeconds,
    };

    if (operationByTx) {
      next = { ...next, timelockId: operationByTx.timelockId };
      const operation = await context.TimelockOperation.get(operationByTx.timelockId);
      if (operation) {
        context.TimelockOperation.set({ ...operation, proposal_id: next.id });
      }
    }
    context.Proposal.set(next);

    context.Governance.set({
      ...governance,
      proposalsQueued: governance.proposalsQueued + BIGINT_ONE,
    });
  },
);

// =====================================================
// Parameter setters
// =====================================================

indexer.onEvent(
  { contract: "Governance", event: "ProposalThresholdSet" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({ ...gov, proposalThreshold: event.params.newProposalThreshold });
  },
);

indexer.onEvent(
  { contract: "Governance", event: "QuorumNumeratorUpdated" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({ ...gov, quorumNumerator: event.params.newQuorumNumerator });
  },
);

indexer.onEvent(
  { contract: "Governance", event: "OptimisticParamsUpdated" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({
      ...gov,
      isOptimistic: true,
      optimisticVetoDelay: event.params.optimisticParams[0],
      optimisticVetoPeriod: event.params.optimisticParams[1],
      optimisticVetoThreshold: event.params.optimisticParams[2],
    });
  },
);

indexer.onEvent(
  { contract: "Governance", event: "ProposalThrottleUpdated" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({
      ...gov,
      isOptimistic: true,
      optimisticProposalThrottleCapacity: event.params.throttleCapacity,
    });
  },
);

indexer.onEvent(
  { contract: "Governance", event: "VotingDelaySet" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({ ...gov, votingDelay: event.params.newVotingDelay });
  },
);

indexer.onEvent(
  { contract: "Governance", event: "VotingPeriodSet" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const gov = await context.Governance.get(id);
    if (!gov) return;
    context.Governance.set({ ...gov, votingPeriod: event.params.newVotingPeriod });
  },
);

// =====================================================
// VoteCast
// =====================================================
indexer.onEvent(
  { contract: "Governance", event: "VoteCast" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const governorAddress = event.srcAddress.toLowerCase();
    const govId = makeId(chainId, governorAddress);
    const governance = await context.Governance.get(govId);
    if (!governance) return;

    const proposalEntityId = `${govId}-${event.params.proposalId.toString()}`;
    let proposal = await context.Proposal.get(proposalEntityId);
    if (!proposal) return;

    // On first vote, transition PENDING -> ACTIVE and refresh quorum +
    // tokenHoldersAtStart / delegatesAtStart snapshots.
    if (proposal.state === ProposalState.PENDING) {
      // Effect throws (uncached) on RPC failure; fall back to "0" so it retries.
      const quorumStr = await context
        .effect(getGovernorQuorum, {
          chainId,
          address: governorAddress,
          blockNumber: proposal.voteStart.toString(),
        })
        .catch(() => "0");
      const quorumVotes = BigInt(quorumStr);

      const stToken = await context.StakingToken.get(governance.token_id);
      let tokenHoldersAtStart = BIGINT_ZERO;
      let delegatesAtStart = BIGINT_ZERO;
      if (stToken) {
        const token = await context.Token.get(stToken.token_id);
        tokenHoldersAtStart = token?.currentHolderCount ?? BIGINT_ZERO;
        delegatesAtStart = proposal.isOptimistic
          ? stToken.currentOptimisticDelegates
          : stToken.currentDelegates;
      }
      proposal = {
        ...proposal,
        state: ProposalState.ACTIVE,
        quorumVotes,
        tokenHoldersAtStart,
        delegatesAtStart,
      };
    }

    const voter = await getOrCreateDelegate(
      context,
      governance.token_id,
      event.params.voter.toLowerCase(),
    );

    const support = Number(event.params.support);
    const choice =
      support === VoteChoice.AGAINST_VALUE
        ? VoteChoice.AGAINST
        : support === VoteChoice.FOR_VALUE
          ? VoteChoice.FOR
          : VoteChoice.ABSTAIN;

    const voteEntityId = `${voter.id}-${proposal.id}`;
    const vote: Entity<"Vote"> = {
      id: voteEntityId,
      choice,
      weight: event.params.weight,
      reason: event.params.reason,
      voter_id: voter.id,
      proposal_id: proposal.id,
      block: BigInt(event.block.number),
      blockTime: BigInt(event.block.timestamp),
      txnHash: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      blockTimeId: `${event.block.timestamp}-${event.logIndex}`,
    };
    context.Vote.set(vote);

    // Tally
    let nextProposal: Entity<"Proposal"> = { ...proposal };
    if (support === VoteChoice.AGAINST_VALUE) {
      nextProposal = {
        ...nextProposal,
        againstDelegateVotes: nextProposal.againstDelegateVotes + BIGINT_ONE,
        againstWeightedVotes: nextProposal.againstWeightedVotes + event.params.weight,
      };
    } else if (support === VoteChoice.FOR_VALUE) {
      nextProposal = {
        ...nextProposal,
        forDelegateVotes: nextProposal.forDelegateVotes + BIGINT_ONE,
        forWeightedVotes: nextProposal.forWeightedVotes + event.params.weight,
      };
    } else if (support === VoteChoice.ABSTAIN_VALUE) {
      nextProposal = {
        ...nextProposal,
        abstainDelegateVotes: nextProposal.abstainDelegateVotes + BIGINT_ONE,
        abstainWeightedVotes: nextProposal.abstainWeightedVotes + event.params.weight,
      };
    }
    nextProposal = {
      ...nextProposal,
      totalDelegateVotes: nextProposal.totalDelegateVotes + BIGINT_ONE,
      totalWeightedVotes: nextProposal.totalWeightedVotes + event.params.weight,
    };
    context.Proposal.set(nextProposal);

    context.Delegate.set({
      ...voter,
      numberOptimisticVotes: nextProposal.isOptimistic
        ? voter.numberOptimisticVotes + 1
        : voter.numberOptimisticVotes,
      numberVotes: !nextProposal.isOptimistic ? voter.numberVotes + 1 : voter.numberVotes,
    });

    // Daily snapshot
    const dayId = `${nextProposal.id}-${BigInt(event.block.timestamp) / SECONDS_PER_DAY}`;
    const existingSnap = await context.VoteDailySnapshot.get(dayId);
    const snap: Entity<"VoteDailySnapshot"> = {
      id: dayId,
      proposal_id: nextProposal.id,
      forWeightedVotes: nextProposal.forWeightedVotes,
      againstWeightedVotes: nextProposal.againstWeightedVotes,
      abstainWeightedVotes: nextProposal.abstainWeightedVotes,
      totalWeightedVotes: nextProposal.totalWeightedVotes,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    context.VoteDailySnapshot.set(existingSnap ? { ...existingSnap, ...snap } : snap);
  },
);

// =====================================================
// Timelock handlers
// =====================================================

indexer.onEvent(
  { contract: "Timelock", event: "MinDelayChange" },
  async ({ event, context }) => {
    const id = makeId(event.chainId, event.srcAddress.toLowerCase());
    const tl = await context.GovernanceTimelock.get(id);
    if (!tl) return;
    context.GovernanceTimelock.set({ ...tl, executionDelay: event.params.newDuration });
  },
);

indexer.onEvent(
  { contract: "Timelock", event: "CallScheduled" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const timelockId = event.params.id.toLowerCase();

    const opId = makeId(chainId, timelockId);
    const op: Entity<"TimelockOperation"> = {
      id: opId,
      transactionHash: txHash,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      proposal_id: undefined,
    };
    context.TimelockOperation.set(op);

    const byTxId = makeId(chainId, txHash);
    const byTx: Entity<"TimelockOperationByTx"> = {
      id: byTxId,
      timelockId: opId,
    };
    context.TimelockOperationByTx.set(byTx);
  },
);

indexer.onEvent(
  { contract: "Timelock", event: "Cancelled" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const timelockId = event.params.id.toLowerCase();
    const opId = makeId(chainId, timelockId);
    const operation = await context.TimelockOperation.get(opId);
    if (!operation || !operation.proposal_id) return;
    const proposal = await context.Proposal.get(operation.proposal_id);
    if (!proposal) return;
    context.Proposal.set({
      ...proposal,
      state: ProposalState.CANCELED,
      cancellationTxnHash: event.transaction.hash,
      cancellationBlock: BigInt(event.block.number),
      cancellationTime: BigInt(event.block.timestamp),
    });
    const governance = await context.Governance.get(proposal.governance_id);
    if (governance) {
      context.Governance.set({
        ...governance,
        proposalsCanceled: governance.proposalsCanceled + BIGINT_ONE,
      });
    }
  },
);

// Timelock RoleGranted / RoleRevoked — guardians + optimisticProposers + proposer attach.
const ROLE_OPTIMISTIC_PROPOSER = normalizeRole(Role.OPTIMISTIC_PROPOSER);
const ROLE_CANCELLER = normalizeRole(Role.CANCELLER);
// Default OZ TimelockController PROPOSER_ROLE hash (used since reading from chain
// is async and we keep the handler synchronous-after-await for clarity).
const ROLE_PROPOSER =
  "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";

indexer.onEvent(
  { contract: "Timelock", event: "TimelockRoleGranted" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const timelockAddress = event.srcAddress.toLowerCase();
    const tlId = makeId(chainId, timelockAddress);
    const timelock = await context.GovernanceTimelock.get(tlId);
    if (!timelock) return;

    const role = normalizeRole(event.params.role);
    const account = event.params.account.toLowerCase();

    if (role === ROLE_CANCELLER) {
      const next = timelock.guardians.includes(account)
        ? timelock.guardians
        : [...timelock.guardians, account];
      context.GovernanceTimelock.set({ ...timelock, guardians: next });
    } else if (role === ROLE_OPTIMISTIC_PROPOSER) {
      const current = timelock.optimisticProposers ?? [];
      const next = current.includes(account) ? current : [...current, account];
      context.GovernanceTimelock.set({ ...timelock, optimisticProposers: next });
      if (timelock.governance_id) {
        const gov = await context.Governance.get(timelock.governance_id);
        if (gov) {
          context.Governance.set({ ...gov, optimisticProposers: next });
        }
      }
    } else if (role === ROLE_PROPOSER) {
      await attachGovernanceToTimelock(
        context,
        chainId,
        tlId,
        account,
        event.block.number,
      );
    }
  },
);

indexer.onEvent(
  { contract: "Timelock", event: "TimelockRoleRevoked" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const tlId = makeId(chainId, event.srcAddress.toLowerCase());
    const timelock = await context.GovernanceTimelock.get(tlId);
    if (!timelock) return;
    const role = normalizeRole(event.params.role);
    const account = event.params.account.toLowerCase();

    if (role === ROLE_CANCELLER) {
      const idx = timelock.guardians.indexOf(account);
      if (idx !== -1) {
        context.GovernanceTimelock.set({
          ...timelock,
          guardians: removeFromArrayAtIndex(timelock.guardians, idx),
        });
      }
    } else if (role === ROLE_OPTIMISTIC_PROPOSER) {
      const current = timelock.optimisticProposers ?? [];
      const idx = current.indexOf(account);
      if (idx !== -1) {
        const next = removeFromArrayAtIndex(current, idx);
        context.GovernanceTimelock.set({ ...timelock, optimisticProposers: next });
        if (timelock.governance_id) {
          const gov = await context.Governance.get(timelock.governance_id);
          if (gov) {
            context.Governance.set({ ...gov, optimisticProposers: next });
          }
        }
      }
    }
  },
);

// Suppress unused
void bigintToDecimal;
void GENESIS_ADDRESS;
