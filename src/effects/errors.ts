// viem error classifier for the Effect API.
//
// Effects must NOT cache dummy data produced by transient infrastructure
// failures. Feature-detection effects (getGovernorParams, getTimelockSnapshot)
// use this to swallow only deterministic on-chain reverts — those results are
// reproducible and safe to cache as a "feature absent" answer — and to re-throw
// everything else so the Effect cache stays empty and the next run retries.

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";

// True when the failure is a deterministic on-chain revert or a missing
// function selector (contract returned empty data). False for transient
// infrastructure errors (HTTP, timeout, rate limit, RPC node issues).
export function isDeterministicRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}
