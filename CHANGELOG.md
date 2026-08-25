# @arispay/payagent-mcp

## 4.0.0

### Major Changes

- One coherent USDC/x402 payment product. The default surface is six
  core tools: `setup`, `discover`, `inspect`, `pay`, `balance`,
  `history`. Four wallet-administration tools (`create_agent`,
  `fund_agent`, `list_agents`, `rename_agent`) load only under
  `PAYAGENT_MCP_PROFILE=admin`.

  Renames from v3: `create_user` → `setup`, `pay_api` → `pay`,
  `discover_paid_api` → `discover`, `inspect_paid_api` → `inspect`,
  `check_wallet` + `get_balance_agent` → `balance`. New: `history`
  (server activity feed in delegated mode, local receipts in
  self-custody mode).

  Removed outright: `create_wallet`, `list_wallets`, `fund_wallet`,
  `get_balance`, `pay_merchant`, `create_enduser`,
  `attach_card_for_user`, `set_user_limits`, `get_user_status`.
  Every card and EUR/EURØP funding path is gone from the public MCP.
  Agents fund wallets with USDC deposits and pay x402 APIs on Base,
  Solana, and BNB Chain.

  `pay` is now the complete machine path: it requires an
  `idempotencyKey` (a repeated key returns the cached receipt and
  never pays twice — including after a post-payment network failure)
  and returns a structured machine-readable receipt (amount, asset,
  network, wallet, settlement tx from `X-PAYMENT-RESPONSE`, remaining
  mandate). Receipts persist to `~/.payagent/mcp-receipts.json`.

  Every tool declares MCP safety annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) and states in
  its description whether it spends real funds. `pay` is the only
  destructive tool.

  `create_agent` accepts `network: "solana"` / `"solana-devnet"`
  (server-gated by the deployment's `X402_SOLANA_NETWORK`).

  The server reports its real package version over MCP (previously
  hardcoded `3.0.0`); `surface.test.ts` gates the release on version
  lockstep with `server.json`, the exact tools/list surface, the
  annotation + description rubric, and the absence of retired product
  references.


## 3.4.0

### Minor Changes

- ace356a: Add BNB Smart Chain (`bsc`, eip155:56) x402 support with USD1 as the settlement asset.

  BSC's bridged USDC does not implement EIP-3009, so x402 settles in USD1
  (World Liberty Financial USD, `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d`).
  USD1 has 18 decimals; every cents ↔ base-units conversion is now
  decimals-aware (10^16 per cent for USD1, 10^4 for USDC/EURC). The USD1
  address, decimals, and EIP-712 domain (`World Liberty Financial USD`,
  version `1`) were verified on-chain.

  - `paygate`: `network: "bsc"` resolves USD1 as the USD asset, prices routes
    in 18-decimal base units, and emits the correct EIP-712 `extra`
    name/version on the 402 challenge. Self-settle gains a default BSC RPC.
  - `payagent`: `bsc` joins the network unions and the CAIP-2 alias maps;
    `inspectChallenge` recognizes USD1 (currency `USD`, cents at 10^16);
    balance pre-checks know the public BSC RPC.
  - `@arispay/payagent-mcp`: `create_agent` accepts `network: "bsc"`.

### Patch Changes

- Updated dependencies [ace356a]
- Updated dependencies [9b2912d]
  - payagent@2.21.0

## 3.3.0

### Minor Changes

- bc2c743: Local-key (Lane P) mode is now visible to MCP hosts, and stale registry metadata is fixed.

  - `check_wallet` derives the deposit address from `PAYAGENT_PRIVATE_KEY`, so a key-only setup can show the human where to send USDC. It previously answered "No wallet known." (Needs `payagent` ≥ 2.19.0; against older payagent versions the derivation is skipped and the server still works.)
  - `pay_api`'s tool description now states the local-signing mode (the behavior already existed).
  - `server.json` and `smithery.yaml` no longer advertise the removed `bootstrap_agent` tool name (the cold-start tool is `create_user`) and document `PAYAGENT_PRIVATE_KEY`.
  - README rewritten: both wallet modes, real tool list, no phantom "provision on the website" step, all env vars optional.

### Patch Changes

- Updated dependencies [bc2c743]
  - payagent@2.19.0

## 3.2.2

### Patch Changes

- fea2bcd: `fund_wallet` no longer defaults the EURØP browser handoff to the retired
  `buyforme.arispay.app` domain (which serves a static retirement notice and
  dropped the handoff entirely). With no `BUYFORME_URL` configured, the
  `rail='europ'` branch now returns a structured `FUNDING_HANDOFF_UNAVAILABLE`
  error (code, `retryable:false`, detail) that lists working alternatives: the
  card rail, and the permissionless x402 path (fund your own wallet, sign
  locally via `PAYAGENT_PRIVATE_KEY` / `payFetchLocal`). Operators with a
  self-hosted handoff can still set `BUYFORME_URL` explicitly.

## 3.2.1

### Patch Changes

- de3c99e: Point repository/homepage/bugs metadata at the public source repository (arispay-inc/arispay-x402) — npm links now resolve publicly.
- Updated dependencies [de3c99e]
  - payagent@2.14.1

## 3.2.0

### Minor Changes

- 52b38ba: Add `discover_paid_api` and `inspect_paid_api` read-only tools: search the ArisPay paid-API catalog (budget-bounded in integer cents) and inspect an x402-protected URL's price/asset/network without paying. Both tools need no API key and never send payment; available in both the `core` and `all` profiles.

### Patch Changes

- Updated dependencies [52b38ba]
  - payagent@2.14.0

## 3.1.2

### Patch Changes

- 0ab506a: Add the `mcpName` package.json field (`io.github.stevemilton/payagent-mcp`) required by the official MCP registry's npm-package validation, so the server can be published to registry.modelcontextprotocol.io. No runtime change. (buyforme-mcp got the same field in-repo, but it is changeset-ignored — it ships on its next manual `pnpm publish`.)
- Updated dependencies [91e7100]
  - payagent@2.13.4

## 3.1.1

### Patch Changes

- 6f48c55: docs: link facilitator.arispay.app from the SDK READMEs — an inbound link so human server-operators and crawlers reach the facilitator's discovery site. paygate gains a "Facilitator" section (it settles there by default: open, USDC + EURC, no fee/no subsidy); payagent's facilitator reference now links the live service (source moved to a secondary link); payagent-mcp lists it under Related.
- Updated dependencies [6f48c55]
  - payagent@2.13.2

## 3.1.0

### Minor Changes

- 02ba351: `pay_api` gains permissionless local-signer mode: when `PAYAGENT_PRIVATE_KEY` is set, payments sign in-process with no ArisPay account and no stored agent (mirrors the payagent CLI path). Delegated custody flow unchanged.

### Patch Changes

- Updated dependencies [072044e]
  - payagent@2.13.1

## 2.7.1

### Patch Changes

- da0772d: npm discoverability pass: descriptions and keywords tuned for the queries
  agents and coding assistants actually make ("pay for api", "agent wallet",
  "monetize api", "eurc"/"euro"). paygate and @arispay/payagent-mcp
  descriptions now lead with the USD + EUR settlement capability. Metadata
  only — no code changes.
- Updated dependencies [da0772d]
  - payagent@2.12.2

## 2.7.0

### Minor Changes

- f95b93f: BuyForMe phone-pairing handoff (Phase 5 of `docs/buyforme-app.md`).

  **`payagent`** — `BootstrapAgentResult` now carries an optional `pairing` block:

  ```ts
  pairing?: {
    url: string;        // Phone-openable; encode as QR
    expiresAt: string;  // 10-minute TTL by default
    qrPayload: string;  // Reserved for a future `buyforme://` deep link; today = url
  }
  ```

  New exported type `BootstrapPairing`. `payagent quickstart` prints the QR + URL on the terminal after bootstrap, so the user can land on `buyforme.arispay.app` already signed in without retyping their email.

  Absent only when running against an older API that pre-dates the Phase-5 pairing route.

  **`@arispay/payagent-mcp`** — the `bootstrap_agent` tool now surfaces the pairing URL in the tool result so AI hosts (Claude Desktop, Cursor, etc.) can pass it to the user.

- 97a2a85: Server-authoritative wallet listing, agent rename, and bootstrap rehydration — eliminates the orphan-wallet failure mode where a user on a new machine (or with a wiped `~/.payagent/config.json`) was blind to wallets they already owned, and could mint a fresh one on top of funded ones.

  **SDK (`payagent`):**

  - `DelegationClient.listAgents(opts?)` — hits `GET /v1/agents?withDelegation=1`, returns one row per x402 wallet with authoritative `walletAddress`, `network`, limits, `allowedDomains`, `suspended`, `fundedAt`. Balance is fanned out separately via `getBalance(agentId)` to keep the list call cheap.
  - `DelegationClient.renameAgent(agentId, newName)` — PATCHes `/v1/agents/:id`. Server enforces per-org name uniqueness with a 409.
  - `syncAgents({ includeBalance? })` — high-level helper combining `listAgents` + per-wallet balance fanout (optional) + `upsertManyFromServer` write-back to the local cache. Preserves locally-held agent API key plaintexts (the server only stores the SHA-256 hash, so it cannot return them).
  - `upsertManyFromServer(agents)` + `renameStoredAgent(oldName, newName)` exported from the config store.
  - `bootstrapAgent()` result now carries `reused: boolean` and `existingAgents: BootstrapExistingAgent[]` — every wallet under the resolved org. Rehydrates the local cache automatically so a re-bootstrap from a wiped machine recovers the full wallet set, not just the named one.
  - `payagent agent list` is now server-first (`--local` to opt out, `--balance` to fan out balance checks).
  - New `payagent agent rename <old> <new>` subcommand.

  **MCP (`@arispay/payagent-mcp`):**

  - `list_agents` rewritten to call `syncAgents()`. Now returns every wallet under the developer key's org with limits, allowedDomains, and `fundedAt`. Optional `withBalance: true` fans out per-wallet on-chain balance. Falls back to local-cache-only when no developer key is set (preserves legacy `ARISPAY_AGENT_KEY` flow).
  - New `rename_agent({ name, newName })` tool — server-side rename plus local-cache mirror.

### Patch Changes

- Updated dependencies [370c06f]
- Updated dependencies [f95b93f]
- Updated dependencies [87f1e96]
- Updated dependencies [97a2a85]
  - payagent@2.12.0

## 2.6.3

### Patch Changes

- 2865691: Fix two independent bugs that left `npx @arispay/payagent-mcp` (and the `buyforme-mcp` alias) unusable on npm:

  - **`workspace:^` dep leak.** 2.6.1 and 2.6.2 were published from the now-archived `arispay-inc/payagent-mcp` repo with the `payagent` dependency left as the raw pnpm workspace specifier, breaking install with `EUNSUPPORTEDPROTOCOL`. This release republishes from the consolidated monorepo, where `pnpm publish` rewrites `workspace:^` to a real semver range. `repository` now points at the consolidated repo with `directory: "packages/payagent-mcp"`.
  - **Double shebang in `dist/index.js`.** `src/index.ts` started with `#!/usr/bin/env node` and `tsup.config.ts` injected another one via `banner.js`, producing two consecutive shebang lines that Node can't parse (`SyntaxError: Invalid or unexpected token` at line 2). Source shebang removed; tsup banner remains canonical per the package's CLAUDE.md.

