/**
 * THE TABLE CONTRACT — one shape, every tool that returns rows.
 *
 * Answers here are prose, and prose is the wrong medium for twenty-five holders
 * with an amount and a percentage each. The model was left to lay those out in
 * text, which costs tokens, invites arithmetic it is not trusted with, and gives
 * the reader nothing to sort or export. So a tool that produces rows returns them
 * as DATA under a single agreed key, and the renderer draws them.
 *
 * The agreement, in full:
 *
 *   evidence.table = {
 *     id,         // stable slug for the renderer and the export filename
 *     title,      // one line naming what the rows are ("Top 25 holders of NVDA")
 *     columns,    // [{ key, label, align }] — the ONLY thing a renderer reads
 *     rows,       // flat objects, one per row, keyed by the column keys
 *     rowCount,   // rows.length, precomputed so the model never counts
 *     totalRows,  // how many exist upstream, or null when that is unknown
 *     truncated,  // true when `rows` is a prefix of something longer
 *     note,       // why it is a prefix, or any other caveat; null when none
 *   }
 *
 * Three properties are load-bearing:
 *
 *  1. ONE KEY, NO SPECIAL CASING. A renderer that looks for `evidence.table` and
 *     walks `columns` can draw a holder table, a wallet trace, or the next tool
 *     nobody has written yet, with no knowledge of which tool produced it.
 *  2. ROWS ARE FLAT. Every value is a string, a number, a boolean or null —
 *     buildTable enforces it. A nested object in a cell renders as "[object
 *     Object]" and exports to CSV as garbage, so it becomes null instead.
 *     Pre-rendered display strings therefore travel INLINE on the row
 *     (`amountDisplay` beside `amount`) rather than in the nested `display`
 *     object used elsewhere for non-tabular evidence. Same discipline — the model
 *     copies a finished string and never reformats a float — flatter shape.
 *  3. TRUNCATION IS PART OF THE SHAPE, not a comment in the prose. A table that
 *     shows 25 of 28,899 holders says so in `totalRows` and `truncated`, so the
 *     answer cannot imply it read a whole list it only sampled.
 *
 * tableToCsv lives here too, so the export the reader downloads is built from the
 * same columns the table drew and cannot drift from them.
 *
 * Pure: no I/O, no state, no React. Safe to import from a client component.
 */

/** Alignments a renderer is expected to understand. Anything else becomes "left". */
export const TABLE_ALIGNMENTS = Object.freeze(["left", "right", "center"]);

/** The evidence key a renderer looks for. One name, one place it is spelled. */
export const TABLE_KEY = "table";

/**
 * One column descriptor.
 *
 * @param {string} key - the row property this column reads
 * @param {string} label - the header text
 * @param {"left"|"right"|"center"} [align] - numbers right, identifiers left
 * @returns {{ key: string, label: string, align: string }}
 */
export function col(key, label, align = "left") {
  const k = String(key ?? "").trim();
  return {
    key: k,
    label: String(label ?? k).trim() || k,
    align: TABLE_ALIGNMENTS.includes(align) ? align : "left",
  };
}

/**
 * An upstream row count, or null.
 *
 * `Number("")` is 0 and `Number(false)` is 0, so the obvious coercion turns "the
 * indexer never told us how many there are" into "there are none" — a table of 25
 * holders reporting a total of 0, which is a figure nobody measured. That path is
 * live rather than hypothetical: Blockscout sends "" for a counter it has not
 * computed, and lib/ask-evidence.js and lib/market-evidence.js both guard `""`
 * explicitly for the same reason. A negative count is refused on the same ground.
 */
function countOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t >= 0 ? t : null;
}

