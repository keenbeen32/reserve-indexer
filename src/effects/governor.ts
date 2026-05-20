// Governor view-function reads. Replaces subgraph `Governor.bind(...)` chains
// from utils/getters.ts `getOrCreateGovernance` with a single Effect batch.

import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { clientFor } from "./client";
import { isDeterministicRevert } from "./errors";

const GOVERNOR_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function token() view returns (address)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function proposalThreshold() view returns (uint256)",
  "function quorumDenominator() view returns (uint256)",
  "function quorumNumerator() view returns (uint256)",
  "function optimisticParams() view returns ((uint48 vetoDelay,uint32 vetoPeriod,uint256 vetoThreshold))",
  "function proposalThrottleCapacity() view returns (uint256)",
  "function selectorRegistry() view returns (address)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
]);

export type OptimisticParams = {
  vetoDelay: string;
  vetoPeriod: string;
  vetoThreshold: string;
};

export const getGovernorParams = createEffect(
  {
    name: "getGovernorParams",
    // blockNumber: governance params are block-variant; read (and cache-key) at
    // the discovery event's block to match the subgraph's event-block .bind().
    input: S.schema({ chainId: S.number, address: S.string, blockNumber: S.number }),
    output: S.schema({
      name: S.string,
      version: S.string,
      token: S.string,
      votingDelay: S.string,
      votingPeriod: S.string,
      proposalThreshold: S.string,
      quorumDenominator: S.string,
      isOptimistic: S.boolean,
      optimisticParams: S.nullable(
        S.schema({ vetoDelay: S.string, vetoPeriod: S.string, vetoThreshold: S.string }),
      ),
      proposalThrottleCapacity: S.nullable(S.string),
      selectorRegistry: S.nullable(S.string),
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    // blockNumber in args → every readContract below runs at the discovery block.
    const args = {
      address: input.address as `0x${string}`,
      abi: GOVERNOR_ABI,
      blockNumber: BigInt(input.blockNumber),
    } as const;

    // Mandatory reads. If any of these revert the address isn't a Governor;
    // surface the error rather than fall through with garbage.
    const [name, version, token, votingDelay, votingPeriod, proposalThreshold, quorumDenominator] =
      await Promise.all([
        client.readContract({ ...args, functionName: "name" }),
        client.readContract({ ...args, functionName: "version" }),
        client.readContract({ ...args, functionName: "token" }),
        client.readContract({ ...args, functionName: "votingDelay" }),
        client.readContract({ ...args, functionName: "votingPeriod" }),
        client.readContract({ ...args, functionName: "proposalThreshold" }),
        client.readContract({ ...args, functionName: "quorumDenominator" }),
      ]);

    // Optional optimistic reads. A deterministic revert on optimisticParams()
    // genuinely means "this Governor is non-optimistic" — that result is safe to
    // cache. A transient error is re-thrown so the whole effect throws and is
    // NOT cached (the call site retries on the next run).
    let optimisticParams: OptimisticParams | null = null;
    let proposalThrottleCapacity: string | null = null;
    let selectorRegistry: string | null = null;
    let isOptimistic = false;

    try {
      const op = (await client.readContract({
        ...args,
        functionName: "optimisticParams",
      })) as unknown as { vetoDelay: number | bigint; vetoPeriod: number; vetoThreshold: bigint };
      isOptimistic = true;
      optimisticParams = {
        vetoDelay: BigInt(op.vetoDelay).toString(),
        vetoPeriod: BigInt(op.vetoPeriod).toString(),
        vetoThreshold: op.vetoThreshold.toString(),
      };

      const [throttle, registry] = await Promise.all([
        client
          .readContract({ ...args, functionName: "proposalThrottleCapacity" })
          .catch((err: unknown) => {
            if (!isDeterministicRevert(err)) throw err;
            return null;
          }),
        client
          .readContract({ ...args, functionName: "selectorRegistry" })
          .catch((err: unknown) => {
            if (!isDeterministicRevert(err)) throw err;
            return null;
          }),
      ]);
      proposalThrottleCapacity = throttle !== null ? (throttle as bigint).toString() : null;
      selectorRegistry = registry !== null ? (registry as string).toLowerCase() : null;
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      // deterministic revert — not an optimistic governor, leave fields null
    }

    return {
      name: String(name),
      version: String(version),
      token: (token as string).toLowerCase(),
      votingDelay: (votingDelay as bigint).toString(),
      votingPeriod: (votingPeriod as bigint).toString(),
      proposalThreshold: (proposalThreshold as bigint).toString(),
      quorumDenominator: (quorumDenominator as bigint).toString(),
      isOptimistic,
      optimisticParams,
      proposalThrottleCapacity,
      selectorRegistry,
    };
  },
);

// Used by ProposalCreated to read `quorum(voteStart - 1)` at the proposal's
// snapshot block. Subgraph called `governor.quorum(voteStart - 1)`.
export const getGovernorQuorum = createEffect(
  {
    name: "getGovernorQuorum",
    input: S.schema({
      chainId: S.number,
      address: S.string,
      blockNumber: S.string, // bigint serialized
    }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const result = (await client.readContract({
      address: input.address as `0x${string}`,
      abi: GOVERNOR_ABI,
      functionName: "quorum",
      args: [BigInt(input.blockNumber)],
    })) as bigint;
    return result.toString();
  },
);
