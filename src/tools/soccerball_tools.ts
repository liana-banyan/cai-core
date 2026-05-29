/**
 * Soccerball Tools — caithedral-core BP058 W15 V15.4
 *
 * Wrappers for Soccerball/Speckle Architecture operations.
 * Provides caithedral-core facing surface for hex codec operations.
 */

export { pearl_emit, pearl_decode, pearl_crystal_size } from "./pearl_tools.js";

import { createHash } from "crypto";

// ─── Local MassCrystal (caithedral-core internal) ────────────────────────────

interface PeanutRoll {
  v: 1;
  s: string;
  p: string[];
  b: Record<string, string>;
  ts: number;
}

const CAITHEDRAL_CRYSTAL = new Map<string, PeanutRoll>();

// ─── soccerball_emit ──────────────────────────────────────────────────────────

/**
 * soccerball_emit — encode N pearl_ids + bindings into 32-char Soccerball handle.
 * Content-addressed: same inputs always yield same soccerball_id.
 */
export function soccerball_emit(
  pearls: string[],
  bindings: Record<string, string> = {}
): string {
  if (pearls.length === 0) throw new Error("soccerball_emit: pearls must be non-empty");

  const sorted = [...pearls].sort();
  const sortedB = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  const hash = createHash("sha256").update(JSON.stringify({ p: sorted, b: sortedB })).digest("hex");
  const sid = hash.slice(0, 32);

  CAITHEDRAL_CRYSTAL.set(sid, { v: 1, s: sid, p: sorted, b: sortedB, ts: Date.now() });
  return sid;
}

// ─── soccerball_decode ────────────────────────────────────────────────────────

/**
 * soccerball_decode — decode Soccerball handle to pearls + bindings.
 * Returns null if handle not in caithedral substrate.
 */
export function soccerball_decode(
  soccerball_id: string
): { pearls: string[]; bindings: Record<string, string> } | null {
  const roll = CAITHEDRAL_CRYSTAL.get(soccerball_id);
  if (!roll) return null;
  return { pearls: [...roll.p], bindings: { ...roll.b } };
}

// ─── soccerball_lookup ────────────────────────────────────────────────────────

/**
 * soccerball_lookup — O(1) wire-format lookup.
 * Returns full PeanutRoll or null.
 */
export function soccerball_lookup(soccerball_id: string): PeanutRoll | null {
  return CAITHEDRAL_CRYSTAL.get(soccerball_id) ?? null;
}

// ─── speckle_nibble ────────────────────────────────────────────────────────────

/**
 * speckle_nibble — extract single Speckle (4-bit nibble) at position 0-31.
 */
export function speckle_nibble(soccerball_id: string, position: number): string {
  if (position < 0 || position > 31) throw new Error("Position must be 0-31");
  return soccerball_id[position];
}

// ─── Substrate Diagnostics ────────────────────────────────────────────────────

/**
 * caithedral_substrate_stats — current caithedral MassCrystal stats.
 */
export function caithedral_substrate_stats(): { count: number; estimatedBytes: number } {
  return { count: CAITHEDRAL_CRYSTAL.size, estimatedBytes: CAITHEDRAL_CRYSTAL.size * 200 };
}
