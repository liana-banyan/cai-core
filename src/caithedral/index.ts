/**
 * Caithedral™ — CPU-only Tier-1 substrate retrieval
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Caithedral™ is the zero-LLM-inference retrieval path: BM25-lite keyword
 * scoring against a local substrate index. Sub-millisecond latency target.
 * Three-mode operation: ai_burst · normal · fallback.
 *
 * Data directory: ~/.cai_core/substrate/
 */

import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
} from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const DATA_DIR = resolve(CAI_CORE_HOME, 'substrate');

const CLOUD_COST_PER_TOKEN_USD = 0.000003;
const TYPICAL_RESPONSE_TOKENS = 800;

// ─── Types ────────────────────────────────────────────────────────────────────

export type FrameMode = 'ai_burst' | 'normal' | 'fallback';

export interface SubstrateRecord {
  id: string;
  text: string;
  source: string;
  keywords: string[];
  ts: string;
  embedding_hint?: string;
}

export interface QueryResult {
  hit: boolean;
  record?: SubstrateRecord;
  score?: number;
  routing: 'substrate_hit' | 'local_ollama' | 'cloud_escalation' | 'peer_sync' | 'miss';
  latency_ms: number;
  cloud_cost_avoided_usd: number;
}

export interface QueryOptions {
  degraded?: boolean;
}

// ─── Stop words ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'they', 'will', 'been', 'were',
  'what', 'when', 'where', 'which', 'while', 'your', 'more', 'also', 'into',
  'than', 'then', 'some', 'about', 'just', 'would', 'could', 'should',
  'their', 'there', 'these', 'those', 'each', 'such', 'other', 'after',
  'over', 'under', 'only', 'very', 'still', 'well', 'back', 'even',
]);

// ─── Caithedral™ Local Index ──────────────────────────────────────────────────

export class CaithedralLocalIndex {
  private records: SubstrateRecord[] = [];
  private indexedKeywords: Map<string, Set<number>> = new Map();
  private loaded = false;

  private get cacheFile(): string {
    return resolve(DATA_DIR, 'caithedral_cache.jsonl');
  }

  async load(): Promise<void> {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    if (existsSync(this.cacheFile)) {
      const lines = readFileSync(this.cacheFile, 'utf8')
        .split('\n')
        .filter(Boolean);
      for (const line of lines) {
        try {
          this.addRecord(JSON.parse(line) as SubstrateRecord);
        } catch {
          // Malformed line — skip
        }
      }
    }

    this.loaded = true;
    console.log(`[Caithedral™] Loaded ${this.records.length} records`);
  }

