/**
 * AutoBaton CVT — Continuously-variable-transmission orchestration primitive
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * AutoBaton implements Wave / Drekaskip / NOVACULA orchestration:
 * parallel SEG fan-out + synthesis receipt (HMAC-bound Eblet™).
 *
 * Named after the conductor's baton — AutoBaton automates orchestration
 * so no single vendor acts as privileged conductor.
 *
 * Substrate filesystem layout under ~/.cai_core/autobaton/:
 *   wave_queue/    — queued wave requests
 *   wave_active/   — in-flight waves + per-SEG progress
 *   wave_archive/  — completed waves + synthesis Eblet™ + HMAC
 */

import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  appendFileSync,
} from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { randomUUID, createHmac, createHash } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const AUTOBATON_ROOT = resolve(CAI_CORE_HOME, 'autobaton');
const WAVE_QUEUE_DIR   = resolve(AUTOBATON_ROOT, 'wave_queue');
const WAVE_ACTIVE_DIR  = resolve(AUTOBATON_ROOT, 'wave_active');
const WAVE_ARCHIVE_DIR = resolve(AUTOBATON_ROOT, 'wave_archive');

const SUBSTRATE_API_BASE = `http://127.0.0.1:${process.env.CAI_API_PORT ?? '11480'}`;
const WAVE_HMAC_KEY = process.env.CAI_WAVE_HMAC_KEY ?? 'cai-wave-hmac-default-key';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SegRecipient = 'claude' | 'ollama' | 'gemini' | 'perplexity' | 'cpu_only';
export type WaveStatus   = 'queued' | 'running' | 'synthesizing' | 'complete' | 'aborted';
export type SegStatus    = 'pending' | 'dispatched' | 'done' | 'error';
export type WaveMode     = 'standard' | 'drekaskip' | 'novacula';

export interface SegConfig {
  seg_id?: string;
  recipient: SegRecipient;
  prompt: string;
  context_msgs?: Array<{ role: string; content: string }>;
}

export interface WaveRequest {
  wave_id?: string;
  mode?: WaveMode;
  segs: SegConfig[];
  synthesizer_recipient?: SegRecipient;
  synthesizer_prompt_template?: string;
  hmac_key?: string;
}

export interface SegProgress {
  seg_id: string;
  recipient: SegRecipient;
  status: SegStatus;
  started_at?: string;
  completed_at?: string;
  result_excerpt?: string;
  error?: string;
  tokens_used?: number;
}

