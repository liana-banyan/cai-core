/**
 * CFP Body Exchange — CAI™ Core v0.1.9
 * Extends the manifest-exchange scaffold (v0.1.8) with actual Eblet body transfer.
 * sha256-verify on receive · acceptance-handshake per CFP spec
 * Cathedral Federation Protocol — cooperative-class peer-to-peer only · no vendor relay
 *
 * Protocol:
 *   Discovery (UDP 42424) → manifest exchange → body request (TCP 42425) → sha256 verify → handshake
 *
 * SSPL-1.0 + Cooperative Patent Pledge #2260
 */

import { createHash } from 'crypto';
import { createServer, createConnection, Server } from 'net';

export interface CfpBodyRequest {
  requestId: string;
  ebletId: string;
  requestingPeerId: string;
  timestamp: string;
}

export interface CfpBodyResponse {
  requestId: string;
  ebletId: string;
  body: string;          // Eblet content (markdown text)
  sourceSha256: string;  // sha256 of body content
  providingPeerId: string;
  timestamp: string;
}

export interface CfpAcceptanceHandshake {
  requestId: string;
  ebletId: string;
  receivedSha256: string; // sha256 computed by receiver
  accepted: boolean;      // true if sha256 matches
  reason?: string;        // populated if rejected
}

/** Result returned to callers after a full request-verify cycle */
export interface CfpBodyExchangeResult {
  ok: boolean;
  ebletId: string;
  body?: string;
  sha256?: string;
  error?: string;
}

export class CfpBodyExchange {
  private tcpPort: number;
  private server: Server | null = null;
  private localPeerId: string;

  /** TCP port for body exchange (discovery UDP port + 1) */
  static readonly BODY_EXCHANGE_PORT = 42425;

  constructor(localPeerId: string, tcpPort = CfpBodyExchange.BODY_EXCHANGE_PORT) {
    this.localPeerId = localPeerId;
    this.tcpPort = tcpPort;
  }

  /**
   * Start TCP listener for incoming body-exchange requests.
   * getEbletBody is a callback that maps ebletId → body text (or null if not held locally).
   * Peer discovery is via UDP (port 42424) — body exchange is TCP (port 42425).
   */
  startServer(getEbletBody: (ebletId: string) => string | null): void {
    if (this.server) return;

    this.server = createServer((socket) => {
      let reqBuffer = '';

      const onRequest = (chunk: Buffer) => {
        reqBuffer += chunk.toString();
        let parsed: CfpBodyRequest | null = null;
        try {
          parsed = JSON.parse(reqBuffer) as CfpBodyRequest;
          reqBuffer = '';
        } catch {
          return; // incomplete JSON — wait for more data
        }

        socket.removeListener('data', onRequest);

        const body = getEbletBody(parsed.ebletId);
        if (!body) {
          socket.write(JSON.stringify({
            error: 'Eblet not found',
            ebletId: parsed.ebletId,
          }) + '\n');
          socket.end();
          return;
        }

        const sha256 = createHash('sha256').update(body, 'utf-8').digest('hex');
        const response: CfpBodyResponse = {
          requestId: parsed.requestId,
          ebletId: parsed.ebletId,
          body,
          sourceSha256: sha256,
          providingPeerId: this.localPeerId,
          timestamp: new Date().toISOString(),
        };

        socket.write(JSON.stringify(response) + '\n');

        // Wait for acceptance handshake
        let hsBuffer = '';
        socket.on('data', (hsChunk: Buffer) => {
          hsBuffer += hsChunk.toString();
          try {
            const handshake = JSON.parse(hsBuffer) as CfpAcceptanceHandshake;
            if (!handshake.accepted) {
              console.warn(`[CFP] Body rejected by peer ${parsed!.requestingPeerId}: ${handshake.reason}`);
            }
            socket.end();
          } catch {
            // incomplete handshake — wait
          }
        });
      };

      socket.on('data', onRequest);
      socket.on('error', () => { /* non-fatal */ });
    });

    this.server.listen(this.tcpPort, '0.0.0.0', () => {
      console.log(`[CFP] Body-exchange server listening on TCP :${this.tcpPort}`);
    });

    this.server.on('error', (err) => {
      console.warn('[CFP] Body-exchange server error:', err);
    });
  }

  /**
   * Request an Eblet body from a discovered peer.
   * Performs full sha256 verification before accepting.
   * Returns null if the transfer fails or sha256 mismatches.
   */
  async requestBody(
    peerIp: string,
    request: CfpBodyRequest,
    timeoutMs = 10_000,
  ): Promise<CfpBodyExchangeResult> {
    return new Promise((resolve) => {
      const socket = createConnection(this.tcpPort, peerIp, () => {
        socket.write(JSON.stringify(request) + '\n');
      });

      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let response: CfpBodyResponse | { error: string; ebletId: string };
        try {
          response = JSON.parse(buffer);
        } catch {
          return; // incomplete
        }

        if ('error' in response) {
          socket.end();
          resolve({ ok: false, ebletId: request.ebletId, error: response.error });
          return;
        }

        const resp = response as CfpBodyResponse;

        // sha256 verify
        const computedSha256 = createHash('sha256').update(resp.body, 'utf-8').digest('hex');
        const accepted = computedSha256 === resp.sourceSha256;

        const handshake: CfpAcceptanceHandshake = {
          requestId: request.requestId,
          ebletId: request.ebletId,
          receivedSha256: computedSha256,
          accepted,
          reason: accepted ? undefined : 'sha256 mismatch',
        };

        socket.write(JSON.stringify(handshake) + '\n');
        socket.end();

        if (accepted) {
          resolve({ ok: true, ebletId: resp.ebletId, body: resp.body, sha256: computedSha256 });
        } else {
          resolve({
            ok: false,
            ebletId: resp.ebletId,
            error: `sha256 mismatch — source: ${resp.sourceSha256} · computed: ${computedSha256}`,
          });
        }
      });

      socket.on('error', (err) => {
        resolve({ ok: false, ebletId: request.ebletId, error: `TCP error: ${(err as Error).message}` });
      });

      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        resolve({ ok: false, ebletId: request.ebletId, error: 'request timeout' });
      });
    });
  }

  stopServer(): void {
    this.server?.close();
    this.server = null;
  }
}
