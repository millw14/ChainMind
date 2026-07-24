"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

/**
 * The tokenized-equity table on /stocks.
 *
 * Everything here is local state over the `items` the server already fetched —
 * searching and sorting never refetch, so the page stays honest about being a
 * single snapshot of the chain rather than silently re-querying per keystroke.
 */

/* --------------------------- formatting --------------------------- */

const EMPTY = "—";

/** Price in USD, always 2dp so the column reads as a straight decimal ladder. */
function formatPrice(value) {
  if (!Number.isFinite(value)) return EMPTY;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const UNITS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * 1_234_567_890 -> "1.2B". Values of 100+ in a unit drop the decimal, so a cell
 * never grows past four characters and the column can stay narrow.
 */
function formatCompact(value) {
  if (!Number.isFinite(value) || value < 0) return EMPTY;
  for (const [size, suffix] of UNITS) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(value));
}

function formatCap(value) {
  const compact = formatCompact(value);
  return compact === EMPTY ? EMPTY : `$${compact}`;
}

/* --------------------------- sorting --------------------------- */

/**
 * Columns the header can sort by. `numeric` decides both the comparator and the
 * direction a fresh click starts in — money reads biggest-first, tickers A–Z.
 */
const COLUMNS = [
  { key: "symbol", label: "Symbol", numeric: false },
  { key: "price", label: "Price", numeric: true },
  { key: "marketCap", label: "Market cap", numeric: true },
  { key: "holders", label: "Holders", numeric: true },
];

const NUMERIC_KEYS = new Set(COLUMNS.filter((c) => c.numeric).map((c) => c.key));

/**
 * Compare one field, unknowns last in both directions. A token with no price is
 * missing data, not the cheapest stock on the chain, so it must never win the
 * top of an ascending sort.
 */
function compare(a, b, key, dir) {
  const flip = dir === "asc" ? 1 : -1;

  if (NUMERIC_KEYS.has(key)) {
    const x = a[key];
    const y = b[key];
    const xOk = Number.isFinite(x);
    const yOk = Number.isFinite(y);
    if (!xOk && !yOk) return 0;
    if (!xOk) return 1;
    if (!yOk) return -1;
    if (x === y) return 0;
    return (x < y ? -1 : 1) * flip;
  }

  const x = String(a[key] ?? "");
  const y = String(b[key] ?? "");
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return x.localeCompare(y, "en") * flip;
}

/* --------------------------- layout --------------------------- */

/**
 * One grid template drives the head and every row, so the columns stay locked
 * together. Company and Holders are `hidden sm:block`; a display:none cell drops
 * out of the grid entirely, which is what leaves exactly three tracks on phones.
 */
const GRID =
  "grid grid-cols-[4.25rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 " +
  "sm:grid-cols-[5rem_minmax(0,1fr)_7rem_8rem_6rem] sm:gap-x-4";

const NUM_CELL = "text-right font-mono text-xs tabular-nums sm:text-sm";

function SortArrow({ active, dir }) {
  if (!active) return null;
  return (
    <span aria-hidden="true" className="text-cm-accent">
      {dir === "asc" ? "↑" : "↓"}
    </span>
  );
}

function HeaderButton({ column, sort, onSort, className }) {
  const active = sort.key === column.key;
  const order = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <button
      type="button"
      onClick={() => onSort(column.key)}
      aria-label={active ? `${column.label}, sorted ${order}. Reverse the order` : `Sort by ${column.label}`}
      className={`flex items-center gap-1 text-[10px] uppercase tracking-widest transition-colors motion-reduce:transition-none ${
        active ? "text-cm-text" : "text-cm-faint hover:text-cm-subtle"
      } ${className}`}
    >
      {column.label}
      <SortArrow active={active} dir={sort.dir} />
    </button>
  );
}

/* --------------------------- table --------------------------- */

export function StockTable({ items = [] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: "marketCap", dir: "desc" });

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? items.filter((item) => {
          const symbol = String(item.symbol ?? "").toLowerCase();
          const company = String(item.company ?? "").toLowerCase();
          return symbol.includes(needle) || company.includes(needle);
        })
      : items.slice();
    // Sorted on a copy — `items` is the server's array and mutating it would
    // reorder the prop under React on the next render.
    return filtered.sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [items, query, sort]);

  function onSort(key) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: NUMERIC_KEYS.has(key) ? "desc" : "asc" };
    });
  }

  const symbolCol = COLUMNS[0];
  const [, priceCol, capCol, holdersCol] = COLUMNS;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <label className="block w-full sm:max-w-xs">
          <span className="sr-only">Filter stocks by symbol or company</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by symbol or company…"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full border border-cm-border bg-cm-elevated px-3 font-mono text-xs text-cm-text placeholder:text-cm-faint focus:border-cm-accent focus:outline-none"
          />
        </label>
        <p className="font-mono text-[10px] uppercase tracking-widest text-cm-faint">
          {rows.length} / {items.length} listed
        </p>
      </div>

      {/* Cells truncate rather than push, so this rarely scrolls — but a very
          narrow viewport gets a scroller instead of overflowing the page.
          Rows are links, not <tr>s: a whole-row link is the point of the table,
          and an anchor cannot live inside a row without breaking either the
          table semantics or the click target. */}
      <div className="mt-4 overflow-x-auto border border-cm-border">
        <div className="min-w-[18rem]">
          <div className={`${GRID} border-b border-cm-border bg-cm-row px-3 py-2 sm:px-4`}>
            <HeaderButton column={symbolCol} sort={sort} onSort={onSort} className="justify-start" />
            <div className="hidden text-[10px] uppercase tracking-widest text-cm-faint sm:block">Company</div>
            <div className="flex justify-end">
              <HeaderButton column={priceCol} sort={sort} onSort={onSort} className="justify-end" />
            </div>
            <div className="flex justify-end">
              <HeaderButton column={capCol} sort={sort} onSort={onSort} className="justify-end" />
            </div>
            <div className="hidden justify-end sm:flex">
              <HeaderButton column={holdersCol} sort={sort} onSort={onSort} className="justify-end" />
            </div>
          </div>

          <ul className="divide-y divide-cm-border-subtle">
            {rows.map((item) => {
              const symbol = item.symbol ?? item.company ?? EMPTY;
              return (
                <li key={item.address}>
                  <Link
                    href={`/ask?q=${encodeURIComponent(symbol)}`}
                    className={`${GRID} group px-3 py-2.5 transition-colors hover:bg-cm-row-hover focus-visible:bg-cm-row-hover focus-visible:outline-none motion-reduce:transition-none sm:px-4`}
                  >
                    <span className="truncate font-mono text-xs font-semibold text-cm-text transition-colors group-hover:text-cm-accent group-focus-visible:text-cm-accent motion-reduce:transition-none sm:text-sm">
                      {symbol}
                    </span>
                    <span className="hidden truncate text-sm text-cm-muted sm:block">{item.company ?? EMPTY}</span>
                    <span className={`${NUM_CELL} text-cm-subtle`}>{formatPrice(item.price)}</span>
                    <span className={`${NUM_CELL} text-cm-subtle`}>{formatCap(item.marketCap)}</span>
                    <span className={`hidden ${NUM_CELL} text-cm-muted sm:block`}>{formatCompact(item.holders)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-cm-muted sm:px-4">
              Nothing matches <span className="font-mono text-cm-subtle">{query.trim() || "that filter"}</span>.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
