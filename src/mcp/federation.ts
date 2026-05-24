/**
 * CAI™ Core — Cathedral Federation Protocol (CFP)
 * v0.1.9 · KniPr006 + NOVACULI SAGA-p
 *
 * v0.1.9 adds full body exchange (TCP 42425):
 *   sha256-verify on receive · acceptance-handshake per CFP spec
 *
 * MCP tool: cai_federate_manifest
 *   Accepts: { peer_id, cathedral_id }
 *   Returns: manifest (list of Eblet™ IDs + topics + sha256 hashes, NOT content bodies)
 *
 * IPC channel: cfp:request-body
 *   Accepts: { peerIp, ebletId, requestingPeerId }
 *   Returns: CfpBodyExchangeResult (body + sha256 on success)
 *
 * UDP multicast discovery: 239.255.42.42:42424
 *   30s beacon · 90s peer expiry
 * TCP body exchange: port 42425 (discovery + 1)
 *
 * Federation URI scheme: cai://federate/{cathedral-id}
 *
 * SSPL-1.0 + Cooperative Patent Pledge #2260
 */

import { createSocket, type Socket } from 'dgram';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir, hostname } from 'os';
import { CfpBodyExchange, type CfpBodyRequest, type CfpBodyExchangeResult } from './cfp_body_exchange.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const FED_DIR = resolve(CAI_CORE_HOME, 'federation');
const MANIFEST_PATH = resolve(FED_DIR, 'local_manifest.json');
const PEERS_PATH = resolve(FED_DIR, 'discovered_peers.json');

/** CFP multicast group address (matches Mnemosyne™ v0.1.8 discovery) */
const MULTICAST_GROUP = '239.255.42.42';
const MULTICAST_PORT = 42424;
const BEACON_INTERVAL_MS = 30_000;
const PEER_EXPIRY_MS = 90_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CfpManifestEntry {
  id: string;
  sha256: string;
  topic?: string;
  updated_at: string;
}

export interface CfpManifest {
  cathedral_id: string;
  version: string;
  entries: CfpManifestEntry[];
  generated_at: string;
}

export interface CfpPeer {
  peer_id: string;
  cathedral_id: string;
  address: string;
  port: number;
  last_seen: string;
  entry_count: number;
}

export interface CfpFederateManifestResult {
  ok: boolean;
  peer_id: string;
  cathedral_id: string;
  manifest?: CfpManifest;
  uri: string;
  error?: string;
}

// ─── Cathedral ID ─────────────────────────────────────────────────────────────

