// Ported from dtf-index-subgraph/src/utils/getters.ts.
//
// Key differences:
//  - All entity reads are async (HyperIndex context.Entity.get() returns a Promise).
//  - Contract metadata reads use the Effect API (Effects in src/effects/*).
//  - Template subscription does NOT happen here. Dynamic contract registration
//    runs in src/handlers/deploy.ts via indexer.contractRegister hooks at the
//    FolioDeployed / GovernedFolioDeployed / DeployedGovernedStakingToken
//    events. Getters are pure entity-creation helpers.

import type { Entity, EvmOnEventContext } from "envio";
import { BigDecimal } from "envio";

import { getErc20Metadata, getErc20TotalSupply } from "../effects/erc20";
import { getGovernorParams } from "../effects/governor";
import { getTimelockSnapshot } from "../effects/timelock";
import {
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  GENESIS_ADDRESS,
  GovernanceType,
  Role,
  SECONDS_PER_DAY,
  SECONDS_PER_MONTH,
  TokenType,
  chainId as makeId,
} from "./constants";

type Ctx = EvmOnEventContext;

// =====================================================
// Token / StakingToken
// =====================================================

export async function getOrCreateToken(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  type: TokenType = TokenType.ASSET,
): Promise<Entity<"Token">> {
  const id = makeId(chainId, tokenAddress);
  const existing = await context.Token.get(id);
  if (existing) return existing;

  // The effect throws on RPC failure (so the failure is never cached). Fall
  // back to subgraph-equivalent dummy metadata here so the indexer keeps going.
  let meta: { name: string; symbol: string; decimals: number; totalSupply: string };
  try {
    meta = await context.effect(getErc20Metadata, {
      chainId,
      address: tokenAddress,
    });
  } catch {
    meta = { name: "unknown", symbol: "unknown", decimals: 18, totalSupply: "0" };
  }

  const token: Entity<"Token"> = {
    id,
    address: tokenAddress.toLowerCase(),
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    currentHolderCount: BIGINT_ZERO,
    cumulativeHolderCount: BIGINT_ZERO,
    transferCount: BIGINT_ZERO,
    mintCount: BIGINT_ZERO,
    burnCount: BIGINT_ZERO,
    totalSupply: BIGINT_ZERO,
    totalBurned: BIGINT_ZERO,
    totalMinted: BIGINT_ZERO,
    type,
  };
  context.Token.set(token);
  return token;
}

