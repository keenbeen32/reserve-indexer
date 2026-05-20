// RSR burn tracker — mirrors subgraph src/dtf/handlers.ts `_handleRSRBurn`.
// Filtered to Transfers whose `to` is the dead address (the burn sink).

import type { Entity } from "envio";
import { indexer } from "envio";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  DEAD_ADDRESS,
  chainId as makeId,
} from "../utils/constants";
import {
  getOrCreateRSRBurnDailySnapshot,
  getOrCreateRSRBurnGlobal,
  getOrCreateRSRBurnMonthlySnapshot,
} from "../utils/getters";

indexer.onEvent(
  {
    contract: "RSR",
    event: "Transfer",
    where: { params: { to: DEAD_ADDRESS as `0x${string}` } },
  },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const id = makeId(chainId, `${txHash}-${event.logIndex}`);
    const amount = event.params.value;
    const blockNumber = BigInt(event.block.number);
    const timestamp = BigInt(event.block.timestamp);

    const burn: Entity<"RSRBurn"> = {
      id,
      amount,
      burner: event.params.from.toLowerCase(),
      blockNumber,
      timestamp,
      transactionHash: txHash,
    };
    context.RSRBurn.set(burn);

    const global = await getOrCreateRSRBurnGlobal(context, chainId);
    const newTotal = global.totalBurned + amount;
    context.RSRBurnGlobal.set({
      ...global,
      totalBurned: newTotal,
      totalBurnCount: global.totalBurnCount + BIGINT_ONE,
      lastUpdateBlock: blockNumber,
      lastUpdateTimestamp: timestamp,
    });

    const daily = await getOrCreateRSRBurnDailySnapshot(
      context,
      chainId,
      blockNumber,
      timestamp,
    );
    context.RSRBurnDailySnapshot.set({
      ...daily,
      dailyBurnAmount: daily.dailyBurnAmount + amount,
      dailyBurnCount: daily.dailyBurnCount + 1,
      cumulativeBurned: newTotal,
      blockNumber,
      timestamp,
    });

    const monthly = await getOrCreateRSRBurnMonthlySnapshot(
      context,
      chainId,
      blockNumber,
      timestamp,
    );
    context.RSRBurnMonthlySnapshot.set({
      ...monthly,
      monthlyBurnAmount: monthly.monthlyBurnAmount + amount,
      monthlyBurnCount: monthly.monthlyBurnCount + 1,
      cumulativeBurned: newTotal,
      blockNumber,
      timestamp,
    });

    // Suppress unused-import warnings when no other RSRBurn writes happen.
    void BIGINT_ZERO;
  },
);
