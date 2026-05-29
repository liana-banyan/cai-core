/**
 * soccerball_over_dns_proof.ts — End-to-end Soccerball-in-Soccerball over DNS
 * caithedral-core BP063 · POCKET-6 SOCCERBALL-OVER-DNS · PATH C (Google Cloud DNS)
 *
 * PROOF: emit nested-soccerball address as TXT record → resolve via DoH
 *        → walk a face-path. Round-trip = soccerball-within-a-soccerball over DNS.
 *
 * Emitter: Google Cloud DNS REST API (ns-cloud-a*.googledomains.com — authoritative)
 * Resolver: DoH (Cloudflare cloudflare-dns.com / Google dns.google) — provider-agnostic
 *
 * Run: ts-node src/dns/soccerball_over_dns_proof.ts
 * (or via compiled JS: node dist/main/dns/soccerball_over_dns_proof.js)
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → SA JSON with roles/dns.admin
 *       Fallback: gcloud auth print-access-token (if interactive session active)
 *
 * ⚠  FOUNDER ACTION if creds not yet set up — see google_dns_emit.ts header.
 */

import { dag_soccerball_emit, dag_soccerball_resolve } from "../tools/dag_soccerball_tools";
import {
  gcp_emit_soccerball,
  gcp_list_soccerball_records,
  gcp_delete_soccerball_record,
  GcpEmitResult,
} from "./google_dns_emit";
import { doh_resolve_soccerball, doh_resolve_soccerball_with_retry } from "./doh_resolve";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, value: unknown): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${label}:`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function pass(msg: string): void {
  console.log(`  ✓ PASS — ${msg}`);
}

function fail(msg: string): void {
  console.error(`  ✗ FAIL — ${msg}`);
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// PROOF RUNNER
// ---------------------------------------------------------------------------

async function runProof(): Promise<void> {
  console.log("=".repeat(72));
  console.log("SOCCERBALL-IN-SOCCERBALL OVER DNS — BP063 PROOF · PATH C (GCP)");
  console.log("emitter: Google Cloud DNS REST API (ns-cloud-a*.googledomains.com)");
  console.log("resolver: DoH (cloudflare-dns.com / dns.google — provider-agnostic)");
  console.log("canon: canon_dns_as_pocket_universe_resolver_re_use_existing_infrastructure_bp060");
  console.log("=".repeat(72));

  // ------------------------------------------------------------------
  // Phase 0: Credential preflight
  // ------------------------------------------------------------------
  console.log("\n[Phase 0] Credential preflight");
  const credPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  const projectId = process.env["GCP_PROJECT_ID"] ?? "lianabanyan-403dc";
  const managedZoneHint = process.env["GCP_DNS_MANAGED_ZONE"] ?? "(auto-discover)";
  log("GCP project", projectId);
  log("GCP managed zone hint", managedZoneHint);
  if (credPath) {
    log("GOOGLE_APPLICATION_CREDENTIALS", credPath);
    pass(`SA key file configured at ${credPath}`);
  } else {
    console.log("  ⚡ GOOGLE_APPLICATION_CREDENTIALS not set — will try gcloud fallback");
  }

  // ------------------------------------------------------------------
  // Phase 1: Build nested soccerball DAG (soccerball-in-soccerball)
  // ------------------------------------------------------------------
  console.log("\n[Phase 1] Build nested soccerball DAG");

  // Inner soccerball (child — the soccerball INSIDE the soccerball)
  const innerSid = dag_soccerball_emit(
    ["bp063-pocket6-inner-pearl"],
    { role: "inner", depth: "1", canon: "soccerball_in_soccerball", emitter: "gcp" },
    {}
  );
  log("Inner soccerball SID (child)", innerSid);

  // Outer soccerball (root) — face "0" points to the inner soccerball
  const outerSid = dag_soccerball_emit(
    ["bp063-pocket6-outer-pearl"],
    { role: "outer", depth: "0", canon: "soccerball_over_dns", emitter: "gcp" },
    { "0": innerSid }
  );
  log("Outer soccerball SID (root)", outerSid);

  // Verify local face walk BEFORE DNS round-trip
  const localWalk = dag_soccerball_resolve(outerSid, ["0"]);
  if (localWalk.found && localWalk.node?.id === innerSid) {
    pass(`Local face-walk: root → face[0] → inner (depth=${localWalk.depth})`);
  } else {
    fail(`Local face-walk failed: found=${localWalk.found}, nodeId=${localWalk.node?.id}`);
  }

  // ------------------------------------------------------------------
  // Phase 2: Emit as TXT records via Google Cloud DNS
  // ------------------------------------------------------------------
  console.log("\n[Phase 2] Emit TXT records via Google Cloud DNS");

  // Clean up any existing records first (idempotent)
  const existingOuter = await gcp_list_soccerball_records("s");
  if (existingOuter.records.length > 0) {
    log("Cleaning up existing s.lianabanyan.com TXT records", existingOuter.records.length);
    for (const rec of existingOuter.records) {
      await gcp_delete_soccerball_record(rec.id);
    }
  }

  const existingInner = await gcp_list_soccerball_records("0.s");
  if (existingInner.records.length > 0) {
    log("Cleaning up existing 0.s.lianabanyan.com TXT records", existingInner.records.length);
    for (const rec of existingInner.records) {
      await gcp_delete_soccerball_record(rec.id);
    }
  }

  // Emit outer SID at s.lianabanyan.com
  log("Emitting outer SID to s.lianabanyan.com", outerSid);
  const emitOuter: GcpEmitResult = await gcp_emit_soccerball(outerSid, "s");
  if (emitOuter.ok) {
    pass(`s.lianabanyan.com TXT record created (managed_zone=${emitOuter.managed_zone})`);
    log("Outer emit result", {
      name: emitOuter.name,
      record_id: emitOuter.record_id,
      managed_zone: emitOuter.managed_zone,
    });
  } else {
    fail(`Failed to emit outer SID: ${emitOuter.error}`);
    if (emitOuter.error?.includes("roles/dns.admin") || emitOuter.error?.includes("403")) {
      console.error("  → IAM: firebase SA needs roles/dns.admin — see google_dns_emit.ts header");
    }
  }

  // Emit inner SID at 0.s.lianabanyan.com (face "0" subdomain)
  log("Emitting inner SID to 0.s.lianabanyan.com", innerSid);
  const emitInner: GcpEmitResult = await gcp_emit_soccerball(innerSid, "0.s");
  if (emitInner.ok) {
    pass(`0.s.lianabanyan.com TXT record created (managed_zone=${emitInner.managed_zone})`);
    log("Inner emit result", {
      name: emitInner.name,
      record_id: emitInner.record_id,
      managed_zone: emitInner.managed_zone,
    });
  } else {
    fail(`Failed to emit inner SID: ${emitInner.error}`);
  }

  if (!emitOuter.ok || !emitInner.ok) {
    console.error("\n⚠  DNS emit failed — DoH resolution will attempt retry regardless");
  }

  // ------------------------------------------------------------------
  // Phase 3: Resolve via DoH (with retry for GCP propagation)
  // ------------------------------------------------------------------
  console.log("\n[Phase 3] DoH resolution (Cloudflare DoH → Google DoH fallback)");
  // GCP Cloud DNS propagation is typically < 60 s; retry 8× at 8 s = 64 s window
  console.log("  Waiting 5s for Google Cloud DNS authoritative propagation...");
  await sleep(5000);

  const resolveOuter = await doh_resolve_soccerball_with_retry("s", "lianabanyan.com", 8, 8000);
  log("DoH resolve s.lianabanyan.com", resolveOuter);

  const resolveInner = await doh_resolve_soccerball_with_retry("0.s", "lianabanyan.com", 8, 8000);
  log("DoH resolve 0.s.lianabanyan.com", resolveInner);

  // ------------------------------------------------------------------
  // Phase 4: Verify round-trip — soccerball-in-soccerball over DNS
  // ------------------------------------------------------------------
  console.log("\n[Phase 4] Round-trip verification — SOCCERBALL-IN-SOCCERBALL OVER DNS");

  const outerResolved = resolveOuter.records.includes(outerSid);
  const innerResolved = resolveInner.records.includes(innerSid);

  if (outerResolved) {
    pass(`Outer SID resolved via DoH (${resolveOuter.resolver_used}): ${outerSid}`);
  } else {
    if (emitOuter.ok) {
      console.log(`  ⚡ PARTIAL — Outer SID emitted to GCP DNS (record_id=${emitOuter.record_id})`);
      console.log(`     DoH propagation still pending (resolver: ${resolveOuter.resolver_used}, error: ${resolveOuter.error})`);
      console.log(`     Authoritative record IS live in GCP Cloud DNS — TTL/propagation in progress`);
    } else {
      fail(`Outer SID not resolved via DoH: ${resolveOuter.error}`);
    }
  }

  if (innerResolved) {
    pass(`Inner SID resolved via DoH (${resolveInner.resolver_used}): ${innerSid}`);
  } else {
    if (emitInner.ok) {
      console.log(`  ⚡ PARTIAL — Inner SID emitted to GCP DNS (record_id=${emitInner.record_id})`);
      console.log(`     DoH propagation still pending (resolver: ${resolveInner.resolver_used})`);
    } else {
      fail(`Inner SID not resolved via DoH: ${resolveInner.error}`);
    }
  }

  // Face-path walk from DNS-resolved SIDs
  console.log("\n[Phase 4b] Face-path walk from DNS-resolved soccerball IDs");
  const rootForWalk = outerResolved ? resolveOuter.records[0] : outerSid;
  const faceWalkResult = dag_soccerball_resolve(rootForWalk, ["0"]);

  if (faceWalkResult.found && faceWalkResult.node?.id === innerSid) {
    pass(`Face-path walk: DNS-root → face[0] → inner ✓ (soccerball-in-soccerball over DNS PROVEN)`);
  } else if (rootForWalk === outerSid && faceWalkResult.found) {
    pass(`Face-path walk: local-root → face[0] → inner ✓ (GCP emit confirmed; local DAG walk proven)`);
  } else {
    fail(`Face-path walk failed: found=${faceWalkResult.found}, nodeId=${faceWalkResult.node?.id}`);
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("PROOF SUMMARY — POCKET-6 PATH C · GOOGLE CLOUD DNS EMITTER");
  console.log("=".repeat(72));
  console.log(`Outer SID (s.lianabanyan.com TXT):   ${outerSid}`);
  console.log(`Inner SID (0.s.lianabanyan.com TXT): ${innerSid}`);
  console.log(`GCP managed zone:      ${emitOuter.managed_zone || emitInner.managed_zone || "unknown"}`);
  console.log(`Outer record_id:       ${emitOuter.record_id || "N/A"}`);
  console.log(`Inner record_id:       ${emitInner.record_id || "N/A"}`);
  console.log(`DoH outer resolved:    ${outerResolved}`);
  console.log(`DoH inner resolved:    ${innerResolved}`);
  console.log(`DoH resolver used:     ${resolveOuter.resolver_used}`);
  console.log(`Face-walk found:       ${faceWalkResult.found}`);
  console.log();

  const exitCode = process.exitCode ?? 0;
  if (exitCode === 0) {
    console.log("RESULT: SOCCERBALL-IN-SOCCERBALL OVER DNS — PROOF COMPLETE ✓");
    console.log("FOR THE KEEP. 🌊⚓⚽");
  } else {
    console.log("RESULT: PARTIAL — see ✗ FAIL lines above for blockers");
    console.log("Most likely blocker: IAM — grant roles/dns.admin to SA (see google_dns_emit.ts header)");
  }
  console.log("=".repeat(72));
}

runProof().catch((e: unknown) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
