/**
 * Who a wallet actually moved value with, and in what shape.
 *
 * PURE. No network, no clock — these take rows and return rows, so the counting
 * that an investigation rests on can be tested exhaustively offline. The walk that
 * feeds it lives in lib/wallet-evidence.js.
 *
 * WHAT THIS IS FOR. Somebody whose wallet was drained needs to know where the
 * funds went and which hops are worth chasing: an address that behaves like an
 * exchange deposit is where a report gets filed and where on-chain tracing stops,
 * a contract is something you can go and read, and an address that received from
 * this wallet and nothing else is a different kind of lead entirely. That is
 * ordinary forensics and the product should do it well.
 *
 * WHAT IT REFUSES TO DO, AND THIS IS THE WHOLE DISCIPLINE: it reports SHAPES with
 * their denominators and names the innocent explanations that produce the same
 * shape. It never says an address IS an exchange, and it never says two addresses
 * belong to one person. Both are identity claims, and no arrangement of transfers
 * establishes either — an exchange deposit address, a payment processor, a
 * marketplace escrow and somebody's own consolidation wallet all look identical
 * from here. Saying "this is Binance" to somebody with hours left on a freeze
 * window, and being wrong, costs them the only hours that mattered.
 */

/** A counterparty's measured shape. Never a claim about who they are. */
export const SHAPE = Object.freeze({
  /** Received from many distinct addresses, sent onward to very few. */
  CONSOLIDATING: "consolidating",
  /** Sent to many distinct addresses — a disperse, an airdrop, a payout. */
  DISTRIBUTING: "distributing",
  /** High traffic in both directions with many distinct addresses. */
  HUB: "hub",
  /** This wallet is the only address it has been seen dealing with. */
  EXCLUSIVE: "exclusive",
  /** Nothing in the sample separates it from an ordinary address. */
  ORDINARY: "ordinary",
});

/**
 * The sentence each shape gets, with the alternatives that produce it.
 *
 * WRITTEN OUT RATHER THAN ASSEMBLED, because a hedge built by string concatenation
 * is where the hedge gets dropped. Every one of these names what was measured
 * first and what it could mean second, and none of them names an entity.
 */
export const SHAPE_READING = Object.freeze({
  [SHAPE.CONSOLIDATING]:
    "Received from many different addresses and sent onward to very few. Exchange deposit addresses look like this, and so do payment processors, bridges, marketplace escrow and one person's own consolidation wallet — the shape does not separate them. If funds you are tracing stopped here, this is the kind of address worth reporting to a service rather than following further on-chain.",
  [SHAPE.DISTRIBUTING]:
    "Sent to many different addresses and received from very few. Airdrop and disperse contracts look like this, and so do payroll, faucets and a launch distributing supply.",
  [SHAPE.HUB]:
    "Heavy traffic both ways with many distinct addresses. Routers, aggregators, bridges and exchange operating wallets all look like this, and one router commonly fronts trades for hundreds of unrelated wallets.",
  [SHAPE.EXCLUSIVE]:
    "In everything read, this address has dealt with no other address than this one. That is a narrow relationship rather than a shared owner: a fresh wallet, a single counterparty in a one-off trade and somebody's second wallet all look the same here.",
  [SHAPE.ORDINARY]:
    "Nothing in what was read separates this from an ordinary address.",
});

/** Lowercased address, or "" — one form for every comparison in this module. */
function addr(x) {
  return typeof x === "string" ? x.trim().toLowerCase() : "";
}

/**
 * A finite number, or null — and null and undefined never become zero.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious guard lets
 * every absent value through as a real measurement. Both places that read a count
 * here were wrong in exactly that way: a transfer with no timestamp took first-seen
 * back to the epoch, and a counterparty whose own activity could not be read was
 * classified as having zero senders — which is the "unknown reads as zero" failure
 * this codebase refuses everywhere else, arriving through a type coercion.
 */
