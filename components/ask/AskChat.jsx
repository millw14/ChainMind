"use client";
import { useEffect, useRef, useState } from "react";

/** Pull the first tx hash (0x + 64 hex) or address (0x + 40 hex) out of free text. */
function extractTarget(text) {
  const tx = text.match(/0x[0-9a-fA-F]{64}/);
  if (tx) return tx[0];
  const addr = text.match(/0x[0-9a-fA-F]{40}/);
  if (addr) return addr[0];
  return null;
}

function shortHex(v) {
  if (typeof v !== "string" || !v.startsWith("0x")) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

const EXAMPLES = [
  { label: "Explain a transaction", hint: "What happened in 0x<tx hash>?" },
  { label: "Analyze a wallet", hint: "What is 0x<address> and what has it been doing?" },
  { label: "Look up a token", hint: "Tell me about the token at 0x<address>." },
];

export function AskChat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const didPrefill = useRef(false);

  // Prefill from a ?q= param (e.g. the landing-page hero input) once on mount.
  useEffect(() => {
    if (didPrefill.current) return;
    didPrefill.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setInput(q);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const target = extractTarget(text);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");

    if (!target) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          error: "Paste a Robinhood Chain address (0x…40 chars) or transaction hash (0x…64 chars) in your message.",
        },
      ]);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, target }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setMessages((m) => [
          ...m,
          { role: "assistant", error: j?.error || `Request failed (${res.status}).`, detail: j?.detail },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: j.answer, kind: j.kind, target: j.target, evidence: j.evidence, model: j.model },
        ]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", error: String(e?.message ?? e) }]);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-3xl flex-col px-3 sm:px-6">
      {/* Intro */}
      <div className="pt-6 pb-4">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
          Robinhood Chain · AI explorer
        </p>
        <h1 className="mt-1 text-lg font-semibold text-cm-text sm:text-xl">Ask anything on-chain</h1>
        <p className="mt-1 text-sm text-cm-muted">
          Paste an address or transaction hash and ask a question. Answers are grounded in live chain data.
        </p>
      </div>

      {/* Conversation */}
      <div className="flex-1 space-y-4 pb-4">
        {empty && (
          <div className="grid gap-2 sm:grid-cols-3">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => setInput(ex.hint)}
                className="rounded-lg border border-cm-border bg-cm-card px-3 py-3 text-left text-sm text-cm-subtle transition hover:border-cm-accent/40 hover:bg-cm-row-hover"
              >
                <span className="block font-medium text-cm-text">{ex.label}</span>
                <span className="mt-1 block font-mono text-[11px] text-cm-faint">{ex.hint}</span>
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}

        {busy && (
          <div className="flex items-center gap-2 font-mono text-xs text-cm-terminal">
            <span className="inline-block h-2 w-2 animate-pulse-slow rounded-full bg-cm-terminal" />
            reading chain…
          </div>
        )}
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
            placeholder="Ask about a 0x address or transaction…"
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

  if (m.error) {
    return (
      <div className="rounded-lg border border-cm-bad/30 bg-cm-bad/5 px-3 py-2 text-sm text-cm-bad">
        {m.error}
        {m.detail && <pre className="mt-1 overflow-auto font-mono text-[10px] text-cm-muted">{m.detail}</pre>}
      </div>
    );
  }

  return (
    <div className="rounded-2xl rounded-bl-sm border border-cm-border bg-cm-surface px-3 py-3">
      {(m.kind || m.target) && (
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-cm-faint">
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
