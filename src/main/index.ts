/**
 * CAI™ Core — Electron Main Process
 * v0.1.7 · BP051 NOVACULA SEG-CC-7
 *
 * Strip rules applied (26 total per BP051 NOVACULA discipline):
 *   - auth_manager deleted → enabled: true static
 *   - ip_ledger, marketplace handlers deleted
 *   - federation member token IPC deleted
 *   - on_deck deleted (HOLD v0.1.8-core)
 *   - hearth_app_builder deleted (HOLD v0.1.8-core)
 *   - MNEMOSYNE_HOME → CAI_CORE_HOME, ~/.mnemosyne/ → ~/.cai_core/
 *   - mnemosyne:// → cai:// deep-link scheme
 *   - 'Mnemosyne' branding → 'CAI Core' throughout
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  shell,
  globalShortcut,
  dialog,
} from 'electron';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';

// ─── Substrate engine imports ─────────────────────────────────────────────────

import { CaithedralLocalIndex, CaithedralRouter } from '../caithedral/index.js';
import { PheromoneEntityStore, PheromoneEngine } from '../pheromone/index.js';
import { WrasseTriggerRegistry, WrasseEngine } from '../wrasse/index.js';
import { MCPRouter } from '../mcp/index.js';
import { AutoBatonCVT } from '../autobaton/index.js';
import { BanyanMetricLedger } from '../banyan_metric/index.js';
import { MoneyPennyMeter } from '../banyan_metric/money_penny.js';
import { SubstratedFoldersManager } from './substrated_folders.js';
import { getCfpServer } from '../mcp/federation.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;
const VITE_DEV_URL = 'http://127.0.0.1:5173';
const RENDERER_URL = IS_DEV
  ? VITE_DEV_URL
  : `file://${join(__dirname, '../renderer/index.html')}`;

export const CAI_CORE_HOME =
  process.env.CAI_CORE_HOME ?? resolve(homedir(), '.cai_core');

const FIRST_RUN_FLAG = join(CAI_CORE_HOME, 'first_run.flag');
const CAI_API_PORT = parseInt(process.env.CAI_API_PORT ?? '11480', 10);

// ─── CSP ──────────────────────────────────────────────────────────────────────

const CSP_DEV =
  "default-src 'self' http://127.0.0.1:5173; " +
  "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173; " +
  "style-src 'self' 'unsafe-inline'; " +
  `connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173 http://127.0.0.1:${CAI_API_PORT}; ` +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:";

const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  `connect-src 'self' http://127.0.0.1:${CAI_API_PORT}; ` +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:";

const ACTIVE_CSP = IS_DEV ? CSP_DEV : CSP_PROD;

// ─── First-run helpers ────────────────────────────────────────────────────────

function isFirstRun(): boolean {
  return !existsSync(FIRST_RUN_FLAG);
}

function markFirstRunComplete(): void {
  mkdirSync(CAI_CORE_HOME, { recursive: true });
  writeFileSync(FIRST_RUN_FLAG, new Date().toISOString(), 'utf-8');
}

// ─── Safe bounds (multi-display) ──────────────────────────────────────────────

function getSafeBounds(bounds: Electron.Rectangle): Electron.Rectangle {
  const displays = screen.getAllDisplays();
  const onScreen = displays.some((d) => {
    const b = d.bounds;
    return (
      bounds.x < b.x + b.width &&
      bounds.x + bounds.width > b.x &&
      bounds.y < b.y + b.height &&
      bounds.y + bounds.height > b.y
    );
  });
  if (onScreen) return bounds;
  const primary = screen.getPrimaryDisplay();
  const w = primary.bounds;
  return {
    x: w.x + Math.floor((w.width - bounds.width) / 2),
    y: w.y + Math.floor((w.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height,
  };
}

// ─── Window bounds persistence ────────────────────────────────────────────────

const BOUNDS_FILE = join(CAI_CORE_HOME, 'window_bounds.json');

function loadWindowBounds(): Partial<Electron.Rectangle> {
  if (!existsSync(BOUNDS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BOUNDS_FILE, 'utf-8')) as Partial<Electron.Rectangle>;
  } catch {
    return {};
  }
}

function saveWindowBounds(bounds: Electron.Rectangle): void {
  try {
    mkdirSync(CAI_CORE_HOME, { recursive: true });
    writeFileSync(BOUNDS_FILE, JSON.stringify(bounds, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

// ─── Application state ────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let moneyPennyWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Substrate singletons
let caithedralIndex: CaithedralLocalIndex | null = null;
let caithedralRouter: CaithedralRouter | null = null;
let pheromoneStore: PheromoneEntityStore | null = null;
let pheromoneEngine: PheromoneEngine | null = null;
let wrasseRegistry: WrasseTriggerRegistry | null = null;
let wrasseEngine: WrasseEngine | null = null;
let mcpRouter: MCPRouter | null = null;
let autoBaton: AutoBatonCVT | null = null;
let bmLedger: BanyanMetricLedger | null = null;
let mpMeter: MoneyPennyMeter | null = null;
let substratedFolders: SubstratedFoldersManager | null = null;

// ─── cai:// deep-link protocol ────────────────────────────────────────────────

function registerDeepLinkProtocol(): void {
  app.setAsDefaultProtocolClient('cai');
}

// ─── Substrate initialization ─────────────────────────────────────────────────

async function initSubstrate(): Promise<void> {
  caithedralIndex = new CaithedralLocalIndex();
  await caithedralIndex.load();

  caithedralRouter = new CaithedralRouter(caithedralIndex);

  pheromoneStore = new PheromoneEntityStore();
  await pheromoneStore.load();
  pheromoneEngine = new PheromoneEngine(pheromoneStore);

  wrasseRegistry = new WrasseTriggerRegistry();
  wrasseRegistry.load();
  wrasseEngine = new WrasseEngine(wrasseRegistry, (id) => pheromoneStore!.get(id));

  mcpRouter = new MCPRouter({
    ollamaBase: process.env.OLLAMA_BASE ?? 'http://localhost:11434',
    claudeApiKey: process.env.ANTHROPIC_API_KEY,
  });

  autoBaton = new AutoBatonCVT();
  bmLedger = new BanyanMetricLedger();
  mpMeter = new MoneyPennyMeter(`session_${Date.now()}`, 'BP051');

  // v0.1.8 — Substrated Folders + CFP federation
  substratedFolders = new SubstratedFoldersManager();
  substratedFolders.setIndex(caithedralIndex);
  substratedFolders.startAll();

  const cfp = getCfpServer();
  cfp.startDiscovery();

  console.log(`[CAI™ Core] Substrate initialized — ${caithedralIndex.size} records indexed`);
}

// ─── Window creation ──────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const savedBounds = loadWindowBounds();
  const workArea = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    x: savedBounds.x,
    y: savedBounds.y,
    width: savedBounds.width ?? Math.floor(workArea.width * 0.8),
    height: savedBounds.height ?? Math.floor(workArea.height * 0.8),
    minWidth: 800,
    minHeight: 600,
    title: 'CAI™ Core',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    autoHideMenuBar: true,
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [ACTIVE_CSP],
      },
    });
  });

  win.on('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', () => {
    if (!win.isDestroyed()) {
      saveWindowBounds(win.getBounds());
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.loadURL(RENDERER_URL);
  return win;
}

function createMoneyPennyWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    width: Math.floor(workArea.width * 0.28),
    height: Math.floor(workArea.height * 0.55),
    minWidth: 320,
    minHeight: 480,
    title: 'MoneyPenny™ · CAI™ Core',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
  });

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => { moneyPennyWindow = null; });

  const mpUrl = IS_DEV
    ? `${VITE_DEV_URL}?panel=money_penny`
    : `file://${join(__dirname, '../renderer/index.html')}?panel=money_penny`;
  win.loadURL(mpUrl);
  return win;
}

// ─── Tray setup ───────────────────────────────────────────────────────────────

function setupTray(): void {
  const iconPath = join(__dirname, '../../assets/tray-icon.png');
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('CAI™ Core · click for Dashboard');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => mainWindow?.show() },
    { label: 'MoneyPenny™ Meter', click: () => {
      if (!moneyPennyWindow || moneyPennyWindow.isDestroyed()) {
        moneyPennyWindow = createMoneyPennyWindow();
      } else {
        moneyPennyWindow.focus();
      }
    }},
    { type: 'separator' },
    { label: 'About CAI™ Core', click: () => {
      dialog.showMessageBox({
        type: 'info',
        title: 'About CAI™ Core',
        message: `CAI™ Core v${app.getVersion()}`,
        detail: [
          'Cooperative AI Memory Architecture',
          'Reference Implementation · Designed to Be Copied',
          '',
          'License: SSPL-1.0 + Cooperative Patent Pledge #2260',
          'Download: https://mnemosynec.ai/download/',
          '',
          '© 2026 Liana Banyan Corporation',
        ].join('\n'),
      });
    }},
    { label: 'Open mnemosynec.ai', click: () => shell.openExternal('https://mnemosynec.ai') },
    { type: 'separator' },
    { label: 'Quit CAI™ Core', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus();
      else mainWindow.show();
    }
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // ── Substrate query ──────────────────────────────────────────────────────────
  ipcMain.handle('substrate:query', async (_event, queryText: string) => {
    if (!caithedralRouter) return { hit: false, routing: 'miss', latency_ms: 0, cloud_cost_avoided_usd: 0 };
    const result = await caithedralRouter.query(queryText);
    mpMeter?.recordHit(result.routing);
    return result;
  });

  ipcMain.handle('substrate:write', async (_event, record: { id: string; text: string; source: string }) => {
    if (!caithedralIndex) return { ok: false };
    caithedralIndex.writeRecord({
      id: record.id,
      text: record.text,
      source: record.source,
      keywords: caithedralIndex.extractKeywords(record.text),
      ts: new Date().toISOString(),
    });
    return { ok: true };
  });

  ipcMain.handle('substrate:mode', (_event) => {
    return { mode: caithedralRouter?.getEffectiveMode() ?? 'normal', forced: caithedralRouter?.getForcedMode() ?? null };
  });

  ipcMain.handle('substrate:setMode', (_event, mode: string) => {
    caithedralRouter?.setForcedMode(mode as 'ai_burst' | 'normal' | 'fallback' | null);
    return { ok: true };
  });

  // ── MCP dispatch ─────────────────────────────────────────────────────────────
  ipcMain.handle('mcp:dispatch', async (_event, prompt: string, vendor?: string) => {
    if (!mcpRouter) return { error: 'MCP not initialized' };
    return mcpRouter.dispatch(prompt, vendor as Parameters<typeof mcpRouter.dispatch>[1]);
  });

  ipcMain.handle('mcp:getState', () => mcpRouter?.getState() ?? null);
  ipcMain.handle('mcp:selectVendor', (_event, vendor: string) => {
    return mcpRouter?.selectVendor(vendor as Parameters<typeof mcpRouter.selectVendor>[0]) ?? { ok: false };
  });

  // ── Pheromone ─────────────────────────────────────────────────────────────────
  ipcMain.handle('pheromone:propagate', (_event, trigger: string, sessionId?: string) => {
    return pheromoneEngine?.propagate(trigger, sessionId) ?? null;
  });

  ipcMain.handle('pheromone:entities', () => pheromoneStore?.getAll() ?? []);
  ipcMain.handle('pheromone:propagateROM', (_event, sessionId?: string) => {
    return pheromoneEngine?.propagateROM(sessionId) ?? [];
  });

  // ── Wrasse ────────────────────────────────────────────────────────────────────
  ipcMain.handle('wrasse:preInject', (_event, text: string, sessionId?: string) => {
    return wrasseEngine?.preInject(text, sessionId) ?? { original_text: text, augmented_text: text, injections: [], triggers_fired: [], latency_ms: 0 };
  });

  ipcMain.handle('wrasse:registerTrigger', (_event, phrase: string, entityId: string) => {
    return wrasseRegistry?.register(phrase, entityId) ?? null;
  });

  ipcMain.handle('wrasse:getTriggers', () => wrasseRegistry?.getAll() ?? []);
  ipcMain.handle('wrasse:getStats', () => wrasseEngine?.getInjectionStats() ?? { total_injections: 0, unique_triggers: new Set() });

  // ── AutoBaton wave dispatch ───────────────────────────────────────────────────
  ipcMain.handle('autobaton:dispatch', async (_event, request: Parameters<AutoBatonCVT['dispatch']>[0]) => {
    if (!autoBaton) return { error: 'AutoBaton not initialized' };
    return autoBaton.dispatch(request);
  });

  ipcMain.handle('autobaton:getWave', (_event, waveId: string) => autoBaton?.getWave(waveId) ?? null);
  ipcMain.handle('autobaton:abort', (_event, waveId: string) => autoBaton?.abort(waveId) ?? { ok: false });
  ipcMain.handle('autobaton:summary', () => autoBaton?.getSummary() ?? null);

  // ── Banyan Metric™ + MoneyPenny™ ─────────────────────────────────────────────
  ipcMain.handle('banyanMetric:getLatest', () => bmLedger?.getLatest() ?? null);
  ipcMain.handle('banyanMetric:getTrend', (_event, n?: number) => bmLedger?.getTrend(n) ?? []);
  ipcMain.handle('moneyPenny:getDualView', () => mpMeter?.getDualView() ?? null);
  ipcMain.handle('moneyPenny:getTotals', () => MoneyPennyMeter.getTotals());

  // ── Substrated Folders (v0.1.8) ──────────────────────────────────────────────
  ipcMain.handle('cai-core:list-substrated-folders', () => substratedFolders?.list() ?? []);

  ipcMain.handle('cai-core:add-substrated-folder', async (_event, folderPath?: string) => {
    let targetPath = folderPath;
    if (!targetPath) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Add Folder to CAI™ Core Substrate',
        buttonLabel: 'Substrate This Folder',
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, paths: substratedFolders?.list() ?? [] };
      targetPath = result.filePaths[0];
    }
    return substratedFolders?.add(targetPath) ?? { ok: false, paths: [] };
  });

  ipcMain.handle('cai-core:remove-substrated-folder', (_event, folderPath: string) =>
    substratedFolders?.remove(folderPath) ?? { ok: false, paths: [] },
  );

  ipcMain.handle('cai-core:substrated-manifest', () => substratedFolders?.getManifest() ?? []);

  // ── CFP Federation (v0.1.9) ───────────────────────────────────────────────────
  ipcMain.handle('cfp:getManifest', () => getCfpServer().getLocalManifest());
  ipcMain.handle('cfp:getPeers', () => getCfpServer().getPeers());
  ipcMain.handle('cfp:federateManifest', (_event, peerId: string, cathedralId: string) =>
    getCfpServer().federateManifest(peerId, cathedralId),
  );
  ipcMain.handle('cfp:getCathedralId', () => getCfpServer().getCathedralId());

  ipcMain.handle('cfp:request-body', async (_event, peerId: string, ebletId: string) => {
    const peerIp = getCfpServer().getPeerIp(peerId);
    if (!peerIp) {
      return { ok: false, ebletId, error: `Peer ${peerId} not found in discovery table` };
    }
    return getCfpServer().requestEbletBody(peerIp, ebletId);
  });

  // ── App / shell ───────────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:openExternal', (_event, url: string) => {
    // Only allow https:// URLs to prevent shell injection
    if (url.startsWith('https://')) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, reason: 'non-https URL rejected' };
  });

  ipcMain.handle('app:openMoneyPenny', () => {
    if (!moneyPennyWindow || moneyPennyWindow.isDestroyed()) {
      moneyPennyWindow = createMoneyPennyWindow();
    } else {
      moneyPennyWindow.focus();
    }
    return { ok: true };
  });

  ipcMain.handle('app:firstRun', () => isFirstRun());
  ipcMain.handle('app:markFirstRunComplete', () => {
    markFirstRunComplete();
    return { ok: true };
  });

  // ── Deep-link ─────────────────────────────────────────────────────────────────
  ipcMain.handle('deepLink:open', (_event, url: string) => {
    if (url.startsWith('cai://')) {
      mainWindow?.webContents.send('deep-link', { url });
      return { ok: true };
    }
    return { ok: false };
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerDeepLinkProtocol();
  mkdirSync(CAI_CORE_HOME, { recursive: true });

  await initSubstrate();

  mainWindow = createMainWindow();
  setupTray();
  registerIpcHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Close MoneyPenny™ meter session on exit
  try {
    mpMeter?.closeSession();
  } catch {
    // Non-fatal
  }
  // Stop substrated folder watchers + CFP discovery
  try {
    substratedFolders?.stopAll();
    getCfpServer().stopDiscovery();
  } catch {
    // Non-fatal
  }
  if (process.platform !== 'darwin') app.quit();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const deepLinkUrl = commandLine.find((arg) => arg.startsWith('cai://'));
    if (deepLinkUrl && mainWindow) {
      mainWindow.webContents.send('deep-link', { url: deepLinkUrl });
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Handle cai:// on macOS open-url
app.on('open-url', (_event, url) => {
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', { url });
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

export { mainWindow, moneyPennyWindow, tray };
