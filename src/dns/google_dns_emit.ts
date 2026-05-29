/**
 * google_dns_emit.ts — Soccerball SIDs as Google Cloud DNS TXT records
 * caithedral-core BP063 · POCKET-6 SOCCERBALL-OVER-DNS · PATH C
 *
 * lianabanyan.com is authoritative on Google Cloud DNS (ns-cloud-a*.googledomains.com).
 * cloudflare_emit.ts is tombstoned — Cloudflare is NOT in the DNS path.
 * doh_resolve.ts is unchanged — DoH is provider-agnostic (kept as-is).
 *
 * Auth priority (zero Founder action if SA already has dns.admin):
 *   1. GOOGLE_APPLICATION_CREDENTIALS → SA JSON → JWT → access token
 *   2. `gcloud auth print-access-token` (interactive / dev fallback)
 *
 * Config env vars:
 *   GCP_PROJECT_ID        — GCP project (default: lianabanyan-403dc)
 *   GCP_DNS_MANAGED_ZONE  — managed-zone name (default: auto-discovered by dnsName)
 *
 * ⚠  FOUNDER ACTION FLAG — firebase-adminsdk-fbsvc SA lacks roles/dns.admin.
 *    Minimal one-time grant (if reusing firebase SA):
 *      gcloud projects add-iam-policy-binding lianabanyan-403dc \
 *        --member="serviceAccount:firebase-adminsdk-fbsvc@lianabanyan-403dc.iam.gserviceaccount.com" \
 *        --role="roles/dns.admin"
 *    Alternatively: point GOOGLE_APPLICATION_CREDENTIALS at a SA key that already has dns.admin.
 *    No new SA, no new API key — just one IAM binding.
 *
 * Canon: canon_dns_as_pocket_universe_resolver_re_use_existing_infrastructure_bp060
 */

import * as https from "https";
import * as crypto from "crypto";
import * as fs from "fs";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types (interface mirrors cloudflare_emit.ts for drop-in swap)
// ---------------------------------------------------------------------------

export interface GcpEmitResult {
  ok: boolean;
  record_id: string;    // "${fqdn.}|TXT" — parsed by delete
  name: string;         // FQDN without trailing dot
  content: string;      // soccerball SID
  managed_zone: string;
  created_on?: string;
  error?: string;
}

export interface GcpDeleteResult {
  ok: boolean;
  record_id: string;
  error?: string;
}

