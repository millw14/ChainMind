import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_REL = "data/helius-scan-baseline.json";

/**
 * Baseline: last h24 volume + Helius/Dex price for spike detection across ticks.
 * @typedef {{ h24Vol: number, priceUsd: number | null, updatedAt: string }} MintBaseline
 */

/**
 * @param {string} [pathRel]
 * @returns {Record<string, MintBaseline>}
 */
export function readScanBaseline(pathRel = process.env.HELIUS_SCAN_BASELINE_PATH?.trim() || DEFAULT_REL) {
  const abs = resolve(process.cwd(), pathRel);
  if (!existsSync(abs)) return {};
  try {
    const j = JSON.parse(readFileSync(abs, "utf8"));
    return j.mints && typeof j.mints === "object" ? j.mints : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, MintBaseline>} mints
 * @param {string} [pathRel]
 */
export function writeScanBaseline(mints, pathRel = process.env.HELIUS_SCAN_BASELINE_PATH?.trim() || DEFAULT_REL) {
  const abs = resolve(process.cwd(), pathRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ mints, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}
