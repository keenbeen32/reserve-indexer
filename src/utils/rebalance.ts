// Pure log parser for trusted-fill auction bid reconstruction.
// Mirrors dtf-index-subgraph/src/utils/rebalance.ts: walks ERC20 Transfer logs
// from the same transaction receipt and pairs DTF-out sells with DTF-in buys.
//
// The receipt is fetched by the receiptLogs Effect (replacing subgraph
// `receipt: true`); this file is pure and synchronous.

import type { RawLog } from "../effects/receiptLogs";

export type ParsedAuctionBid = {
  sellToken: string;
  sellAmount: bigint;
  buyToken: string;
  buyAmount: bigint;
  dtf: string;
};

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type DecodedTransfer = {
  log: RawLog;
  from: string;
  to: string;
  value: bigint;
  token: string;
};

function topicToAddress(topic: string): string {
  // 32-byte topic, low 20 bytes is the address.
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function dataToBigInt(data: string): bigint {
  if (!data || data === "0x") return 0n;
  return BigInt(data);
}

function decodeTransfers(dtfAddress: string, logs: readonly RawLog[]): DecodedTransfer[] {
  const dtf = dtfAddress.toLowerCase();
  const result: DecodedTransfer[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const from = topicToAddress(log.topics[1]!);
    const to = topicToAddress(log.topics[2]!);
    if (from !== dtf && to !== dtf) continue;
    result.push({
      log,
      from,
      to,
      value: dataToBigInt(log.data),
      token: log.address.toLowerCase(),
    });
  }
  return result;
}

// Mirrors the subgraph parser's pair-matching: aggregate consecutive same-token
// outflows from the DTF (sell), then collect inflows (buy) until the next sell
// or a third token is encountered. Net out any same-token refund from the sell amount.
export function parseAuctionBidsFromLogs(
  dtfAddress: string,
  logs: readonly RawLog[],
): ParsedAuctionBid[] {
  const dtf = dtfAddress.toLowerCase();
  const transfers = decodeTransfers(dtf, logs).sort((a, b) => a.log.logIndex - b.log.logIndex);
  if (transfers.length === 0) return [];

  const bids: ParsedAuctionBid[] = [];
  let i = 0;

  while (i < transfers.length) {
    const first = transfers[i]!;

    if (first.from !== dtf) {
      i++;
      continue;
    }

    let sellToken = first.token;
    let sellAmount = first.value;

    let j = i + 1;
    while (j < transfers.length) {
      const candidate = transfers[j]!;
      if (candidate.from === dtf && candidate.token === sellToken) {
        sellAmount = sellAmount + candidate.value;
        j++;
      } else {
        break;
      }
    }

    let buyToken = ZERO_ADDRESS;
    let buyAmount = 0n;
    let sellTokenRefund = 0n;
    let foundBuy = false;

    while (j < transfers.length) {
      const t = transfers[j]!;
      if (t.to === dtf) {
        if (t.token === sellToken) {
          sellTokenRefund = sellTokenRefund + t.value;
        } else if (!foundBuy) {
          buyToken = t.token;
          buyAmount = t.value;
          foundBuy = true;
        } else if (t.token === buyToken) {
          buyAmount = buyAmount + t.value;
        } else {
          // third token = end of trade
          break;
        }
        j++;
        continue;
      }
      if (t.from === dtf) break;
      j++;
    }

    if (foundBuy && buyToken !== sellToken) {
      const netSell = sellAmount > sellTokenRefund ? sellAmount - sellTokenRefund : 0n;
      bids.push({
        sellToken,
        sellAmount: netSell,
        buyToken,
        buyAmount,
        dtf,
      });
    }

    i = j;
  }

  return bids;
}