function getOrCreateCathedralId(): string {
  const idPath = resolve(FED_DIR, 'cathedral_id.txt');
  ensureFedDirs();
  if (existsSync(idPath)) {
    try { return readFileSync(idPath, 'utf-8').trim(); } catch { /* fall through */ }
  }
  const id = 'cai-' + createHash('sha256')
    .update(`${hostname()}-${Date.now()}-${randomUUID()}`)
    .digest('hex')
    .slice(0, 32);
  writeFileSync(idPath, id, 'utf-8');
  return id;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function ensureFedDirs(): void {
  if (!existsSync(FED_DIR)) mkdirSync(FED_DIR, { recursive: true });
}

function loadPeers(): CfpPeer[] {
  ensureFedDirs();
  if (!existsSync(PEERS_PATH)) return [];
  try {
    const raw = readFileSync(PEERS_PATH, 'utf-8');
    return JSON.parse(raw) as CfpPeer[];
  } catch {
    return [];
  }
}

function savePeers(peers: CfpPeer[]): void {
  ensureFedDirs();
  writeFileSync(PEERS_PATH, JSON.stringify(peers, null, 2), 'utf-8');
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

/** Federation URI for a cathedral ID: cai://federate/{cathedral-id} */
function federationUri(cathedralId: string): string {
  return `cai://federate/${cathedralId}`;
}

// ─── CFP Server ───────────────────────────────────────────────────────────────

export class CfpFederationServer {
  private cathedralId: string;
  private socket: Socket | null = null;
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private peers: Map<string, CfpPeer> = new Map();
  private localManifest: CfpManifestEntry[] = [];
  private bodyExchange: CfpBodyExchange;

  constructor() {
    this.cathedralId = getOrCreateCathedralId();
    this.peers = new Map(loadPeers().map((p) => [p.peer_id, p]));
    this.bodyExchange = new CfpBodyExchange(this.cathedralId);
    console.log(`[CFP] Cathedral ID: ${this.cathedralId}`);
  }

  getCathedralId(): string {
    return this.cathedralId;
  }

  /** Update local manifest entries (called by SubstratedFoldersManager). */
  updateManifest(entries: CfpManifestEntry[]): void {
    this.localManifest = entries;
    ensureFedDirs();
    const manifest: CfpManifest = {
      cathedral_id: this.cathedralId,
      version: '0.1.9',
      entries,
      generated_at: new Date().toISOString(),
    };
    try {
      writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
  }

  getLocalManifest(): CfpManifest {
    return {
      cathedral_id: this.cathedralId,
      version: '0.1.9',
      entries: this.localManifest,
      generated_at: new Date().toISOString(),
    };
  }

  /** cai_federate_manifest MCP tool handler */
  federateManifest(peerId: string, requestedCathedralId: string): CfpFederateManifestResult {
    const uri = federationUri(requestedCathedralId);

    // If the requested cathedral is our own, return local manifest
    if (requestedCathedralId === this.cathedralId) {
      return {
        ok: true,
        peer_id: peerId,
        cathedral_id: this.cathedralId,
        manifest: this.getLocalManifest(),
        uri,
      };
    }

    // Look up in known peers
    const peer = this.peers.get(peerId);
    if (!peer) {
      return {
        ok: false,
        peer_id: peerId,
        cathedral_id: requestedCathedralId,
        uri,
        error: `Peer ${peerId} not found in discovery table. Start UDP discovery first.`,
      };
    }

    // Peer manifest: return cached stub — body exchange is separate (TCP 42425 / cfp:request-body)
    return {
      ok: true,
      peer_id: peerId,
      cathedral_id: requestedCathedralId,
      uri,
      manifest: {
        cathedral_id: requestedCathedralId,
        version: '0.1.9-remote',
        entries: [],
        generated_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Request an Eblet body from a peer by IP.
   * Called via IPC channel cfp:request-body (v0.1.9+).
   * sha256 verified on receive; acceptance handshake sent automatically.
   */
  async requestEbletBody(
    peerIp: string,
    ebletId: string,
    requestingPeerId?: string,
  ): Promise<CfpBodyExchangeResult> {
    const request: CfpBodyRequest = {
      requestId: randomUUID(),
      ebletId,
      requestingPeerId: requestingPeerId ?? this.cathedralId,
      timestamp: new Date().toISOString(),
    };
    return this.bodyExchange.requestBody(peerIp, request);
  }

  /** Resolve a peer's IP from its peer ID. Returns null if peer unknown/evicted. */
  getPeerIp(peerId: string): string | null {
    this.evictStalePeers();
    return this.peers.get(peerId)?.address ?? null;
  }

  getPeers(): CfpPeer[] {
    this.evictStalePeers();
    return Array.from(this.peers.values());
  }

  /** Start UDP multicast beacon + listener + TCP body-exchange server */
  startDiscovery(getEbletBody?: (ebletId: string) => string | null): void {
    if (this.socket) return;

    // Start TCP body-exchange server (v0.1.9)
    this.bodyExchange.startServer(getEbletBody ?? (() => null));

    try {
      const sock = createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = sock;

      sock.bind(MULTICAST_PORT, () => {
        try {
          sock.addMembership(MULTICAST_GROUP);
          sock.setBroadcast(true);
        } catch (err) {
          console.warn('[CFP] Multicast join failed:', err);
        }
        console.log(`[CFP] UDP discovery listening on ${MULTICAST_GROUP}:${MULTICAST_PORT}`);
      });

      sock.on('message', (msg, rinfo) => {
        try {
          const beacon = JSON.parse(msg.toString()) as {
            type: string;
            peer_id: string;
            cathedral_id: string;
            port: number;
            entry_count: number;
          };
          if (beacon.type !== 'cai_beacon') return;
          if (beacon.peer_id === this.cathedralId) return; // ignore self

          const peer: CfpPeer = {
            peer_id: beacon.peer_id,
            cathedral_id: beacon.cathedral_id,
            address: rinfo.address,
            port: beacon.port,
            last_seen: new Date().toISOString(),
            entry_count: beacon.entry_count,
          };
          this.peers.set(peer.peer_id, peer);
          savePeers(Array.from(this.peers.values()));
        } catch { /* malformed beacon */ }
      });

      sock.on('error', (err) => {
        console.warn('[CFP] Socket error:', err);
      });

      // Send initial beacon + start periodic beacon
      this.sendBeacon();
      this.beaconTimer = setInterval(() => this.sendBeacon(), BEACON_INTERVAL_MS);
    } catch (err) {
      console.warn('[CFP] Discovery start failed:', err);
    }
  }

  stopDiscovery(): void {
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* non-fatal */ }
      this.socket = null;
    }
    this.bodyExchange.stopServer();
  }

  private sendBeacon(): void {
    if (!this.socket) return;
    const beacon = JSON.stringify({
      type: 'cai_beacon',
      peer_id: this.cathedralId,
      cathedral_id: this.cathedralId,
      port: MULTICAST_PORT,
      body_exchange_port: CfpBodyExchange.BODY_EXCHANGE_PORT,
      entry_count: this.localManifest.length,
      version: '0.1.9',
    });
    const buf = Buffer.from(beacon, 'utf-8');
    this.socket.send(buf, MULTICAST_PORT, MULTICAST_GROUP, (err) => {
      if (err) console.warn('[CFP] Beacon send error:', err);
    });
  }

  private evictStalePeers(): void {
    const cutoff = Date.now() - PEER_EXPIRY_MS;
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (new Date(peer.last_seen).getTime() < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) savePeers(Array.from(this.peers.values()));
  }
}

/** Singleton CFP server instance */
let _cfpServer: CfpFederationServer | null = null;

export function getCfpServer(): CfpFederationServer {
  if (!_cfpServer) _cfpServer = new CfpFederationServer();
  return _cfpServer;
}
