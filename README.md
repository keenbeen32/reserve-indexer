## Envio Indexer

*Please refer to the [documentation website](https://docs.envio.dev) for a thorough guide on all [Envio](https://envio.dev) indexer features*

### Pre-requisites

- [Node.js v22+ (v24 recommended)](https://nodejs.org/en/download/current)
- [pnpm (use v8 or newer)](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)

### Environment

Populate `.env` (see `.env.example`):

```bash
# HyperSync token — create at https://envio.dev/app/api-tokens
ENVIO_API_TOKEN="<YOUR-API-TOKEN>"

# RPC endpoint per indexed chain
ENVIO_RPC_URL_1="<YOUR-ETHEREUM-RPC-ENDPOINT>"
ENVIO_RPC_URL_8453="<YOUR-BASE-RPC-ENDPOINT>"
ENVIO_RPC_URL_56="<YOUR-BSC-RPC-ENDPOINT>"
```

### Run

```bash
pnpm i
pnpm dev
```

Visit http://localhost:8080 to see the GraphQL Playground, local password is `testing`.

### Generate files from `config.yaml` or `schema.graphql`

```bash
pnpm codegen
```

### Effect cache

The handlers make RPC calls through the Effect API. On the first run these calls are all made, but the
results are cached — save the cache and later runs replay them instead of re-fetching, which speeds up
the sync significantly.

- **Locally**: hit **Sync Cache** in the **Effects** section of the dev console to write the cache to
  `.envio/cache`.
- **Hosted service**: save the cache from the indexer dashboard.
