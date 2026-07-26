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
| `npm test` | 219 unit tests — offline, no network, no API key |
| `npm run flex:check` | how many messy phrasings the keyword fallback can route |

## How a question gets answered

1. **Fast path** — a pasted `0x` address, tx hash or `$TICKER` names exactly one thing, so it
   skips straight to evidence gathering on a single model completion.
2. **Model routing** — everything else. The model reads the question and picks from the tools
   in [`lib/ask-tools.js`](lib/ask-tools.js): `lookup_token`, `lookup_wallet`,
   `lookup_transaction`, `rank_stocks`, `compare_tokens`, `market_overview`, `safety_check`.
   No keyword list decides what `"hows nvda doin"` is asking for — which is why lowercase,
   typos, slang and other languages all work.
3. **Keyword fallback** — if the endpoint or model cannot do tool calling, it degrades to a
   regex router rather than failing. `npm run flex:check` shows exactly what that fallback
   can and cannot handle (by design: 10/10 on canonical shapes, 0/16 on real speech).

### Honesty rules baked into the pipeline

These are enforced in code and covered by tests, because a confidently wrong number is the
worst thing a tool like this can produce:

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
app/            App Router pages + /api/ask, /api/health
components/     landing, ask overlay, stocks, icons, site chrome
lib/            chain access, evidence gathering, tools, the answer loop
config/         stock-tokens.json — issuer-verified equity registry
test/           node:test suites (all offline)
```

## Provenance

This repository began as a fork of [`web3mami/ChainMind`](https://github.com/web3mami/ChainMind)
and remains a fork — development goes both ways, and PRs from here have been merged upstream.
The Robinhood Chain explorer that exists today (tool-calling assistant, tokenized-stock
registry, issuer-verified impostor detection, the landing motion system) was built in this
tree; the repository previously hosted a Solana coordination-intelligence product, removed
upstream during the pivot. `git log` is the record.

## License

[MIT](LICENSE).
