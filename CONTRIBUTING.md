# Contributing

## Getting set up

```bash
npm install
cp .env.example .env.local     # GROQ_API_KEY is the only required value
npm run dev
```

The public RPC and public Blockscout indexer are the defaults, so no other configuration is
needed to work on almost anything.

## Before you open a PR

```bash
npm test          # must be green — 219 tests, offline, no API key needed
npm run build     # must compile
```

CI runs both on every push and pull request.

## What this codebase cares about

This tool answers questions about money with data pulled from a public chain. Most of the
review attention goes to whether an answer can be **confidently wrong**, because that is worse
than an error message. Concretely:

**Never let unknown read as zero.** If the indexer did not return a value, it is `null` and the
answer must say the data could not be loaded. Sorting must place unknowns last in *both*
directions, or a token nobody priced becomes "the cheapest stock on the chain".

**Never let an outage read as absence.** A failed lookup is "could not look this up", never
"does not exist". Telling someone their real wallet is not on the chain is a false negative
stated as fact.

**Never let the model format money.** Given a raw float, it will slide the decimal — this was
observed overstating a market cap by 1000×. Numbers are pre-rendered server-side into a
`display` object and copied verbatim.

**Never trust an on-chain string.** Token names and symbols are attacker-controlled. Sanitize
them, and treat them as data in prompts, never as instructions.

**Authenticity is decided by the deployer.** Not the name, not the holder count. Both are
forgeable. Verification fails closed to "unverified".

## Tests

`node:test`, all offline — no network, no API key, no fixtures that expire. Pure logic is
factored out specifically so it can be tested that way (see `lib/market-evidence.js` and its
exported helpers). If a change needs the network to be tested, that usually means the pure
part should be extracted first.

Regression tests are pinned to real observed failures — for example the exact float that
produced the 1000× market-cap error. Please keep that habit: when you fix a bug, pin the
input that caused it.

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Explain **why** in the
body, not just what — the diff already says what. If you fixed something subtle, say what the
broken behaviour actually was, so the next person can recognise it.

## Style

Plain JavaScript (no TypeScript), ES modules, double quotes, semicolons. Match the density and
tone of the comments already in the file you are editing. Comments should explain reasoning
that is not obvious from the code; skip the ones that restate it.
