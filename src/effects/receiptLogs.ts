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

// keccak256("Transfer(address,address,uint256)"). Both consumers of this effect
// (token.ts `findTrueMinter` and rebalance.ts `decodeTransfers`) only ever read
// ERC20 Transfer logs and skip everything else. We therefore filter the receipt
// down to Transfer logs BEFORE returning — otherwise the effect cache (cache:
// true) retains every log of every receipt for the whole run, which grows the
// heap without bound and OOMs the indexer. Filtering here is behaviourally
// identical (the consumers already discard non-Transfer logs) but keeps each
// cached entry tiny.
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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
    // Keep only ERC20 Transfer logs (topic0 match + the 3 topics the consumers
    // require). Non-Transfer logs are discarded by every consumer anyway, so
    // dropping them here is identical in behaviour and stops the cache from
    // retaining full receipts. See ERC20_TRANSFER_TOPIC note above.
    return receipt.logs
      .filter(
        (l) =>
          l.topics.length >= 3 &&
          l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC,
      )
      .map((l) => ({
        address: l.address.toLowerCase(),
        topics: (l.topics as readonly string[]).map((t) => t.toLowerCase()),
        data: l.data,
        logIndex: Number(l.logIndex),
      }));
  },
);
