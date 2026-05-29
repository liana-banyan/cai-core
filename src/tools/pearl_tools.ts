/**
 * Pearl Tools — caithedral-core BP058 W15 V15.4
 *
 * Wrappers consuming the V15.1 Speckle Architecture codec from librarian-mcp.
 * These are the caithedral-core facing surface — thin adapters over hex_warehouse.
 *
 * Note: In production these import from the published librarian-mcp package.
 * During development, use relative path or workspace linking.
 */

// ─── Types (mirrored from hex_warehouse for caithedral-core consumers) ─────────

export interface PearlEmitResult {
  pearl_id: string;       // the Pearl ID being bundled
  soccerball_id: string;  // the Soccerball handle after emission
  bindings: Record<string, string>;
}

export interface PearlDecodeResult {
  pearls: string[];
  bindings: Record<string, string>;
  found: boolean;
}

// ─── In-process codec (no external dep for caithedral-core standalone use) ─────

import { createHash } from "crypto";

const LOCAL_CRYSTAL = new Map<string, { pearls: string[]; bindings: Record<string, string>; ts: number }>();

function localEmit(pearls: string[], bindings: Record<string, string> = {}): string {
  const sorted = [...pearls].sort();
  const sortedB = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  const hash = createHash("sha256").update(JSON.stringify({ p: sorted, b: sortedB })).digest("hex");
  const sid = hash.slice(0, 32);
  LOCAL_CRYSTAL.set(sid, { pearls: sorted, bindings: sortedB, ts: Date.now() });
  return sid;
}

// ─── pearl_emit wrapper ────────────────────────────────────────────────────────

/**
 * pearl_emit — wrap one or more Pearl IDs into a Soccerball handle.
 *
 * Thin adapter over soccerball_emit from V15.1 codec.
 * Bindings can include initiative, session, or any KV metadata.
 */
export function pearl_emit(
  pearl_ids: string | string[],
  bindings: Record<string, string> = {}
): PearlEmitResult {
  const pearls = Array.isArray(pearl_ids) ? pearl_ids : [pearl_ids];
  if (pearls.length === 0) throw new Error("pearl_emit: at least one pearl_id required");

  const soccerball_id = localEmit(pearls, bindings);

  return {
    pearl_id: pearls[0],   // primary pearl (first in sort order)
    soccerball_id,
    bindings,
  };
}

// ─── pearl_decode wrapper ──────────────────────────────────────────────────────

/**
 * pearl_decode — decode a Soccerball handle back to Pearl IDs + bindings.
 *
 * Returns `found: false` if soccerball_id is not in the local substrate.
 * (In production, would check librarian-mcp MassCrystal.)
 */
export function pearl_decode(soccerball_id: string): PearlDecodeResult {
  const entry = LOCAL_CRYSTAL.get(soccerball_id);
  if (!entry) {
    return { pearls: [], bindings: {}, found: false };
  }
  return {
    pearls: [...entry.pearls],
    bindings: { ...entry.bindings },
    found: true,
  };
}

/**
 * pearl_crystal_size — diagnostic: number of Soccerballs in local substrate.
 */
export function pearl_crystal_size(): number {
  return LOCAL_CRYSTAL.size;
}