// Single DTF-construction point. The Folio emits its init events (MintFeeSet,
// TVLFeeSet, RoleGranted, ...) at a lower logIndex than FolioDeployed, so a
// config handler can be the first to touch the DTF — it must create the entity
// rather than bail. deployer/proxyAdmin/ownerAddress are placeholders here;
// the FolioDeployed handler fills them and merges (never re-defaults config).
export async function getOrCreateDTF(
  context: Ctx,
  chainId: number,
  dtfAddress: string,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"DTF">> {
  const id = makeId(chainId, dtfAddress);
  const existing = await context.DTF.get(id);
  if (existing) return existing;

  const token = await getOrCreateToken(context, chainId, dtfAddress, TokenType.DTF);
  const dtf: Entity<"DTF"> = {
    id,
    token_id: token.id,
    totalRevenue: BIGINT_ZERO,
    protocolRevenue: BIGINT_ZERO,
    governanceRevenue: BIGINT_ZERO,
    externalRevenue: BIGINT_ZERO,
    deployer: "",
    proxyAdmin: "",
    mintingFee: BIGINT_ZERO,
    tvlFee: BIGINT_ZERO,
    auctionDelay: BIGINT_ZERO,
    auctionLength: BIGINT_ZERO,
    bidsEnabled: undefined,
    trustedFillerRegistry: undefined,
    trustedFillerEnabled: undefined,
    mandate: "",
    // Default to NATIVE DTF with PARTIAL price control; RebalanceControlSet overrides.
    weightControl: true,
    priceControl: 1,
    annualizedTvlFee: BIGINT_ZERO,
    auctionApprovers: [],
    legacyAuctionApprovers: [],
    auctionLaunchers: [],
    brandManagers: [],
    admins: [],
    legacyAdmins: [],
    stToken_id: undefined,
    stTokenAddress: undefined,
    ownerAddress: "",
    ownerGovernance_id: undefined,
    tradingGovernance_id: undefined,
    blockNumber,
    timestamp,
    feeRecipients: "",
  };
  context.DTF.set(dtf);
  return dtf;
}

// Canonical "first time we see this stToken" hook. Seeds totalSupply from chain
// so pre-discovery Transfers aren't lost. Template subscription happens at the
// indexer.contractRegister hook for the spawning event, not here.
export async function getOrCreateStakingToken(
  context: Ctx,
  chainId: number,
  stTokenAddress: string,
  blockNumber: number,
): Promise<Entity<"StakingToken">> {
  const id = makeId(chainId, stTokenAddress);
  const existing = await context.StakingToken.get(id);
  if (existing) return existing;

  // Seed the underlying ERC20 metadata + total supply. totalSupply is read at
  // the discovery block (blockNumber). The effect throws on RPC failure (never
  // cached); fall back to "0" so the indexer keeps going.
  const voteToken = await getOrCreateToken(context, chainId, stTokenAddress, TokenType.VOTE);
  let totalSupplyStr = "0";
  try {
    totalSupplyStr = await context.effect(getErc20TotalSupply, {
      chainId,
      address: stTokenAddress,
      blockNumber,
    });
  } catch {
    totalSupplyStr = "0";
  }
  context.Token.set({ ...voteToken, totalSupply: BigInt(totalSupplyStr) });

  const stToken: Entity<"StakingToken"> = {
    id,
    underlying_id: undefined,
    token_id: voteToken.id,
    governance_id: undefined,
    legacyGovernance: [],
    currentDelegates: BIGINT_ZERO,
    totalDelegates: BIGINT_ZERO,
    delegatedVotesRaw: BIGINT_ZERO,
    delegatedVotes: BIGDECIMAL_ZERO,
    currentOptimisticDelegates: BIGINT_ZERO,
    totalOptimisticDelegates: BIGINT_ZERO,
    optimisticDelegatedVotesRaw: BIGINT_ZERO,
    optimisticDelegatedVotes: BIGDECIMAL_ZERO,
  };
  context.StakingToken.set(stToken);
  return stToken;
}

// =====================================================
// Governance / Timelock
// =====================================================

// Creates the GovernanceTimelock entity. Returns true if it was newly created
// AND looks like a real OZ timelock (getMinDelay() didn't revert). Returns false
// otherwise — caller should bail out, matching subgraph's "Not a timelock" early
// return in createGovernanceTimelock.
export async function createGovernanceTimelock(
  context: Ctx,
  chainId: number,
  timelockAddress: string,
  entityRefId: string,
  entityType: string,
  blockNumber: number,
): Promise<boolean> {
  const id = makeId(chainId, timelockAddress);
  const existing = await context.GovernanceTimelock.get(id);
  if (existing) return true;

  // The effect throws only on transient RPC failure (a deterministic "not a
  // timelock" revert returns isTimelock:false and is cached). On a transient
  // failure, bail like the !isTimelock path — no entity is created, so the next
  // event referencing this address retries. Reads are taken at blockNumber.
  const snapshot = await context
    .effect(getTimelockSnapshot, {
      chainId,
      address: timelockAddress,
      optimisticProposerRole: Role.OPTIMISTIC_PROPOSER,
      blockNumber,
    })
    .catch(() => null);
  if (!snapshot || !snapshot.isTimelock) return false;

  const timelock: Entity<"GovernanceTimelock"> = {
    id,
    governance_id: undefined,
    executionDelay: BigInt(snapshot.executionDelay),
    guardians: snapshot.guardians,
    optimisticProposers: snapshot.optimisticProposers,
    entity: entityRefId,
    type: entityType,
  };
  context.GovernanceTimelock.set(timelock);

  // If a Governor is wired into the timelock (PROPOSER_ROLE), back-attach.
  if (snapshot.governorAddress) {
    await attachGovernanceToTimelock(
      context,
      chainId,
      id,
      snapshot.governorAddress,
      blockNumber,
    );
  }
  return true;
}

export async function attachGovernanceToTimelock(
  context: Ctx,
  chainId: number,
  timelockId: string,
  governorAddress: string,
  blockNumber: number,
): Promise<Entity<"Governance"> | null> {
  const timelock = await context.GovernanceTimelock.get(timelockId);
  if (!timelock) return null;

  const governance = await getOrCreateGovernance(
    context,
    chainId,
    governorAddress,
    timelockId,
    blockNumber,
  );
  if (!governance) return null;

  context.GovernanceTimelock.set({ ...timelock, governance_id: governance.id });

  if (timelock.type === GovernanceType.VOTE_LOCKING) {
    const stakingToken = await context.StakingToken.get(timelock.entity);
    if (stakingToken) {
      context.StakingToken.set({ ...stakingToken, governance_id: governance.id });
    }
  } else {
    const dtf = await context.DTF.get(timelock.entity);
    if (dtf) {
      let next: Entity<"DTF"> = { ...dtf };
      if (timelock.type === GovernanceType.OWNER) {
        next = { ...next, ownerGovernance_id: governance.id };
      } else {
        next = { ...next, tradingGovernance_id: governance.id };
      }
      // Backfill DTF → stToken link if it wasn't set by GovernedFolioDeployed.
      if (!dtf.stToken_id) {
        next = {
          ...next,
          stToken_id: governance.token_id,
          stTokenAddress: governance.token_id.split("-")[1] ?? undefined,
        };
      }
      context.DTF.set(next);
    }
  }
  return governance;
}

export async function getOrCreateGovernance(
  context: Ctx,
  chainId: number,
  governorAddress: string,
  timelockEntityId: string,
  blockNumber: number,
): Promise<Entity<"Governance"> | null> {
  const id = makeId(chainId, governorAddress);
  const existing = await context.Governance.get(id);
  if (existing) return existing;

  // The effect throws only on transient RPC failure (a non-optimistic governor
  // is a deterministic, cached result). On a transient failure, return null —
  // every caller handles null, and no Governance entity is created so the next
  // event referencing this governor retries. Reads are taken at blockNumber.
  const params = await context
    .effect(getGovernorParams, {
      chainId,
      address: governorAddress,
      blockNumber,
    })
    .catch(() => null);
  if (!params) return null;

  // getOrCreateStakingToken handles supply seed for stTokens we discover here
  // (covers untracked-deployer paths too).
  const stakingToken = await getOrCreateStakingToken(
    context,
    chainId,
    params.token,
    blockNumber,
  );

  const governance: Entity<"Governance"> = {
    id,
    name: params.name,
    version: params.version,
    timelock_id: timelockEntityId,
    token_id: stakingToken.id,
    votingDelay: BigInt(params.votingDelay),
    votingPeriod: BigInt(params.votingPeriod),
    proposalThreshold: BigInt(params.proposalThreshold),
    quorumVotes: undefined,
    quorumNumerator: BIGINT_ZERO,
    quorumDenominator: BigInt(params.quorumDenominator),
    isOptimistic: params.isOptimistic,
    optimisticVetoDelay: params.optimisticParams
      ? BigInt(params.optimisticParams.vetoDelay)
      : undefined,
    optimisticVetoPeriod: params.optimisticParams
      ? BigInt(params.optimisticParams.vetoPeriod)
      : undefined,
    optimisticVetoThreshold: params.optimisticParams
      ? BigInt(params.optimisticParams.vetoThreshold)
      : undefined,
    optimisticProposalThrottleCapacity: params.proposalThrottleCapacity
      ? BigInt(params.proposalThrottleCapacity)
      : undefined,
    optimisticSelectorRegistry: params.selectorRegistry ?? undefined,
    optimisticProposers: [],
    proposalCount: BIGINT_ZERO,
    proposalsQueued: BIGINT_ZERO,
    proposalsExecuted: BIGINT_ZERO,
    proposalsCanceled: BIGINT_ZERO,
  };

  if (params.isOptimistic) {
    // Pull optimistic proposers from the timelock so they're available to the UI.
    const tl = await context.GovernanceTimelock.get(timelockEntityId);
    if (tl) {
      context.Governance.set({
        ...governance,
        optimisticProposers: tl.optimisticProposers ?? [],
      });
      return { ...governance, optimisticProposers: tl.optimisticProposers ?? [] };
    }
  }

  context.Governance.set(governance);
  return governance;
}

// =====================================================
// RSR burn snapshot getters
// =====================================================

export async function getOrCreateRSRBurnGlobal(
  context: Ctx,
  chainId: number,
): Promise<Entity<"RSRBurnGlobal">> {
  // Singleton id "1" — but namespaced per chain to keep three independent counters.
  const id = `${chainId}-1`;
  const existing = await context.RSRBurnGlobal.get(id);
  if (existing) return existing;
  const fresh: Entity<"RSRBurnGlobal"> = {
    id,
    totalBurned: BIGINT_ZERO,
    totalBurnCount: BIGINT_ZERO,
    lastUpdateBlock: BIGINT_ZERO,
    lastUpdateTimestamp: BIGINT_ZERO,
  };
  context.RSRBurnGlobal.set(fresh);
  return fresh;
}

export async function getOrCreateRSRBurnDailySnapshot(
  context: Ctx,
  chainId: number,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"RSRBurnDailySnapshot">> {
  const dayBucket = timestamp / SECONDS_PER_DAY;
  const id = `${chainId}-${dayBucket}`;
  const existing = await context.RSRBurnDailySnapshot.get(id);
  if (existing) return existing;
  const fresh: Entity<"RSRBurnDailySnapshot"> = {
    id,
    dailyBurnAmount: BIGINT_ZERO,
    dailyBurnCount: 0,
    cumulativeBurned: BIGINT_ZERO,
    blockNumber,
    timestamp,
  };
  context.RSRBurnDailySnapshot.set(fresh);
  return fresh;
}

export async function getOrCreateRSRBurnMonthlySnapshot(
  context: Ctx,
  chainId: number,
  blockNumber: bigint,
  timestamp: bigint,
): Promise<Entity<"RSRBurnMonthlySnapshot">> {
  const monthBucket = timestamp / SECONDS_PER_MONTH;
  const id = `${chainId}-${monthBucket}`;
  const existing = await context.RSRBurnMonthlySnapshot.get(id);
  if (existing) return existing;
  const fresh: Entity<"RSRBurnMonthlySnapshot"> = {
    id,
    monthlyBurnAmount: BIGINT_ZERO,
    monthlyBurnCount: 0,
    cumulativeBurned: BIGINT_ZERO,
    blockNumber,
    timestamp,
  };
  context.RSRBurnMonthlySnapshot.set(fresh);
  return fresh;
}

// Exposed helper so callers (deploy handlers) can short-circuit before doing
// an Effect / entity write when an stToken was already initialized via the
// alternate path.
export function isGenesis(address: string): boolean {
  return address.toLowerCase() === GENESIS_ADDRESS;
}
