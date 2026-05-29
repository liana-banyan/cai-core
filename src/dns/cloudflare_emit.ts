/**
 * cloudflare_emit.ts — Soccerball SIDs as Cloudflare TXT records
 * caithedral-core BP063 · POCKET-6 SOCCERBALL-OVER-DNS
 *
 * Emits and manages soccerball SID TXT records on s.lianabanyan.com (and
 * face-path subdomains like 0.s.lianabanyan.com) using the Cloudflare v4 API.
 *
 * Least-privilege: Zone:Edit on lianabanyan.com only.
 * Token: CLOUDFLARE_API_TOKEN env var (never echoed).
 * Canon: canon_dns_as_pocket_universe_resolver_re_use_existing_infrastructure_bp060
 */

import * as https from "https";
import * as url from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CfEmitResult {
  ok: boolean;
  record_id: string;
  name: string;
  content: string;        // soccerball SID
  zone_id: string;
  created_on?: string;
  error?: string;
}

export interface CfDeleteResult {
  ok: boolean;
  record_id: string;
  error?: string;
}

export interface CfListResult {
  records: Array<{
    id: string;
    name: string;
    content: string;
    ttl: number;
    modified_on?: string;
  }>;
  error?: string;
}

interface CfApiBody {
  success: boolean;
  result: unknown;
  errors: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers (native https — no extra deps)
// ---------------------------------------------------------------------------

function cfGet(path: string, token: string): Promise<CfApiBody> {
  return cfRequest("GET", path, null, token);
}

function cfPost(path: string, body: unknown, token: string): Promise<CfApiBody> {
  return cfRequest("POST", path, body, token);
}

function cfDelete(path: string, token: string): Promise<CfApiBody> {
  return cfRequest("DELETE", path, null, token);
}

function cfRequest(
  method: string,
  path: string,
  body: unknown,
  token: string
): Promise<CfApiBody> {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const opts: https.RequestOptions = {
      hostname: "api.cloudflare.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr).toString() } : {}),
      },
    };

    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(JSON.parse(raw) as CfApiBody);
        } catch (e) {
          reject(new Error(`CF API parse error: ${String(e)}`));
        }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Zone lookup (cached per process)
// ---------------------------------------------------------------------------

let _cachedZoneId: string | null = null;

export async function cf_zone_id(
  zoneName: string,
  token: string
): Promise<string> {
  if (_cachedZoneId) return _cachedZoneId;

  // Attempt 1: list by name (requires Zone:Read at account level)
  const encoded = encodeURIComponent(zoneName);
  const data = await cfGet(`/client/v4/zones?name=${encoded}`, token);

  if (data.success) {
    const results = data.result as Array<{ id: string; name: string }>;
    if (results && results.length > 0) {
      _cachedZoneId = results[0].id;
      return _cachedZoneId;
    }
  }

  // Attempt 2: list all zones the scoped token can see
  // (zone-scoped tokens return only their zone)
  const all = await cfGet(`/client/v4/zones`, token);
  if (all.success) {
    const results = all.result as Array<{ id: string; name: string }>;
    if (results && results.length > 0) {
      const match = results.find((z) => z.name === zoneName);
      const zone = match ?? results[0]; // if scoped token, first result IS the zone
      _cachedZoneId = zone.id;
      return _cachedZoneId;
    }
  }

  // Attempt 3: CLOUDFLARE_ZONE_ID env var override (must be a 32-char hex zone ID)
  const envZoneId = process.env["CLOUDFLARE_ZONE_ID"];
  if (envZoneId && /^[0-9a-f]{32}$/i.test(envZoneId)) {
    _cachedZoneId = envZoneId;
    return _cachedZoneId;
  }

  // Diagnostics: surface what the API actually returned
  const attempt1Msg = data.success
    ? `attempt1: success but 0 zones`
    : `attempt1: ${(data.errors || []).map((e) => e.message).join("; ")}`;
  const attempt2Msg = all.success
    ? `attempt2: success but 0 zones`
    : `attempt2: ${(all.errors || []).map((e) => e.message).join("; ")}`;
  const attempt3Msg = envZoneId
    ? `attempt3: CLOUDFLARE_ZONE_ID="${envZoneId}" (not a 32-char hex ID — expected format: 32 hex chars)`
    : `attempt3: CLOUDFLARE_ZONE_ID not set`;

  throw new Error(
    `cf_zone_id: cannot resolve zone "${zoneName}" — ${attempt1Msg} | ${attempt2Msg} | ${attempt3Msg}. ` +
    `Fix: set CLOUDFLARE_ZONE_ID=<32-char hex zone ID> in env.`
  );
}

