// Deploy handlers — FolioDeployer + GovernanceDeployer.
// Ported from dtf-index-subgraph/src/deploy/handlers.ts + mappings.ts.
//
// Each spawn event has TWO registrations:
//   1. `indexer.contractRegister` to register dynamic contracts so future
//      events from the spawned addresses get indexed (replaces subgraph
//      *Template.create() calls).
//   2. `indexer.onEvent` to create entity rows.

import type { Address, Entity } from "envio";
import { indexer } from "envio";

import { getUnstakingManagerAddress } from "../effects/stakingVault";
import {
  BIGINT_ZERO,
  GENESIS_ADDRESS,
  GovernanceType,
  TokenType,
  chainId as makeId,
} from "../utils/constants";
import {
  attachGovernanceToTimelock,
  createGovernanceTimelock,
  getOrCreateGovernance,
  getOrCreateStakingToken,
  getOrCreateToken,
} from "../utils/getters";

// =====================================================
// FolioDeployer.FolioDeployed
// =====================================================

indexer.contractRegister(
  { contract: "FolioDeployer", event: "FolioDeployed" },
  async ({ event, context }) => {
    context.chain.DTF.add(event.params.folio as Address);
  },
);

indexer.onEvent(
  { contract: "FolioDeployer", event: "FolioDeployed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddress = event.params.folio.toLowerCase();
    // TEMP DEBUG — see [ORDER-DEBUG] logs in dtf.ts. Remove once confirmed.
    if (dtfAddress === "0x323c03c48660fe31186fa82c289b0766d331ce21") {
      context.log.info(
        `[ORDER-DEBUG] FolioDeployed block=${event.block.number} logIndex=${event.logIndex} CREATING DTF`,
      );
    }
    const proxyAdmin = event.params.folioAdmin.toLowerCase();
    const deployer = event.transaction.from
      ? (event.transaction.from as string).toLowerCase()
      : event.params.folioOwner.toLowerCase();

    const token = await getOrCreateToken(context, chainId, dtfAddress, TokenType.DTF);
    const dtf: Entity<"DTF"> = {
      id: makeId(chainId, dtfAddress),
      token_id: token.id,
      totalRevenue: BIGINT_ZERO,
      protocolRevenue: BIGINT_ZERO,
      governanceRevenue: BIGINT_ZERO,
      externalRevenue: BIGINT_ZERO,
      deployer,
      proxyAdmin,
      mintingFee: BIGINT_ZERO,
      tvlFee: BIGINT_ZERO,
      auctionDelay: BIGINT_ZERO,
      auctionLength: BIGINT_ZERO,
      bidsEnabled: undefined,
      trustedFillerRegistry: undefined,
      trustedFillerEnabled: undefined,
      mandate: "",
      // Default to NATIVE DTF with PARTIAL price control; RebalanceControlSet
      // event overrides if/when the DTF emits it.
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
      ownerAddress: deployer,
      ownerGovernance_id: undefined,
      tradingGovernance_id: undefined,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      feeRecipients: "",
    };
    context.DTF.set(dtf);
  },
);

// =====================================================
// FolioDeployer.GovernedFolioDeployed
// =====================================================

indexer.contractRegister(
  { contract: "FolioDeployer", event: "GovernedFolioDeployed" },
  async ({ event, context }) => {
    context.chain.StakingToken.add(event.params.stToken as Address);
    context.chain.Governance.add(event.params.ownerGovernor as Address);
    context.chain.Timelock.add(event.params.ownerTimelock as Address);
    if (event.params.tradingTimelock.toLowerCase() !== GENESIS_ADDRESS) {
      context.chain.Governance.add(event.params.tradingGovernor as Address);
      context.chain.Timelock.add(event.params.tradingTimelock as Address);
    }
  },
);

