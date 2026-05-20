// BridgedDTF Transfer handler — thin wrapper over the shared transfer pipeline.
// Mirrors dtf-index-subgraph/src/bridged-dtf/mappings.ts.

import { indexer } from "envio";
import { processTransfer } from "./token";

indexer.onEvent(
  { contract: "BridgedDTF", event: "Transfer" },
  async ({ event, context }) => {
    await processTransfer(
      context,
      event.chainId,
      event.srcAddress,
      "BRIDGED_DTF",
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
