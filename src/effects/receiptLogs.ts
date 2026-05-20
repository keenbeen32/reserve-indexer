// Transaction receipt log fetcher. Replaces subgraph `receipt: true` for the
// DTF.AuctionTrustedFillCreated handler, which needs sibling ERC20 Transfer
// logs in the same transaction to reconstruct CowSwap (trusted-fill) bid amounts.
//
// HyperIndex does not expose `event.receipt.logs` or sibling logs from
// field_selection. The only handler-level workaround is to call
// `eth_getTransactionReceipt` via viem — that's what this Effect does.

import { createEffect, S } from "envio";
import { clientFor } from "./client";

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
};

export const getTxReceiptLogs = createEffect(
  {
    name: "getTxReceiptLogs",
    input: S.schema({ chainId: S.number, txHash: S.string }),
    // Untyped pass-through — the consumer rebalance.ts parser inspects topics/data.
    output: S.array(
      S.schema({
        address: S.string,
        topics: S.array(S.string),
        data: S.string,
        logIndex: S.number,
      }),
    ),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    // Throws on failure — the cache is never populated with an empty-log dummy.
    // The call site catches and falls back to [] (no bids parsed).
    const client = clientFor(input.chainId);
    const receipt = await client.getTransactionReceipt({
      hash: input.txHash as `0x${string}`,
    });
    return receipt.logs.map((l) => ({
      address: l.address.toLowerCase(),
      topics: (l.topics as readonly string[]).map((t) => t.toLowerCase()),
      data: l.data,
      logIndex: Number(l.logIndex),
    }));
  },
);