indexer.onEvent(
  { contract: "FolioDeployer", event: "GovernedFolioDeployed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dtfAddress = event.params.folio.toLowerCase();
    const dtfId = makeId(chainId, dtfAddress);

    const dtf = await context.DTF.get(dtfId);
    if (!dtf) return;

    const blockNumber = event.block.number;
    const stTokenAddress = event.params.stToken.toLowerCase();
    const stToken = await getOrCreateStakingToken(
      context,
      chainId,
      stTokenAddress,
      blockNumber,
    );

    // Owner governance + timelock
    const ownerTimelockAddress = event.params.ownerTimelock.toLowerCase();
    const ownerTimelockId = makeId(chainId, ownerTimelockAddress);
    await createGovernanceTimelock(
      context,
      chainId,
      ownerTimelockAddress,
      dtfId,
      GovernanceType.OWNER,
      blockNumber,
    );
    const ownerGovernance = await getOrCreateGovernance(
      context,
      chainId,
      event.params.ownerGovernor.toLowerCase(),
      ownerTimelockId,
      blockNumber,
    );

    // Trading governance + timelock (optional)
    let tradingGovernanceId: string | undefined;
    if (event.params.tradingTimelock.toLowerCase() !== GENESIS_ADDRESS) {
      const tradingTimelockAddress = event.params.tradingTimelock.toLowerCase();
      const tradingTimelockId = makeId(chainId, tradingTimelockAddress);
      await createGovernanceTimelock(
        context,
        chainId,
        tradingTimelockAddress,
        dtfId,
        GovernanceType.TRADING,
        blockNumber,
      );
      const tradingGovernance = await getOrCreateGovernance(
        context,
        chainId,
        event.params.tradingGovernor.toLowerCase(),
        tradingTimelockId,
        blockNumber,
      );
      tradingGovernanceId = tradingGovernance?.id;
    }

    context.DTF.set({
      ...dtf,
      stToken_id: stToken.id,
      stTokenAddress,
      ownerGovernance_id: ownerGovernance?.id,
      tradingGovernance_id: tradingGovernanceId,
      ownerAddress: ownerTimelockAddress,
    });
  },
);

// =====================================================
// GovernanceDeployer.DeployedGovernedStakingToken
// =====================================================

// Plain viem read used inside contractRegister, which doesn't expose the
// Effect API. Tradeoff: no Effect cache/dedup, but we need this address to
// register the UnstakingManager dynamic contract.
async function readUnstakingManager(
  chainIdNum: number,
  stakingVault: string,
): Promise<string | null> {
  const { clientFor } = await import("../effects/client");
  const { parseAbi } = await import("viem");
  const abi = parseAbi(["function unstakingManager() view returns (address)"]);
  try {
    const client = clientFor(chainIdNum);
    const addr = (await client.readContract({
      address: stakingVault as `0x${string}`,
      abi,
      functionName: "unstakingManager",
    })) as string;
    return addr.toLowerCase();
  } catch {
    return null;
  }
}

indexer.contractRegister(
  { contract: "GovernanceDeployer", event: "DeployedGovernedStakingToken" },
  async ({ event, context }) => {
    context.chain.StakingToken.add(event.params.stToken as Address);
    context.chain.Governance.add(event.params.governor as Address);
    context.chain.Timelock.add(event.params.timelock as Address);

    const unstakingManagerAddress = await readUnstakingManager(
      context.chain.id,
      event.params.stToken,
    );
    if (unstakingManagerAddress) {
      context.chain.UnstakingManager.add(unstakingManagerAddress as Address);
    }
  },
);

indexer.onEvent(
  { contract: "GovernanceDeployer", event: "DeployedGovernedStakingToken" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const blockNumber = event.block.number;
    const stTokenAddress = event.params.stToken.toLowerCase();
    const underlyingAddress = event.params.underlying.toLowerCase();
    const governorAddress = event.params.governor.toLowerCase();
    const timelockAddress = event.params.timelock.toLowerCase();

    const stToken = await getOrCreateStakingToken(
      context,
      chainId,
      stTokenAddress,
      blockNumber,
    );
    const underlying = await getOrCreateToken(
      context,
      chainId,
      underlyingAddress,
      TokenType.ASSET,
    );

    // VOTE_LOCKING timelock anchored on the stToken entity (matches subgraph).
    const timelockId = makeId(chainId, timelockAddress);
    await createGovernanceTimelock(
      context,
      chainId,
      timelockAddress,
      stToken.id,
      GovernanceType.VOTE_LOCKING,
      blockNumber,
    );
    const governance = await getOrCreateGovernance(
      context,
      chainId,
      governorAddress,
      timelockId,
      blockNumber,
    );

    context.StakingToken.set({
      ...stToken,
      underlying_id: underlying.id,
      governance_id: governance?.id,
    });

    // Read & wire UnstakingManager. The effect throws (uncached) on RPC
    // failure; fall back to undefined so the entity is skipped — same as the
    // existing guard. The contractRegister hook handles the address separately.
    const unstakingManagerAddress = await context
      .effect(getUnstakingManagerAddress, {
        chainId,
        stakingVault: stTokenAddress,
      })
      .catch(() => undefined);
    if (unstakingManagerAddress) {
      const um: Entity<"UnstakingManager"> = {
        id: makeId(chainId, unstakingManagerAddress),
        token_id: stToken.id,
      };
      context.UnstakingManager.set(um);
    }

    // Suppress unused — attachGovernanceToTimelock is exported for other callers.
    void attachGovernanceToTimelock;
  },
);