export interface GcpListResult {
  records: Array<{
    id: string;       // "${fqdn.}|TXT"
    name: string;
    content: string;
    ttl: number;
    modified_on?: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

interface GcpRrset {
  name: string;
  type: string;
  ttl: number;
  rrdatas: string[];
}

// ---------------------------------------------------------------------------
// HTTP helper (native https — no extra deps)
// ---------------------------------------------------------------------------

function httpsRaw(
  method: string,
  reqUrl: string,
  body: string | null,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
    };
    const opts: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Auth — service-account JWT → access token
// ---------------------------------------------------------------------------

function loadServiceAccountKey(): ServiceAccountKey | null {
  const credPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (!credPath) return null;
  try {
    const raw = fs.readFileSync(credPath, "utf8");
    return JSON.parse(raw) as ServiceAccountKey;
  } catch {
    return null;
  }
}

function base64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function tokenFromSA(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/ndev.clouddns.readwrite",
    aud: key.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const sigInput = `${header}.${claim}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const sig = base64url(sign.sign(key.private_key));
  const jwt = `${sigInput}.${sig}`;

  const formBody =
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" +
    `&assertion=${encodeURIComponent(jwt)}`;

  const raw = await httpsRaw(
    "POST",
    key.token_uri ?? "https://oauth2.googleapis.com/token",
    formBody,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  const resp = JSON.parse(raw) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!resp.access_token) {
    throw new Error(
      `SA token exchange failed: ${resp.error ?? "unknown"} — ${resp.error_description ?? ""}`
    );
  }
  return resp.access_token;
}

function tokenFromGcloud(): string | null {
  try {
    const out = execSync("gcloud auth print-access-token 2>&1", { timeout: 8000 })
      .toString()
      .trim();
    // access tokens start with ya29. (short-lived); JWTs start with eyJ (for impersonation)
    if (out.startsWith("ya29.") || out.startsWith("eyJ")) return out;
    return null;
  } catch {
    return null;
  }
}

// Token cache: avoid hammering the token endpoint within one process lifetime
let _tokenCache: { token: string; expiry: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && now < _tokenCache.expiry) return _tokenCache.token;

  // Path 1 — service-account key from GOOGLE_APPLICATION_CREDENTIALS
  const key = loadServiceAccountKey();
  if (key) {
    const token = await tokenFromSA(key);
    _tokenCache = { token, expiry: now + 55 * 60 * 1000 }; // 55-min cache (1-hr SA expiry)
    return token;
  }

  // Path 2 — gcloud CLI fallback (interactive / dev environment)
  const gcloudToken = tokenFromGcloud();
  if (gcloudToken) {
    _tokenCache = { token: gcloudToken, expiry: now + 50 * 60 * 1000 };
    return gcloudToken;
  }

  throw new Error(
    "GCP auth: no credentials found.\n" +
    "  Option A (production): set GOOGLE_APPLICATION_CREDENTIALS to a SA JSON with roles/dns.admin\n" +
    "  Option B (dev): run `gcloud auth application-default login` and ensure the active account has dns.admin\n" +
    "  IAM grant: gcloud projects add-iam-policy-binding lianabanyan-403dc \\\n" +
    "    --member=serviceAccount:firebase-adminsdk-fbsvc@lianabanyan-403dc.iam.gserviceaccount.com \\\n" +
    "    --role=roles/dns.admin"
  );
}

// ---------------------------------------------------------------------------
// Managed-zone discovery
// ---------------------------------------------------------------------------

let _zoneCache: string | null = null;

async function getManagedZone(
  project: string,
  dnsName: string,
  token: string
): Promise<string> {
  if (_zoneCache) return _zoneCache;

  // Explicit env override
  const envZone = process.env["GCP_DNS_MANAGED_ZONE"];
  if (envZone) {
    _zoneCache = envZone;
    return _zoneCache;
  }

  // Auto-discover: list managed zones, match by dnsName (Cloud DNS appends trailing dot)
  const url =
    `https://dns.googleapis.com/dns/v1/projects/${project}/managedZones` +
    `?dnsName=${encodeURIComponent(dnsName + ".")}`;

  const raw = await httpsRaw("GET", url, null, { Authorization: `Bearer ${token}` });
  const resp = JSON.parse(raw) as {
    managedZones?: Array<{ name: string; dnsName: string }>;
    error?: { message: string; code: number };
  };

  if (resp.error) {
    throw new Error(`getManagedZone: ${resp.error.code} ${resp.error.message}`);
  }

  const zones = resp.managedZones ?? [];
  if (zones.length === 0) {
    throw new Error(
      `No managed zone for "${dnsName}" in project "${project}". ` +
      `Set GCP_DNS_MANAGED_ZONE to the zone name.`
    );
  }

  _zoneCache = zones[0].name;
  return _zoneCache;
}

// ---------------------------------------------------------------------------
// Rrset helpers (Cloud DNS v1 REST)
// ---------------------------------------------------------------------------

async function getRrset(
  project: string,
  managedZone: string,
  fqdnDot: string,
  token: string
): Promise<GcpRrset | null> {
  const url =
    `https://dns.googleapis.com/dns/v1/projects/${project}` +
    `/managedZones/${managedZone}/rrsets` +
    `?name=${encodeURIComponent(fqdnDot)}&type=TXT`;

  const raw = await httpsRaw("GET", url, null, { Authorization: `Bearer ${token}` });
  const resp = JSON.parse(raw) as {
    rrsets?: GcpRrset[];
    error?: { message: string; code: number };
  };

  if (resp.error && resp.error.code !== 404) {
    throw new Error(`getRrset: ${resp.error.code} ${resp.error.message}`);
  }

  const sets = resp.rrsets ?? [];
  return sets.find((r) => r.name === fqdnDot && r.type === "TXT") ?? null;
}

async function submitChange(
  project: string,
  managedZone: string,
  additions: GcpRrset[],
  deletions: GcpRrset[],
  token: string
): Promise<{ id: string; status: string; error?: string }> {
  const url =
    `https://dns.googleapis.com/dns/v1/projects/${project}` +
    `/managedZones/${managedZone}/changes`;

  const body = JSON.stringify({ additions, deletions });
  const raw = await httpsRaw("POST", url, body, { Authorization: `Bearer ${token}` });
  const resp = JSON.parse(raw) as {
    id?: string;
    status?: string;
    error?: { message: string; code: number };
  };

  if (resp.error) {
    return {
      id: "",
      status: "error",
      error: `${resp.error.code} ${resp.error.message}`,
    };
  }

  return { id: resp.id ?? "", status: resp.status ?? "unknown" };
}

// ---------------------------------------------------------------------------
// GCP project default (env-overridable)
// ---------------------------------------------------------------------------

function gcpProject(): string {
  return process.env["GCP_PROJECT_ID"] ?? "lianabanyan-403dc";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * gcp_emit_soccerball — write a soccerball SID as a TXT record in Google Cloud DNS.
 *
 * Cloud DNS replaces rrsets atomically (delete old + add new in one change).
 * TTL minimum is 0 in Cloud DNS (vs. 1 in Cloudflare).
 *
 * @param sid        32-char soccerball_id (content-addressed)
 * @param subdomain  e.g. "s" → s.lianabanyan.com, "0.s" → 0.s.lianabanyan.com
 * @param zone       zone root (default "lianabanyan.com")
 * @param ttl        TTL in seconds (default 60)
 */
export async function gcp_emit_soccerball(
  sid: string,
  subdomain: string = "s",
  zone: string = "lianabanyan.com",
  ttl: number = 60
): Promise<GcpEmitResult> {
  const fqdn = `${subdomain}.${zone}`;
  const fqdnDot = `${fqdn}.`;
  const project = gcpProject();

  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    return { ok: false, record_id: "", name: fqdn, content: sid, managed_zone: "", error: String(e) };
  }

  let managedZone: string;
  try {
    managedZone = await getManagedZone(project, zone, token);
  } catch (e) {
    return { ok: false, record_id: "", name: fqdn, content: sid, managed_zone: "", error: String(e) };
  }

  // Fetch existing rrset — Cloud DNS does atomic replace, not append
  let existing: GcpRrset | null = null;
  try {
    existing = await getRrset(project, managedZone, fqdnDot, token);
  } catch (e) {
    return { ok: false, record_id: "", name: fqdn, content: sid, managed_zone: managedZone, error: String(e) };
  }

  // Cloud DNS TXT rrdatas must be double-quoted strings
  const newRrset: GcpRrset = {
    name: fqdnDot,
    type: "TXT",
    ttl,
    rrdatas: [`"${sid}"`],
  };

  const result = await submitChange(
    project,
    managedZone,
    [newRrset],
    existing ? [existing] : [],
    token
  );

  if (result.error) {
    return { ok: false, record_id: "", name: fqdn, content: sid, managed_zone: managedZone, error: result.error };
  }

  return {
    ok: true,
    record_id: `${fqdnDot}|TXT`,
    name: fqdn,
    content: sid,
    managed_zone: managedZone,
    created_on: new Date().toISOString(),
  };
}

/**
 * gcp_list_soccerball_records — list TXT rrset at `{subdomain}.{zone}`.
 * Returns only entries that match the 32-char soccerball SID format.
 */
export async function gcp_list_soccerball_records(
  subdomain: string = "s",
  zone: string = "lianabanyan.com"
): Promise<GcpListResult> {
  const fqdn = `${subdomain}.${zone}`;
  const fqdnDot = `${fqdn}.`;
  const project = gcpProject();

  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    return { records: [], error: String(e) };
  }

  let managedZone: string;
  try {
    managedZone = await getManagedZone(project, zone, token);
  } catch (e) {
    return { records: [], error: String(e) };
  }

  let rrset: GcpRrset | null = null;
  try {
    rrset = await getRrset(project, managedZone, fqdnDot, token);
  } catch (e) {
    return { records: [], error: String(e) };
  }

  if (!rrset) return { records: [] };

  const sidPattern = /^[0-9a-f]{32}$/i;
  const records = rrset.rrdatas
    .map((r) => {
      const content = r.replace(/^"|"$/g, ""); // strip GCP double-quoting
      return {
        id: `${fqdnDot}|TXT`,
        name: fqdn,
        content,
        ttl: rrset!.ttl,
      };
    })
    .filter((r) => sidPattern.test(r.content));

  return { records };
}

/**
 * gcp_delete_soccerball_record — delete a TXT rrset by record_id.
 * record_id format: "${fqdn.}|TXT" (as returned by gcp_emit_soccerball / gcp_list_soccerball_records).
 * Idempotent: returns ok=true if the record is already gone.
 */
export async function gcp_delete_soccerball_record(
  record_id: string,
  zone: string = "lianabanyan.com"
): Promise<GcpDeleteResult> {
  const parts = record_id.split("|");
  const fqdnDot = parts[0];
  if (!fqdnDot || parts[1] !== "TXT") {
    return {
      ok: false,
      record_id,
      error: `Invalid record_id "${record_id}" — expected format: "{fqdn.}|TXT"`,
    };
  }

  const project = gcpProject();

  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    return { ok: false, record_id, error: String(e) };
  }

  let managedZone: string;
  try {
    managedZone = await getManagedZone(project, zone, token);
  } catch (e) {
    return { ok: false, record_id, error: String(e) };
  }

  let existing: GcpRrset | null = null;
  try {
    existing = await getRrset(project, managedZone, fqdnDot, token);
  } catch (e) {
    return { ok: false, record_id, error: String(e) };
  }

  if (!existing) return { ok: true, record_id }; // already absent — idempotent

  const result = await submitChange(project, managedZone, [], [existing], token);
  if (result.error) return { ok: false, record_id, error: result.error };
  return { ok: true, record_id };
}
