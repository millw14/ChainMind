# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/millw14/ChainMind/security/advisories/new).
Please do not open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps. If the
finding involves a specific contract or address on Robinhood Chain, include it — this project
reads live chain data, so a reproduction usually needs one.

## Scope

This is a read-only explorer. It holds no user funds, custodies no keys, and signs no
transactions. The realistic risks are therefore:

| Area | Concern |
| --- | --- |
| `POST /api/ask` | Cost abuse — every question can spend up to two model completions |
| Prompt injection | Token names and symbols are attacker-controlled on-chain strings |
| Impostor detection | A false "official" verdict is the most damaging bug this can ship |
| Data honesty | A confidently wrong number is treated as a security-class defect |

## What is already in place

**`/api/ask` abuse guards**, in order: `Content-Type` must be `application/json` (415);
requests must look same-origin (403); per-IP fixed-window rate limit (429). The question is
capped at 500 characters, serialized evidence at 24k, and completions at 700 tokens. The
rate limiter is in-memory and therefore **per-instance** — a floor, not a distributed
guarantee. Put a real limiter in front of it before serious traffic.

**Prompt injection.** Anyone can mint a token whose name is a paragraph of instructions and
airdrop it to a wallet, so it lands in the evidence of an innocent lookup. Indexer-supplied
names and symbols are sanitized (control, zero-width and bidi characters stripped, length
capped), the user question is fenced in delimiters it cannot close, and the system prompt
treats every string value in evidence as data rather than instruction.

**Authenticity.** Token authenticity is decided by the **deployer address**, never by name or
holder count — both of which are forgeable or purchasable. Verification **fails closed**: any
lookup error yields "unverified", never "official".

**Secrets.** `.env*` is gitignored except `.env.example`. No key has ever been committed;
history has been scanned to confirm it.

## Known accepted risk

`npm audit` reports a high-severity advisory in `sharp` (inherited libvips CVEs), pulled in by
Next.js image optimization. The only offered remedy is downgrading Next 15 → 14.2.35, a major
version downgrade that would forfeit Next's own security fixes and break App Router features
in use.

Assessment: **not reachable here.** The vulnerability requires processing untrusted image
input; this app processes none. The single generated image (`app/opengraph-image.js`) is
rendered from static, first-party code with no user input. Revisit if user-supplied images
are ever introduced, or when Next ships a patched `sharp` on the 15.x line.