export interface WaveRecord {
  wave_id: string;
  mode: WaveMode;
  status: WaveStatus;
  segs: SegProgress[];
  created_at: string;
  started_at?: string;
  completed_at?: string;
  synthesis_result?: string;
  synthesis_receipt_sha256?: string;
  synthesis_receipt_hmac?: string;
  aborted_reason?: string;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function ensureLayout(): void {
  for (const d of [WAVE_QUEUE_DIR, WAVE_ACTIVE_DIR, WAVE_ARCHIVE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function wavePath(dir: string, waveId: string): string {
  return resolve(dir, `${waveId}.wave.json`);
}

function loadWave(waveId: string): WaveRecord | null {
  for (const dir of [WAVE_ACTIVE_DIR, WAVE_ARCHIVE_DIR, WAVE_QUEUE_DIR]) {
    const p = wavePath(dir, waveId);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as WaveRecord;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function saveWave(wave: WaveRecord, dir = WAVE_ACTIVE_DIR): void {
  ensureLayout();
  writeFileSync(wavePath(dir, wave.wave_id), JSON.stringify(wave, null, 2), 'utf8');
}

function moveToArchive(wave: WaveRecord): void {
  const activePath = wavePath(WAVE_ACTIVE_DIR, wave.wave_id);
  saveWave(wave, WAVE_ARCHIVE_DIR);
  if (existsSync(activePath)) {
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(activePath);
    } catch {
      // Non-fatal
    }
  }
}

// ─── HMAC receipt signing ─────────────────────────────────────────────────────

function signReceipt(payload: string, key = WAVE_HMAC_KEY): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

// ─── In-flight wave map ───────────────────────────────────────────────────────

const _inFlight = new Map<string, WaveRecord>();

// ─── AutoBaton Wave Generator ─────────────────────────────────────────────────

export class AutoBatonCVT {
  constructor() {
    this.restoreState();
  }

  /** Scan wave_active/ on startup; mark any mid-flight waves as aborted. */
  private restoreState(): void {
    ensureLayout();
    try {
      const files = readdirSync(WAVE_ACTIVE_DIR).filter((f) => f.endsWith('.wave.json'));
      for (const file of files) {
        try {
          const wave = JSON.parse(
            readFileSync(resolve(WAVE_ACTIVE_DIR, file), 'utf8'),
          ) as WaveRecord;
          if (wave.status === 'running' || wave.status === 'synthesizing') {
            wave.status = 'aborted';
            wave.aborted_reason = 'crash-restart: mid-flight wave detected at init';
            wave.completed_at = new Date().toISOString();
            moveToArchive(wave);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir scan failed */ }
  }

  /** Dispatch a new wave. Returns the wave_id immediately; SEGs run async. */
  async dispatch(request: WaveRequest): Promise<WaveRecord> {
    ensureLayout();

    const waveId = request.wave_id ?? randomUUID();
    const now = new Date().toISOString();

    const segs: SegProgress[] = request.segs.map((seg, i) => ({
      seg_id: seg.seg_id ?? `seg_${String(i + 1).padStart(2, '0')}`,
      recipient: seg.recipient,
      status: 'pending',
    }));

    const wave: WaveRecord = {
      wave_id: waveId,
      mode: request.mode ?? 'standard',
      status: 'queued',
      segs,
      created_at: now,
    };

    saveWave(wave, WAVE_QUEUE_DIR);
    _inFlight.set(waveId, wave);

    // Run async (non-blocking)
    this._runWave(wave, request).catch((err) => {
      console.error(`[AutoBaton] Wave ${waveId} fatal error:`, err);
    });

    return wave;
  }

  private async _runWave(wave: WaveRecord, request: WaveRequest): Promise<void> {
    wave.status = 'running';
    wave.started_at = new Date().toISOString();
    saveWave(wave);

    // Parallel fan-out to all SEGs
    await Promise.all(
      request.segs.map(async (seg, i) => {
        const segProg = wave.segs[i];
        segProg.status = 'dispatched';
        segProg.started_at = new Date().toISOString();

        try {
          const result = await this._dispatchSeg(seg);
          segProg.status = 'done';
          segProg.completed_at = new Date().toISOString();
          segProg.result_excerpt = result.slice(0, 200);
        } catch (err) {
          segProg.status = 'error';
          segProg.completed_at = new Date().toISOString();
          segProg.error = (err as Error).message;
        }

        saveWave(wave);
      }),
    );

    wave.status = 'synthesizing';
    saveWave(wave);

    const receipts = wave.segs
      .filter((s) => s.status === 'done')
      .map((s) => `[${s.recipient}] ${s.result_excerpt ?? ''}`)
      .join('\n\n');

    const synthesisResult = receipts || '[no successful SEG results]';
    const receiptPayload = JSON.stringify({ wave_id: wave.wave_id, segs: wave.segs, synthesis: synthesisResult });
    const receiptSha256 = createHash('sha256').update(receiptPayload).digest('hex');
    const receiptHmac = signReceipt(receiptPayload, request.hmac_key ?? WAVE_HMAC_KEY);

    wave.status = 'complete';
    wave.completed_at = new Date().toISOString();
    wave.synthesis_result = synthesisResult;
    wave.synthesis_receipt_sha256 = receiptSha256;
    wave.synthesis_receipt_hmac = receiptHmac;

    moveToArchive(wave);
    _inFlight.delete(wave.wave_id);
  }

  private async _dispatchSeg(seg: SegConfig): Promise<string> {
    const base = SUBSTRATE_API_BASE;
    const payload = {
      recipient: seg.recipient,
      prompt: seg.prompt,
      context_msgs: seg.context_msgs ?? [],
    };

    const res = await fetch(`${base}/yoke/wave/seg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`SEG dispatch HTTP ${res.status}`);
    }

    const data = await res.json() as { result?: string };
    return data.result ?? '[empty result]';
  }

  getWave(waveId: string): WaveRecord | null {
    return _inFlight.get(waveId) ?? loadWave(waveId);
  }

  abort(waveId: string): { ok: boolean; reason?: string } {
    const wave = _inFlight.get(waveId) ?? loadWave(waveId);
    if (!wave) return { ok: false, reason: 'wave not found' };
    if (wave.status === 'complete' || wave.status === 'aborted') {
      return { ok: false, reason: `wave already ${wave.status}` };
    }
    wave.status = 'aborted';
    wave.aborted_reason = 'manual abort';
    wave.completed_at = new Date().toISOString();
    moveToArchive(wave);
    _inFlight.delete(waveId);
    return { ok: true };
  }

  getSummary(): { total: number; complete: number; aborted: number; in_flight: number } {
    const inFlight = _inFlight.size;
    let complete = 0;
    let aborted = 0;
    try {
      const files = readdirSync(WAVE_ARCHIVE_DIR).filter((f) => f.endsWith('.wave.json'));
      for (const file of files) {
        try {
          const wave = JSON.parse(readFileSync(resolve(WAVE_ARCHIVE_DIR, file), 'utf8')) as WaveRecord;
          if (wave.status === 'complete') complete++;
          else if (wave.status === 'aborted') aborted++;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return { total: complete + aborted + inFlight, complete, aborted, in_flight: inFlight };
  }
}

// ─── NOVACULA planning layer ──────────────────────────────────────────────────

export interface NOVACULAWave {
  wave_name: string;
  segs: SegConfig[];
  wave_mode: WaveMode;
  rationale: string;
}

export interface NOVACULAPlan {
  plan_id: string;
  waves: NOVACULAWave[];
  total_segs: number;
  created_at: string;
}

export function planNOVACULA(description: string, segs: SegConfig[]): NOVACULAPlan {
  const SEGS_PER_WAVE = 8;
  const waves: NOVACULAWave[] = [];

  for (let i = 0; i < segs.length; i += SEGS_PER_WAVE) {
    const batch = segs.slice(i, i + SEGS_PER_WAVE);
    waves.push({
      wave_name: `W${Math.floor(i / SEGS_PER_WAVE)}`,
      segs: batch,
      wave_mode: 'novacula',
      rationale: `${description} · batch ${Math.floor(i / SEGS_PER_WAVE) + 1}`,
    });
  }

  return {
    plan_id: randomUUID(),
    waves,
    total_segs: segs.length,
    created_at: new Date().toISOString(),
  };
}