function num(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Address labels the indexer already sent, harvested from pages in hand.
 *
 * THE ONE LABEL SOURCE ON THIS CHAIN, AND IT COSTS NOTHING. `public_tags` and
 * `private_tags` are empty on every address here, which is easy to check and easy
 * to conclude from that there is no way to tell an exchange from a wallet. There
 * is: every embedded address object carries `metadata.tags` (Open Labels
 * Initiative), and they are populated — measured, 145 of 200 address objects on
 * two ordinary pages, with names like "WETH" and classifiers like "Farcaster".
 * They arrive INSIDE the from/to of pages already fetched, so reading them adds
 * no call, and nothing in this codebase read them before.
 *
 * WHAT A LABEL IS AND IS NOT. It is the explorer's attestation, not a chain
 * record. It is not verified here, it can be stale, and on a permissionless chain
 * the text is attacker-influenceable — which is why `sanitize` is required rather
 * than optional, and why the reading that quotes one must always say whose claim
 * it is. Quoting a label is still enormously more useful than a six-way shrug when
 * somebody is trying to work out where their funds went: a name the reader can
 * search beats "this could be six things".
 *
 * Generic tags are kept separate from names. "Metamask User" sits on the zero
 * address alongside "Miner", and treating that as an identity would be worse than
 * having no label at all.
 *
 * @param {unknown} payload any indexer response; walked for address objects
 * @param {(s: unknown) => string} sanitize label cleaner, required
 * @returns {Map<string, {names: string[], classifiers: string[], generic: string[]}>}
 */
export function harvestTags(payload, sanitize) {
  const out = new Map();
  if (typeof sanitize !== "function") return out;
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (seen.has(node)) return;
    seen.add(node);
    const hash = addr(node.hash);
    const tags = node?.metadata?.tags;
    if (hash && Array.isArray(tags) && tags.length) {
      let entry = out.get(hash);
      if (!entry) {
        entry = { names: [], classifiers: [], generic: [] };
        out.set(hash, entry);
      }
      for (const tag of tags) {
        const text = sanitize(tag?.name ?? tag?.slug);
        if (!text) continue;
        const type = String(tag?.tagType ?? "").toLowerCase();
        const bucket = type === "name" ? entry.names : type === "classifier" ? entry.classifiers : entry.generic;
        if (!bucket.includes(text)) bucket.push(text);
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  };

  walk(payload, 0);
  return out;
}

/**
 * The sentence for a harvested label.
 *
 * NAMES WHOSE CLAIM IT IS, EVERY TIME. "This is Relay" and "the explorer labels
 * this Relay" send a reader to the same place, but only one of them survives being
 * wrong — and a victim acting on a stale label inside a freeze window cannot
 * afford the difference.
 */
export function labelReading(entry) {
  if (!entry) return null;
  const named = [...(entry.names ?? []), ...(entry.classifiers ?? [])];
  if (named.length) {
    return `The explorer labels this address ${named.map((n) => `"${n}"`).join(", ")}. That is the explorer's label rather than a chain record, and it is not verified here.`;
  }
  if ((entry.generic ?? []).length) {
    return `The explorer attaches only generic tags to this address (${entry.generic.map((n) => `"${n}"`).join(", ")}), which describe a category of user rather than identifying anyone.`;
  }
  return null;
}

/**
 * Tally a wallet's transfer rows into one entry per counterparty.
 *
 * Rows are whatever traceRows() produced, so direction and counterparty are
 * already resolved. `self` rows and `other` rows are counted separately and are
 * NOT dropped: a transfer between a wallet's own addresses and a transfer that
 * touched neither side are both facts about the sample, and silently discarding
 * them would make the denominators below describe a set nobody can reconstruct.
 *
 * @param {object[]} rows from traceRows
 * @returns {{counterparties: object[], sent: number, received: number,
 *            selfTransfers: number, unrelated: number, distinct: number}}
 */
export function tallyFlows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  let sent = 0;
  let received = 0;
  let selfTransfers = 0;
  let unrelated = 0;

  for (const row of list) {
    if (row?.direction === "self") {
      selfTransfers += 1;
      continue;
    }
    if (row?.direction !== "in" && row?.direction !== "out") {
      unrelated += 1;
      continue;
    }
    if (row.direction === "in") received += 1;
    else sent += 1;

    const key = addr(row.counterparty);
    if (!key) continue;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        address: key,
        transfersSentTo: 0,
        transfersReceivedFrom: 0,
        transfers: 0,
        tokens: new Set(),
        firstSeenMs: null,
        lastSeenMs: null,
        lastSeen: null,
      };
      map.set(key, entry);
    }
    entry.transfers += 1;
    if (row.direction === "out") entry.transfersSentTo += 1;
    else entry.transfersReceivedFrom += 1;
    const token = addr(row.tokenAddress);
    if (token) entry.tokens.add(token);
    const ms = num(row.timeMs);
    if (ms !== null) {
      if (entry.firstSeenMs === null || ms < entry.firstSeenMs) entry.firstSeenMs = ms;
      if (entry.lastSeenMs === null || ms > entry.lastSeenMs) {
        entry.lastSeenMs = ms;
        entry.lastSeen = row.time ?? null;
      }
    }
  }

  const counterparties = [...map.values()]
    .map((e) => ({
      address: e.address,
      transfersSentTo: e.transfersSentTo,
      transfersReceivedFrom: e.transfersReceivedFrom,
      transfers: e.transfers,
      distinctTokens: e.tokens.size,
      direction: e.transfersSentTo > 0 && e.transfersReceivedFrom > 0 ? "both" : e.transfersSentTo > 0 ? "sent to" : "received from",
      firstSeenMs: e.firstSeenMs,
      lastSeenMs: e.lastSeenMs,
      lastSeen: e.lastSeen,
    }))
    .sort((a, b) => b.transfers - a.transfers || a.address.localeCompare(b.address))
    .map((e, i) => ({ rank: i + 1, ...e }));

  return { counterparties, sent, received, selfTransfers, unrelated, distinct: counterparties.length };
}

