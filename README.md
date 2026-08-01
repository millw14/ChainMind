# ChainMind

**AI explorer for [Robinhood Chain](https://chain.robinhood.com).** Ask about any wallet, token,
transaction or tokenized stock and get the figures — plus what they imply — grounded in live chain
data. Written for people who already trade on-chain: numbers first, no glossary.

[chainmind.fun](https://chainmind.fun)

```
"hows nvda doin"          → price, market cap, holders, concentration, impostor warning
"whos got the most bags"  → holders ranking across all 94 tokenized equities
"tsla vs nvda"            → both, side by side
"que es nvda"             → the same answer, in Spanish
"is 0x4658…A492 safe?"    → impostor, with the deployer that proves it
```

---

## Why it exists

Robinhood Chain is an Arbitrum Orbit L2 (chain id `4663`, ETH gas) carrying ~94 **tokenized
equities and ETFs** — NVDA, AAPL, TSLA, SPY, SGOV and the rest — alongside ordinary tokens.
Block explorers show you `0x` rows. This answers questions.

It also solves a problem specific to this chain: **impostor tokens.** A live contract at
`0x465834D5…CA492` carries a name and symbol byte-identical to the real NVDA token. Holder
counts are cheap to inflate by airdrop on an L2, so neither the name nor "it has more holders"
can establish authenticity.

**All 94 genuine equity tokens share one deployer**, which cannot be forged without its key —
so that is what decides. `config/stock-tokens.json` snapshots the issuer plus the verified
addresses; anything outside it is checked against the issuer live, and any lookup failure
**fails closed to "unverified"** rather than "official".

## Quick start

```bash
npm install
cp .env.example .env.local     # set GROQ_API_KEY (free: console.groq.com)
npm run dev                    # http://localhost:3000
```

Everything else is optional — the public RPC and the public Blockscout indexer work with no
configuration. See [`.env.example`](.env.example) for the full list.

| Command | |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` / `npm start` | production |
| `npm test` | 1,418 unit tests — offline, no network, no API key |
| `npm run flex:check` | how many messy phrasings the keyword fallback can route |
| `npm run route:bench` | scores the model's routing against a 106-question corpus. Costs money and needs the network, so it is not in `npm test`; it prints the bill and refuses to spend without `--yes` |

## How a question gets answered

1. **Fast path** — a pasted `0x` address, tx hash or `$TICKER` names exactly one thing, so it
   skips straight to evidence gathering on a single model completion.
2. **Model routing** — everything else. The model reads the question and picks one of the 26
   lookups in [`lib/ask-tools.js`](lib/ask-tools.js). No keyword list decides what
   `"hows nvda doin"` is asking for — which is why lowercase, typos, slang and other languages
   all work. That turn is scored rather than assumed: `npm run route:bench` runs 106 sourced
   questions past the real model and prints accuracy, the confusion pairs, and how often the
   same question routed two different ways.
3. **Keyword fallback** — if the endpoint or model cannot do tool calling, it degrades to a
   regex router rather than failing. `npm run flex:check` shows exactly what that fallback
   can and cannot handle (by design: 10/10 on canonical shapes, 0/16 on real speech). It is a
   last resort, not a shrug: a tool call the API refuses to serialize is read back out of the
   error and run, because the model did choose and throwing that choice away is how a question
   routed to `project_profile` used to arrive on screen looking like `lookup_token`.

### Honesty rules baked into the pipeline

These are enforced in code and covered by tests, because a confidently wrong number is the
worst thing a tool like this can produce:

- **A question naming a contract, a hash or a ticker is never answered without a lookup.** The
  routing turn runs at temperature 0 because picking a tool is a classification, not prose; if it
  picks nothing anyway it is asked again with the option of picking nothing removed, then routed
  from the identifier itself. If even that fails the answer says it has not read the chain, rather
  than writing about the contract from memory.
- **Unknown values sort last in both directions**, so a token the indexer never priced can
  never be reported as "the cheapest".
- **Aggregates report how many entries lacked data** rather than counting `null` as zero.
- **A dead indexer reads as "could not look this up"**, never as "does not exist".
- **An unpriced token says why it is unpriced.** Only the issuer-verified equities carry a quote on
  the indexer, so an ordinary ERC-20 comes back with `priceStatus: "not_indexed"` and a reason
  attached. The answer leads with supply, holders, verification and concentration and closes with
  the price gap in one clause — rather than opening with three bare absences. An indexer failure is
  `"unavailable"` instead, which is a different sentence.
- **Money is pre-rendered server-side** (`$4.16M`) and copied verbatim. Given a raw float, a
  model will slide the decimal — that was a real, observed 1000× overstatement.
- **On-chain strings are untrusted.** Token names are attacker-controlled; anyone can mint a
  token named like an instruction and airdrop it into an innocent wallet's evidence. They are
  sanitized and the prompt treats them as data, never instructions.

## Layout

```
app/            App Router pages + /api/ask, /api/health, /api/research
components/     landing, ask overlay, stocks, icons, site chrome
lib/            chain access, evidence gathering, tools, the answer loop
config/         stock-tokens.json — issuer-verified equity registry
test/           node:test suites (all offline)
services/       deployables that are NOT part of the Next.js app
  render/       headless-browser render service (separate Railway deployment)
  research/     deep-research job service (separate Railway deployment)
```

The Next.js app deploys to **Vercel**. Each directory under `services/` is a **separate
Railway deployment** with its own `package.json`, Dockerfile and `railway.json` — both build
from the repository root so they import the app's *real* modules rather than copies that
would drift, and `.vercelignore` keeps them out of the Vercel build.

**`services/render/`** exists because an HTTP GET cannot read a client-rendered site.
Measured through this repo's own `lib/safe-fetch.js`: `https://eska.fun/` returns 5,782
bytes of HTML containing **four characters** of visible text. Rendered in a browser, the
same URL yields 76,266 bytes and 343 characters, in 2.2 s. See
[`services/render/README.md`](services/render/README.md) for the deployment steps, the
security model, and the TLS chain finding behind `www.ponsfamily.com`.

**`services/research/`** exists because a diligence report is a **loop**, not an answer.
`lib/site-analysis.js` reads one page inside a 24-second budget and cannot decide what to
look at next; the research service submits a job, works it for minutes, and delivers a
structured sourced report. Measured against `https://htmx.org/`: page → repository (found in
an `href`) → file tree → commit count → **repository-wide search** → source file →
conclusion, in 7 steps and 56 s. See
[`services/research/README.md`](services/research/README.md) for the tool set, the boundary
that stops a page steering its own investigation, the caps, and the Railway steps.

The app reaches it through `lib/research-client.js`, gates it in `lib/research-access.js`
(sign-in required, its own small daily allowance, capped for holders too — a job is minutes
of somebody else's bandwidth), and renders the finished report at `/research/<id>`, readable
only by the wallet that started it. A question that clearly asks for diligence starts a job
from the ask path and says so, without the answer waiting on it. **With
`RESEARCH_SERVICE_URL` and `RESEARCH_SHARED_SECRET` unset the app behaves exactly as it did
before and says so in words** — no button that fails when pressed, no job that silently
never runs.

## Provenance

This repository began as a fork of [`web3mami/ChainMind`](https://github.com/web3mami/ChainMind)
and remains a fork — development goes both ways, and PRs from here have been merged upstream.
The Robinhood Chain explorer that exists today (tool-calling assistant, tokenized-stock
registry, issuer-verified impostor detection, the landing motion system) was built in this
tree; the repository previously hosted a Solana coordination-intelligence product, removed
upstream during the pivot. `git log` is the record.

## License

[MIT](LICENSE).