## 2.6.0

### Minor Changes

- 9aac5a4: Headless one-shot signup + agent provisioning. Cold-start in a single command — no browser, no prior dashboard account.

  **`payagent` (CLI + SDK)**:

  - New `payagent quickstart --email you@example.com --name polar [--fund 25]` command. Calls the new `POST /v1/bootstrap` endpoint and persists everything to `~/.payagent/config.json`.
  - New `bootstrapAgent({ email, name })` library export — same primitive for in-code use. Returns a ready-to-use agent handle with `.fetch`, `.getBalance`, `.waitUntilFunded`, `.getFundingLink`.
  - New `payagent doctor` command — single-shot diagnostic for binary path, version, key validity, locally-stored agents.
  - `payagent agent create` UX polish: positional name (`payagent agent create polar`), conservative default limits ($0.50/tx, $10/day, $100/month) when none supplied, interactive TTY prompts when only some are.
  - Best-effort version-staleness nudge on every command (opt-out: `PAYAGENT_NO_UPDATE_CHECK=1`). Hard-warns when running a major-version-old binary against the live API.
  - CLI error formatter now scrubs internal route fragments (`/x402-balance`, `/v1/agents/:id/x402-balance`, ...) from user-facing messages and suggests `payagent doctor` / `payagent init` on 401.

  **`@arispay/payagent-mcp`**:

  - New `bootstrap_agent` tool — full developer + agent provisioning in one MCP call. Lets Claude Desktop / Cursor spin up a working agent without ever leaving the host.

  Both packages keep the existing API surface; this is purely additive.

