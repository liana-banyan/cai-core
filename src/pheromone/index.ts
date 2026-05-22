/**
 * Pheromone — Multi-strength canonical-entity propagation
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Pheromone drives propagation of canonical entities across the substrate.
 * Each entity carries a strength field (weak · medium · strong · rom) that
 * controls injection priority and eviction resistance.
 *
 * ROM-class entities: permanent · non-evictable · cross-scale-homomorphic.
 *
 * Pheromone trail filesystem layout under ~/.cai_core/pheromone/:
 *   trails.jsonl  — append-only emission log
 *   entities/     — per-entity JSON snapshots
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const PHEROMONE_DIR = resolve(CAI_CORE_HOME, 'pheromone');
const ENTITIES_DIR = resolve(PHEROMONE_DIR, 'entities');
const TRAILS_LOG = resolve(PHEROMONE_DIR, 'trails.jsonl');

function ensureDirs(): void {
  for (const d of [PHEROMONE_DIR, ENTITIES_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type PheromoneStrength = 'weak' | 'medium' | 'strong' | 'rom';

export interface CanonicalEntity {
  id: string;
  label: string;
  aliases: string[];
  strength: PheromoneStrength;
  body: string;
  sha256: string;
  source: string;
  first_seen: string;
  last_updated: string;
  emit_count: number;
}

export interface PheromoneTrail {
  entity_id: string;
  strength: PheromoneStrength;
  trigger: string;
  emitted_at: string;
  session_id?: string;
  context_hint?: string;
}

export interface PropagationResult {
  entity_id: string;
  injected: boolean;
  strength: PheromoneStrength;
  trail_id: string;
  entity?: CanonicalEntity;
}

// ─── Entity store ─────────────────────────────────────────────────────────────

export class PheromoneEntityStore {
  private entities: Map<string, CanonicalEntity> = new Map();
  private aliasIndex: Map<string, string> = new Map();
  private loaded = false;

  async load(): Promise<void> {
    ensureDirs();

    if (existsSync(ENTITIES_DIR)) {
      const files = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(ENTITIES_DIR, file), 'utf8');
          const entity = JSON.parse(raw) as CanonicalEntity;
          this.entities.set(entity.id, entity);
          for (const alias of entity.aliases) {
            this.aliasIndex.set(alias.toLowerCase(), entity.id);
          }
        } catch {
          // Skip corrupt files
        }
      }
    }

    this.loaded = true;
    console.log(`[Pheromone] Loaded ${this.entities.size} canonical entities`);
  }

  upsert(entity: Omit<CanonicalEntity, 'sha256' | 'first_seen' | 'last_updated' | 'emit_count'>): CanonicalEntity {
    ensureDirs();

    const sha256 = createHash('sha256').update(entity.body).digest('hex');
    const now = new Date().toISOString();
    const existing = this.entities.get(entity.id);

    const canonical: CanonicalEntity = {
      ...entity,
      sha256,
      first_seen: existing?.first_seen ?? now,
      last_updated: now,
      emit_count: existing?.emit_count ?? 0,
    };

    this.entities.set(entity.id, canonical);
    for (const alias of entity.aliases) {
      this.aliasIndex.set(alias.toLowerCase(), entity.id);
    }

    const entityPath = resolve(ENTITIES_DIR, `${entity.id}.json`);
    writeFileSync(entityPath, JSON.stringify(canonical, null, 2), 'utf8');

    return canonical;
  }

  get(id: string): CanonicalEntity | undefined {
    return this.entities.get(id);
  }

  resolveAlias(alias: string): CanonicalEntity | undefined {
    const id = this.aliasIndex.get(alias.toLowerCase());
    return id ? this.entities.get(id) : undefined;
  }

  getByStrength(strength: PheromoneStrength): CanonicalEntity[] {
    return Array.from(this.entities.values()).filter((e) => e.strength === strength);
  }

  getROM(): CanonicalEntity[] {
    return this.getByStrength('rom');
  }

  getAll(): CanonicalEntity[] {
    return Array.from(this.entities.values());
  }

  get size(): number {
    return this.entities.size;
  }
}

// ─── Propagation engine ───────────────────────────────────────────────────────

export class PheromoneEngine {
  private store: PheromoneEntityStore;
  private strengthThreshold: PheromoneStrength;

  private static readonly STRENGTH_ORDER: PheromoneStrength[] = ['weak', 'medium', 'strong', 'rom'];

  constructor(store: PheromoneEntityStore, minStrength: PheromoneStrength = 'weak') {
    this.store = store;
    this.strengthThreshold = minStrength;
  }

  private strengthLevel(s: PheromoneStrength): number {
    return PheromoneEngine.STRENGTH_ORDER.indexOf(s);
  }

  private meetsThreshold(strength: PheromoneStrength): boolean {
    return this.strengthLevel(strength) >= this.strengthLevel(this.strengthThreshold);
  }

  /**
   * Attempt to inject a canonical entity matching the trigger text.
   * ROM-class entities always inject; others respect strength threshold.
   */
  propagate(trigger: string, sessionId?: string): PropagationResult {
    const entity =
      this.store.get(trigger) ??
      this.store.resolveAlias(trigger);

    const trailId = createHash('md5')
      .update(`${trigger}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);

    if (!entity) {
      return { entity_id: trigger, injected: false, strength: 'weak', trail_id: trailId };
    }

    const shouldInject = entity.strength === 'rom' || this.meetsThreshold(entity.strength);

    const trail: PheromoneTrail = {
      entity_id: entity.id,
      strength: entity.strength,
      trigger,
      emitted_at: new Date().toISOString(),
      session_id: sessionId,
    };

    try {
      ensureDirs();
      appendFileSync(TRAILS_LOG, JSON.stringify(trail) + '\n', 'utf8');
    } catch {
      // Non-fatal
    }

    if (shouldInject) {
      entity.emit_count++;
      try {
        writeFileSync(
          resolve(ENTITIES_DIR, `${entity.id}.json`),
          JSON.stringify(entity, null, 2),
          'utf8',
        );
      } catch {
        // Non-fatal
      }
    }

    return {
      entity_id: entity.id,
      injected: shouldInject,
      strength: entity.strength,
      trail_id: trailId,
      entity: shouldInject ? entity : undefined,
    };
  }

  /** Propagate all ROM entities unconditionally (session-open injection). */
  propagateROM(sessionId?: string): PropagationResult[] {
    return this.store.getROM().map((entity) =>
      this.propagate(entity.id, sessionId),
    );
  }
}
