"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tableToCsv } from "@/lib/table-shape";
import { IconCheck, IconCopy, IconDownload } from "@/components/icons/AskIcons";

/**
 * AnswerTable — the rows an answer is about, drawn as a table instead of recited
 * as prose.
 *
 * Twenty-five holders with an amount and a share each is data, and prose is the
 * wrong medium for it: it costs the model tokens to lay out, invites it to do
 * arithmetic nobody should trust it with, and leaves the reader with nothing to
 * scan down or take away. lib/table-shape.js is the contract that fixes that, and
 * this is the renderer for it.
 *
 * The whole component reads `columns` and nothing else. It does not know what a
 * holder is, or a transfer, or a ranking — a tool that returns rows in the agreed
 * shape gets a table here with no change to this file, which is the point of the
 * contract having a columns descriptor at all.
 *
 * Three details are deliberate:
 *
 *  - NUMBERS ARE PRINTED, NEVER FORMATTED. A cell carrying 4160789.11 renders as
 *    "4160789.11". Sliding a decimal point or rounding to three fraction digits
 *    (which is what `toLocaleString` does by default) would misstate a market cap
 *    or a token balance, and the shape already carries pre-rendered display
 *    strings inline for the columns that want them — a tool declares the column it
 *    wants shown. Row counts in the chrome are the exception, and they are
 *    integers, where grouping is exact.
 *  - A MISSING CELL IS NOT AN EMPTY ONE. null renders as a muted dash, because a
 *    blank cell in a table of amounts reads as zero.
 *  - THE EXPORT COMES FROM THE SAME COLUMNS. tableToCsv walks the descriptor this
 *    table drew, so the CSV can never carry different columns than the reader saw.
 */

/** Rows shown before the expander. Ten is a glance; twenty-five is a document. */
const VISIBLE_ROWS = 10;

/** How long the Copy button wears its result before going back to normal (ms). */
const COPY_FEEDBACK_MS = 1600;

/** Height the body is held to once expanded, so the sticky header has a job. */
const EXPANDED_MAX_H = "max-h-[26rem]";

/** What an absent cell looks like. Never blank: blank reads as zero. */
const EMPTY_CELL = "—";

/**
 * The UTF-8 byte-order mark, as a character rather than as an invisible literal.
 *
 * Excel reads a BOM-less CSV in the local code page, which turns every non-ASCII
 * token name and every "…" in an export into mojibake. Spelled with a char code
 * so it is visible to anyone reading this file.
 */
const BOM = String.fromCharCode(0xfeff);

const ALIGN_CLASS = {
  right: "text-right",
  center: "text-center",
  left: "text-left",
};

/**
 * A count with thousands separators. Integers only — `toLocaleString` rounds to
 * three fraction digits by default, so anything else is printed as it came.
 */
function count(n) {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(n);
}

/**
 * One cell, as text.
 *
 * @param {string|number|boolean|null|undefined} value
 * @returns {string}
 */
function cellText(value) {
  if (value === null || value === undefined) return EMPTY_CELL;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EMPTY_CELL;
  const text = String(value);
  return text.trim() ? text : EMPTY_CELL;
}

/**
 * A descriptive, filesystem-safe download name.
 *
 * Built from the table's own title ("Top 25 holders of NVDA" ->
 * "chainmind-top-25-holders-of-nvda.csv") so a folder of exports is readable
 * later. Everything outside [a-z0-9-] goes, which also means the name cannot
 * carry a path separator, a leading dot or a quote — the title comes from a tool,
 * and a tool's strings are not trusted to name a file.
 */
function fileName(table) {
  const source = String(table?.title || table?.id || "table").toLowerCase();
  const slug = source
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return `chainmind-${slug || "table"}.csv`;
}

