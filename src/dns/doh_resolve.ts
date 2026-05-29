/**
 * doh_resolve.ts — DNS-over-HTTPS resolver for soccerball SID lookup
 * caithedral-core BP063 · POCKET-6 SOCCERBALL-OVER-DNS
 *
 * Any AI with plain HTTPS access can resolve LB substrate over DNS.
 * No custom resolver required — uses Cloudflare DoH (1.1.1.1/dns-query)
 * and falls back to Google DoH (8.8.8.8/resolve).
 *
 * Canon: canon_dns_as_pocket_universe_resolver_re_use_existing_infrastructure_bp060
 * — "re-purpose DNS · don't build a resolver"
 */

import * as https from "https";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DohResult {
  ok: boolean;
  name: string;
  records: string[];   // raw TXT record strings (soccerball SIDs)
  ttl: number;
  resolver_used: string;
  error?: string;
}

interface CloudflareDohResponse {
  Status: number;        // 0 = NOERROR
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: Array<{ name: string; type: number }>;
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
  Authority?: unknown;
  Comment?: string;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

function httpsGet(reqUrl: string, acceptHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const opts: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Accept: acceptHeader,
        "User-Agent": "caithedral-core/BP063 soccerball-over-dns",
      },
    };

    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cloudflare DoH (primary)
// ---------------------------------------------------------------------------

async function doh_cloudflare(fqdn: string): Promise<DohResult> {
  const reqUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(fqdn)}&type=TXT`;

  let raw: string;
  try {
    raw = await httpsGet(reqUrl, "application/dns-json");
  } catch (e) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "cloudflare-dns.com",
      error: String(e),
    };
  }

  let resp: CloudflareDohResponse;
  try {
    resp = JSON.parse(raw) as CloudflareDohResponse;
  } catch (e) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "cloudflare-dns.com",
      error: `JSON parse error: ${String(e)}`,
    };
  }

  if (resp.Status !== 0) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "cloudflare-dns.com",
      error: `DNS status ${resp.Status} (NXDOMAIN=3, SERVFAIL=2)`,
    };
  }

  const answers = (resp.Answer || []).filter((a) => a.type === 16); // TXT = type 16
  const records = answers.map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  const ttl = answers[0]?.TTL ?? 0;

  return {
    ok: records.length > 0,
    name: fqdn,
    records,
    ttl,
    resolver_used: "cloudflare-dns.com",
    ...(records.length === 0 ? { error: "NOERROR but no TXT records found" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Google DoH (fallback)
// ---------------------------------------------------------------------------

async function doh_google(fqdn: string): Promise<DohResult> {
  const reqUrl = `https://dns.google/resolve?name=${encodeURIComponent(fqdn)}&type=TXT`;

  let raw: string;
  try {
    raw = await httpsGet(reqUrl, "application/json");
  } catch (e) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "dns.google",
      error: String(e),
    };
  }

  let resp: CloudflareDohResponse;
  try {
    resp = JSON.parse(raw) as CloudflareDohResponse;
  } catch (e) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "dns.google",
      error: `JSON parse error: ${String(e)}`,
    };
  }

  if (resp.Status !== 0) {
    return {
      ok: false,
      name: fqdn,
      records: [],
      ttl: 0,
      resolver_used: "dns.google",
      error: `DNS status ${resp.Status}`,
    };
  }

  const answers = (resp.Answer || []).filter((a) => a.type === 16);
  const records = answers.map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  const ttl = answers[0]?.TTL ?? 0;

  return {
    ok: records.length > 0,
    name: fqdn,
    records,
    ttl,
    resolver_used: "dns.google",
    ...(records.length === 0 ? { error: "NOERROR but no TXT records found" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * doh_resolve_txt — resolve TXT records for an FQDN via DoH.
 * Tries Cloudflare first, falls back to Google.
 * Returns raw TXT record strings (soccerball SIDs embedded verbatim).
 */
export async function doh_resolve_txt(fqdn: string): Promise<DohResult> {
  const primary = await doh_cloudflare(fqdn);
  if (primary.ok) return primary;

  // Fallback
  const fallback = await doh_google(fqdn);
  return fallback;
}

/**
 * doh_resolve_soccerball — resolve TXT on `{subdomain}.{zone}` and
 * return only the records that look like 32-char soccerball SIDs.
 *
 * @param subdomain  e.g. "s" → s.lianabanyan.com
 * @param zone       zone root (default "lianabanyan.com")
 */
export async function doh_resolve_soccerball(
  subdomain: string = "s",
  zone: string = "lianabanyan.com"
): Promise<DohResult> {
  const fqdn = `${subdomain}.${zone}`;
  const result = await doh_resolve_txt(fqdn);

  // Filter to 32-char hex strings (soccerball SID format)
  const sidPattern = /^[0-9a-f]{32}$/i;
  const sids = result.records.filter((r) => sidPattern.test(r));

  return {
    ...result,
    records: sids,
    ...(sids.length === 0 && result.ok
      ? { ok: false, error: "TXT records found but none match 32-char soccerball SID format" }
      : {}),
  };
}

/**
 * doh_resolve_soccerball_with_retry — retry up to maxAttempts times,
 * waiting waitMs between each attempt. Useful for newly-emitted records
 * that need time to propagate.
 */
export async function doh_resolve_soccerball_with_retry(
  subdomain: string = "s",
  zone: string = "lianabanyan.com",
  maxAttempts: number = 6,
  waitMs: number = 5000
): Promise<DohResult> {
  let last: DohResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await doh_resolve_soccerball(subdomain, zone);
    if (result.ok) return result;
    last = result;

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return last ?? {
    ok: false,
    name: `${subdomain}.${zone}`,
    records: [],
    ttl: 0,
    resolver_used: "none",
    error: "Max retry attempts exceeded",
  };
}
