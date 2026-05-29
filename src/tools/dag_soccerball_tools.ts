/**
 * DAG Soccerball Tools — caithedral-core BP061 W1
 * Recursive soccerball-in-soccerball addressing for substrate DAG navigation.
 * Each soccerball has 6 faces (0-5); each face → an optional child soccerball.
 * Depth N = 6^N addressable items. Local DAG walker; no external dependency.
 * Per canon_soccerball_in_soccerball_mnemosyne_context_lever_founder_directive_bp061.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagNode {
  id: string;                        // 32-char soccerball_id (content-addressed)
  pearls: string[];                  // pearl IDs encoded in this node
  bindings: Record<string, string>;  // key-value metadata
  faces: Record<string, string>;     // face-label ("0"-"5") → child dag_id
  depth: number;                     // depth from root (0 = root)
  ts: number;                        // creation timestamp
}

export interface DagHandle {
  root_id: string;       // 32-char root soccerball_id
  max_depth: number;     // max depth seen when emitting
  total_nodes: number;   // total nodes in this DAG
  pearls_hash: string;   // sha256 first 16 chars of joined pearl IDs
  epoch_ms: number;      // creation epoch
  session_meta?: string; // optional session label (up to 32 chars)
}

export interface DagWalkResult {
  nodes: DagNode[];
  depth_reached: number;
  addressable_count: number;       // 6^depth_reached
  total_bytes_referenced: number;  // nodes × 200 (estimated)
}

export interface DagResolveResult {
  found: boolean;
  node: DagNode | null;
  path_taken: string[];
  depth: number;
}

// ---------------------------------------------------------------------------
// Internal store — separate from CAITHEDRAL_CRYSTAL
// ---------------------------------------------------------------------------

const DAG_CRYSTAL = new Map<string, DagNode>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_FACES = new Set(["0", "1", "2", "3", "4", "5"]);

function validateFaces(faces: Record<string, string>): void {
  for (const key of Object.keys(faces)) {
    if (!VALID_FACES.has(key)) {
      throw new Error(`Invalid face key "${key}": must be one of "0"-"5"`);
    }
  }
}

function sortedJson(obj: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function contentAddress(
  pearls: string[],
  bindings: Record<string, string>,
  faces: Record<string, string>
): string {
  const payload = JSON.stringify([
    [...pearls].sort(),
    sortedJson(bindings),
    sortedJson(faces),
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function pearlsHash(pearls: string[]): string {
  const joined = [...pearls].sort().join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

// BFS walk — returns annotated copies of nodes with walk-computed depth
function bfsWalk(rootId: string, maxDepth: number): DagNode[] {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const result: DagNode[] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);

    const stored = DAG_CRYSTAL.get(item.id);
    if (!stored) continue;

    // Return a copy with walk-computed depth rather than stored depth=0
    result.push({ ...stored, depth: item.depth });

    if (item.depth < maxDepth) {
      for (const face of Object.keys(stored.faces).sort()) {
        const childId = stored.faces[face];
        if (childId && !visited.has(childId)) {
          queue.push({ id: childId, depth: item.depth + 1 });
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Emit a DAG soccerball node. Content-addressed; stores in DAG_CRYSTAL.
 * @param pearls   Non-empty array of pearl IDs.
 * @param bindings Key-value metadata (default {}).
 * @param faces    Face "0"-"5" → child dag_id (default {}).
 * @returns        32-char dag_id.
 */
export function dag_soccerball_emit(
  pearls: string[],
  bindings: Record<string, string> = {},
  faces: Record<string, string> = {}
): string {
  if (!pearls || pearls.length === 0) {
    throw new Error("dag_soccerball_emit: pearls must be a non-empty array");
  }
  validateFaces(faces);

  const id = contentAddress(pearls, bindings, faces);

  if (!DAG_CRYSTAL.has(id)) {
    // Compute depth: 0 if no parent references this node,
    // but here depth is supplied as 0 (root) — callers build trees top-down.
    // We store depth=0 at creation; dag_soccerball_walker adjusts depth in walk.
    const node: DagNode = {
      id,
      pearls: [...pearls],
      bindings: { ...bindings },
      faces: { ...faces },
      depth: 0,
      ts: Date.now(),
    };
    DAG_CRYSTAL.set(id, node);
  }

  return id;
}

/**
 * O(1) lookup of a DAG node by its 32-char dag_id.
 */
export function dag_soccerball_lookup(dag_id: string): DagNode | null {
  return DAG_CRYSTAL.get(dag_id) ?? null;
}