/** A small square-ish chrome button: Copy, Download, and the row expander. */
function TableButton({ onClick, label, title, Icon, active = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition ${
        active
          ? "border-cm-accent text-cm-accent"
          : "border-cm-border-subtle text-cm-muted hover:border-cm-border hover:text-cm-text"
      }`}
    >
      {Icon ? <Icon size={12} className="shrink-0" /> : null}
      <span>{label}</span>
    </button>
  );
}

/**
 * Render one table from the evidence.
 *
 * @param {Object} props
 * @param {object} props.table - one value in the lib/table-shape.js shape
 * @returns {JSX.Element|null} null when there is nothing drawable
 */
export default function AnswerTable({ table }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState("idle");

  // Every timer this component starts, so unmount takes them all with it: the
  // copy-feedback reset sets state, and doing that after teardown is a leak.
  const timersRef = useRef([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    };
  }, []);

  const later = useCallback((fn, ms) => {
    const timer = setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== timer);
      fn();
    }, ms);
    timersRef.current.push(timer);
  }, []);

  const columns = useMemo(
    () => (Array.isArray(table?.columns) ? table.columns.filter((c) => c && c.key) : []),
    [table],
  );
  const rows = useMemo(() => (Array.isArray(table?.rows) ? table.rows : []), [table]);

  // The CSV text is both the download and the clipboard payload — one source, so
  // what is pasted and what is saved cannot disagree.
  const csv = useMemo(() => tableToCsv({ columns, rows }), [columns, rows]);

  const onCopy = useCallback(async () => {
    try {
      if (!navigator?.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(csv);
      if (!mountedRef.current) return;
      setCopied("done");
    } catch {
      // A denied permission, an insecure context, or a browser without the API.
      // Say so on the button rather than pretending it worked.
      if (!mountedRef.current) return;
      setCopied("failed");
    }
    later(() => {
      if (mountedRef.current) setCopied("idle");
    }, COPY_FEEDBACK_MS);
  }, [csv, later]);

  const onDownload = useCallback(() => {
    try {
      const blob = new Blob([`${BOM}${csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName(table);
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next task, not synchronously: some browsers cancel a
      // download whose blob URL is released in the same tick as the click.
      later(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      console.warn(`[ask] CSV download failed: ${String(e?.message ?? e)}`);
    }
  }, [csv, later, table]);

  if (!columns.length) return null;

  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - shown.length;
  // `Number("")` and `Number(false)` are both 0, so coercing first would let an
  // upstream count the indexer never sent render as "25 of 0 shown" — a figure
  // nobody measured, printed with total confidence. Unknown has to stay unknown.
  const rawTotal = table?.totalRows;
  const total =
    rawTotal === null || rawTotal === undefined || rawTotal === "" || typeof rawTotal === "boolean"
      ? null
      : Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0
        ? Number(rawTotal)
        : null;
  const truncated = Boolean(table?.truncated) || (total !== null && total > rows.length);

  return (
    <figure className="mt-4 min-w-0 overflow-hidden rounded-xl border border-cm-border bg-cm-card">
      {/* What it is, then how much of it there is, then what can be done with it. */}
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-cm-border-subtle px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] uppercase tracking-[0.16em] text-cm-subtle">
            {table?.title || `${count(rows.length)} rows`}
          </p>
          {/* Three states, and the middle one is the one that used to be missing:
              a prefix whose upstream total nobody could read still has to say it
              is a prefix. Falling back to the plain row count there would print a
              sampled list as though it were the whole list. */}
          <p className="mt-0.5 font-mono text-[10px] text-cm-faint">
            {truncated
              ? total !== null
                ? `${count(rows.length)} of ${count(total)} shown`
                : `first ${count(rows.length)} shown — more exist`
              : `${count(rows.length)} ${rows.length === 1 ? "row" : "rows"}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <TableButton
            onClick={onCopy}
            Icon={copied === "done" ? IconCheck : IconCopy}
            label={copied === "done" ? "Copied" : copied === "failed" ? "Blocked" : "Copy"}
            title={copied === "failed" ? "The browser would not allow the copy" : "Copy these rows as CSV"}
            active={copied === "done"}
          />
          <TableButton onClick={onDownload} Icon={IconDownload} label="CSV" title="Download these rows as a CSV file" />
        </div>
      </figcaption>

      {/* The table owns its horizontal scrolling: the page must never scroll
          sideways because a wallet trace has six columns. Once expanded the body
          is height-capped too, which is what gives the sticky header something to
          stick to. */}
      <div className={`min-w-0 overflow-x-auto ${expanded ? `${EXPANDED_MAX_H} overflow-y-auto` : ""}`}>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`sticky top-0 z-10 whitespace-nowrap border-b border-cm-border-subtle bg-cm-row px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-cm-faint ${
                    ALIGN_CLASS[column.align] ?? ALIGN_CLASS.left
                  }`}
                >
                  {column.label || column.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={`r-${index}`} className="border-b border-cm-border-subtle last:border-b-0 hover:bg-cm-row-hover">
                {columns.map((column) => {
                  const raw = row ? row[column.key] : null;
                  const missing = raw === null || raw === undefined || raw === "";
                  return (
                    <td
                      key={column.key}
                      className={`whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px] tabular-nums sm:text-xs ${
                        ALIGN_CLASS[column.align] ?? ALIGN_CLASS.left
                      } ${missing ? "text-cm-faint" : "text-cm-subtle"}`}
                    >
                      {cellText(raw)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center font-mono text-[11px] text-cm-muted"
                >
                  No rows came back for this one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {hidden > 0 || expanded ? (
        <div className="border-t border-cm-border-subtle px-3 py-2 sm:px-4">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-cm-muted transition hover:text-cm-accent"
          >
            {expanded ? `Show ${VISIBLE_ROWS}` : `Show all ${count(rows.length)}`}
          </button>
        </div>
      ) : null}

      {/* The caveat travels with the data rather than being left to the prose:
          "25 of 28,899" is only honest if the reason is next to it. */}
      {table?.note ? (
        <p className="border-t border-cm-border-subtle px-3 py-2 text-[11px] leading-relaxed text-cm-muted sm:px-4">
          {table.note}
        </p>
      ) : null}
    </figure>
  );
}
