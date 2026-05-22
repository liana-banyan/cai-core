/**
 * Eblet™ — Atomic Context Unit
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Eblet™ is the fundamental substrate primitive: YAML frontmatter + prose body
 * with sha256 dual-write integrity. Every canonical artifact in the CAI™
 * substrate is an Eblet™.
 *
 * Three-tier hierarchy:
 *   Stone Tablet → Iron Tablet → Gold Tablet → canonical Eblet™
 *
 * ROM-class entities: permanent · non-evictable · cross-scale-homomorphic.
 * Pheromone-eligible: strength field drives propagation weight.
 */

import { createHash, createHmac } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'fs';
import { resolve } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EbletTier = 'stone' | 'iron' | 'gold' | 'canonical';

export type PheromoneStrength = 'weak' | 'medium' | 'strong' | 'rom';

export interface EbletFrontmatter {
  id: string;
  tier: EbletTier;
  source: string;
  ts: string;
  sha256: string;
  pheromone_strength?: PheromoneStrength;
  keywords?: string[];
  embedding_hint?: string;
  tsa_stamp?: string;
  hmac_sig?: string;
}

export interface Eblet {
  frontmatter: EbletFrontmatter;
  body: string;
  raw: string;
}

export interface EbletWriteResult {
  id: string;
  sha256: string;
  tier: EbletTier;
  path_primary: string;
  path_vault?: string;
  written_at: string;
}

// ─── Sha256 helpers ───────────────────────────────────────────────────────────

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

export function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

// ─── YAML frontmatter serialization ──────────────────────────────────────────

export function serializeFrontmatter(fm: EbletFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseFrontmatter(raw: string): { frontmatter: EbletFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('Eblet™ parse error: missing YAML frontmatter delimiters');
  }
  const yamlBlock = match[1];
  const body = match[2].trim();

  const fm: Partial<EbletFrontmatter> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of yamlBlock.split('\n')) {
    const arrayItem = line.match(/^  - (.+)$/);
    if (arrayItem && currentArrayKey) {
      currentArray.push(arrayItem[1]);
      continue;
    }
    if (currentArrayKey) {
      (fm as Record<string, unknown>)[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }
    const kv = line.match(/^(\w+): (.+)$/);
    if (kv) {
      (fm as Record<string, unknown>)[kv[1]] = kv[2];
      continue;
    }
    const arrayStart = line.match(/^(\w+):$/);
    if (arrayStart) {
      currentArrayKey = arrayStart[1];
      currentArray = [];
    }
  }
  if (currentArrayKey) {
    (fm as Record<string, unknown>)[currentArrayKey] = currentArray;
  }

  return { frontmatter: fm as EbletFrontmatter, body };
}

// ─── Eblet Store ──────────────────────────────────────────────────────────────

export class EbletStore {
  private dataDir: string;
  private vaultDir?: string;
  private index: Map<string, Eblet> = new Map();
  private loaded = false;

  constructor(dataDir: string, vaultDir?: string) {
    this.dataDir = dataDir;
    this.vaultDir = vaultDir;
  }

  async load(): Promise<void> {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });

    const files = existsSync(this.dataDir)
      ? readdirSync(this.dataDir).filter((f) => f.endsWith('.eblet.md'))
      : [];

    for (const file of files) {
      try {
        const raw = readFileSync(resolve(this.dataDir, file), 'utf8');
        const parsed = parseFrontmatter(raw);
        const eblet: Eblet = { ...parsed, raw };
        this.index.set(eblet.frontmatter.id, eblet);
      } catch {
        // Malformed eblet — skip
      }
    }

    this.loaded = true;
    console.log(`[EbletStore] Loaded ${this.index.size} Eblets™ from ${this.dataDir}`);
  }

  write(
    body: string,
    meta: Omit<EbletFrontmatter, 'sha256' | 'ts'>,
    hmacSecret?: string,
  ): EbletWriteResult {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });

    const ts = new Date().toISOString();
    const sha256 = sha256Hex(body);
    const hmac_sig = hmacSecret ? hmacSign(body, hmacSecret) : undefined;

    const frontmatter: EbletFrontmatter = { ...meta, sha256, ts, hmac_sig };
    const raw = `${serializeFrontmatter(frontmatter)}\n\n${body}`;

    const filename = `${meta.id}.eblet.md`;
    const primaryPath = resolve(this.dataDir, filename);
    writeFileSync(primaryPath, raw, 'utf8');

    let vaultPath: string | undefined;
    if (this.vaultDir) {
      if (!existsSync(this.vaultDir)) mkdirSync(this.vaultDir, { recursive: true });
      vaultPath = resolve(this.vaultDir, filename);
      writeFileSync(vaultPath, raw, 'utf8');
    }

    const eblet: Eblet = { frontmatter, body, raw };
    this.index.set(meta.id, eblet);

    return {
      id: meta.id,
      sha256,
      tier: meta.tier,
      path_primary: primaryPath,
      path_vault: vaultPath,
      written_at: ts,
    };
  }

  get(id: string): Eblet | undefined {
    return this.index.get(id);
  }

  getAll(): Eblet[] {
    return Array.from(this.index.values());
  }

  getByTier(tier: EbletTier): Eblet[] {
    return this.getAll().filter((e) => e.frontmatter.tier === tier);
  }

  getByPheromoneStrength(strength: PheromoneStrength): Eblet[] {
    return this.getAll().filter((e) => e.frontmatter.pheromone_strength === strength);
  }

  verify(id: string): { valid: boolean; reason?: string } {
    const eblet = this.index.get(id);
    if (!eblet) return { valid: false, reason: 'not found' };

    const expected = sha256Hex(eblet.body);
    if (expected !== eblet.frontmatter.sha256) {
      return { valid: false, reason: `sha256 mismatch: expected ${expected} got ${eblet.frontmatter.sha256}` };
    }
    return { valid: true };
  }

  get size(): number {
    return this.index.size;
  }
}

// ─── JSONL append ledger (dual-write companion) ───────────────────────────────

export class EbletLedger {
  private ledgerPath: string;

  constructor(ledgerPath: string) {
    this.ledgerPath = ledgerPath;
    const dir = resolve(ledgerPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(result: EbletWriteResult): void {
    const row = JSON.stringify({ ...result, appended_at: new Date().toISOString() }) + '\n';
    appendFileSync(this.ledgerPath, row, 'utf8');
  }

  readAll(): EbletWriteResult[] {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as EbletWriteResult;
        } catch {
          return null;
        }
      })
      .filter((r): r is EbletWriteResult => r !== null);
  }
}
