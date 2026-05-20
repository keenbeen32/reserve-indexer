// Timelock view-function reads — minDelay, role members, ETA fetch.
// Replaces `Timelock.bind(...)` patterns from utils/getters.ts.
//
// getTimelockSnapshot is a feature-detection effect: a deterministic revert on
// getMinDelay() genuinely means "not a TimelockController" and that result is
// safe to cache. Transient infrastructure errors are re-thrown so they are NOT
// cached — the call site (createGovernanceTimelock) catches them.
// getTimelockOperationEta is a pure-fetch effect: it throws on any failure.

import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { clientFor } from "./client";
import { isDeterministicRevert } from "./errors";

const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
]);

// Default OZ TimelockController role hashes (used as fallback if CANCELLER_ROLE/PROPOSER_ROLE revert).
const DEFAULT_CANCELLER_ROLE =
  "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783";
const DEFAULT_PROPOSER_ROLE =
  "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";

async function readRoleMembers(
  client: ReturnType<typeof clientFor>,
  address: `0x${string}`,
  role: `0x${string}`,
  blockNumber: bigint,
): Promise<string[]> {
  let count: bigint;
  try {
    count = (await client.readContract({
      address,
      abi: TIMELOCK_ABI,
      functionName: "getRoleMemberCount",
      args: [role],
      blockNumber,
    })) as bigint;
  } catch (err) {
    // Deterministic revert = contract isn't AccessControlEnumerable → no members.
    // Transient error must not be cached — re-throw to fail the whole effect.
    if (!isDeterministicRevert(err)) throw err;
    return [];
  }

  const members: string[] = [];
  for (let i = 0n; i < count; i++) {
    try {
      const member = (await client.readContract({
        address,
        abi: TIMELOCK_ABI,
        functionName: "getRoleMember",
        args: [role, i],
        blockNumber,
      })) as string;
      members.push(member.toLowerCase());
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      // deterministic revert on a single index — skip it
    }
  }
  return members;
}

export const getTimelockSnapshot = createEffect(
  {
    name: "getTimelockSnapshot",
    // blockNumber: minDelay + role members are block-variant; read (and
    // cache-key) at the discovery event's block to match the subgraph's
    // event-block .bind() reads.
    input: S.schema({
      chainId: S.number,
      address: S.string,
      optimisticProposerRole: S.string,
      blockNumber: S.number,
    }),
    output: S.schema({
      isTimelock: S.boolean, // false → contract reverts on getMinDelay → not a TimelockController
      executionDelay: S.string,
      guardians: S.array(S.string), // CANCELLER_ROLE holders
      optimisticProposers: S.array(S.string), // OPTIMISTIC_PROPOSER_ROLE holders
      governorAddress: S.nullable(S.string), // first PROPOSER_ROLE holder
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const address = input.address as `0x${string}`;
    const blockNumber = BigInt(input.blockNumber);
    // blockNumber in args → every readContract below runs at the discovery block.
    const args = { address, abi: TIMELOCK_ABI, blockNumber } as const;

    // getMinDelay reverts on non-timelock contracts. A deterministic revert is
    // a real "not a timelock" answer (safe to cache); a transient error is
    // re-thrown so it is never cached as a false negative.
    let executionDelay: bigint;
    try {
      executionDelay = (await client.readContract({
        ...args,
        functionName: "getMinDelay",
      })) as bigint;
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      return {
        isTimelock: false,
        executionDelay: "0",
        guardians: [],
        optimisticProposers: [],
        governorAddress: null,
      };
    }

    // Resolve CANCELLER_ROLE and PROPOSER_ROLE hashes from the contract; fall
    // back to OZ defaults if those getters genuinely don't exist (deterministic
    // revert). A transient error is re-thrown.
    let cancellerRole = DEFAULT_CANCELLER_ROLE as `0x${string}`;
    let proposerRole = DEFAULT_PROPOSER_ROLE as `0x${string}`;
    try {
      cancellerRole = (await client.readContract({
        ...args,
        functionName: "CANCELLER_ROLE",
      })) as `0x${string}`;
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      // keep default
    }
    try {
      proposerRole = (await client.readContract({
        ...args,
        functionName: "PROPOSER_ROLE",
      })) as `0x${string}`;
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      // keep default
    }

    const optimisticProposerRole = input.optimisticProposerRole as `0x${string}`;

    const [guardians, optimisticProposers, proposers] = await Promise.all([
      readRoleMembers(client, address, cancellerRole, blockNumber),
      readRoleMembers(client, address, optimisticProposerRole, blockNumber),
      readRoleMembers(client, address, proposerRole, blockNumber),
    ]);

    const governorAddress = proposers.length > 0 ? proposers[0]! : null;

    return {
      isTimelock: true,
      executionDelay: executionDelay.toString(),
      guardians,
      optimisticProposers,
      governorAddress,
    };
  },
);

// Fetches the scheduled execution timestamp (ETA) for a timelock operation.
// Pure-fetch effect — throws on any failure (never caches a dummy "0").
export const getTimelockOperationEta = createEffect(
  {
    name: "getTimelockOperationEta",
    input: S.schema({
      chainId: S.number,
      address: S.string,
      operationId: S.string,
    }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const ts = (await client.readContract({
      address: input.address as `0x${string}`,
      abi: TIMELOCK_ABI,
      functionName: "getTimestamp",
      args: [input.operationId as `0x${string}`],
    })) as bigint;
    return ts.toString();
  },
);