### Patch Changes

- Updated dependencies [9aac5a4]
  - payagent@2.8.0

## 2.5.0

### Minor Changes

- 18d485a: Phase 2: Coinbase Onramp for hosted agent top-ups.

  **payagent 2.2.0** adds:

  - **`DelegationClient.getHostedTopup(agentId, { amount? })`** — hits the
    new `POST /v1/agents/:id/hosted-topup` endpoint and returns
    `{ fundingUrl, expiresAt, provider, walletAddress, network }`. Share the
    URL with an end-user; they pay with card / Apple Pay / bank transfer on
    Coinbase's hosted page, and Coinbase deposits USDC straight into the
    agent's CDP wallet. ArisPay never touches the funds.
  - **`HostedTopupNotConfiguredError`** — thrown on 501 responses so
    callers can fall back gracefully to "send USDC manually to this
    address" when the deployment hasn't configured an onramp.
  - **`agent.getFundingLink()`** on `LaunchedAgent`, pre-bound to the
    launched agent.
  - **`payagent agent fund NAME --hosted [AMOUNT]`** — CLI flag to print a
    Coinbase onramp URL instead of the wallet address + QR. Still polls
    until the deposit lands. Falls back silently to the manual flow when
    the API is unconfigured.

  **@arispay/payagent-mcp 2.2.0** extends the `fund_agent` tool with two
  optional params: `hosted: boolean` and `amount: number`. When `hosted`
  is true, the tool returns a Coinbase onramp URL so Claude / Cursor /
  Hermes can relay it to the end-user directly. When the deployment has
  no onramp configured, the tool returns a helpful manual fallback message
  instead of erroring.

  Server side (not part of this changeset — shipped via apps/api):

  - `POST /v1/agents/:id/hosted-topup` no longer returns a blanket 501 —
    when `ARISPAY_ONRAMP_PROVIDER=coinbase` + `COINBASE_ONRAMP_APP_ID` are
    set, it builds a real `https://pay.coinbase.com/buy/...` URL pre-filled
    with the agent's destination wallet, USDC, and Base (or whichever
    `X402_NETWORK` the deployment uses).

  No breaking changes to any existing API. Legacy env-var MCP mode still
  works. Safe to upgrade.