// ---------------------------------------------------------------------------
// Emit (create TXT record)
// ---------------------------------------------------------------------------

/**
 * cf_emit_soccerball — write a soccerball SID as a TXT record.
 *
 * @param sid        32-char soccerball_id (content-addressed)
 * @param subdomain  e.g. "s" → s.lianabanyan.com, or "0.s" → 0.s.lianabanyan.com
 * @param zone       zone root (default "lianabanyan.com")
 * @param ttl        TTL in seconds (default 60, minimum 1 for Cloudflare)
 */
export async function cf_emit_soccerball(
  sid: string,
  subdomain: string = "s",
  zone: string = "lianabanyan.com",
  ttl: number = 60
): Promise<CfEmitResult> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!token) {
    return {
      ok: false,
      record_id: "",
      name: `${subdomain}.${zone}`,
      content: sid,
      zone_id: "",
      error: "CLOUDFLARE_API_TOKEN not set — cred loading bug, not the token",
    };
  }

  const fqdn = `${subdomain}.${zone}`;
  let zone_id: string;

  try {
    zone_id = await cf_zone_id(zone, token);
  } catch (e) {
    return { ok: false, record_id: "", name: fqdn, content: sid, zone_id: "", error: String(e) };
  }

  const payload = {
    type: "TXT",
    name: fqdn,
    content: sid,
    ttl,
    comment: `soccerball-over-dns BP063 · ${new Date().toISOString()}`,
  };

  let data: CfApiBody;
  try {
    data = await cfPost(`/client/v4/zones/${zone_id}/dns_records`, payload, token);
  } catch (e) {
    return { ok: false, record_id: "", name: fqdn, content: sid, zone_id, error: String(e) };
  }

  if (!data.success) {
    const msg = (data.errors || []).map((e) => e.message).join("; ");
    return { ok: false, record_id: "", name: fqdn, content: sid, zone_id, error: msg };
  }

  const rec = data.result as { id: string; created_on?: string };
  return {
    ok: true,
    record_id: rec.id,
    name: fqdn,
    content: sid,
    zone_id,
    created_on: rec.created_on,
  };
}

// ---------------------------------------------------------------------------
// List records for a subdomain
// ---------------------------------------------------------------------------

export async function cf_list_soccerball_records(
  subdomain: string = "s",
  zone: string = "lianabanyan.com"
): Promise<CfListResult> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!token) {
    return { records: [], error: "CLOUDFLARE_API_TOKEN not set" };
  }

  const fqdn = `${subdomain}.${zone}`;
  let zone_id: string;
  try {
    zone_id = await cf_zone_id(zone, token);
  } catch (e) {
    return { records: [], error: String(e) };
  }

  const encoded = encodeURIComponent(fqdn);
  const data = await cfGet(
    `/client/v4/zones/${zone_id}/dns_records?type=TXT&name=${encoded}`,
    token
  );

  if (!data.success) {
    const msg = (data.errors || []).map((e) => e.message).join("; ");
    return { records: [], error: msg };
  }

  const recs = data.result as Array<{
    id: string;
    name: string;
    content: string;
    ttl: number;
    modified_on?: string;
  }>;

  return {
    records: recs.map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      modified_on: r.modified_on,
    })),
  };
}

// ---------------------------------------------------------------------------
// Delete a TXT record
// ---------------------------------------------------------------------------

export async function cf_delete_soccerball_record(
  record_id: string,
  zone: string = "lianabanyan.com"
): Promise<CfDeleteResult> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!token) {
    return { ok: false, record_id, error: "CLOUDFLARE_API_TOKEN not set" };
  }

  let zone_id: string;
  try {
    zone_id = await cf_zone_id(zone, token);
  } catch (e) {
    return { ok: false, record_id, error: String(e) };
  }

  let data: CfApiBody;
  try {
    data = await cfDelete(`/client/v4/zones/${zone_id}/dns_records/${record_id}`, token);
  } catch (e) {
    return { ok: false, record_id, error: String(e) };
  }

  if (!data.success) {
    const msg = (data.errors || []).map((e) => e.message).join("; ");
    return { ok: false, record_id, error: msg };
  }

  return { ok: true, record_id };
}
