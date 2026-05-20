// ERC20 view-function reads. Replaces subgraph utils/tokens.ts (`.bind()` +
// try_name/try_symbol/try_decimals/try_totalSupply) with the Envio Effect API.
//
// These effects THROW on any failure — they never return dummy data. Envio does
// not cache a thrown effect, so a transient RPC failure is retried on the next
// run instead of being permanently cached. Callers wrap context.effect(...) in
// try/catch and supply the "unknown" / 18 / "0" fallback there.

import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { clientFor } from "./client";

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

export const getErc20Metadata = createEffect(
  {
    name: "getErc20Metadata",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.schema({
      name: S.string,
      symbol: S.string,
      decimals: S.number,
      totalSupply: S.string, // serialized bigint
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const args = { address: input.address as `0x${string}`, abi: ERC20_ABI } as const;

    // Any failed read throws the whole effect (all-or-nothing). The cache is
    // only populated when every read succeeds.
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({ ...args, functionName: "name" }),
      client.readContract({ ...args, functionName: "symbol" }),
      client.readContract({ ...args, functionName: "decimals" }),
      client.readContract({ ...args, functionName: "totalSupply" }),
    ]);

    return {
      name: String(name),
      symbol: String(symbol),
      decimals: Number(decimals),
      totalSupply: (totalSupply as bigint).toString(),
    };
  },
);

// Total-supply read used to seed a staking token's supply baseline at discovery.
// totalSupply is block-variant and feeds a delta-accumulated value, so it MUST
// be read at the discovery event's block — `blockNumber` is both the read tag
// and part of the cache key (the subgraph reads it at the event block).
export const getErc20TotalSupply = createEffect(
  {
    name: "getErc20TotalSupply",
    input: S.schema({ chainId: S.number, address: S.string, blockNumber: S.number }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = clientFor(input.chainId);
    const result = (await client.readContract({
      address: input.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "totalSupply",
      blockNumber: BigInt(input.blockNumber),
    })) as bigint;
    return result.toString();
  },
);
