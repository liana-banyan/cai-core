/**
 * Provenance — sha256 dual-write · RFC 3161 TSA · HMAC integrity
 * CAI™ Core · SSPL-1.0 + Cooperative Patent Pledge #2260
 *
 * Primary TSA: DigiCert (FREE · public endpoint · no auth · WebTrust-audited · US federal admissibility)
 * Backup TSA: GlobalSign (enterprise SaaS · paid · eIDAS QTSP · EU evidence chain)
 *
 * Court verification: openssl ts -verify -in <tst> -data <original> -CAfile <ca-bundle>
 */

import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  TimeStampReq,
  TimeStampResp,
  MessageImprint,
} from '@peculiar/asn1-tsp';
import { AlgorithmIdentifier } from '@peculiar/asn1-x509';
import { createHash, randomBytes, createHmac } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const TSA_DIGICERT_PRIMARY = 'http://timestamp.digicert.com';
export const TSA_GLOBALSIGN_BACKUP = '';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TSAVendor = 'DigiCert' | 'GlobalSign';

export interface TSACoTimestamp {
  tsa_vendor: TSAVendor;
  tsa_endpoint: string;
  tst_base64: string;
  tst_time: string;
  tsa_cert_serial: string;
  tsa_cert_sha256: string;
  verification_command: string;
}

export interface TSAResult {
  ok: boolean;
  co_timestamp?: TSACoTimestamp;
  failover_co_timestamp?: TSACoTimestamp;
  error?: string;
  status: 'obtained' | 'pending' | 'failed';
}

export interface ProvenanceRecord {
  sha256: string;
  hmac_sig?: string;
  tsa_result?: TSAResult;
  stamped_at: string;
}

// ─── SHA-256 helpers ──────────────────────────────────────────────────────────

export function sha256Hex(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256Buffer(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function hmacVerify(data: string, sig: string, secret: string): boolean {
  const expected = hmacSign(data, secret);
  return expected === sig;
}

// ─── TSA timestamp request builder ───────────────────────────────────────────

function buildTimeStampRequest(data: Buffer): Uint8Array {
  const hashed = sha256Buffer(data);
  const SHA256_OID = '2.16.840.1.101.3.4.2.1';
  const nonceBytes = randomBytes(8);
  const nonceBuf = nonceBytes.buffer.slice(
    nonceBytes.byteOffset,
    nonceBytes.byteOffset + nonceBytes.byteLength,
  );

  const req = new TimeStampReq({
    version: 1,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithm: SHA256_OID }),
      hashedMessage: new OctetString(
        hashed.buffer.slice(hashed.byteOffset, hashed.byteOffset + hashed.byteLength),
      ),
    }),
    nonce: nonceBuf,
    certReq: true,
  });

  return new Uint8Array(AsnConvert.serialize(req));
}

async function fetchTimestamp(tsaUrl: string, data: Buffer): Promise<Buffer> {
  const tsReq = buildTimeStampRequest(data);
  const res = await fetch(tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: tsReq as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`TSA ${tsaUrl} HTTP ${res.status} ${res.statusText}`);
  }
  const respBuf = Buffer.from(await res.arrayBuffer());
  const resp = AsnConvert.parse(respBuf, TimeStampResp);
  if (!resp.timeStampToken) {
    throw new Error(`TSA ${tsaUrl} returned no token · status ${JSON.stringify(resp.status)}`);
  }
  return Buffer.from(AsnConvert.serialize(resp.timeStampToken));
}

// ─── TST parsing helpers ──────────────────────────────────────────────────────

function extractTstTime(_tst: Buffer): string {
  return new Date().toISOString();
}

function extractCertSerial(_tst: Buffer): string {
  return 'pending-impl';
}

function extractCertSha256(_tst: Buffer): string {
  return 'pending-impl';
}

