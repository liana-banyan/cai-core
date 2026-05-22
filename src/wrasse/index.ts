/**
 * Wrasse — Trigger-phrase pre-injection context retrieval mechanism
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Wrasse detects trigger phrases in incoming text and pre-injects the
 * corresponding Caithedral™ context before the request reaches the LLM.
 *
 * Named after the Wrasse fish that cleans parasites from larger fish —
 * Wrasse removes context gaps before they cause inference hallucinations.
 *
 * Trigger registry filesystem layout under ~/.cai_core/wrasse/:
 *   triggers.json     — phrase → entity_id mapping
 *   injection_log.jsonl — injection events for substrate feedback
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { CanonicalEntity } from '../pheromone/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const WRASSE_DIR = resolve(CAI_CORE_HOME, 'wrasse');
const TRIGGER_REGISTRY = resolve(WRASSE_DIR, 'triggers.json');
const INJECTION_LOG = resolve(WRASSE_DIR, 'injection_log.jsonl');

function ensureDirs(): void {
  if (!existsSync(WRASSE_DIR)) mkdirSync(WRASSE_DIR, { recursive: true });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TriggerEntry {
  phrase: string;
  entity_id: string;
  case_sensitive: boolean;
  added_at: string;
  hit_count: number;
}

export interface TriggerRegistry {
  version: number;
  entries: TriggerEntry[];
}

export interface InjectionEvent {
  trigger_phrase: string;
  entity_id: string;
  context_injected: string;
  injected_at: string;
  session_id?: string;
  latency_ms: number;
}

export interface WrasseResult {
  original_text: string;
  augmented_text: string;
  injections: InjectionEvent[];
  triggers_fired: string[];
  latency_ms: number;
}

// ─── Trigger registry ─────────────────────────────────────────────────────────

export class WrasseTriggerRegistry {
  private registry: TriggerRegistry = { version: 1, entries: [] };
  private loaded = false;

  load(): void {
    ensureDirs();
    if (existsSync(TRIGGER_REGISTRY)) {
      try {
        this.registry = JSON.parse(readFileSync(TRIGGER_REGISTRY, 'utf8')) as TriggerRegistry;
      } catch {
        this.registry = { version: 1, entries: [] };
      }
    }
    this.loaded = true;
  }

  private save(): void {
    ensureDirs();
    writeFileSync(TRIGGER_REGISTRY, JSON.stringify(this.registry, null, 2), 'utf8');
  }

  register(phrase: string, entityId: string, caseSensitive = false): TriggerEntry {
    const existing = this.registry.entries.find(
      (e) => e.phrase.toLowerCase() === phrase.toLowerCase(),
    );
    if (existing) {
      existing.entity_id = entityId;
      this.save();
      return existing;
    }

    const entry: TriggerEntry = {
      phrase,
      entity_id: entityId,
      case_sensitive: caseSensitive,
      added_at: new Date().toISOString(),
      hit_count: 0,
    };
    this.registry.entries.push(entry);
    this.save();
    return entry;
  }

  remove(phrase: string): boolean {
    const before = this.registry.entries.length;
    this.registry.entries = this.registry.entries.filter(
      (e) => e.phrase.toLowerCase() !== phrase.toLowerCase(),
    );
    if (this.registry.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  getAll(): TriggerEntry[] {
    return this.registry.entries;
  }

  findMatches(text: string): TriggerEntry[] {
    if (!this.loaded) this.load();
    return this.registry.entries.filter((entry) => {
      if (entry.case_sensitive) {
        return text.includes(entry.phrase);
      }
      return text.toLowerCase().includes(entry.phrase.toLowerCase());
    });
  }
}

// ─── Pre-injection engine ─────────────────────────────────────────────────────

export type EntityResolver = (entityId: string) => CanonicalEntity | undefined;

export class WrasseEngine {
  private registry: WrasseTriggerRegistry;
  private resolveEntity: EntityResolver;

  constructor(registry: WrasseTriggerRegistry, resolveEntity: EntityResolver) {
    this.registry = registry;
    this.resolveEntity = resolveEntity;
  }

  /**
   * Scan `text` for trigger phrases and pre-inject the corresponding
   * Caithedral™ context. Returns the augmented text and injection log.
   */
  preInject(text: string, sessionId?: string): WrasseResult {
    const t0 = Date.now();
    const matches = this.registry.findMatches(text);
    const injections: InjectionEvent[] = [];
    const triggersFired: string[] = [];
    let augmented = text;

    for (const match of matches) {
      const entity = this.resolveEntity(match.entity_id);
      if (!entity) continue;

      const contextBlock = `\n\n[Wrasse™ pre-injection · ${entity.label}]\n${entity.body}\n[/Wrasse™]`;
      augmented = augmented + contextBlock;
      triggersFired.push(match.phrase);
      match.hit_count++;

      const event: InjectionEvent = {
        trigger_phrase: match.phrase,
        entity_id: entity.id,
        context_injected: entity.body.slice(0, 200),
        injected_at: new Date().toISOString(),
        session_id: sessionId,
        latency_ms: Date.now() - t0,
      };
      injections.push(event);

      try {
        ensureDirs();
        appendFileSync(INJECTION_LOG, JSON.stringify(event) + '\n', 'utf8');
      } catch {
        // Non-fatal
      }
    }

    return {
      original_text: text,
      augmented_text: augmented,
      injections,
      triggers_fired: triggersFired,
      latency_ms: Date.now() - t0,
    };
  }

  /** Returns injection statistics from the log. */
  getInjectionStats(): { total_injections: number; unique_triggers: Set<string> } {
    let total_injections = 0;
    const unique_triggers = new Set<string>();

    if (!existsSync(INJECTION_LOG)) {
      return { total_injections, unique_triggers };
    }

    try {
      const lines = readFileSync(INJECTION_LOG, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as InjectionEvent;
          total_injections++;
          unique_triggers.add(event.trigger_phrase);
        } catch {
          // Skip
        }
      }
    } catch {
      // Non-fatal
    }

    return { total_injections, unique_triggers };
  }
}
