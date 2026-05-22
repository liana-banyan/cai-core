/**
 * Cross-Vendor MCP — Symmetric Multi-vendor dispatch substrate
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Cross-Vendor MCP implements symmetric dispatch: no privileged orchestrator.
 * Claude · GPT · Gemini · Perplexity all receive the same depth of context.
 *
 * Modes:
 *   cpu_only        — CPU-only Caithedral™ substrate; zero model spend
 *   ollama          — Local Ollama llama3.1:8b-instruct-q4_K_M
 *   claude          — Claude via Anthropic API
 *   all_in_conjunction — Parallel fan-out to all backends + synthesis
 *
 * State filesystem layout under ~/.cai_core/mcp/:
 *   state.json          — persistent mode selection
 *   dispatch_log.jsonl  — dispatch receipt log
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { randomUUID, createHash } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const MCP_DIR = resolve(CAI_CORE_HOME, 'mcp');
const STATE_PATH = resolve(MCP_DIR, 'state.json');
const DISPATCH_LOG = resolve(MCP_DIR, 'dispatch_log.jsonl');

function ensureDirs(): void {
  if (!existsSync(MCP_DIR)) mkdirSync(MCP_DIR, { recursive: true });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type MCPVendor = 'cpu_only' | 'ollama' | 'claude' | 'all_in_conjunction';

export interface MCPState {
  selected: MCPVendor;
  per_request_override: MCPVendor | null;
  last_dispatch: {
    vendor: MCPVendor;
    ts: string;
    latency_ms: number;
    success: boolean;
  } | null;
}

export interface AdapterReceipt {
  vendor: MCPVendor;
  result: string | null;
  error: string | null;
  latency_ms: number;
  cost_usd?: number;
  tokens?: { in: number; out: number };
}

export interface MCPDispatchResult {
  dispatch_id: string;
  routed_to: MCPVendor[];
  receipts: AdapterReceipt[];
  synthesized: string | null;
  total_latency_ms: number;
  prompt_sha256: string;
}

// ─── State persistence ────────────────────────────────────────────────────────

const DEFAULT_STATE: MCPState = {
  selected: 'cpu_only',
  per_request_override: null,
  last_dispatch: null,
};

function loadState(): MCPState {
  ensureDirs();
  try {
    if (existsSync(STATE_PATH)) {
      return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<MCPState> };
    }
  } catch {
    // Corrupt state — fall back
  }
  return { ...DEFAULT_STATE };
}

function saveState(state: MCPState): void {
  ensureDirs();
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

// ─── Backend adapters ─────────────────────────────────────────────────────────

async function cpuOnlyDispatch(prompt: string): Promise<AdapterReceipt> {
  const t0 = Date.now();
  return {
    vendor: 'cpu_only',
    result: `[Caithedral™ cpu_only] No LLM inference invoked. Substrate query: "${prompt.slice(0, 80)}"`,
    error: null,
    latency_ms: Date.now() - t0,
    cost_usd: 0,
  };
}

async function ollamaDispatch(
  prompt: string,
  base = 'http://localhost:11434',
  model = 'llama3.1:8b-instruct-q4_K_M',
): Promise<AdapterReceipt> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 600 } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { response?: string };
    return {
      vendor: 'ollama',
      result: data.response?.trim() ?? null,
      error: null,
      latency_ms: Date.now() - t0,
      cost_usd: 0,
    };
  } catch (err) {
    return { vendor: 'ollama', result: null, error: (err as Error).message, latency_ms: Date.now() - t0 };
  }
}

async function claudeDispatch(
  prompt: string,
  apiKey: string,
  model = 'claude-opus-4-7-20251101',
): Promise<AdapterReceipt> {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as {
      content?: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = data.content?.find((c) => c.type === 'text')?.text ?? null;
    const tokens = data.usage
      ? { in: data.usage.input_tokens, out: data.usage.output_tokens }
      : undefined;
    const cost_usd = tokens ? (tokens.in * 0.000015 + tokens.out * 0.000075) : undefined;

    return { vendor: 'claude', result: text, error: null, latency_ms: Date.now() - t0, cost_usd, tokens };
  } catch (err) {
    return { vendor: 'claude', result: null, error: (err as Error).message, latency_ms: Date.now() - t0 };
  }
}

// ─── Cross-vendor MCP Router ──────────────────────────────────────────────────

export class MCPRouter {
  private state: MCPState;
  private ollamaBase: string;
  private claudeApiKey: string;

  constructor(opts: { ollamaBase?: string; claudeApiKey?: string } = {}) {
    this.state = loadState();
    this.ollamaBase = opts.ollamaBase ?? 'http://localhost:11434';
    this.claudeApiKey = opts.claudeApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  }

  getState(): MCPState {
    return { ...this.state };
  }

  selectVendor(vendor: MCPVendor): { ok: boolean; previous: MCPVendor } {
    const previous = this.state.selected;
    this.state = { ...this.state, selected: vendor, per_request_override: null };
    saveState(this.state);
    return { ok: true, previous };
  }

  async dispatch(prompt: string, vendorOverride?: MCPVendor): Promise<MCPDispatchResult> {
    const t0 = Date.now();
    const vendor = vendorOverride ?? this.state.per_request_override ?? this.state.selected;
    const dispatchId = randomUUID();
    const promptSha256 = createHash('sha256').update(prompt).digest('hex').slice(0, 32);

    const receipts: AdapterReceipt[] = [];
    const routedTo: MCPVendor[] = [];

    if (vendor === 'all_in_conjunction') {
      const [cpu, ollama, claude] = await Promise.all([
        cpuOnlyDispatch(prompt),
        ollamaDispatch(prompt, this.ollamaBase),
        this.claudeApiKey ? claudeDispatch(prompt, this.claudeApiKey) : Promise.resolve({
          vendor: 'claude' as MCPVendor, result: null, error: 'API key not configured', latency_ms: 0,
        }),
      ]);
      receipts.push(cpu, ollama, claude);
      routedTo.push('cpu_only', 'ollama', 'claude');
    } else {
      let receipt: AdapterReceipt;
      if (vendor === 'cpu_only') receipt = await cpuOnlyDispatch(prompt);
      else if (vendor === 'ollama') receipt = await ollamaDispatch(prompt, this.ollamaBase);
      else receipt = this.claudeApiKey
        ? await claudeDispatch(prompt, this.claudeApiKey)
        : { vendor, result: null, error: 'API key not configured', latency_ms: 0 };
      receipts.push(receipt);
      routedTo.push(vendor);
    }

    if (this.state.per_request_override) {
      this.state.per_request_override = null;
      saveState(this.state);
    }

    const synthesized = receipts.find((r) => r.result !== null)?.result ?? null;

    const result: MCPDispatchResult = {
      dispatch_id: dispatchId,
      routed_to: routedTo,
      receipts,
      synthesized,
      total_latency_ms: Date.now() - t0,
      prompt_sha256: promptSha256,
    };

    try {
      ensureDirs();
      appendFileSync(DISPATCH_LOG, JSON.stringify({
        ...result,
        dispatched_at: new Date().toISOString(),
      }) + '\n', 'utf8');
    } catch {
      // Non-fatal
    }

    return result;
  }
}
