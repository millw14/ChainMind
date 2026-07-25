## What this changes

<!-- The behaviour, not the diff. If it fixes a bug, say what the broken behaviour was. -->

## Why

<!-- Reasoning that is not obvious from the code. -->

## Checks

- [ ] `npm test` green
- [ ] `npm run build` compiles
- [ ] If this touches how an answer is produced: unknown values still read as unknown (never zero),
      an indexer outage still reads as "could not look this up" (never "does not exist"), and money
      is still pre-rendered server-side rather than formatted by the model
- [ ] If this fixes a bug: a regression test is pinned to the input that caused it
