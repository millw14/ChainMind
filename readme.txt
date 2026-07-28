ChainMind — AI explorer for Robinhood Chain

Ask about any wallet, token, transaction or tokenized stock and get the figures —
plus what they imply — grounded in live chain data. Robinhood Chain is an Arbitrum Orbit
L2 (chain id 4663, ETH gas) carrying ~94 tokenized equities and ETFs.

Run it:
  npm install
  cp .env.example .env.local     # then set GROQ_API_KEY (required)
  npm run dev                    # http://localhost:3000

Production:
  npm run build
  npm start

Checks:
  npm test          # unit suite (offline, no network, no API key needed)
  npm run flex:check # how many messy phrasings the keyword fallback can route

Pages:
  /              landing
  /ask           the assistant
  /stocks        every tokenized equity on the chain, sortable and searchable
  /docs          setup and environment reference
  /how-it-works  product map

API:
  POST /api/ask    { question, target? }  → { ok, intent, answer, evidence, toolCalls }
                   `target` is optional: ask "how is NVDA doing" or paste a 0x
                   address / tx hash. Guarded by content-type, same-origin and a
                   per-IP rate limit — each question can cost up to two model
                   completions, so the limit matters.
  GET  /api/health 200 while the RPC answers and reports chain 4663, else 503.
                   Cheap and unauthenticated; point an uptime monitor at it.

How a question is answered:
  1. A pasted address, hash or $TICKER takes a fast path — one completion.
  2. Everything else is routed by the MODEL, which picks from the tools in
     lib/ask-tools.js (lookup_token, lookup_wallet, lookup_transaction,
     rank_stocks, compare_tokens, market_overview, safety_check). No keyword
     list decides what "hows nvda doin" or "que es nvda" is asking for.
  3. If tool calling is unavailable, it degrades to keyword routing rather than
     failing. Run npm run flex:check to see what that fallback can and cannot do.

Tokenized stocks and impostors:
  The equity tokens are named like "NVIDIA - Robinhood Token", but THE NAME IS
  NOT PROOF. Live contracts exist whose name and symbol are byte-identical to
  the real ones, and holder counts are cheap to inflate by airdrop, so neither
  can be the authority. All 94 genuine tokens share one deployer, which cannot
  be forged without its key, so that is what decides.
  config/stock-tokens.json snapshots the issuer plus the verified addresses;
  anything outside the snapshot is checked against the issuer live, and any
  lookup failure fails closed to "unverified" rather than "official".
  Refresh the snapshot when new tickers list (live verification covers them in
  the meantime, at the cost of one extra call).

Deploy (Vercel or Railway):
  Connect the repo — Vercel detects Next.js. No worker, no cron.
  Required env:  GROQ_API_KEY
  Recommended:   NEXT_PUBLIC_APP_URL (public origin; used for link-preview image
                 URLs and accepted as a same-origin caller by the /api/ask guard)
  Optional:      ROBINHOOD_NETWORK, ROBINHOOD_RPC_URL, ALCHEMY_*, BLOCKSCOUT_*,
                 STOCK_CACHE_TTL_MS — see .env.example.
  Leave Output Directory empty (Next.js builds to .next).

  Turning the wallet gate on adds three requirements, and each one fails closed
  rather than degrading quietly:
    SESSION_SECRET            32+ chars. Unset = the auth routes return 503 and
                              nobody can sign in.
    NEXT_PUBLIC_APP_URL       (or AUTH_DOMAIN) — the domain baked into the signed
                              message. It is NEVER read from the Host header, so
                              unset = sign-in is unavailable, not unsafe.
    UPSTASH_REDIS_REST_URL    + UPSTASH_REDIS_REST_TOKEN. A shared store. Without
                              one the daily quota is counted per instance, which
                              on Vercel means it is not a limit at all —
                              /api/health reports `quota.enforced: false` and the
                              server logs a banner at startup saying so.
  The store speaks Redis over plain HTTPS, so it needs no dependency and behaves
  the same on Vercel's many short-lived instances and Railway's one long process.
  Postgres is supported as an alternative (STORE_DATABASE_URL) but needs
  `npm install pg` in the deployment. See .env.example.

RPC provider (optional — the public RPC works out of the box):
  https://rpc.mainnet.chain.robinhood.com is the zero-config default and is fine
  for development. Move to a dedicated provider such as Alchemy for rate limits
  that survive real traffic, websockets, or webhooks. Set ONE of:
    ALCHEMY_RPC_URL   full endpoint URL from the dashboard (key included), used
                      verbatim — preferred.
    ALCHEMY_RPC_TEMPLATE + ALCHEMY_API_KEY  to keep the key out of the URL. The
                      template carries the host Alchemy assigns to chain 4663;
                      the app never guesses that host, so a wrong hostname can
                      never be baked in silently.
  Precedence: ROBINHOOD_RPC_URL > ALCHEMY_RPC_URL > template+key > public RPC.
  Blockscout (token lists, holders, transfers) is a separate service and is not
  affected by the RPC choice.

Paths:
  app/          App Router pages + /api routes
  components/   React UI (landing, ask, stocks, site chrome)
  lib/          chain access, evidence gathering, tools, the answer loop
  config/       stock-tokens.json — issuer-verified equity registry
  test/         node:test suites (all offline)
  scripts/      check-intent-flex.mjs

Note: this repo previously hosted a Solana coordination-intelligence product
with a SQLite/Turso pipeline and an always-on ingest worker. That was removed
upstream when the product became a Robinhood Chain explorer; its runbooks were
deleted with it rather than left to mislead. See git history if you need them.
