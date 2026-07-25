"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { INTENTS, classifyIntent, extractTargets } from "@/lib/ask-intent";

const THINKING_PHASES = ["reading chain", "gathering evidence", "asking the model"];

function ThinkingIndicator() {
  const reduce = useReducedMotion() ?? false;
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setPhase((p) => (p + 1) % THINKING_PHASES.length), 1500);
    return () => clearInterval(id);
  }, [reduce]);

  return (
    <div className="flex items-center gap-2.5 font-mono text-xs text-cm-terminal">
      <span className="flex h-4 items-end gap-[3px]">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.span
            key={i}
            className="w-[3px] rounded-full bg-cm-terminal"
            style={{ height: 5 }}
            animate={reduce ? {} : { height: [5, 15, 5] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.12 }}
          />
        ))}
      </span>
      {reduce ? (
        <span>reading chain…</span>
      ) : (
        <motion.span key={phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          {THINKING_PHASES[phase]}…
        </motion.span>
      )}
    </div>
  );
}

function shortHex(v) {
  if (typeof v !== "string" || !v.startsWith("0x")) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** Same shortening, applied in place to every long hex run inside a sentence. */
function shortenHexIn(text) {
  return String(text ?? "").replace(/0x[0-9a-fA-F]{20,}/g, (m) => shortHex(m));
}

/**
 * Router intents, rendered as a short human tag. Anything unmapped falls back to
 * the raw name with underscores opened up, so a new server intent still shows
 * something readable instead of vanishing.
 */
const INTENT_LABELS = {
  [INTENTS.EXPLAIN_TARGET]: "lookup",
  [INTENTS.COMPARE]: "compare",
  [INTENTS.RANK_STOCKS]: "ranking",
  [INTENTS.MARKET_OVERVIEW]: "market",
  [INTENTS.SAFETY_CHECK]: "safety",
  [INTENTS.EXPLAIN_CHAIN]: "chain",
};

function intentLabel(intent) {
  if (typeof intent !== "string" || !intent || intent === INTENTS.UNKNOWN) return null;
  return INTENT_LABELS[intent] ?? intent.replace(/_/g, " ");
}

/**
 * The empty state doubles as the feature list: one example per thing the intent
 * router can now do, so nobody has to guess that a bare ranking question works.
 * Both addresses are real — the issuer wallet behind the official equity tokens,
 * and a live NVDA impostor — so a click produces a genuine answer rather than a
 * lookup failure on a placeholder.
 */
const EXAMPLES = [
  { label: "Price a ticker", question: "How is NVDA trading on Robinhood Chain right now?" },
  { label: "Rank the market", question: "Which five stock tokens have the most holders?" },
  { label: "Set two side by side", question: "Compare NVDA and TSLA on price and holder count." },
  {
    label: "Check it is genuine",
    question: "Is the NVDA token at 0x465834D5BA3af2169E49B70A139448e59e3CA492 the official one?",
  },
  {
    label: "Read a wallet",
    question: "What is 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046 and what has it been doing?",
  },
];

export function AskChat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const didPrefill = useRef(false);

  // Handle a ?q= handoff (the landing hero input and its suggestion chips) once
  // on mount. Actionable now means "the router recognises it" rather than "it
  // carries a 0x" — a ranking or market question answers itself with no target
  // at all. Only a question nothing matches is prefilled with a hint.
  useEffect(() => {
    if (didPrefill.current) return;
    didPrefill.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    if (classifyIntent(q).intent !== INTENTS.UNKNOWN) {
      submit(q);
      return;
    }
    setInput(q);
    setMessages([
      {
        role: "assistant",
        hint: "I could not tell what that one is asking for. Name a ticker (NVDA), ask for a ranking (\"most holders\"), compare two stocks, or paste a 0x address — then press Ask.",
      },
    ]);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  /** Send one question. Text is passed in so the ?q= handoff can send directly. */
  async function submit(raw) {
    const text = String(raw ?? "").trim();
    if (!text || busy) return;

    setMessages((m) => [...m, { role: "user", content: text }]);

    // The composer no longer refuses questions without a target: deciding what a
    // question is asking for is the router's job, and most of the good ones name
    // nothing at all. `target` is still sent for a plain lookup so the existing
    // explain_target path is untouched — but never for a compare or a ranking,
    // where pinning one target is exactly how "compare NVDA and TSLA" used to
    // collapse into an answer about NVDA alone.
    const targets = extractTargets(text);
    const previewed = classifyIntent(text, targets);
    const target =
      previewed.intent === INTENTS.EXPLAIN_TARGET
        ? targets.txs[0] ?? targets.addresses[0] ?? targets.symbols[0] ?? null
        : null;

    // Only now is the question actually leaving — clearing earlier destroyed
    // what the user typed on the most common failure.
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target ? { question: text, target } : { question: text }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        // A 400 is always something about the question itself — too vague, too
        // long. That is coaching, not a failure, so it reads as an ordinary
        // reply instead of a red box the user feels told off by. Only a plain
        // string is shown: a structured `guidance` would throw on render.
        const raw400 = j?.guidance ?? j?.error;
        const guidance = typeof raw400 === "string" ? raw400.trim() : "";
        if (res.status === 400 && guidance) {
          setMessages((m) => [...m, { role: "assistant", hint: guidance }]);
        } else {
          setMessages((m) => [
            ...m,
            { role: "assistant", error: j?.error || `Request failed (${res.status}).`, detail: j?.detail },
          ]);
        }
      } else {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: j.answer,
            intent: j.intent,
            kind: j.kind,
            target: j.target,
            evidence: j.evidence,
            model: j.model,
          },
        ]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", error: String(e?.message ?? e) }]);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    submit(input);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // The examples stay up until a real question is asked, so the ?q= hint has
  // something actionable next to it.
  const empty = !messages.some((m) => m.role === "user");

  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-3xl flex-col px-3 sm:px-6">
      {/* Intro */}
      <div className="pt-6 pb-4">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
          Robinhood Chain · AI explorer
        </p>
        <h1 className="mt-1 text-lg font-semibold text-cm-text sm:text-xl">Ask anything on-chain</h1>
        <p className="mt-1 text-sm text-cm-muted">
          Ask about a ticker, a ranking, two stocks side by side, or any 0x address. Answers are grounded in live chain
          data.
        </p>
      </div>

      {/* Conversation */}
      <div className="flex-1 space-y-4 pb-4">
        {empty && (
          <div className="grid gap-2 sm:grid-cols-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                disabled={busy}
                onClick={() => submit(ex.question)}
                className="rounded-lg border border-cm-border bg-cm-card px-3 py-3 text-left text-sm text-cm-subtle transition hover:border-cm-accent/40 hover:bg-cm-row-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="block font-medium text-cm-text">{ex.label}</span>
                {/* Sends the full question; only the display shortens the hex. */}
                <span className="mt-1 block font-mono text-[11px] text-cm-faint">{shortenHexIn(ex.question)}</span>
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}

        {busy && <ThinkingIndicator />}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 border-t border-cm-border bg-cm-bg/95 py-3 backdrop-blur-md">
        <div className="flex items-end gap-2 rounded-xl border border-cm-border bg-cm-card p-2 focus-within:border-cm-accent/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask about a ticker, a ranking, an address…"
            className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-cm-text placeholder:text-cm-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-lg bg-cm-accent px-4 py-2 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ m }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-cm-row px-3 py-2 text-sm text-cm-text">
          {m.content}
        </div>
      </div>
    );
  }

  if (m.hint) {
    return (
      <div className="rounded-lg border border-cm-border bg-cm-card px-3 py-2 text-sm text-cm-subtle">{m.hint}</div>
    );
  }

  if (m.error) {
    return (
      <div className="rounded-lg border border-cm-bad/30 bg-cm-bad/5 px-3 py-2 text-sm text-cm-bad">
        {m.error}
        {m.detail && <pre className="mt-1 overflow-auto font-mono text-[10px] text-cm-muted">{m.detail}</pre>}
      </div>
    );
  }

  const intent = intentLabel(m.intent);

  return (
    <div className="rounded-2xl rounded-bl-sm border border-cm-border bg-cm-surface px-3 py-3">
      {(intent || m.kind || m.target) && (
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-cm-faint">
          {/* What the router decided this question was — deliberately quiet. */}
          {intent && <span>{intent}</span>}
          {m.kind && <span className="rounded bg-cm-row px-1.5 py-0.5 text-cm-terminal">{m.kind}</span>}
          {m.target && <span>{shortHex(m.target)}</span>}
        </div>
      )}
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-cm-text">{m.content}</p>
      {m.evidence && (
        <details className="mt-2 rounded border border-cm-border-subtle bg-cm-card/60 px-2 py-1">
          <summary className="cursor-pointer select-none font-mono text-[11px] text-cm-faint">Evidence</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-cm-muted">
            {JSON.stringify(m.evidence, null, 2)}
          </pre>
        </details>
      )}
      {m.model && (
        <p className="mt-1.5 font-mono text-[9px] text-cm-faint">{m.model}</p>
      )}
    </div>
  );
}
