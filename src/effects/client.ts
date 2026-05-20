// Lazy-instantiated viem public clients per chain. RPC URLs come from
// ENVIO_RPC_URL_<chainId> env vars (Envio requires the ENVIO_ prefix).
//
// All Effect API calls funnel through here so a missing/unset RPC URL fails
// loudly at the first call site with chain context, rather than at module load.

import { createPublicClient, http, type PublicClient } from "viem";

const clients = new Map<number, PublicClient>();

export function clientFor(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const envKey = `ENVIO_RPC_URL_${chainId}`;
  const url = process.env[envKey];
  if (!url) {
    throw new Error(
      `Missing RPC URL: set ${envKey} in .env to enable Effect API calls on chain ${chainId}.`,
    );
  }

  const client = createPublicClient({ transport: http(url) });
  clients.set(chainId, client);
  return client;
}