- 95bf10f: Headless launch flow — `npx payagent` CLI, `launchAgent()` SDK sugar, and four new MCP tools.

  **payagent 2.1.0** adds:

  - **`npx payagent` CLI.** A new `bin` entry exposes `init`, `logout`, `whoami`, `agent create|fund|balance|list|remove`, and `pay`. `init` runs an OAuth device-code flow against `POST /v1/auth/device/*` and persists the developer API key to `~/.payagent/config.json` (dir 0700, file 0600).
  - **`launchAgent(config)`** — a new functional entry point that composes `DelegationClient.createX402Agent` + `payFetchDelegated` into a single call returning `{ agentId, walletAddress, apiKey, fetch, getBalance, waitUntilFunded }`. `getLaunchedAgent(name)` rehydrates an agent from the local config store.
  - **Shared config store + device-code helpers.** Re-exported from the main entry so `@arispay/payagent-mcp` can use the same credentials and same flow. Env overrides: `ARISPAY_API_KEY`, `ARISPAY_URL`, `PAYAGENT_CONFIG_DIR`.
  - **`DelegationClient`, `payFetchDelegated`, adapters** — unchanged. No breaking API changes.

  **@arispay/payagent-mcp 2.1.0** adds four new MCP tools alongside the existing `pay_api` and `check_wallet`:

  - `create_agent({ name, perTx, daily, monthly, allowedDomains?, network?, agentType? })` — provisions an x402 agent via `launchAgent` and persists it to the shared config store.
  - `fund_agent({ name })` — returns the wallet address + funding instructions.
  - `get_balance({ name })` — USDC balance + `fundedAt` latch via the developer key.
  - `list_agents()` — enumerate locally-cached agents (no secrets in the response).

  `pay_api` and `check_wallet` gain an optional `agent` parameter. When `ARISPAY_AGENT_KEY` is unset, the MCP falls back to the shared config store, so agents created via the CLI (or the new `create_agent` MCP tool) are immediately usable.

  Legacy env-var mode (`ARISPAY_AGENT_KEY`, `PAYAGENT_WALLET`) remains supported — no migration required for existing MCP clients.