/** A cell value a renderer and a CSV can both take. Anything else is null. */
function cell(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string") return value;
  if (t === "boolean") return value;
  // NaN and Infinity are not figures anyone measured; they must not print.
  if (t === "number") return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * Assemble a table in the shape above. Never throws, and never invents a row:
 * junk columns are dropped, junk cells become null, and a row is only ever the
 * projection of the declared columns.
 *
 * @param {object} spec
 * @param {string} spec.id - stable slug ("holders", "wallet-trace")
 * @param {string} spec.title - one line naming the rows
 * @param {Array<{ key: string, label: string, align?: string }>} spec.columns
 * @param {Array<object>} spec.rows
 * @param {number|null} [spec.totalRows] - how many exist upstream, if known. An
 *   empty string, a boolean or a negative number all mean UNKNOWN, not zero.
 * @param {boolean} [spec.truncated] - is `rows` a prefix of something longer
 * @param {string|null} [spec.note] - the caveat that goes with `truncated`
 * @returns {{ id: string, title: string|null, columns: Array<object>, rows: Array<object>, rowCount: number, totalRows: number|null, truncated: boolean, note: string|null }}
 */
export function buildTable({ id, title, columns, rows, totalRows = null, truncated = false, note = null } = {}) {
  const cols = (Array.isArray(columns) ? columns : [])
    .map((c) => (c && typeof c === "object" ? col(c.key, c.label, c.align) : null))
    .filter((c) => c && c.key);

  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object" && !Array.isArray(r));
  const projected = list.map((row) => {
    const out = {};
    for (const c of cols) out[c.key] = cell(row[c.key]);
    return out;
  });

  const claimed = countOrNull(totalRows);
  // A total BELOW the rows in hand is a stale counter, not a total. It happens for
  // real: a holder count comes from /tokens/{a}/counters while the rows come from
  // /tokens/{a}/holders, two calls that can disagree. "25 of 1" is a table
  // contradicting itself, so the count is dropped to unknown and `truncated` falls
  // back to whatever the caller actually knew.
  const total = claimed !== null && claimed < projected.length ? null : claimed;
  return {
    id: String(id ?? "table").trim() || "table",
    title: String(title ?? "").trim() || null,
    columns: cols,
    rows: projected,
    rowCount: projected.length,
    totalRows: total,
    // A prefix of a longer list is truncated whether or not the caller said so:
    // deriving it from the counts means one fewer place to forget.
    truncated: Boolean(truncated) || (total !== null && projected.length < total),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  };
}

/**
 * One CSV cell.
 *
 * The leading-character guard is not paranoia: token names come off the chain and
 * anyone can mint one called "=IMPORTXML(...)". A spreadsheet treats that as a
 * formula on open, so a value starting with =, +, - or @ is prefixed with a
 * single quote — visible, harmless, and not executable.
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Is this a table a renderer can actually draw?
 *
 * `columns` is the test, not `rows`: a table with columns and no rows is a real
 * (if empty) result, while rows with no columns are unreadable data no renderer
 * can lay out. Anything failing this is skipped silently rather than rendered as
 * an empty frame — a blank table implies a lookup returned nothing, which is
 * exactly the false claim this codebase refuses to make.
 *
 * @param {unknown} table
 * @returns {boolean}
 */
export function isTable(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) return false;
  const cols = table.columns;
  if (!Array.isArray(cols) || !cols.some((c) => c && typeof c === "object" && c.key)) return false;
  return Array.isArray(table.rows);
}

/**
 * Every table in one answer's evidence, in a stable order.
 *
 * Two places have to be looked at, because lib/ask-loop.js summarize() gives the
 * evidence two shapes: ONE lookup returns its evidence blob bare (so the table is
 * at `evidence.table`), and two or more return an object keyed by tool name (so
 * it is at `evidence.rank_stocks.table`). A client that only knew the first shape
 * would drop the table from every multi-tool answer — silently, and only for the
 * more interesting questions.
 *
 * One level of nesting is deliberately as far as this goes: the keyed shape is
 * exactly one level deep, and walking arbitrarily deep would start finding
 * "tables" in indexer-supplied data that merely happens to have those key names.
 *
 * @param {unknown} evidence - the value of the response's `evidence` field
 * @returns {Array<object>} the tables, `[]` when there are none
 */
export function collectTables(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const out = [];
  if (isTable(evidence[TABLE_KEY])) out.push(evidence[TABLE_KEY]);
  for (const value of Object.values(evidence)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = value[TABLE_KEY];
    if (isTable(nested) && !out.includes(nested)) out.push(nested);
  }
  return out;
}

/**
 * Render a table built above as CSV text — header row from `columns`, one line
 * per row, CRLF line endings (what spreadsheets expect).
 *
 * Same source as the drawn table by construction, so an export can never carry
 * different columns than the reader saw.
 *
 * @param {object} table - the value of evidence.table
 * @returns {string} CSV text; "" when there is nothing to export
 */
export function tableToCsv(table) {
  const cols = Array.isArray(table?.columns) ? table.columns.filter((c) => c && c.key) : [];
  if (!cols.length) return "";
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row?.[c.key])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