/**
 * Walk the DAG from root_id following face-edge labels in path.
 * Returns the resolved node, the path actually taken, and the depth reached.
 */
export function dag_soccerball_resolve(
  root_id: string,
  path: string[]
): DagResolveResult {
  for (const label of path) {
    if (!VALID_FACES.has(label)) {
      throw new Error(`Invalid face label "${label}" in path: must be "0"-"5"`);
    }
  }

  let current: DagNode | null = DAG_CRYSTAL.get(root_id) ?? null;
  if (!current) {
    return { found: false, node: null, path_taken: [], depth: 0 };
  }

  const path_taken: string[] = [];
  let depth = 0;

  for (const face of path) {
    const childId: string | undefined = (current as DagNode).faces[face];
    if (!childId) {
      return { found: false, node: current, path_taken, depth };
    }
    const child: DagNode | null = DAG_CRYSTAL.get(childId) ?? null;
    if (!child) {
      return { found: false, node: current, path_taken, depth };
    }
    path_taken.push(face);
    depth += 1;
    current = child;
  }

  return { found: true, node: current, path_taken, depth };
}

/**
 * BFS walk from root_id up to max_depth (default 6).
 * Returns all discovered nodes and aggregate statistics.
 */
export function dag_soccerball_walker(
  root_id: string,
  max_depth: number = 6
): DagWalkResult {
  const nodes = bfsWalk(root_id, max_depth);
  const depth_reached = nodes.reduce((acc, n) => Math.max(acc, n.depth), 0);
  const addressable_count = Math.pow(6, depth_reached);
  const total_bytes_referenced = nodes.length * 200;

  return { nodes, depth_reached, addressable_count, total_bytes_referenced };
}

/**
 * Encode a compact handle string (~135 bytes) for the DAG rooted at root_id.
 * Format: DAGV1:{root_id}:{max_depth_hex}:{total_nodes_hex}:{pearls_hash}:{epoch_hex}:{session_meta_or_empty}
 */
export function dag_soccerball_handle_encode(
  root_id: string,
  session_meta?: string
): string {
  const root = DAG_CRYSTAL.get(root_id);
  if (!root) {
    throw new Error(`dag_soccerball_handle_encode: root_id "${root_id}" not found in DAG_CRYSTAL`);
  }

  const walk = dag_soccerball_walker(root_id, 6);
  const max_depth = walk.depth_reached;
  const total_nodes = walk.nodes.length;

  const allPearls: string[] = [];
  for (const node of walk.nodes) allPearls.push(...node.pearls);
  const ph = pearlsHash(allPearls);

  const epoch_ms = root.ts;
  const meta = session_meta ? session_meta.slice(0, 20) : "";

  const handle = [
    "DAGV1",
    root_id,
    max_depth.toString(16).padStart(2, "0"),
    total_nodes.toString(16).padStart(4, "0"),
    ph,
    epoch_ms.toString(16),
    meta,
  ].join(":");

  return handle;
}

/**
 * Decode a handle string back to a DagHandle object.
 * Returns null if the format is invalid.
 */
export function dag_soccerball_handle_decode(handle: string): DagHandle | null {
  if (!handle || typeof handle !== "string") return null;

  const parts = handle.split(":");
  // Minimum 6 parts (7th is optional session_meta which may be empty)
  if (parts.length < 6) return null;
  if (parts[0] !== "DAGV1") return null;

  const [, root_id, max_depth_hex, total_nodes_hex, pearls_hash, epoch_hex, ...metaParts] = parts;

  if (!root_id || root_id.length !== 32) return null;
  if (!max_depth_hex || !total_nodes_hex || !pearls_hash || !epoch_hex) return null;

  const max_depth = parseInt(max_depth_hex, 16);
  const total_nodes = parseInt(total_nodes_hex, 16);
  const epoch_ms = parseInt(epoch_hex, 16);

  if (isNaN(max_depth) || isNaN(total_nodes) || isNaN(epoch_ms)) return null;

  const session_meta = metaParts.join(":") || undefined;

  return {
    root_id,
    max_depth,
    total_nodes,
    pearls_hash,
    epoch_ms,
    session_meta,
  };
}

/**
 * Return aggregate stats for the DAG_CRYSTAL store.
 */
export function dag_soccerball_stats(): { total_dag_nodes: number; estimatedBytes: number } {
  const total_dag_nodes = DAG_CRYSTAL.size;
  // Approximate: each node ~400 bytes for pearls + bindings + faces + overhead
  const estimatedBytes = total_dag_nodes * 400;
  return { total_dag_nodes, estimatedBytes };
}