- 609470a: Phase 3a: end-user helpers — create customers, attach cards / wallets, set per-user spend limits.

  **payagent 2.3.0** adds to `DelegationClient`:

  - `createEndUser({ externalId, email?, findOrCreate? })` — create or find-or-create a customer (PRD "User" / Prisma `EndUser`) under your developer org.
  - `getEndUser(id)` — fetch by ArisPay-internal id.
  - `createCardSetupSession({ endUserId, agentId? })` — returns `{ token, setupUrl, expiresAt }`. Hand `setupUrl` to the end-user; they enter their card on ArisPay's hosted page. Tokenization + 3DS handled server-side.
  - `getCardSetupStatus(token)` / `pollCardSetup(token, options?)` — one-shot check or poll until terminal (`completed` | `expired` | `failed` | `not_found`).
  - `attachWallet(userId, { walletAddress, chain })` — attach a USDC wallet (base / ethereum / polygon / solana) as a non-custodial rail.
  - `setUserLimits(userId, { agentId, maxPerTransaction?, maxDaily?, maxMonthly?, allowedMerchantCategories?, blockedMerchantCategories? })` — per-user-per-agent spend override. Integer cents.
  - `getWalletStatus(userId)` — USDC balance, allowance, sufficiency, readiness.

  `LaunchedAgent` gains a `setUserLimits(endUserId, options)` convenience that passes `agentId` automatically.

  **CLI** adds a new `user` command group:

  ```
  payagent user create --external-id tg:12345 [--email X] [--find-or-create]
  payagent user attach-card  USER_ID [--agent AGENT]
  payagent user attach-wallet USER_ID --address 0x... --chain base|ethereum|polygon|solana
  payagent user set-limits   USER_ID --agent NAME [--per-tx N] [--daily N] [--monthly N]
                                                  [--allowed-mcc CSV] [--blocked-mcc CSV]
  payagent user status       USER_ID
  ```

  `attach-card` polls the card-setup session and reports when the card is tokenized + 3DS-verified.

  **@arispay/payagent-mcp 2.3.0** gains four end-user tools:

  - `create_enduser({ externalId, email?, findOrCreate? })`
  - `attach_card_for_user({ userId, agentName? })` — returns the hosted URL for the AI agent to relay to the end-user.
  - `set_user_limits({ userId, agentName, perTx?, daily?, monthly?, allowedMcc?, blockedMcc? })`
  - `get_user_status({ userId })` — card + wallet + allowance readiness in one view.

  No new server endpoints; everything wraps existing `/v1/users/*`, `/v1/card-setup-sessions`, and `/v1/users/:id/{payment-methods,limits,wallet-status}`. No breaking changes.

  Prereq for Phase 3b, which will ship `agent.pay(intent)` with rail auto-selection.

- a5b0866: Phase 3b: multi-rail `agent.pay(intent)` for merchant payments.

  **payagent 2.4.0** adds:

  - `DelegationClient.createPayment(agentId, options)` — wraps
    `POST /v1/payments`. Picks the rail server-side (`card`, `crypto`,
    `mpp`, or `balance`) based on agent mode and whether a `userId` is
    supplied. Autonomous agents default to `balance`; platform agents to
    `card`. Explicit `rail` overrides.
  - `LaunchedAgent.pay(options)` — convenience on the agent handle that
    supplies `agentId` automatically.
  - Auto-generated `idempotencyKey` (`payagent-<ts>-<rand>`) if the caller
    doesn't provide one. Explicit keys are always respected.
  - New types exported: `CreatePaymentOptions`, `PaymentResponse`,
    `PaymentStatus`, `PaymentRail`, `PaymentNextAction`.

  **CLI** adds `payagent pay-merchant`:

  ```
  payagent pay-merchant URL --amount $5 --memo "flight booking" \
    [--user USER_ID] [--agent NAME] [--rail card|crypto|balance|mpp]
    [--merchant-name "..."] [--mcc 5411]
  ```

  Prints payment id, status, rail, amount, and any 3DS `nextAction`
  (challenge URL or device-fingerprint form) when `requires_action`.

  **@arispay/payagent-mcp 2.4.0** adds a `pay_merchant` tool with the
  same arguments, so Claude / Cursor / Hermes can create a merchant
  payment in-conversation.

  ## For x402 API calls use `.fetch()` instead

  `.pay()` is for server-side settled transactions through
  `/v1/payments` (card, crypto, MPP, balance). x402-priced HTTP
  resources still go through `agent.fetch(url)` / `payFetchDelegated`,
  which handles the 402 challenge + signing transparently. Both paths
  stay fully supported; the README and CLI help now call out the
  distinction.

  Zero server changes — every method wraps an existing route. No schema
  migration. No new dependencies.

### Patch Changes

- Updated dependencies [18d485a]
- Updated dependencies [95bf10f]

- Updated dependencies [4280f24]

- Updated dependencies [4feec26]

- Updated dependencies [609470a]
- Updated dependencies [a5b0866]
  - payagent@2.5.0
