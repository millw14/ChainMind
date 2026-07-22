"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

const EXPLORER = "https://robinhoodchain.blockscout.com";

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

function explorerUrl(target, kind) {
  if (!target) return EXPLORER;
  return kind === "tx" ? `${EXPLORER}/tx/${target}` : `${EXPLORER}/address/${target}`;
}

/** Real, working example prompts — clicking one runs it. */
const EXAMPLES = [
  {
    label: "Explain a token",
    query: "Tell me about the token at 0xda80bc8f014cfd7e564a3f8cd0c31417cc751111",
    hint: "PUMP · 0xda80…1111",
  },
  {
    label: "Analyze a wallet",
    query: "What is 0x966C2F237b3C6e2e29D8be0e2D50DdB036b8Ca79 doing?",
    hint: "wallet · 0x966C…Ca79",
  },
  {
    label: "Explain a transaction",
    query: "What happened in 0x49ffc3bb77fe638d72d64e2f30880c86319bbc20c18a47160d2d8c717428e09b?",
    hint: "tx · 0x49ff…e09b",
  },
];

export function AskChat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const busyRef = useRef(false);
  const didInit = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(override) {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || busyRef.current) return;

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

    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Auto-run a ?q= param once on mount (landing-page handoff / shared links).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) send(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <div>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-cm-faint">Try one</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => send(ex.query)}
                  className="group rounded-lg border border-cm-border bg-cm-card px-3 py-3 text-left text-sm text-cm-subtle transition hover:border-cm-accent/50 hover:bg-cm-row-hover"
                >
                  <span className="block font-medium text-cm-text group-hover:text-cm-accent-bright">{ex.label}</span>
                  <span className="mt-1 block font-mono text-[11px] text-cm-faint">{ex.hint}</span>
                </button>
              ))}
            </div>
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
            placeholder="Ask about a 0x address or transaction…"
            className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-cm-text placeholder:text-cm-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={() => send()}
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
          {m.target && (
            <a
              href={explorerUrl(m.target, m.kind)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cm-accent-bright hover:underline"
            >
              {shortHex(m.target)} ↗
            </a>
          )}
        </div>
      )}
      <Markdown text={m.content} />
      {m.evidence && (
        <details className="mt-2 rounded border border-cm-border-subtle bg-cm-card/60 px-2 py-1">
          <summary className="cursor-pointer select-none font-mono text-[11px] text-cm-faint">Evidence</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-cm-muted">
            {JSON.stringify(m.evidence, null, 2)}
          </pre>
        </details>
      )}
      <div className="mt-2 flex items-center gap-3">
        <CopyButton text={m.content} />
        {m.model && <span className="font-mono text-[9px] text-cm-faint">{m.model}</span>}
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(text ?? ""));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="font-mono text-[10px] text-cm-faint transition hover:text-cm-subtle"
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}

/* --------- tiny markdown renderer (bold, inline code, bullet/number lists) --------- */

function renderInline(text) {
  const nodes = [];
  const regex = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[2] != null) {
      nodes.push(
        <strong key={key++} className="font-semibold text-cm-text">
          {match[2]}
        </strong>,
      );
    } else if (match[3] != null) {
      nodes.push(
        <code key={key++} className="rounded bg-cm-row px-1 py-0.5 font-mono text-[0.85em] text-cm-subtle">
          {match[3]}
        </code>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet) {
      if (!list || list.type !== "ul") {
        flush();
        list = { type: "ul", items: [] };
      }
      list.items.push(bullet[1]);
    } else if (numbered) {
      if (!list || list.type !== "ol") {
        flush();
        list = { type: "ol", items: [] };
      }
      list.items.push(numbered[1]);
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      blocks.push({ type: "p", text: line });
    }
  }
  flush();

  return (
    <div className="space-y-2 text-sm leading-relaxed text-cm-text">
      {blocks.map((b, i) => {
        if (b.type === "p") return <p key={i}>{renderInline(b.text)}</p>;
        const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>);
        return b.type === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-cm-accent">
            {items}
          </ul>
        ) : (
          <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-cm-faint">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
