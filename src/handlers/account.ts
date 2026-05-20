// Account / AccountBalance helpers — ported from
// dtf-index-subgraph/src/account/mappings.ts. Pure helper module (no handlers
// registered here); imported by token.ts and the Lock/RewardClaim handlers.

import type { Entity, EvmOnEventContext } from "envio";
import { BIGINT_ZERO, SECONDS_PER_DAY, chainId as makeId } from "../utils/constants";

type Ctx = EvmOnEventContext;

function accountId(chainId: number, address: string): string {
  return makeId(chainId, address);
}

function balanceId(accountEntityId: string, tokenEntityId: string): string {
  // Already namespaced; just concatenate.
  return `${accountEntityId}-${tokenEntityId}`;
}

export async function getOrCreateAccount(
  context: Ctx,
  chainId: number,
  accountAddress: string,
): Promise<Entity<"Account">> {
  const id = accountId(chainId, accountAddress);
  const existing = await context.Account.get(id);
  if (existing) return existing;
  const fresh: Entity<"Account"> = { id };
  context.Account.set(fresh);
  return fresh;
}

export async function isNewTokenHolder(
  context: Ctx,
  accountEntityId: string,
  tokenEntityId: string,
): Promise<boolean> {
  const bal = await context.AccountBalance.get(balanceId(accountEntityId, tokenEntityId));
  return bal === undefined;
}

export async function getOrCreateAccountBalance(
  context: Ctx,
  account: Entity<"Account">,
  token: Entity<"Token">,
): Promise<Entity<"AccountBalance">> {
  const id = balanceId(account.id, token.id);
  const existing = await context.AccountBalance.get(id);
  if (existing) return existing;
  const fresh: Entity<"AccountBalance"> = {
    id,
    account_id: account.id,
    token_id: token.id,
    amount: BIGINT_ZERO,
    delegate_id: undefined,
    optimisticDelegate_id: undefined,
    blockNumber: undefined,
    timestamp: undefined,
    firstHoldTimestamp: undefined,
    currentHoldStartTimestamp: undefined,
  };
  context.AccountBalance.set(fresh);
  return fresh;
}

// Increase + return new entity (caller persists via context.AccountBalance.set).
export async function increaseAccountBalance(
  context: Ctx,
  account: Entity<"Account">,
  token: Entity<"Token">,
  amount: bigint,
  timestamp: bigint,
): Promise<Entity<"AccountBalance">> {
  const current = await getOrCreateAccountBalance(context, account, token);
  const previousAmount = current.amount;
  let next: Entity<"AccountBalance"> = {
    ...current,
    amount: current.amount + amount,
  };
  if (previousAmount === BIGINT_ZERO && next.amount > BIGINT_ZERO) {
    next = {
      ...next,
      firstHoldTimestamp: next.firstHoldTimestamp ?? timestamp,
      currentHoldStartTimestamp: timestamp,
    };
  }
  return next;
}

export async function decreaseAccountBalance(
  context: Ctx,
  account: Entity<"Account">,
  token: Entity<"Token">,
  amount: bigint,
): Promise<Entity<"AccountBalance">> {
  const current = await getOrCreateAccountBalance(context, account, token);
  let newAmount = current.amount - amount;
  if (newAmount < BIGINT_ZERO) newAmount = BIGINT_ZERO;
  const next: Entity<"AccountBalance"> = {
    ...current,
    amount: newAmount,
    currentHoldStartTimestamp:
      newAmount === BIGINT_ZERO ? undefined : current.currentHoldStartTimestamp,
  };
  return next;
}

export function updateAccountBalanceDailySnapshot(
  context: Ctx,
  chainId: number,
  balance: Entity<"AccountBalance">,
  blockNumber: bigint,
  timestamp: bigint,
): void {
  const dayBucket = timestamp / SECONDS_PER_DAY;
  // Composite ID: account-token-day. Namespace via the balance ID which is
  // already chain-prefixed.
  void chainId;
  const id = `${balance.id}-${dayBucket}`;
  const snapshot: Entity<"AccountBalanceDailySnapshot"> = {
    id,
    account_id: balance.account_id,
    token_id: balance.token_id,
    amount: balance.amount,
    blockNumber,
    timestamp,
  };
  context.AccountBalanceDailySnapshot.set(snapshot);
}