/**
 * How concentrated a wallet's outbound traffic is.
 *
 * THE DENOMINATOR IS THE POINT. "Everything went to one address" is a strong lead
 * when it is over a complete history and nearly meaningless over the last twenty
 * transfers of a busy wallet, so the count it was measured over rides along and
 * `complete` says whether the walk ever reached the end.
 *
 * @param {object[]} counterparties from tallyFlows
 * @param {{sent: number, complete: boolean}} args
 */
export function outboundConcentration(counterparties, { sent = 0, complete = false } = {}) {
  const list = (Array.isArray(counterparties) ? counterparties : []).filter((c) => c.transfersSentTo > 0);
  if (!list.length || sent <= 0) {
    return { distinctRecipients: 0, topShare: null, topAddress: null, measuredOver: sent, complete, reading: null };
  }
  const ranked = [...list].sort((a, b) => b.transfersSentTo - a.transfersSentTo);
  const top = ranked[0];
  const share = Math.round((top.transfersSentTo / sent) * 100);
  const scope = complete
    ? "across this wallet's whole transfer history"
    : `across the ${sent} outbound transfer${sent === 1 ? "" : "s"} read, which is not its whole history`;
  return {
    distinctRecipients: ranked.length,
    topShare: share,
    topAddress: top.address,
    measuredOver: sent,
    complete,
    reading:
      ranked.length === 1
        ? `Every outbound transfer read went to one address, ${scope}.`
        : `${share}% of outbound transfers went to one address, out of ${ranked.length} distinct recipients, ${scope}.`,
  };
}

/**
 * Classify one counterparty's SHAPE from what was measured about it.
 *
 * DELIBERATELY CONSERVATIVE, AND ORDINARY IS THE DEFAULT. Every threshold here
 * decides whether a reader is sent chasing an address, so a shape is only claimed
 * when the numbers are lopsided enough that an ordinary wallet would not produce
 * them. When the sample is too small to separate anything, the answer is
 * `unknown` with a reason rather than a guess — a wallet with four transfers is
 * not a hub and is not exclusive, it is unmeasured.
 *
 * @param {object} args
 * @param {number} args.distinctSenders addresses this counterparty received from
 * @param {number} args.distinctRecipients addresses it sent to
 * @param {number} args.transfersSeen how many of its transfers were read
 * @param {boolean} [args.sampleComplete] the read reached the end of its history
 * @returns {{shape: string|null, confident: boolean, why: string}}
 */
export function classifyShape({ distinctSenders, distinctRecipients, transfersSeen, sampleComplete = false } = {}) {
  const senders = num(distinctSenders);
  const recipients = num(distinctRecipients);
  const seen = num(transfersSeen);

  if (senders === null || recipients === null || seen === null) {
    return { shape: null, confident: false, why: "this address's own activity could not be read" };
  }
  // TOO FEW TO SAY ANYTHING. The floor is what stops every quiet address being
  // labelled "exclusive" and every address with three senders being called a hub.
  if (seen < 8) {
    return {
      shape: null,
      confident: false,
      why: `only ${seen} of this address's own transfer${seen === 1 ? " was" : "s were"} read, which is too few to describe how it behaves`,
    };
  }

  if (senders === 0 && recipients === 0) {
    return { shape: null, confident: false, why: "no counterparties of its own were resolved" };
  }
  if (senders + recipients <= 1) {
    return { shape: SHAPE.EXCLUSIVE, confident: sampleComplete, why: "one counterparty across everything read" };
  }
  if (senders >= 10 && recipients >= 10) {
    return { shape: SHAPE.HUB, confident: true, why: `${senders} senders and ${recipients} recipients` };
  }
  if (senders >= 10 && recipients * 3 <= senders) {
    return { shape: SHAPE.CONSOLIDATING, confident: true, why: `${senders} senders against ${recipients} recipients` };
  }
  if (recipients >= 10 && senders * 3 <= recipients) {
    return { shape: SHAPE.DISTRIBUTING, confident: true, why: `${recipients} recipients against ${senders} senders` };
  }
  return { shape: SHAPE.ORDINARY, confident: false, why: `${senders} senders and ${recipients} recipients` };
}
