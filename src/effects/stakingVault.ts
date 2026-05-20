// StakingVault view-function reads. Replaces subgraph `StakingVault.bind(...)`
// in deploy/handlers.ts for the `unstakingManager()` read needed at staking-token
// creation time.

import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { clientFor } from "./client";

const STAKING_VAULT_ABI = parseAbi([
  "function unstakingManager() view returns (address)",
]);

// Throws on failure — the cache is never populated with a null dummy. The call
// site (deploy.ts DeployedGovernedStakingToken) catches and skips UnstakingManager
// entity creation.
export const getUnstakingManagerAddress = createEffect(
  {
    name: "getUnstakingManagerAddress",
    input: S.schema({ chainId: S.number, stakingVault: S.string }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const addr = (await client.readContract({
      address: input.stakingVault as `0x${string}`,
      abi: STAKING_VAULT_ABI,
      functionName: "unstakingManager",
    })) as string;
    return addr.toLowerCase();
  },
);