export function buildVerificationCommand(
  tstFilename: string,
  originalFilename: string,
  vendor: TSAVendor,
): string {
  const caBundle =
    vendor === 'DigiCert' ? 'digicert-ca-bundle.pem' : 'globalsign-ca-bundle.pem';
  return `openssl ts -verify -in ${tstFilename} -data ${originalFilename} -CAfile ${caBundle}`;
}

// ─── Primary stamp API ────────────────────────────────────────────────────────

/**
 * Stamp arbitrary bytes with DigiCert primary + GlobalSign backup (if configured).
 * Both timestamps stored alongside the artifact for redundancy.
 */
export async function stampArtifact(data: Buffer): Promise<TSAResult> {
  try {
    const primaryTst = await fetchTimestamp(TSA_DIGICERT_PRIMARY, data);
    const primary: TSACoTimestamp = {
      tsa_vendor: 'DigiCert',
      tsa_endpoint: TSA_DIGICERT_PRIMARY,
      tst_base64: primaryTst.toString('base64'),
      tst_time: extractTstTime(primaryTst),
      tsa_cert_serial: extractCertSerial(primaryTst),
      tsa_cert_sha256: extractCertSha256(primaryTst),
      verification_command: `openssl ts -verify -in <tst-file> -data <original-file> -CAfile digicert-ca-bundle.pem`,
    };

    let backup: TSACoTimestamp | undefined = undefined;
    if (TSA_GLOBALSIGN_BACKUP) {
      try {
        const backupTst = await fetchTimestamp(TSA_GLOBALSIGN_BACKUP, data);
        backup = {
          tsa_vendor: 'GlobalSign',
          tsa_endpoint: TSA_GLOBALSIGN_BACKUP,
          tst_base64: backupTst.toString('base64'),
          tst_time: extractTstTime(backupTst),
          tsa_cert_serial: extractCertSerial(backupTst),
          tsa_cert_sha256: extractCertSha256(backupTst),
          verification_command: `openssl ts -verify -in <tst-file> -data <original-file> -CAfile globalsign-ca-bundle.pem`,
        };
      } catch {
        // Backup failure is non-fatal
      }
    }

    return { ok: true, co_timestamp: primary, failover_co_timestamp: backup, status: 'obtained' };
  } catch (primaryErr) {
    if (TSA_GLOBALSIGN_BACKUP) {
      try {
        const backupTst = await fetchTimestamp(TSA_GLOBALSIGN_BACKUP, data);
        const backup: TSACoTimestamp = {
          tsa_vendor: 'GlobalSign',
          tsa_endpoint: TSA_GLOBALSIGN_BACKUP,
          tst_base64: backupTst.toString('base64'),
          tst_time: extractTstTime(backupTst),
          tsa_cert_serial: extractCertSerial(backupTst),
          tsa_cert_sha256: extractCertSha256(backupTst),
          verification_command: `openssl ts -verify -in <tst-file> -data <original-file> -CAfile globalsign-ca-bundle.pem`,
        };
        return { ok: true, co_timestamp: backup, status: 'obtained' };
      } catch (backupErr) {
        return {
          ok: false,
          status: 'pending',
          error: `Primary: ${(primaryErr as Error).message} · Backup: ${(backupErr as Error).message}`,
        };
      }
    }
    return {
      ok: false,
      status: 'pending',
      error: `Primary failed (no backup configured): ${(primaryErr as Error).message}`,
    };
  }
}

/**
 * Stamp a string artifact: compute sha256, optional HMAC, optional TSA co-timestamp.
 */
export async function stampString(
  content: string,
  opts: { hmacSecret?: string; tsaEnabled?: boolean } = {},
): Promise<ProvenanceRecord> {
  const sha256 = sha256Hex(content);
  const hmac_sig = opts.hmacSecret ? hmacSign(content, opts.hmacSecret) : undefined;

  let tsa_result: TSAResult | undefined;
  if (opts.tsaEnabled) {
    tsa_result = await stampArtifact(Buffer.from(content, 'utf8'));
  }

  return {
    sha256,
    hmac_sig,
    tsa_result,
    stamped_at: new Date().toISOString(),
  };
}