  /** Ingest records from an external JSONL file (e.g. gold tablets) */
  ingestJSONL(filePath: string, sourceLabel: string): number {
    if (!existsSync(filePath)) return 0;
    let count = 0;
    try {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as { text?: string; id?: string; tags?: string[] };
          if (!rec.text) continue;
          this.addRecord({
            id: rec.id ?? createHash('md5').update(rec.text).digest('hex').slice(0, 12),
            text: rec.text,
            source: sourceLabel,
            keywords: this._extractKeywords(rec.text, rec.tags),
            ts: new Date().toISOString(),
          });
          count++;
        } catch {
          // Skip malformed records
        }
      }
    } catch {
      // Skip unreadable file
    }
    return count;
  }

  private addRecord(record: SubstrateRecord): void {
    const idx = this.records.length;
    this.records.push(record);
    for (const kw of record.keywords) {
      const set = this.indexedKeywords.get(kw) ?? new Set();
      set.add(idx);
      this.indexedKeywords.set(kw, set);
    }
  }

  extractKeywords(text: string, extra?: string[]): string[] {
    return this._extractKeywords(text, extra);
  }

  private _extractKeywords(text: string, extra?: string[]): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .filter((w) => !STOP_WORDS.has(w));

    const all = Array.from(new Set([...words, ...(extra ?? []).map((t) => t.toLowerCase())]));
    return all.slice(0, 40);
  }

  /** BM25-lite query. Returns top-K records by keyword overlap score. */
  query(queryText: string, topK = 1): Array<{ record: SubstrateRecord; score: number }> {
    if (!this.loaded || this.records.length === 0) return [];

    const queryKeywords = this._extractKeywords(queryText);
    if (queryKeywords.length === 0) return [];

    const scores = new Map<number, number>();

    for (const kw of queryKeywords) {
      const postings = this.indexedKeywords.get(kw);
      if (!postings) continue;
      const idf = Math.log(1 + this.records.length / postings.size);
      for (const idx of postings) {
        scores.set(idx, (scores.get(idx) ?? 0) + idf);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([idx, score]) => ({ record: this.records[idx], score }));
  }

  writeRecord(record: SubstrateRecord): void {
    this.addRecord(record);
    try {
      appendFileSync(this.cacheFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      console.warn('[Caithedral™] Failed to persist record:', err);
    }
  }

  get size(): number {
    return this.records.length;
  }
}

// ─── Three-Mode Query Router ──────────────────────────────────────────────────

export class CaithedralRouter {
  private index: CaithedralLocalIndex;
  private currentMode: FrameMode = 'normal';
  private forcedMode: FrameMode | null = null;
  private ollamaBase: string;

  constructor(index: CaithedralLocalIndex, ollamaBase = 'http://localhost:11434') {
    this.index = index;
    this.ollamaBase = ollamaBase;
  }

  setMode(mode: FrameMode): void {
    this.currentMode = mode;
  }

  setForcedMode(mode: FrameMode | null): void {
    this.forcedMode = mode;
    if (mode !== null) this.currentMode = mode;
  }

  getForcedMode(): FrameMode | null {
    return this.forcedMode;
  }

  getEffectiveMode(): FrameMode {
    return this.forcedMode ?? this.currentMode;
  }

  async query(
    queryText: string,
    ollamaModel?: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const t0 = Date.now();
    const mode = options.degraded ? 'fallback' : this.getEffectiveMode();

    // Step 1: Caithedral™ local substrate lookup (all modes) — zero LLM inference
    const hits = this.index.query(queryText, 1);
    const CONFIDENCE_THRESHOLD = 2.0;

    if (hits.length > 0 && hits[0].score >= CONFIDENCE_THRESHOLD) {
      return {
        hit: true,
        record: hits[0].record,
        score: hits[0].score,
        routing: 'substrate_hit',
        latency_ms: Date.now() - t0,
        cloud_cost_avoided_usd: CLOUD_COST_PER_TOKEN_USD * TYPICAL_RESPONSE_TOKENS,
      };
    }

    // Step 2a: Normal / Fallback — return miss (no escalation)
    if (mode === 'normal' || mode === 'fallback') {
      return {
        hit: false,
        routing: mode === 'fallback' ? 'peer_sync' : 'miss',
        latency_ms: Date.now() - t0,
        cloud_cost_avoided_usd: 0,
      };
    }

    // Step 2b: AI Burst — try local Ollama
    const ollamaResult = await this._tryOllama(queryText, ollamaModel);
    if (ollamaResult) {
      const newRecord: SubstrateRecord = {
        id: createHash('md5').update(queryText).digest('hex').slice(0, 12),
        text: `${queryText} — ${ollamaResult.slice(0, 300)}`,
        source: 'local_ollama',
        keywords: [],
        ts: new Date().toISOString(),
      };
      this.index.writeRecord(newRecord);

      return {
        hit: true,
        record: newRecord,
        routing: 'local_ollama',
        latency_ms: Date.now() - t0,
        cloud_cost_avoided_usd: CLOUD_COST_PER_TOKEN_USD * TYPICAL_RESPONSE_TOKENS,
      };
    }

    // Step 3: AI Burst — cloud escalation
    return {
      hit: false,
      routing: 'cloud_escalation',
      latency_ms: Date.now() - t0,
      cloud_cost_avoided_usd: 0,
    };
  }

  private async _tryOllama(
    query: string,
    model = 'llama3.1:8b-instruct-q4_K_M',
  ): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${this.ollamaBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: query,
          stream: false,
          options: { num_predict: 200 },
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) return null;
      const data = await res.json() as { response?: string };
      return data.response?.trim() ?? null;
    } catch {
      return null;
    }
  }
}
