import * as extensionConfig from '../extension.json';

const APP_NAME = String((extensionConfig as any).displayName || 'JLC Bridge');
const APP_VERSION = String((extensionConfig as any).version || '0.0.0');
const BRIDGE_DIR = '/Users/al/.openclaw/workspace/jlc-bridge';
const COMMAND_FILE = `${BRIDGE_DIR}/command.json`;
const RESULT_FILE = `${BRIDGE_DIR}/result.json`;
const LOG_FILE = `${BRIDGE_DIR}/bridge.log`;
const POLL_INTERVAL_MS = 500;
const ENABLED_STORAGE_KEY = 'jlcBridgeEnabled';
const TIMER_ID = 'jlc_bridge_poll_loop';

let bridgeEnabled = false;
let nativeIntervalHandle: ReturnType<typeof setInterval> | null = null;
let usingNativeTimer = false;
let usingSysTimer = false;
let lastCommandTime = 0;
let pollInProgress = false;

// ─── WebSocket state ───
const WS_URL = 'ws://127.0.0.1:18800/ws/bridge';
const WS_RECONNECT_MS = 3000;
let wsConnection: WebSocket | null = null;
let wsConnected = false;
let wsReconnectHandle: ReturnType<typeof setTimeout> | null = null;

type BridgeCommand = {
  id: string;
  action: string;
  params: Record<string, any>;
  timestamp: number;
};

type BridgeResult = {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  durationMs?: number;
};

function anyEda(): any {
  return eda as any;
}

function hasLegacyFileApi(): boolean {
  const fileApi = anyEda()?.sys_File;
  return Boolean(fileApi?.readFile && fileApi?.writeFile);
}

function hasFileSystemApi(): boolean {
  const fsApi = anyEda()?.sys_FileSystem;
  return Boolean(fsApi?.readFileFromFileSystem && fsApi?.saveFileToFileSystem);
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.readFile) {
      const content = fileApi.readFile(filePath);
      if (typeof content === 'string') return content;
      return undefined;
    }
  } catch {
    // continue with fallback
  }

  try {
    const fsApi = anyEda()?.sys_FileSystem;
    if (!fsApi?.readFileFromFileSystem) return undefined;

    const file: File | undefined = await fsApi.readFileFromFileSystem(filePath);
    if (!file) return undefined;
    if (typeof file.text !== 'function') return undefined;
    return await file.text();
  } catch {
    return undefined;
  }
}

async function readLocalFile(filePath: string): Promise<File | undefined> {
  const fsApi = anyEda()?.sys_FileSystem;
  if (!fsApi?.readFileFromFileSystem) {
    throw new Error('current EDA does not support sys_FileSystem.readFileFromFileSystem');
  }
  const file: File | undefined = await fsApi.readFileFromFileSystem(String(filePath || ''));
  if (!file) throw new Error(`failed to read local file: ${filePath}`);
  return file;
}

async function writeTextFile(filePath: string, content: string): Promise<boolean> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.writeFile) {
      fileApi.writeFile(filePath, content);
      return true;
    }
  } catch {
    // continue with fallback
  }

  try {
    const fsApi = anyEda()?.sys_FileSystem;
    if (!fsApi?.saveFileToFileSystem) return false;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const ok = await fsApi.saveFileToFileSystem(filePath, blob, undefined, true);
    return Boolean(ok);
  } catch {
    return false;
  }
}

async function ensureBridgeDir(): Promise<void> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.mkdir) {
      fileApi.mkdir(BRIDGE_DIR);
    }
  } catch {
    // ignore
  }
}

function showInfo(content: string, title = APP_NAME): void {
  try {
    anyEda()?.sys_Dialog?.showInformationMessage?.(content, title);
    return;
  } catch {
    // fall through
  }

  try {
    (globalThis as any).alert?.(`${title}\n${content}`);
    return;
  } catch {
    // fall through
  }

  console.log(`[${APP_NAME}] ${title}: ${content}`);
}

function showError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  showInfo(`${title}\n${message}`, APP_NAME);
  console.error(`[${APP_NAME}]`, title, error);
}

function appendLog(message: string): void {
  void (async () => {
    await ensureBridgeDir();
    const line = `${new Date().toISOString()} ${message}\n`;
    const prev = (await readTextFile(LOG_FILE)) || '';
    await writeTextFile(LOG_FILE, prev + line);
  })();
}

function log(message: string): void {
  console.log(`[${APP_NAME}] ${message}`);
  appendLog(message);
}

function readEnabledPref(): boolean {
  try {
    const raw = anyEda()?.sys_Storage?.getExtensionUserConfig?.(ENABLED_STORAGE_KEY);
    return raw === true || raw === 'true' || raw === 1;
  } catch {
    return false;
  }
}

async function saveEnabledPref(enabled: boolean): Promise<void> {
  try {
    await anyEda()?.sys_Storage?.setExtensionUserConfig?.(ENABLED_STORAGE_KEY, enabled);
  } catch {
    // ignore
  }
}

function getTimerMode(): string {
  if (usingSysTimer) return 'sys_Timer';
  if (usingNativeTimer) return 'setInterval';
  return 'none';
}

function getFileApiMode(): string {
  const modes: string[] = [];
  if (hasLegacyFileApi()) modes.push('sys_File');
  if (hasFileSystemApi()) modes.push('sys_FileSystem');
  return modes.length ? modes.join(' + ') : 'none';
}

function readFirstStringValue(target: any, getterNames: string[]): string {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const raw = getter.call(target);
      if (typeof raw === 'string') {
        const text = raw.trim();
        if (text) return text;
      } else if (raw !== undefined && raw !== null) {
        const text = String(raw).trim();
        if (text) return text;
      }
    } catch {
      // ignore getter errors
    }
  }
  return '';
}

function readFirstNumberValue(target: any, getterNames: string[]): number | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const value = Number(getter.call(target));
      if (Number.isFinite(value)) return value;
    } catch {
      // ignore getter errors
    }
  }
  return undefined;
}

function readFirstBooleanValue(target: any, getterNames: string[]): boolean | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      return Boolean(getter.call(target));
    } catch {
      // ignore getter errors
    }
  }
  return undefined;
}

function normalizeNetArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const net = item.trim();
      if (net) dedup.add(net);
      continue;
    }

    if (item && typeof item === 'object') {
      const netRaw = (item as any).net;
      if (typeof netRaw === 'string') {
        const net = netRaw.trim();
        if (net) dedup.add(net);
      }
    }
  }
  return Array.from(dedup);
}

type Box = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function toFinite(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeAngle(angle: number): number {
  let value = toFinite(angle, 0);
  while (value <= -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

function createBoxFromCenter(x: number, y: number, width: number, height: number): Box {
  const halfW = Math.max(0, toFinite(width, 0) / 2);
  const halfH = Math.max(0, toFinite(height, 0) / 2);
  return {
    minX: x - halfW,
    minY: y - halfH,
    maxX: x + halfW,
    maxY: y + halfH,
  };
}

function isVerticalAngle(angle: number): boolean {
  const a = Math.abs(normalizeAngle(angle));
  return Math.abs(a - 90) <= 20;
}

function estimateStringBox(x: number, y: number, text: string, fontSize: number, rotation: number): Box {
  const content = String(text || '');
  const size = Math.max(1, toFinite(fontSize, 10));
  const estimatedWidth = Math.max(size * Math.max(content.length, 1) * 0.6, size * 0.8);
  const estimatedHeight = Math.max(size, 1);
  const width = isVerticalAngle(rotation) ? estimatedHeight : estimatedWidth;
  const height = isVerticalAngle(rotation) ? estimatedWidth : estimatedHeight;
  return createBoxFromCenter(x, y, width, height);
}

function boxIntersects(a: Box, b: Box, tolerance = 0): boolean {
  const t = Math.max(0, toFinite(tolerance, 0));
  if (a.maxX < b.minX - t) return false;
  if (a.minX > b.maxX + t) return false;
  if (a.maxY < b.minY - t) return false;
  if (a.minY > b.maxY + t) return false;
  return true;
}

function boxInside(inner: Box, outer: Box, margin = 0): boolean {
  const m = Math.max(0, toFinite(margin, 0));
  return (
    inner.minX >= outer.minX - m &&
    inner.minY >= outer.minY - m &&
    inner.maxX <= outer.maxX + m &&
    inner.maxY <= outer.maxY + m
  );
}

async function getBBoxOfPrimitive(primitive: any): Promise<Box | undefined> {
  try {
    const bbox = await anyEda()?.pcb_Primitive?.getPrimitivesBBox?.([primitive]);
    if (!bbox) return undefined;
    return {
      minX: toFinite((bbox as any).minX, NaN),
      minY: toFinite((bbox as any).minY, NaN),
      maxX: toFinite((bbox as any).maxX, NaN),
      maxY: toFinite((bbox as any).maxY, NaN),
    };
  } catch {
    return undefined;
  }
}

function firstBox(boxes: Array<Box | undefined>): Box | undefined {
  for (const box of boxes) {
    if (!box) continue;
    const ok =
      Number.isFinite(box.minX) &&
      Number.isFinite(box.minY) &&
      Number.isFinite(box.maxX) &&
      Number.isFinite(box.maxY);
    if (ok) return box;
  }
  return undefined;
}

function makeRectPolygonSource(x1: number, y1: number, x2: number, y2: number): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  return [minX, minY, 'L', maxX, minY, maxX, maxY, minX, maxY];
}

function makeRectPolygonSourceR(x1: number, y1: number, x2: number, y2: number): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return ['R', minX, maxY, width, height, 0, 0];
}

function waitMs(delay: number): Promise<void> {
  const ms = Number.isFinite(delay) && delay > 0 ? Math.floor(delay) : 0;
  if (!ms) return Promise.resolve();

  return new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') {
      setTimeout(() => resolve(), ms);
      return;
    }

    const timerApi = anyEda()?.sys_Timer;
    if (!timerApi?.setTimeoutTimer) {
      resolve();
      return;
    }

    const timerId = `jlc_bridge_wait_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    timerApi.setTimeoutTimer(timerId, ms, () => {
      try {
        resolve();
      } finally {
        try {
          timerApi.clearTimeoutTimer?.(timerId);
        } catch {
          // ignore
        }
      }
    });
  });
}

function encodeBase64FromArrayBuffer(buffer: ArrayBuffer): string {
  const maybeBuffer = (globalThis as any)?.Buffer;
  if (maybeBuffer?.from) {
    return maybeBuffer.from(buffer).toString('base64');
  }

  if (typeof btoa !== 'function') {
    throw new Error('base64 encoding unavailable');
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const mimeType = blob?.type || 'image/png';
  const buffer = await blob.arrayBuffer();
  const base64 = encodeBase64FromArrayBuffer(buffer);
  return `data:${mimeType};base64,${base64}`;
}

function readTabIdFromDocumentInfo(info: any): string | undefined {
  if (!info) return undefined;

  if (typeof info?.tabId === 'string' && info.tabId.trim()) {
    return info.tabId.trim();
  }

  if (typeof info?.getState_TabId === 'function') {
    try {
      const tabId = info.getState_TabId();
      if (typeof tabId === 'string' && tabId.trim()) {
        return tabId.trim();
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

async function resolveCaptureTabId(): Promise<string | undefined> {
  const api = anyEda();

  try {
    const currentDoc = await api?.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const tabId = readTabIdFromDocumentInfo(currentDoc);
    if (tabId) return tabId;
  } catch {
    // ignore
  }

  try {
    const boardInfo = await api?.dmt_Board?.getCurrentBoardInfo?.();
    const pcbUuid = String(boardInfo?.pcb?.uuid || '').trim();
    if (!pcbUuid) return undefined;

    try {
      const openedTabId = await api?.dmt_EditorControl?.openDocument?.(pcbUuid);
      if (typeof openedTabId === 'string' && openedTabId.trim()) {
        return openedTabId.trim();
      }
    } catch {
      // ignore open error
    }

    return pcbUuid;
  } catch {
    return undefined;
  }
}

async function tryCaptureRenderedAreaImageDataUrl(): Promise<string | undefined> {
  const api = anyEda();
  if (!api?.dmt_EditorControl?.getCurrentRenderedAreaImage) {
    return undefined;
  }

  const tabId = await resolveCaptureTabId();

  if (tabId && api?.dmt_EditorControl?.activateDocument) {
    try {
      await api.dmt_EditorControl.activateDocument(tabId);
    } catch {
      // ignore
    }
  }

  if (api?.dmt_EditorControl?.zoomToAllPrimitives) {
    try {
      await api.dmt_EditorControl.zoomToAllPrimitives(tabId);
    } catch {
      // ignore
    }
  }

  await waitMs(120);

  try {
    const blob: Blob | undefined = await api.dmt_EditorControl.getCurrentRenderedAreaImage(tabId);
    if (blob?.arrayBuffer) {
      return await blobToDataUrl(blob);
    }
  } catch {
    // ignore
  }

  try {
    const fallbackBlob: Blob | undefined = await api.dmt_EditorControl.getCurrentRenderedAreaImage();
    if (fallbackBlob?.arrayBuffer) {
      return await blobToDataUrl(fallbackBlob);
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function getBoardBoundingBox(): Promise<Box | undefined> {
  const api = anyEda();
  const layerCandidates = [api?.EPCB_LayerId?.BOARD_OUTLINE, 11].filter((item) => Number.isFinite(Number(item)));

  let merged: Box | undefined;
  for (const layer of layerCandidates) {
    try {
      const lines = await api?.pcb_PrimitiveLine?.getAll?.(undefined, Number(layer));
      const arcs = await api?.pcb_PrimitiveArc?.getAll?.(undefined, Number(layer));
      const polys = await api?.pcb_PrimitivePolyline?.getAll?.(undefined, Number(layer));
      const rows = [...(Array.isArray(lines) ? lines : []), ...(Array.isArray(arcs) ? arcs : []), ...(Array.isArray(polys) ? polys : [])];
      for (const row of rows) {
        const box = await getBBoxOfPrimitive(row);
        if (!box) continue;
        if (!merged) {
          merged = { ...box };
          continue;
        }
        merged.minX = Math.min(merged.minX, box.minX);
        merged.minY = Math.min(merged.minY, box.minY);
        merged.maxX = Math.max(merged.maxX, box.maxX);
        merged.maxY = Math.max(merged.maxY, box.maxY);
      }
      if (merged) return merged;
    } catch {
      // try next candidate
    }
  }

  try {
    const state = await getPCBState();
    if (state?.boardBounds) {
      return {
        minX: toFinite(state.boardBounds.minX, 0),
        minY: toFinite(state.boardBounds.minY, 0),
        maxX: toFinite(state.boardBounds.maxX, 100),
        maxY: toFinite(state.boardBounds.maxY, 100),
      };
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function getSelectedPrimitiveIdSet(): Promise<Set<string>> {
  const result = new Set<string>();
  try {
    const ids = await anyEda()?.pcb_SelectControl?.getAllSelectedPrimitives_PrimitiveId?.();
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && id.trim()) {
          result.add(id.trim());
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}

async function collectSilkscreenRows(): Promise<any[]> {
  const api = anyEda();
  const dedup = new Map<string, any>();
  const stringApi = api?.pcb_PrimitiveString;
  const tryPushRow = (row: any) => {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) return;
    dedup.set(primitiveId, row);
  };

  if (stringApi?.getAll) {
    for (const layer of [3, 4]) {
      try {
        const rows = await stringApi.getAll(layer);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            tryPushRow(row);
          }
        }
      } catch {
        // ignore layer read error
      }
    }

    if (dedup.size === 0) {
      try {
        const rows = await stringApi.getAll();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            tryPushRow(row);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (dedup.size > 0) {
    return Array.from(dedup.values());
  }

  try {
    const rows = await api?.pcb_Document?.getPrimitivesInRegion?.(-1_000_000, 1_000_000, 1_000_000, -1_000_000, false);
    if (!Array.isArray(rows)) return [];
    for (const row of rows) {
      const textGetter = row?.getState_Text;
      if (typeof textGetter !== 'function') continue;
      tryPushRow(row);
    }
  } catch {
    // ignore
  }

  return Array.from(dedup.values());
}

async function buildSilkscreenItem(row: any, selectedSet: Set<string>): Promise<any | null> {
  const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
  if (!primitiveId) return null;

  const text = readFirstStringValue(row, ['getState_Text', 'getState_Content']);
  const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX']);
  const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY']);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const rotation = toFinite(readFirstNumberValue(row, ['getState_Rotation']), 0);
  const fontSize = toFinite(readFirstNumberValue(row, ['getState_FontSize']), 10);
  const parentPrimitiveId = readFirstStringValue(row, ['getState_ParentPrimitiveId', 'getState_BelongPrimitiveId']);
  const layer = readFirstNumberValue(row, ['getState_Layer']);
  const locked = Boolean(readFirstBooleanValue(row, ['getState_PrimitiveLock']));

  const measuredBox = await getBBoxOfPrimitive(row);
  const estimatedBox = estimateStringBox(x, y, text, fontSize, rotation);
  const bbox = firstBox([measuredBox, estimatedBox]) || estimatedBox;

  return {
    primitiveId,
    text,
    x,
    y,
    rotation,
    fontSize,
    parentPrimitiveId: parentPrimitiveId || '',
    layer: Number.isFinite(layer) ? Number(layer) : undefined,
    locked,
    selected: selectedSet.has(primitiveId),
    bbox,
    width: bbox.maxX - bbox.minX,
    height: bbox.maxY - bbox.minY,
  };
}

function buildObstacleBoxFromPrimitiveRow(row: any, diameterGetterNames: string[]): Box | undefined {
  const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX']);
  const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY']);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  const diameter = readFirstNumberValue(row, diameterGetterNames);
  const size = Math.max(1, toFinite(diameter, 10));
  return createBoxFromCenter(x, y, size, size);
}

async function collectPadObstacleBoxes(limit = 10000): Promise<Array<{ primitiveId: string; net: string; box: Box }>> {
  const rows = await anyEda()?.pcb_PrimitivePad?.getAll?.();
  const result: Array<{ primitiveId: string; net: string; box: Box }> = [];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;
    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    const measuredBox = await getBBoxOfPrimitive(row);
    const estimatedBox = buildObstacleBoxFromPrimitiveRow(row, ['getState_Diameter', 'getState_PadDiameter']);
    const box = firstBox([measuredBox, estimatedBox]);
    if (!box) continue;
    result.push({ primitiveId, net, box });
    if (result.length >= limit) break;
  }
  return result;
}

async function collectViaObstacleBoxes(limit = 10000): Promise<Array<{ primitiveId: string; net: string; box: Box }>> {
  const rows = await anyEda()?.pcb_PrimitiveVia?.getAll?.();
  const result: Array<{ primitiveId: string; net: string; box: Box }> = [];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;
    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    const measuredBox = await getBBoxOfPrimitive(row);
    const estimatedBox = buildObstacleBoxFromPrimitiveRow(row, ['getState_Diameter']);
    const box = firstBox([measuredBox, estimatedBox]);
    if (!box) continue;
    result.push({ primitiveId, net, box });
    if (result.length >= limit) break;
  }
  return result;
}

async function detectSilkscreenConflicts(
  silkscreens: any[],
): Promise<{
  perSilk: Map<string, any[]>;
  stats: { totalConflicts: number; byType: Record<string, number> };
  boardBox?: Box;
}> {
  const padObstacles = await collectPadObstacleBoxes();
  const viaObstacles = await collectViaObstacleBoxes();
  const boardBox = await getBoardBoundingBox();
  const perSilk = new Map<string, any[]>();
  const byType: Record<string, number> = {};
  let totalConflicts = 0;

  const pushConflict = (silkId: string, conflict: any) => {
    if (!perSilk.has(silkId)) perSilk.set(silkId, []);
    perSilk.get(silkId)!.push(conflict);
    const key = String(conflict.type || 'unknown');
    byType[key] = (byType[key] || 0) + 1;
    totalConflicts += 1;
  };

  for (const silk of silkscreens) {
    const silkBox: Box | undefined = silk?.bbox;
    const silkId = String(silk?.primitiveId || '');
    if (!silkBox || !silkId) continue;

    if (boardBox && !boxInside(silkBox, boardBox, 0)) {
      pushConflict(silkId, {
        type: 'out_of_board',
        targetId: 'BOARD',
        description: 'silkscreen out of board',
      });
    }

    for (const pad of padObstacles) {
      if (boxIntersects(silkBox, pad.box, 0.5)) {
        pushConflict(silkId, {
          type: 'overlap_pad',
          targetId: pad.primitiveId,
          net: pad.net || '',
          description: 'silkscreen overlaps pad',
        });
      }
    }

    for (const via of viaObstacles) {
      if (boxIntersects(silkBox, via.box, 0.5)) {
        pushConflict(silkId, {
          type: 'overlap_via',
          targetId: via.primitiveId,
          net: via.net || '',
          description: 'silkscreen overlaps via',
        });
      }
    }
  }

  for (let i = 0; i < silkscreens.length; i += 1) {
    const a = silkscreens[i];
    const boxA: Box | undefined = a?.bbox;
    const idA = String(a?.primitiveId || '');
    if (!boxA || !idA) continue;

    for (let j = i + 1; j < silkscreens.length; j += 1) {
      const b = silkscreens[j];
      const boxB: Box | undefined = b?.bbox;
      const idB = String(b?.primitiveId || '');
      if (!boxB || !idB) continue;
      if (!boxIntersects(boxA, boxB, 0.5)) continue;

      pushConflict(idA, {
        type: 'overlap_silkscreen',
        targetId: idB,
        description: 'silkscreen overlaps silkscreen',
      });
      pushConflict(idB, {
        type: 'overlap_silkscreen',
        targetId: idA,
        description: 'silkscreen overlaps silkscreen',
      });
    }
  }

  return {
    perSilk,
    stats: {
      totalConflicts,
      byType,
    },
    boardBox: boardBox || undefined,
  };
}

async function getSilkscreens(params?: { includeConflicts?: boolean; onlyConflicted?: boolean; limit?: number }): Promise<any> {
  const rows = await collectSilkscreenRows();
  const selectedSet = await getSelectedPrimitiveIdSet();
  const limitRaw = toFinite(params?.limit, 20000);
  const limit = Math.max(1, Math.floor(limitRaw));

  const silkscreens: any[] = [];
  for (const row of rows) {
    const item = await buildSilkscreenItem(row, selectedSet);
    if (!item) continue;
    silkscreens.push(item);
    if (silkscreens.length >= limit) break;
  }

  const includeConflicts = Boolean(params?.includeConflicts || params?.onlyConflicted);
  if (!includeConflicts) {
    return {
      totalSilkscreens: silkscreens.length,
      returnedSilkscreens: silkscreens.length,
      silkscreens,
    };
  }

  const conflictResult = await detectSilkscreenConflicts(silkscreens);
  const onlyConflicted = Boolean(params?.onlyConflicted);
  const output = [];
  for (const item of silkscreens) {
    const conflicts = conflictResult.perSilk.get(item.primitiveId) || [];
    const next = {
      ...item,
      hasConflict: conflicts.length > 0,
      conflicts,
      conflictCount: conflicts.length,
    };
    if (!onlyConflicted || next.hasConflict) {
      output.push(next);
    }
  }

  return {
    totalSilkscreens: silkscreens.length,
    returnedSilkscreens: output.length,
    conflictSummary: conflictResult.stats,
    boardBox: conflictResult.boardBox || null,
    silkscreens: output,
  };
}

async function moveSilkscreen(params: { primitiveId: string; x: number; y: number; rotation?: number }): Promise<any> {
  const api = anyEda();
  if (!params?.primitiveId) throw new Error('primitiveId is required');
  if (!Number.isFinite(Number(params?.x)) || !Number.isFinite(Number(params?.y))) {
    throw new Error('x/y must be numbers');
  }
  if (!api?.pcb_PrimitiveString?.modify) {
    throw new Error('current EDA does not support silkscreen modify');
  }

  const property: any = {
    x: Number(params.x),
    y: Number(params.y),
  };
  if (params.rotation !== undefined) {
    property.rotation = Number(params.rotation);
  }

  await api.pcb_PrimitiveString.modify(String(params.primitiveId), property);
  return {
    primitiveId: String(params.primitiveId),
    x: Number(params.x),
    y: Number(params.y),
    rotation: params.rotation !== undefined ? Number(params.rotation) : undefined,
  };
}

function makeTranslatedSilkBox(item: any, x: number, y: number, rotation: number): Box {
  const w = Math.max(1, toFinite(item?.width, 10));
  const h = Math.max(1, toFinite(item?.height, 10));
  const vertical = isVerticalAngle(rotation);
  return createBoxFromCenter(x, y, vertical ? h : w, vertical ? w : h);
}

async function autoSilkscreen(params?: {
  maxMoves?: number;
  step?: number;
  maxRadius?: number;
  tryAngles?: number[];
  onlyConflicted?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveString?.modify) {
    throw new Error('current EDA does not support silkscreen modify');
  }

  const maxMoves = Math.max(1, Math.floor(toFinite(params?.maxMoves, 80)));
  const step = Math.max(2, toFinite(params?.step, 12));
  const maxRadius = Math.max(step, toFinite(params?.maxRadius, 96));
  const angleCandidatesBase = Array.isArray(params?.tryAngles) && params?.tryAngles.length > 0
    ? params!.tryAngles.map((a) => toFinite(a, 0))
    : [0, 90, 180, -90];

  const silkResult = await getSilkscreens({ includeConflicts: true, onlyConflicted: Boolean(params?.onlyConflicted) });
  const items: any[] = Array.isArray(silkResult?.silkscreens) ? silkResult.silkscreens : [];
  if (items.length === 0) {
    return {
      total: 0,
      moved: 0,
      improved: 0,
      skipped: 0,
      details: [],
    };
  }

  const padObstacles = await collectPadObstacleBoxes();
  const viaObstacles = await collectViaObstacleBoxes();
  const boardBox = (await getBoardBoundingBox()) || undefined;

  const fixedBoxes = new Map<string, Box>();
  for (const item of items) {
    if (item?.primitiveId && item?.bbox) {
      fixedBoxes.set(String(item.primitiveId), item.bbox as Box);
    }
  }

  const evaluateScore = (selfId: string, candidateBox: Box): number => {
    let score = 0;
    for (const pad of padObstacles) {
      if (boxIntersects(candidateBox, pad.box, 0.5)) score += 20;
    }
    for (const via of viaObstacles) {
      if (boxIntersects(candidateBox, via.box, 0.5)) score += 18;
    }
    for (const [otherId, otherBox] of fixedBoxes.entries()) {
      if (otherId === selfId) continue;
      if (boxIntersects(candidateBox, otherBox, 0.5)) score += 12;
    }
    if (boardBox && !boxInside(candidateBox, boardBox, 0)) {
      score += 50;
    }
    return score;
  };

  const sortItems = [...items].sort((a, b) => Number(b?.conflictCount || 0) - Number(a?.conflictCount || 0));
  const details: any[] = [];
  let moved = 0;
  let improved = 0;
  let skipped = 0;

  for (const item of sortItems) {
    if (moved >= maxMoves) break;
    const primitiveId = String(item?.primitiveId || '');
    if (!primitiveId || item?.locked) {
      skipped += 1;
      continue;
    }

    const originalX = toFinite(item.x, 0);
    const originalY = toFinite(item.y, 0);
    const originalRot = toFinite(item.rotation, 0);
    const originalBox = makeTranslatedSilkBox(item, originalX, originalY, originalRot);
    const originalScore = evaluateScore(primitiveId, originalBox);

    let best = {
      x: originalX,
      y: originalY,
      rotation: originalRot,
      score: originalScore,
      distance: 0,
    };

    const directionCandidates = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [0, 0],
    ];

    const tryAngles = Array.from(new Set([originalRot, ...angleCandidatesBase]));
    for (let radius = 0; radius <= maxRadius; radius += step) {
      for (const [dx, dy] of directionCandidates) {
        const x = round3(originalX + dx * radius);
        const y = round3(originalY + dy * radius);
        for (const rotation of tryAngles) {
          const box = makeTranslatedSilkBox(item, x, y, rotation);
          const score = evaluateScore(primitiveId, box);
          const distance = Math.hypot(x - originalX, y - originalY);
          if (score < best.score || (score === best.score && distance < best.distance)) {
            best = { x, y, rotation, score, distance };
          }
          if (best.score === 0 && best.distance <= step) {
            break;
          }
        }
      }
    }

    if (best.score < originalScore) {
      await api.pcb_PrimitiveString.modify(primitiveId, {
        x: best.x,
        y: best.y,
        rotation: best.rotation,
      });
      moved += 1;
      improved += 1;
      const finalBox = makeTranslatedSilkBox(item, best.x, best.y, best.rotation);
      fixedBoxes.set(primitiveId, finalBox);
      details.push({
        primitiveId,
        from: { x: originalX, y: originalY, rotation: originalRot, score: originalScore },
        to: { x: best.x, y: best.y, rotation: best.rotation, score: best.score },
      });
    } else {
      skipped += 1;
      details.push({
        primitiveId,
        from: { x: originalX, y: originalY, rotation: originalRot, score: originalScore },
        skipped: true,
      });
    }
  }

  return {
    total: sortItems.length,
    moved,
    improved,
    skipped,
    details,
  };
}

async function getPCBState(): Promise<any> {
  const api = anyEda();

  const components: any[] = [];
  if (api?.pcb_PrimitiveComponent?.getAll) {
    const rows = await api.pcb_PrimitiveComponent.getAll();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const primitiveId = row?.getState_PrimitiveId?.() || '';
        const designator = row?.getState_Designator?.() || '';
        if (!primitiveId || !designator) continue;

        components.push({
          primitiveId,
          designator,
          name: row?.getState_Name?.() || '',
          x: Number(row?.getState_X?.() ?? 0),
          y: Number(row?.getState_Y?.() ?? 0),
          rotation: Number(row?.getState_Rotation?.() ?? 0),
          width: Number(row?.getState_Width?.() ?? 0),
          height: Number(row?.getState_Height?.() ?? 0),
          layer: String(row?.getState_Layer?.() ?? ''),
          locked: Boolean(row?.getState_PrimitiveLock?.()),
          padNets: normalizeNetArray(row?.getState_Pads?.()),
        });
      }
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const c of components) {
    minX = Math.min(minX, c.x - c.width / 2);
    minY = Math.min(minY, c.y - c.height / 2);
    maxX = Math.max(maxX, c.x + c.width / 2);
    maxY = Math.max(maxY, c.y + c.height / 2);
  }

  const nets: any[] = [];
  if (api?.pcb_Net?.getAllNetsName) {
    const names = await api.pcb_Net.getAllNetsName();
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === 'string' && name.trim()) {
          const netName = name.trim();
          let length: number | undefined;
          try {
            length = await api.pcb_Net.getNetLength(netName);
          } catch {
            // ignore
          }
          nets.push({ name: netName, length });
        }
      }
    }
  }

  return {
    components,
    nets,
    boardBounds: {
      minX: minX === Number.POSITIVE_INFINITY ? 0 : minX,
      minY: minY === Number.POSITIVE_INFINITY ? 0 : minY,
      maxX: maxX === Number.NEGATIVE_INFINITY ? 100 : maxX,
      maxY: maxY === Number.NEGATIVE_INFINITY ? 100 : maxY,
    },
    layerCount: 2,
  };
}

async function getPads(params?: { nets?: string[] | string; limit?: number; includeBBox?: boolean }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePad?.getAll) {
    throw new Error('current EDA does not support pad query');
  }

  const rows = await api.pcb_PrimitivePad.getAll();
  const limitRaw = Number(params?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10000;
  const includeBBox = Boolean(params?.includeBBox);

  const netsInput = Array.isArray(params?.nets)
    ? params?.nets
    : typeof params?.nets === 'string'
    ? params.nets.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const netFilter = new Set<string>(netsInput.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean));

  const pads: any[] = [];
  for (const row of rows || []) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;

    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    if (netFilter.size > 0) {
      if (!net || !netFilter.has(net.toUpperCase())) {
        continue;
      }
    }

    const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX', 'getState_PosX']);
    const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY', 'getState_PosY']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    const layerRaw = readFirstNumberValue(row, ['getState_Layer']);
    const layer = Number.isFinite(layerRaw) ? Number(layerRaw) : undefined;

    const pad: any = {
      primitiveId,
      net: net || '',
      padNumber: readFirstStringValue(row, ['getState_PadNumber']),
      x,
      y,
      layer: layer !== undefined ? layer : String(readFirstStringValue(row, ['getState_Layer']) || ''),
      parentPrimitiveId: readFirstStringValue(row, [
        'getState_ParentPrimitiveId',
        'getState_BelongPrimitiveId',
        'getState_ComponentPrimitiveId',
      ]),
      designator: readFirstStringValue(row, ['getState_Designator']),
      locked: Boolean(readFirstBooleanValue(row, ['getState_PrimitiveLock'])),
      holeDiameter: readFirstNumberValue(row, ['getState_HoleDiameter', 'getState_DrillDiameter']),
      diameter: readFirstNumberValue(row, ['getState_Diameter', 'getState_PadDiameter']),
      shape: readFirstStringValue(row, ['getState_Shape', 'getState_PadShape']),
    };

    if (includeBBox) {
      try {
        const bbox = await api.pcb_Primitive.getPrimitivesBBox([row as any]);
        if (bbox) {
          pad.bbox = {
            minX: bbox.minX,
            minY: bbox.minY,
            maxX: bbox.maxX,
            maxY: bbox.maxY,
          };
        }
      } catch {
        // ignore bbox errors
      }
    }

    pads.push(pad);
    if (pads.length >= limit) break;
  }

  const netStats = new Map<string, number>();
  for (const item of pads) {
    const key = String(item.net || '').trim();
    if (!key) continue;
    netStats.set(key, (netStats.get(key) || 0) + 1);
  }

  const nets = Array.from(netStats.entries())
    .map(([name, padCount]) => ({ name, padCount }))
    .sort((a, b) => b.padCount - a.padCount);

  return {
    totalPads: Array.isArray(rows) ? rows.length : 0,
    returnedPads: pads.length,
    nets,
    pads,
  };
}

async function modifyPcbPad(params: {
  primitiveId: string;
  padNumber?: string;
  net?: string;
  x?: number;
  y?: number;
  rotation?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePad?.modify) {
    throw new Error('current EDA does not support pcb_PrimitivePad.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');

  const property: Record<string, any> = {};
  if (params?.padNumber !== undefined) property.padNumber = String(params.padNumber);
  if (params?.net !== undefined) property.net = String(params.net);
  if (params?.x !== undefined) property.x = toFinite(params.x, NaN);
  if (params?.y !== undefined) property.y = toFinite(params.y, NaN);
  if (params?.rotation !== undefined) property.rotation = toFinite(params.rotation, NaN);
  if (params?.primitiveLock !== undefined) property.primitiveLock = Boolean(params.primitiveLock);
  if (Object.keys(property).length === 0) throw new Error('no pad properties to modify');

  const result = await api.pcb_PrimitivePad.modify(primitiveId, property);
  return {
    primitiveId: getPrimitiveId(result) || primitiveId,
    property,
  };
}

async function deletePcbPad(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePad?.delete) {
    throw new Error('current EDA does not support pcb_PrimitivePad.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitivePad.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function moveComponent(params: { designator: string; x: number; y: number; rotation?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.getAll || !api?.pcb_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support component modify');
  }

  const rows = await api.pcb_PrimitiveComponent.getAll();
  let targetId: string | null = null;
  let targetRow: any = null;

  for (const row of rows) {
    const designator = row?.getState_Designator?.() || '';
    if (designator === params.designator) {
      targetId = row?.getState_PrimitiveId?.() || null;
      targetRow = row;
      break;
    }
  }

  if (!targetId) throw new Error(`component not found: ${params.designator}`);
  if (targetRow?.getState_PrimitiveLock?.()) {
    throw new Error(`component locked: ${params.designator}`);
  }

  await api.pcb_PrimitiveComponent.modify(targetId, {
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  });

  return {
    moved: params.designator,
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  };
}

function parsePrimitiveIds(params: any): string | string[] {
  if (Array.isArray(params?.primitiveIds)) {
    const ids = params.primitiveIds.map((item: any) => String(item || '').trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new Error('primitiveIds must not be empty');
    }
    return ids;
  }
  if (params?.primitiveId !== undefined) {
    const id = String(params.primitiveId || '').trim();
    if (!id) throw new Error('primitiveId must not be empty');
    return id;
  }
  if (params?.id !== undefined) {
    const id = String(params.id || '').trim();
    if (!id) throw new Error('id must not be empty');
    return id;
  }
  throw new Error('primitiveId or primitiveIds is required');
}

function getRectParams(params: any): { x1: number; y1: number; x2: number; y2: number } {
  const x1 = toFinite(params?.x1, NaN);
  const y1 = toFinite(params?.y1, NaN);
  const x2 = toFinite(params?.x2, NaN);
  const y2 = toFinite(params?.y2, NaN);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new Error('x1/y1/x2/y2 are required');
  }
  return { x1, y1, x2, y2 };
}

function getPrimitiveId(primitive: any): string {
  try {
    const id = primitive?.getState_PrimitiveId?.();
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    // ignore
  }
  return '';
}

function makeRectPolygon(params: { x1: number; y1: number; x2: number; y2: number }): any {
  const api = anyEda();
  const sourceLine = makeRectPolygonSource(params.x1, params.y1, params.x2, params.y2);
  const sourceRect = makeRectPolygonSourceR(params.x1, params.y1, params.x2, params.y2);
  const polygonByLine = api?.pcb_MathPolygon?.createPolygon?.(sourceLine as any);
  if (polygonByLine) return polygonByLine;
  const polygonByRect = api?.pcb_MathPolygon?.createPolygon?.(sourceRect as any);
  if (polygonByRect) return polygonByRect;
  throw new Error('failed to create rectangle polygon');
}

function buildRectPolygonCandidates(params: { x1: number; y1: number; x2: number; y2: number }): any[] {
  const api = anyEda();
  const sourceLine = makeRectPolygonSource(params.x1, params.y1, params.x2, params.y2);
  const sourceRect = makeRectPolygonSourceR(params.x1, params.y1, params.x2, params.y2);
  const list: any[] = [];

  const add = (item: any) => {
    if (!item) return;
    list.push(item);
  };

  add(api?.pcb_MathPolygon?.createPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createPolygon?.(sourceRect as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceRect as any));
  add(sourceLine as any);
  add(sourceRect as any);
  return list;
}

type PolygonPoint = {
  x: number;
  y: number;
};

function normalizePolygonPoints(points: any): PolygonPoint[] {
  if (!Array.isArray(points)) return [];
  const result: PolygonPoint[] = [];
  for (const point of points) {
    let x = NaN;
    let y = NaN;
    if (Array.isArray(point)) {
      x = toFinite(point[0], NaN);
      y = toFinite(point[1], NaN);
    } else if (point && typeof point === 'object') {
      x = toFinite((point as any).x, NaN);
      y = toFinite((point as any).y, NaN);
    }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      result.push({ x, y });
    }
  }
  return result;
}

function makePolygonSourceFromPoints(points: PolygonPoint[]): Array<number | string> {
  if (points.length < 3) {
    throw new Error('at least 3 polygon points are required');
  }
  const source: Array<number | string> = [points[0].x, points[0].y, 'L'];
  for (let index = 1; index < points.length; index += 1) {
    source.push(points[index].x, points[index].y);
  }
  return source;
}

function makeRoundedRectPolygonPoints(params: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius?: number;
  segments?: number;
}): PolygonPoint[] {
  const minX = Math.min(toFinite(params.x1), toFinite(params.x2));
  const maxX = Math.max(toFinite(params.x1), toFinite(params.x2));
  const minY = Math.min(toFinite(params.y1), toFinite(params.y2));
  const maxY = Math.max(toFinite(params.y1), toFinite(params.y2));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const radius = Math.max(0, Math.min(toFinite(params.radius, 0), width / 2, height / 2));
  const segments = Math.max(2, Math.min(24, Math.floor(toFinite(params.segments, 8))));
  if (radius <= 0) {
    return [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
  }

  const points: PolygonPoint[] = [];
  const pushArc = (cx: number, cy: number, startDeg: number, endDeg: number) => {
    for (let step = 0; step <= segments; step += 1) {
      const angle = ((startDeg + ((endDeg - startDeg) * step) / segments) * Math.PI) / 180;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const prev = points[points.length - 1];
      if (prev && Math.abs(prev.x - x) < 0.001 && Math.abs(prev.y - y) < 0.001) continue;
      points.push({ x, y });
    }
  };

  pushArc(maxX - radius, minY + radius, -90, 0);
  pushArc(maxX - radius, maxY - radius, 0, 90);
  pushArc(minX + radius, maxY - radius, 90, 180);
  pushArc(minX + radius, minY + radius, 180, 270);
  return points;
}

function buildPolygonCandidatesFromSource(source: Array<number | string>): any[] {
  const api = anyEda();
  const list: any[] = [];
  const add = (item: any) => {
    if (!item) return;
    list.push(item);
  };
  add(api?.pcb_MathPolygon?.createPolygon?.(source as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(source as any));
  add(source as any);
  return list;
}

async function createVia(params: {
  net: string;
  x: number;
  y: number;
  holeDiameter?: number;
  diameter?: number;
  viaType?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveVia?.create) {
    throw new Error('current EDA does not support via create');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');

  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y are required');

  const holeDiameter = Math.max(1, toFinite(params?.holeDiameter, 10));
  const diameter = Math.max(holeDiameter + 1, toFinite(params?.diameter, 22));
  const viaType = Number.isFinite(Number(params?.viaType)) ? Number(params.viaType) : undefined;
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const via = await api.pcb_PrimitiveVia.create(net, x, y, holeDiameter, diameter, viaType, undefined, undefined, primitiveLock);
  return {
    primitiveId: getPrimitiveId(via),
    net,
    x,
    y,
    holeDiameter,
    diameter,
    viaType: viaType ?? null,
  };
}

async function deleteVia(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveVia?.delete) {
    throw new Error('current EDA does not support via delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveVia.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createKeepoutRect(params: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer?: number;
  ruleTypes?: number[];
  regionName?: string;
  lineWidth?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveRegion?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('current EDA does not support region create');
  }

  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 12;
  const ruleTypes = Array.isArray(params?.ruleTypes) && params.ruleTypes.length > 0
    ? params.ruleTypes.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [2, 3, 5, 6, 7];
  const regionName = String(params?.regionName || `KEEP_OUT_${Date.now()}`);
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 4));
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const layerCandidates = Array.from(new Set([requestedLayer, 12, 1, 2].filter((item) => Number.isFinite(item))));
  const polygonCandidates = buildRectPolygonCandidates(rect);
  const ruleTypeCandidates: Array<any> = [];
  if (ruleTypes.length > 0) ruleTypeCandidates.push(ruleTypes);
  ruleTypeCandidates.push([5], [2, 3, 5, 6, 7], undefined);
  const nameCandidates = [regionName, undefined];
  const lineWidthCandidates = [lineWidth, undefined];

  let region: any = undefined;
  let usedLayer = requestedLayer;
  let usedRuleTypes: any = ruleTypes;
  let usedName: any = regionName;
  let usedLineWidth: any = lineWidth;
  let lastError: any = null;

  outer: for (const layer of layerCandidates) {
    for (const polygon of polygonCandidates) {
      for (const rt of ruleTypeCandidates) {
        for (const rn of nameCandidates) {
          for (const lw of lineWidthCandidates) {
            try {
              region = await api.pcb_PrimitiveRegion.create(layer, polygon, rt, rn, lw, primitiveLock);
              if (region) {
                usedLayer = layer;
                usedRuleTypes = rt;
                usedName = rn;
                usedLineWidth = lw;
                break outer;
              }
            } catch (error) {
              lastError = error;
            }
          }
        }
      }
    }
  }

  if (!region) {
    if (lastError) throw lastError;
    throw new Error('failed to create keepout region');
  }

  return {
    primitiveId: getPrimitiveId(region),
    layer: usedLayer,
    ruleTypes: Array.isArray(usedRuleTypes) ? usedRuleTypes : [],
    regionName: usedName || '',
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

async function deleteRegion(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveRegion?.delete) {
    throw new Error('current EDA does not support region delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveRegion.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createPourRect(params: {
  net: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer?: number;
  fillMethod?: string;
  preserveSilos?: boolean;
  pourName?: string;
  pourPriority?: number;
  lineWidth?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('current EDA does not support pour create');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');
  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1;
  const fillMethod = String(params?.fillMethod || 'solid').trim().toLowerCase();
  const preserveSilos = params?.preserveSilos !== undefined ? Boolean(params.preserveSilos) : false;
  const pourName = String(params?.pourName || `POUR_${net}_${Date.now()}`);
  const pourPriority = Math.max(1, Math.floor(toFinite(params?.pourPriority, 1)));
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 8));
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const layerCandidates = Array.from(new Set([requestedLayer, 1, 2].filter((item) => Number.isFinite(item))));
  const polygonCandidates = buildRectPolygonCandidates(rect);
  const fillMethodCandidates = Array.from(new Set([fillMethod, 'solid', undefined] as Array<any>));
  const preserveCandidates = Array.from(new Set([preserveSilos, false, true]));
  const nameCandidates = [pourName, undefined];
  const priorityCandidates = [pourPriority, undefined];
  const lineWidthCandidates = [lineWidth, undefined];

  let pour: any = undefined;
  let usedLayer = requestedLayer;
  let usedFillMethod: any = fillMethod;
  let usedPreserveSilos: any = preserveSilos;
  let usedName: any = pourName;
  let usedPriority: any = pourPriority;
  let usedLineWidth: any = lineWidth;
  let lastError: any = null;

  outer: for (const layer of layerCandidates) {
    for (const polygon of polygonCandidates) {
      for (const fm of fillMethodCandidates) {
        for (const ps of preserveCandidates) {
          for (const pn of nameCandidates) {
            for (const pp of priorityCandidates) {
              for (const lw of lineWidthCandidates) {
                try {
                  pour = await api.pcb_PrimitivePour.create(
                    net,
                    layer,
                    polygon,
                    fm,
                    ps,
                    pn,
                    pp,
                    lw,
                    primitiveLock,
                  );
                  if (pour) {
                    usedLayer = layer;
                    usedFillMethod = fm;
                    usedPreserveSilos = ps;
                    usedName = pn;
                    usedPriority = pp;
                    usedLineWidth = lw;
                    break outer;
                  }
                } catch (error) {
                  lastError = error;
                }
              }
            }
          }
        }
      }
    }
  }

  if (!pour) {
    if (lastError) throw lastError;
    throw new Error('failed to create pour');
  }

  return {
    primitiveId: getPrimitiveId(pour),
    net,
    layer: usedLayer,
    fillMethod: usedFillMethod || '',
    preserveSilos: Boolean(usedPreserveSilos),
    pourName: usedName || '',
    pourPriority: Number.isFinite(Number(usedPriority)) ? Number(usedPriority) : null,
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

async function deletePour(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.delete) {
    throw new Error('current EDA does not support pour delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitivePour.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function serializePour(row: any): Promise<any> {
  const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
  let copperRegion: any = null;
  if (typeof row?.getCopperRegion === 'function') {
    try {
      const region = await row.getCopperRegion();
      if (region) {
        copperRegion = {
          primitiveId: getPrimitiveId(region),
          bbox: await getBBoxOfPrimitive(region),
        };
      }
    } catch (error) {
      copperRegion = { error: errorToString(error) };
    }
  }

  return {
    primitiveId,
    net: readFirstStringValue(row, ['getState_Net', 'getState_NetName']),
    layer: readFirstNumberValue(row, ['getState_Layer']),
    fillMethod: readFirstStringValue(row, ['getState_PourFillMethod']),
    preserveSilos: readFirstBooleanValue(row, ['getState_PreserveSilos']),
    pourName: readFirstStringValue(row, ['getState_PourName']),
    pourPriority: readFirstNumberValue(row, ['getState_PourPriority']),
    lineWidth: readFirstNumberValue(row, ['getState_LineWidth']),
    primitiveLock: readFirstBooleanValue(row, ['getState_PrimitiveLock']),
    bbox: await getBBoxOfPrimitive(row),
    copperRegion,
  };
}

async function serializePoured(row: any): Promise<any> {
  const pourFillsRaw = typeof row?.getState_PourFills === 'function' ? row.getState_PourFills() : [];
  const pourFills = Array.isArray(pourFillsRaw)
    ? pourFillsRaw.map((fill: any) => ({
        id: String(fill?.id || ''),
        lineWidth: Number.isFinite(Number(fill?.lineWidth)) ? Number(fill.lineWidth) : null,
        fill: fill?.fill === undefined ? null : Boolean(fill.fill),
      }))
    : [];
  return {
    primitiveId: readFirstStringValue(row, ['getState_PrimitiveId']),
    pourPrimitiveId: readFirstStringValue(row, ['getState_PourPrimitiveId']),
    pourFillCount: pourFills.length,
    pourFills,
    bbox: await getBBoxOfPrimitive(row),
  };
}

async function serializePrimitiveFill(row: any): Promise<any> {
  return {
    primitiveId: readFirstStringValue(row, ['getState_PrimitiveId']),
    net: readFirstStringValue(row, ['getState_Net', 'getState_NetName']),
    layer: readFirstNumberValue(row, ['getState_Layer']),
    fillMode: readFirstStringValue(row, ['getState_FillMode']),
    lineWidth: readFirstNumberValue(row, ['getState_LineWidth']),
    primitiveLock: readFirstBooleanValue(row, ['getState_PrimitiveLock']),
    bbox: await getBBoxOfPrimitive(row),
  };
}

async function getPours(params?: {
  net?: string;
  layer?: number;
  includePoured?: boolean;
  includeFills?: boolean;
}): Promise<any> {
  const api = anyEda();
  const net = String(params?.net || '').trim() || undefined;
  const layer = Number.isFinite(Number(params?.layer)) ? Number(params!.layer) : undefined;
  const includePoured = params?.includePoured !== false;
  const includeFills = Boolean(params?.includeFills);

  const pours: any[] = [];
  if (api?.pcb_PrimitivePour?.getAll) {
    const rows = await api.pcb_PrimitivePour.getAll(net, layer);
    for (const row of Array.isArray(rows) ? rows : []) {
      pours.push(await serializePour(row));
    }
  }

  const poured: any[] = [];
  if (includePoured && api?.pcb_PrimitivePoured?.getAll) {
    const rows = await api.pcb_PrimitivePoured.getAll();
    for (const row of Array.isArray(rows) ? rows : []) {
      poured.push(await serializePoured(row));
    }
  }

  const fills: any[] = [];
  if (includeFills && api?.pcb_PrimitiveFill?.getAll) {
    const rows = await api.pcb_PrimitiveFill.getAll(layer, net);
    for (const row of Array.isArray(rows) ? rows : []) {
      fills.push(await serializePrimitiveFill(row));
    }
  }

  return {
    totalPours: pours.length,
    totalPoured: poured.length,
    totalFills: fills.length,
    pours,
    poured,
    fills,
  };
}

async function deletePoured(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePoured?.delete) {
    throw new Error('current EDA does not support poured copper delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitivePoured.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function deleteFills(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveFill?.delete) {
    throw new Error('current EDA does not support fill delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveFill.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function deleteAllPours(params?: {
  net?: string;
  layer?: number;
  includePoured?: boolean;
  includeLooseFills?: boolean;
}): Promise<any> {
  const api = anyEda();
  const includePoured = params?.includePoured !== false;
  const includeLooseFills = Boolean(params?.includeLooseFills);
  const before = await getPours({
    net: params?.net,
    layer: params?.layer,
    includePoured,
    includeFills: includeLooseFills,
  });

  const deleted: any = {
    poured: { attempted: 0, deleted: false, primitiveIds: [] as string[], error: '' },
    pours: { attempted: 0, deleted: false, primitiveIds: [] as string[], error: '' },
    fills: { attempted: 0, deleted: false, primitiveIds: [] as string[], error: '' },
  };

  const pouredIds = Array.isArray(before.poured)
    ? before.poured.map((item: any) => String(item?.primitiveId || '')).filter(Boolean)
    : [];
  if (includePoured && pouredIds.length > 0) {
    deleted.poured.attempted = pouredIds.length;
    deleted.poured.primitiveIds = pouredIds;
    if (api?.pcb_PrimitivePoured?.delete) {
      try {
        deleted.poured.deleted = Boolean(await api.pcb_PrimitivePoured.delete(pouredIds as any));
      } catch (error) {
        deleted.poured.error = errorToString(error);
      }
    } else {
      deleted.poured.error = 'pcb_PrimitivePoured.delete unavailable';
    }
  }

  const pourIds = Array.isArray(before.pours)
    ? before.pours.map((item: any) => String(item?.primitiveId || '')).filter(Boolean)
    : [];
  if (pourIds.length > 0) {
    deleted.pours.attempted = pourIds.length;
    deleted.pours.primitiveIds = pourIds;
    if (api?.pcb_PrimitivePour?.delete) {
      try {
        deleted.pours.deleted = Boolean(await api.pcb_PrimitivePour.delete(pourIds as any));
      } catch (error) {
        deleted.pours.error = errorToString(error);
      }
    } else {
      deleted.pours.error = 'pcb_PrimitivePour.delete unavailable';
    }
  }

  const fillIds = Array.isArray(before.fills)
    ? before.fills.map((item: any) => String(item?.primitiveId || '')).filter(Boolean)
    : [];
  if (includeLooseFills && fillIds.length > 0) {
    deleted.fills.attempted = fillIds.length;
    deleted.fills.primitiveIds = fillIds;
    if (api?.pcb_PrimitiveFill?.delete) {
      try {
        deleted.fills.deleted = Boolean(await api.pcb_PrimitiveFill.delete(fillIds as any));
      } catch (error) {
        deleted.fills.error = errorToString(error);
      }
    } else {
      deleted.fills.error = 'pcb_PrimitiveFill.delete unavailable';
    }
  }

  const after = await getPours({
    net: params?.net,
    layer: params?.layer,
    includePoured,
    includeFills: includeLooseFills,
  });
  return { before, deleted, after };
}

async function resolvePourRows(params?: { primitiveId?: string; primitiveIds?: string[]; net?: string; layer?: number }): Promise<any[]> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.get && !api?.pcb_PrimitivePour?.getAll) {
    throw new Error('current EDA does not support pour query');
  }

  if (params?.primitiveId || Array.isArray(params?.primitiveIds)) {
    const primitiveIds = parsePrimitiveIds(params);
    if (!api?.pcb_PrimitivePour?.get) {
      throw new Error('current EDA does not support pcb_PrimitivePour.get');
    }
    const rows = await api.pcb_PrimitivePour.get(primitiveIds as any);
    return Array.isArray(rows) ? rows : rows ? [rows] : [];
  }

  const net = String(params?.net || '').trim() || undefined;
  const layer = Number.isFinite(Number(params?.layer)) ? Number(params!.layer) : undefined;
  const rows = await api.pcb_PrimitivePour.getAll(net, layer);
  return Array.isArray(rows) ? rows : [];
}

async function rebuildPours(params?: { primitiveId?: string; primitiveIds?: string[]; net?: string; layer?: number }): Promise<any> {
  const rows = await resolvePourRows(params);
  const rebuilt: any[] = [];
  const errors: any[] = [];

  for (const row of rows) {
    const primitiveId = getPrimitiveId(row);
    if (typeof row?.rebuildCopperRegion !== 'function') {
      errors.push({ primitiveId, error: 'rebuildCopperRegion unavailable on this pour object' });
      continue;
    }
    try {
      const poured = await row.rebuildCopperRegion();
      rebuilt.push({
        primitiveId,
        poured: poured ? await serializePoured(poured) : null,
      });
    } catch (error) {
      errors.push({ primitiveId, error: errorToString(error) });
    }
  }

  return {
    totalPours: rows.length,
    rebuiltCount: rebuilt.length,
    errorCount: errors.length,
    rebuilt,
    errors,
  };
}

async function createPourPolygon(params: {
  net: string;
  points: any[];
  layer?: number;
  fillMethod?: string;
  preserveSilos?: boolean;
  pourName?: string;
  pourPriority?: number;
  lineWidth?: number;
  primitiveLock?: boolean;
  rebuild?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('current EDA does not support pour create');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');
  const points = normalizePolygonPoints(params?.points);
  if (points.length < 3) throw new Error('at least 3 valid points are required');

  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1;
  const fillMethod = String(params?.fillMethod || 'solid').trim().toLowerCase();
  const preserveSilos = params?.preserveSilos !== undefined ? Boolean(params.preserveSilos) : false;
  const pourName = String(params?.pourName || `POUR_${net}_${Date.now()}`);
  const pourPriority = Math.max(1, Math.floor(toFinite(params?.pourPriority, 1)));
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 8));
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;
  const source = makePolygonSourceFromPoints(points);

  const layerCandidates = Array.from(new Set([requestedLayer, 1, 2].filter((item) => Number.isFinite(item))));
  const polygonCandidates = buildPolygonCandidatesFromSource(source);
  const fillMethodCandidates = Array.from(new Set([fillMethod, 'solid', undefined] as Array<any>));
  const preserveCandidates = Array.from(new Set([preserveSilos, false, true]));
  const nameCandidates = [pourName, undefined];
  const priorityCandidates = [pourPriority, undefined];
  const lineWidthCandidates = [lineWidth, undefined];

  let pour: any = undefined;
  let usedLayer = requestedLayer;
  let usedFillMethod: any = fillMethod;
  let usedPreserveSilos: any = preserveSilos;
  let usedName: any = pourName;
  let usedPriority: any = pourPriority;
  let usedLineWidth: any = lineWidth;
  let lastError: any = null;

  outer: for (const layer of layerCandidates) {
    for (const polygon of polygonCandidates) {
      for (const fm of fillMethodCandidates) {
        for (const ps of preserveCandidates) {
          for (const pn of nameCandidates) {
            for (const pp of priorityCandidates) {
              for (const lw of lineWidthCandidates) {
                try {
                  pour = await api.pcb_PrimitivePour.create(
                    net,
                    layer,
                    polygon,
                    fm,
                    ps,
                    pn,
                    pp,
                    lw,
                    primitiveLock,
                  );
                  if (pour) {
                    usedLayer = layer;
                    usedFillMethod = fm;
                    usedPreserveSilos = ps;
                    usedName = pn;
                    usedPriority = pp;
                    usedLineWidth = lw;
                    break outer;
                  }
                } catch (error) {
                  lastError = error;
                }
              }
            }
          }
        }
      }
    }
  }

  if (!pour) {
    if (lastError) throw lastError;
    throw new Error('failed to create polygon pour');
  }

  const primitiveId = getPrimitiveId(pour);
  let rebuildResult: any = null;
  if (params?.rebuild !== false) {
    rebuildResult = await rebuildPours({ primitiveId });
  }

  return {
    primitiveId,
    net,
    layer: usedLayer,
    fillMethod: usedFillMethod || '',
    preserveSilos: Boolean(usedPreserveSilos),
    pourName: usedName || '',
    pourPriority: Number.isFinite(Number(usedPriority)) ? Number(usedPriority) : null,
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    pointCount: points.length,
    source,
    rebuild: rebuildResult,
  };
}

async function createPourRoundedRect(params: {
  net: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  inset?: number;
  radius?: number;
  segments?: number;
  layer?: number;
  fillMethod?: string;
  preserveSilos?: boolean;
  pourName?: string;
  pourPriority?: number;
  lineWidth?: number;
  primitiveLock?: boolean;
  rebuild?: boolean;
}): Promise<any> {
  let rect: { x1: number; y1: number; x2: number; y2: number };
  const hasExplicitRect = [params?.x1, params?.y1, params?.x2, params?.y2].every((value) => Number.isFinite(Number(value)));
  if (hasExplicitRect) {
    rect = getRectParams(params);
  } else {
    const boardBox = await getBoardBoundingBox();
    if (!boardBox) throw new Error('x1/y1/x2/y2 are required when board outline cannot be detected');
    const inset = Math.max(0, toFinite(params?.inset, 0));
    rect = {
      x1: boardBox.minX + inset,
      y1: boardBox.minY + inset,
      x2: boardBox.maxX - inset,
      y2: boardBox.maxY - inset,
    };
  }

  const points = makeRoundedRectPolygonPoints({
    ...rect,
    radius: params?.radius,
    segments: params?.segments,
  });
  const result = await createPourPolygon({
    ...params,
    points,
  });
  return {
    ...result,
    rect,
    radius: Math.max(0, toFinite(params?.radius, 0)),
    segments: Math.max(2, Math.min(24, Math.floor(toFinite(params?.segments, 8)))),
  };
}

async function createDifferentialPair(params: { name: string; positiveNet: string; negativeNet: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.createDifferentialPair) {
    throw new Error('current EDA does not support differential pair');
  }

  const name = String(params?.name || '').trim();
  const positiveNet = String(params?.positiveNet || '').trim();
  const negativeNet = String(params?.negativeNet || '').trim();
  if (!name || !positiveNet || !negativeNet) {
    throw new Error('name/positiveNet/negativeNet are required');
  }

  const ok = await api.pcb_Drc.createDifferentialPair(name, positiveNet, negativeNet);
  return { created: Boolean(ok), name, positiveNet, negativeNet };
}

async function deleteDifferentialPair(params: { name: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.deleteDifferentialPair) {
    throw new Error('current EDA does not support differential pair');
  }
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('name is required');
  const ok = await api.pcb_Drc.deleteDifferentialPair(name);
  return { deleted: Boolean(ok), name };
}

async function listDifferentialPairs(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.getAllDifferentialPairs) {
    throw new Error('current EDA does not support differential pair');
  }
  const rows = await api.pcb_Drc.getAllDifferentialPairs();
  const pairs = Array.isArray(rows)
    ? rows.map((row: any) => ({
        name: String(row?.name || ''),
        positiveNet: String(row?.positiveNet || ''),
        negativeNet: String(row?.negativeNet || ''),
      }))
    : [];
  return { totalPairs: pairs.length, pairs };
}

async function createEqualLengthGroup(params: {
  name: string;
  nets: string[];
  color?: { r: number; g: number; b: number; alpha: number };
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.createEqualLengthNetGroup) {
    throw new Error('current EDA does not support equal-length group');
  }
  const name = String(params?.name || '').trim();
  const nets = Array.isArray(params?.nets)
    ? params.nets.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!name || nets.length === 0) {
    throw new Error('name and nets are required');
  }
  const color = params?.color || { r: 255, g: 128, b: 0, alpha: 1 };
  const ok = await api.pcb_Drc.createEqualLengthNetGroup(name, nets, color);
  return { created: Boolean(ok), name, nets, color };
}

async function deleteEqualLengthGroup(params: { name: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.deleteEqualLengthNetGroup) {
    throw new Error('current EDA does not support equal-length group');
  }
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('name is required');
  const ok = await api.pcb_Drc.deleteEqualLengthNetGroup(name);
  return { deleted: Boolean(ok), name };
}

async function listEqualLengthGroups(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.getAllEqualLengthNetGroups) {
    throw new Error('current EDA does not support equal-length group');
  }
  const rows = await api.pcb_Drc.getAllEqualLengthNetGroups();
  const groups = Array.isArray(rows)
    ? rows.map((row: any) => ({
        name: String(row?.name || ''),
        nets: Array.isArray(row?.nets) ? row.nets : [],
        color: row?.color || null,
      }))
    : [];
  return { totalGroups: groups.length, groups };
}

// ─── Board / Schematic / Cross-document commands ───

async function getBoardInfo(): Promise<any> {
  const api = anyEda();
  if (!api?.dmt_Board?.getCurrentBoardInfo) {
    throw new Error('current EDA does not support dmt_Board.getCurrentBoardInfo');
  }
  const info = await api.dmt_Board.getCurrentBoardInfo();
  return {
    name: String(info?.name || info?.title || ''),
    schematicUuid: String(info?.schematicUuid || info?.schUuid || info?.sch_uuid || ''),
    pcbUuid: String(info?.pcbUuid || info?.pcb_uuid || ''),
  };
}

async function openDocument(params: { uuid: string }): Promise<any> {
  const api = anyEda();
  if (!api?.dmt_EditorControl?.openDocument) {
    throw new Error('current EDA does not support dmt_EditorControl.openDocument');
  }
  const uuid = String(params?.uuid || '').trim();
  if (!uuid) throw new Error('uuid is required');
  await api.dmt_EditorControl.openDocument(uuid);
  // Wait for document to load
  await new Promise(r => setTimeout(r, 500));
  return { opened: uuid };
}

async function getSchematicState(): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.getAll) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.getAll');
  }

  // Read all components across all schematic pages
  const rows = await api.sch_PrimitiveComponent.getAll(undefined, true);
  const components = (Array.isArray(rows) ? rows : []).map((r: any) => ({
    primitiveId: r?.getState_PrimitiveId?.() || '',
    designator: r?.getState_Designator?.() || '',
    name: r?.getState_Name?.() || r?.getState_DisplayName?.() || '',
    value: r?.getState_Value?.() || '',
    component: {
      libraryUuid: r?.getState_LibraryUuid?.() || r?.getState_ComponentLibraryUuid?.() || '',
      uuid: r?.getState_Uuid?.() || r?.getState_ComponentUuid?.() || '',
    },
  })).filter((c: any) => c.primitiveId);

  // Read pins
  let pins: any[] = [];
  if (api?.sch_PrimitivePin?.getAll) {
    try {
      const pinRows = await api.sch_PrimitivePin.getAll();
      pins = (Array.isArray(pinRows) ? pinRows : []).map((p: any) => ({
        primitiveId: p?.getState_PrimitiveId?.() || '',
        pinNumber: p?.getState_PinNumber?.() || p?.getState_Number?.() || '',
        pinName: p?.getState_PinName?.() || p?.getState_Name?.() || '',
        net: p?.getState_Net?.() || p?.getState_NetName?.() || '',
        x: Number(p?.getState_X?.() ?? 0),
        y: Number(p?.getState_Y?.() ?? 0),
      })).filter((p: any) => p.primitiveId);
    } catch { /* ignore */ }
  }

  // Read wires
  let wires: any[] = [];
  if (api?.sch_PrimitiveWire?.getAll) {
    try {
      const wireRows = await api.sch_PrimitiveWire.getAll();
      wires = (Array.isArray(wireRows) ? wireRows : []).map((w: any) => ({
        primitiveId: w?.getState_PrimitiveId?.() || '',
        net: w?.getState_Net?.() || w?.getState_NetName?.() || '',
        line: w?.getState_Line?.() || [],
      })).filter((w: any) => w.primitiveId);
    } catch { /* ignore */ }
  }

  let texts: any[] = [];
  if (api?.sch_PrimitiveText?.getAll) {
    try {
      const textRows = await api.sch_PrimitiveText.getAll();
      texts = (Array.isArray(textRows) ? textRows : []).map((t: any) => ({
        primitiveId: t?.getState_PrimitiveId?.() || '',
        content: t?.getState_Content?.() || '',
        x: Number(t?.getState_X?.() ?? 0),
        y: Number(t?.getState_Y?.() ?? 0),
        rotation: Number(t?.getState_Rotation?.() ?? 0),
      })).filter((t: any) => t.primitiveId);
    } catch { /* ignore */ }
  }

  return { components, pins, wires, texts };
}

function serializeSchComponent(component: any): any {
  const item: any = describeObject(component);
  try {
    item.primitiveId = component?.getState_PrimitiveId?.() || item.primitiveId || '';
    item.designator = component?.getState_Designator?.() || '';
    item.name = component?.getState_Name?.() || '';
    item.x = component?.getState_X?.();
    item.y = component?.getState_Y?.();
    item.rotation = component?.getState_Rotation?.();
    item.component = component?.getState_Component?.();
    item.footprint = component?.getState_Footprint?.();
  } catch {
    // ignore
  }
  return item;
}

function serializeSchPins(pins: any[] | undefined): any[] {
  return (Array.isArray(pins) ? pins : []).map((pin: any) => {
    const item: any = {};
    for (const [key, methods] of Object.entries({
      primitiveId: ['getState_PrimitiveId'],
      pinNumber: ['getState_PinNumber', 'getState_Number'],
      pinName: ['getState_PinName', 'getState_Name'],
      net: ['getState_Net', 'getState_NetName'],
      x: ['getState_X'],
      y: ['getState_Y'],
      rotation: ['getState_Rotation'],
    } as Record<string, string[]>)) {
      for (const method of methods) {
        try {
          if (typeof pin?.[method] === 'function') {
            item[key] = pin[method]();
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    return item;
  });
}

async function createSchematicComponent(params: {
  component: { libraryUuid: string; uuid: string };
  x: number;
  y: number;
  designator?: string;
  name?: string;
  rotation?: number;
  mirror?: boolean;
  addIntoBom?: boolean;
  addIntoPcb?: boolean;
  otherProperty?: Record<string, any>;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.create) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.create');
  }
  const component = params?.component;
  if (!component?.libraryUuid || !component?.uuid) {
    throw new Error('component.libraryUuid and component.uuid are required');
  }
  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y are required');

  const created = await api.sch_PrimitiveComponent.create(
    { libraryUuid: component.libraryUuid, uuid: component.uuid },
    x,
    y,
    undefined,
    toFinite(params?.rotation, 0),
    Boolean(params?.mirror),
    params?.addIntoBom !== undefined ? Boolean(params.addIntoBom) : true,
    params?.addIntoPcb !== undefined ? Boolean(params.addIntoPcb) : true,
  );
  if (!created) throw new Error('failed to create schematic component');
  const primitiveId = created?.getState_PrimitiveId?.() || '';
  const property: Record<string, any> = {};
  if (params?.designator !== undefined) property.designator = String(params.designator);
  if (params?.name !== undefined) property.name = String(params.name);
  if (params?.otherProperty !== undefined) property.otherProperty = params.otherProperty;
  if (Object.keys(property).length > 0 && api?.sch_PrimitiveComponent?.modify) {
    await api.sch_PrimitiveComponent.modify(primitiveId || created, property);
  }
  let current = created;
  if (primitiveId && api?.sch_PrimitiveComponent?.get) {
    try {
      current = await api.sch_PrimitiveComponent.get(primitiveId);
    } catch {
      // ignore
    }
  }
  let pins: any[] = [];
  try {
    pins = serializeSchPins(await current?.getAllPins?.());
  } catch {
    if (primitiveId && api?.sch_PrimitiveComponent?.getAllPinsByPrimitiveId) {
      try {
        pins = serializeSchPins(await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId));
      } catch {
        // ignore
      }
    }
  }
  return {
    component: serializeSchComponent(current || created),
    pins,
  };
}

async function createSchematicWire(params: {
  line: number[] | number[][];
  net?: string;
  color?: string | null;
  lineWidth?: number | null;
  lineType?: number | null;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveWire?.create) {
    throw new Error('current EDA does not support sch_PrimitiveWire.create');
  }
  const line = params?.line;
  if (!Array.isArray(line) || line.length === 0) throw new Error('line is required');
  const wire = await api.sch_PrimitiveWire.create(
    line as any,
    params?.net !== undefined ? String(params.net) : undefined,
    params?.color ?? null,
    params?.lineWidth ?? null,
    params?.lineType ?? null,
  );
  return serializeValue(wire);
}

async function modifySchematicWire(params: {
  primitiveId: string;
  line?: number[] | number[][];
  net?: string;
  color?: string | null;
  lineWidth?: number | null;
  lineType?: number | null;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveWire?.modify) {
    throw new Error('current EDA does not support sch_PrimitiveWire.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  const property: Record<string, any> = {};
  if (params?.line !== undefined) property.line = params.line;
  if (params?.net !== undefined) property.net = String(params.net);
  if (params?.color !== undefined) property.color = params.color;
  if (params?.lineWidth !== undefined) property.lineWidth = params.lineWidth;
  if (params?.lineType !== undefined) property.lineType = params.lineType;
  if (Object.keys(property).length === 0) throw new Error('no wire properties to modify');
  return serializeValue(await api.sch_PrimitiveWire.modify(primitiveId, property));
}

async function deleteSchematicWire(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveWire?.delete) {
    throw new Error('current EDA does not support sch_PrimitiveWire.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.sch_PrimitiveWire.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createSchematicText(params: {
  x: number;
  y: number;
  content: string;
  rotation?: number;
  textColor?: string | null;
  fontName?: string | null;
  fontSize?: number | null;
  bold?: boolean;
  italic?: boolean;
  underLine?: boolean;
  alignMode?: number;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveText?.create) {
    throw new Error('current EDA does not support sch_PrimitiveText.create');
  }
  const content = String(params?.content || '');
  if (!content) throw new Error('content is required');
  const result = await api.sch_PrimitiveText.create(
    toFinite(params?.x, 0),
    toFinite(params?.y, 0),
    content,
    toFinite(params?.rotation, 0),
    params?.textColor ?? null,
    params?.fontName ?? null,
    params?.fontSize ?? null,
    Boolean(params?.bold),
    Boolean(params?.italic),
    Boolean(params?.underLine),
    Number.isFinite(Number(params?.alignMode)) ? Number(params.alignMode) : 0,
  );
  return serializeValue(result);
}

async function modifySchematicText(params: {
  primitiveId: string;
  x?: number;
  y?: number;
  content?: string;
  rotation?: number;
  textColor?: string | null;
  fontName?: string | null;
  fontSize?: number | null;
  bold?: boolean;
  italic?: boolean;
  underLine?: boolean;
  alignMode?: number;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveText?.modify) {
    throw new Error('current EDA does not support sch_PrimitiveText.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  const property: Record<string, any> = {};
  for (const key of ['x', 'y', 'content', 'rotation', 'textColor', 'fontName', 'fontSize', 'bold', 'italic', 'underLine', 'alignMode']) {
    if ((params as any)?.[key] !== undefined) property[key] = (params as any)[key];
  }
  if (Object.keys(property).length === 0) throw new Error('no text properties to modify');
  return serializeValue(await api.sch_PrimitiveText.modify(primitiveId, property));
}

async function deleteSchematicText(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveText?.delete) {
    throw new Error('current EDA does not support sch_PrimitiveText.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.sch_PrimitiveText.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function modifySchematicComponent(params: {
  primitiveId: string;
  x?: number;
  y?: number;
  rotation?: number;
  mirror?: boolean;
  addIntoBom?: boolean;
  addIntoPcb?: boolean;
  designator?: string | null;
  name?: string | null;
  uniqueId?: string | null;
  manufacturer?: string | null;
  manufacturerId?: string | null;
  supplier?: string | null;
  supplierId?: string | null;
  otherProperty?: Record<string, any>;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  const property: Record<string, any> = {};
  for (const key of ['x', 'y', 'rotation', 'mirror', 'addIntoBom', 'addIntoPcb', 'designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId', 'otherProperty']) {
    if ((params as any)?.[key] !== undefined) property[key] = (params as any)[key];
  }
  if (Object.keys(property).length === 0) throw new Error('no component properties to modify');
  return serializeValue(await api.sch_PrimitiveComponent.modify(primitiveId, property));
}

async function deleteSchematicComponent(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.delete) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.sch_PrimitiveComponent.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function getSchematicComponentPins(params: { primitiveId: string }): Promise<any> {
  const api = anyEda();
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  if (!api?.sch_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.getAllPinsByPrimitiveId');
  }
  const pins = await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
  return { primitiveId, pins: serializeSchPins(pins) };
}

async function createSchematicNetPort(params: {
  direction?: 'IN' | 'OUT' | 'BI';
  net: string;
  x: number;
  y: number;
  rotation?: number;
  mirror?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.createNetPort) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.createNetPort');
  }
  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');
  const result = await api.sch_PrimitiveComponent.createNetPort(
    params?.direction || 'BI',
    net,
    toFinite(params?.x, 0),
    toFinite(params?.y, 0),
    toFinite(params?.rotation, 0),
    Boolean(params?.mirror),
  );
  return serializeValue(result);
}

async function createSchematicNetFlag(params: {
  identification?: 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround';
  net: string;
  x: number;
  y: number;
  rotation?: number;
  mirror?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.createNetFlag) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.createNetFlag');
  }
  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');
  const result = await api.sch_PrimitiveComponent.createNetFlag(
    params?.identification || (net.toUpperCase() === 'GND' ? 'Ground' : 'Power'),
    net,
    toFinite(params?.x, 0),
    toFinite(params?.y, 0),
    toFinite(params?.rotation, 0),
    Boolean(params?.mirror),
  );
  return serializeValue(result);
}

async function importPcbChanges(params?: { schematicUuid?: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Document?.importChanges) {
    throw new Error('current EDA does not support pcb_Document.importChanges');
  }
  const ok = await api.pcb_Document.importChanges(params?.schematicUuid);
  return { imported: Boolean(ok) };
}

async function importSchematicChanges(): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Document?.importChanges) {
    throw new Error('current EDA does not support sch_Document.importChanges');
  }
  const ok = await api.sch_Document.importChanges();
  return { imported: Boolean(ok) };
}

async function saveSchematicDocument(): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Document?.save) {
    throw new Error('current EDA does not support sch_Document.save');
  }
  const ok = await api.sch_Document.save();
  return { saved: Boolean(ok) };
}

async function findCurrentPcbUuid(): Promise<string> {
  const api = anyEda();
  try {
    const board = await api?.dmt_Board?.getCurrentBoardInfo?.();
    const uuid = String(board?.pcbUuid || board?.pcb_uuid || '');
    if (uuid) return uuid;
  } catch {
    // fallback below
  }
  try {
    const project = await api?.dmt_Project?.getCurrentProjectInfo?.();
    const boards = Array.isArray(project?.data) ? project.data : [];
    for (const board of boards) {
      const uuid = String(board?.pcb?.uuid || board?.pcbUuid || '');
      if (uuid) return uuid;
    }
  } catch {
    // ignore
  }
  return '';
}

async function savePcbDocument(params?: { uuid?: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Document?.save) {
    throw new Error('current EDA does not support pcb_Document.save');
  }
  const uuid = String(params?.uuid || await findCurrentPcbUuid()).trim();
  if (!uuid) throw new Error('pcb uuid is required');
  const ok = await api.pcb_Document.save(uuid);
  return { saved: Boolean(ok), uuid };
}

async function getNetlist(params: { type?: string }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Netlist?.getNetlist) {
    throw new Error('current EDA does not support sch_Netlist.getNetlist');
  }
  const netlist = await api.sch_Netlist.getNetlist(params?.type);
  return { netlist: typeof netlist === 'string' ? netlist : JSON.stringify(netlist) };
}

async function runSchDrc(params: { strict?: boolean }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Drc?.check) {
    throw new Error('current EDA does not support sch_Drc.check');
  }
  const strict = params?.strict !== false;
  const result = await api.sch_Drc.check(strict, false);
  return { passed: Boolean(result) };
}

async function getSchematicNets(): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Net?.getAllNetsName && !api?.sch_Net?.getAllNets) {
    throw new Error('current EDA does not support schematic net query');
  }
  const names = api?.sch_Net?.getAllNetsName ? await api.sch_Net.getAllNetsName() : [];
  const nets = api?.sch_Net?.getAllNets ? await api.sch_Net.getAllNets() : [];
  return { names: serializeValue(names), nets: serializeValue(nets) };
}

async function setSchematicNetlist(params: { type?: string; netlist: string }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Netlist?.setNetlist) {
    throw new Error('current EDA does not support sch_Netlist.setNetlist');
  }
  const netlist = String(params?.netlist || '');
  if (!netlist) throw new Error('netlist is required');
  await api.sch_Netlist.setNetlist(params?.type, netlist);
  return { set: true, type: params?.type || null, length: netlist.length };
}

async function createPcbComponent(params: {
  component: { libraryUuid: string; uuid: string };
  layer: number;
  x: number;
  y: number;
  rotation?: number;
  designator?: string;
  name?: string;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.create) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.create');
  }
  const { component, layer, x, y, rotation } = params;
  if (!component?.libraryUuid || !component?.uuid) {
    throw new Error('component.libraryUuid and component.uuid are required');
  }
  const result = await api.pcb_PrimitiveComponent.create(
    { libraryUuid: component.libraryUuid, uuid: component.uuid },
    layer, x, y, rotation ?? 0, false,
  );
  const primitiveId = result?.getState_PrimitiveId?.() || result?.primitiveId || '';
  if (primitiveId && (params?.designator !== undefined || params?.name !== undefined) && api?.pcb_PrimitiveComponent?.modify) {
    const property: Record<string, any> = {};
    if (params?.designator !== undefined) property.designator = String(params.designator);
    if (params?.name !== undefined) property.name = String(params.name);
    await api.pcb_PrimitiveComponent.modify(primitiveId, property);
  }
  return serializePcbComponent(result);
}

function serializePcbComponent(component: any): any {
  if (!component) return null;
  const item: any = {};
  const getters: Record<string, string> = {
    primitiveId: 'getState_PrimitiveId',
    layer: 'getState_Layer',
    x: 'getState_X',
    y: 'getState_Y',
    rotation: 'getState_Rotation',
    locked: 'getState_PrimitiveLock',
    addIntoBom: 'getState_AddIntoBom',
    designator: 'getState_Designator',
    name: 'getState_Name',
    uniqueId: 'getState_UniqueId',
    manufacturer: 'getState_Manufacturer',
    manufacturerId: 'getState_ManufacturerId',
    supplier: 'getState_Supplier',
    supplierId: 'getState_SupplierId',
  };
  for (const [key, method] of Object.entries(getters)) {
    try {
      if (typeof component?.[method] === 'function') item[key] = component[method]();
    } catch {
      // ignore
    }
  }
  try { item.component = component?.getState_Component?.(); } catch { /* ignore */ }
  try { item.footprint = component?.getState_Footprint?.(); } catch { /* ignore */ }
  try { item.model3D = component?.getState_Model3D?.(); } catch { /* ignore */ }
  try { item.pads = component?.getState_Pads?.() || []; } catch { /* ignore */ }
  return item;
}

async function getPcbComponents(params?: { layer?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.getAll) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.getAll');
  }
  const layer = Number.isFinite(Number(params?.layer)) ? Number(params?.layer) : undefined;
  const rows = await api.pcb_PrimitiveComponent.getAll(layer);
  return {
    totalComponents: Array.isArray(rows) ? rows.length : 0,
    components: (Array.isArray(rows) ? rows : []).map((row: any) => serializePcbComponent(row)).filter(Boolean),
  };
}

async function getPcbNets(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Net?.getAllNetsName && !api?.pcb_Net?.getAllNets) {
    throw new Error('current EDA does not support PCB net query');
  }
  const names = api?.pcb_Net?.getAllNetsName ? await api.pcb_Net.getAllNetsName() : [];
  const nets = api?.pcb_Net?.getAllNets ? await api.pcb_Net.getAllNets() : [];
  const lengths: Record<string, any> = {};
  if (Array.isArray(names) && api?.pcb_Net?.getNetLength) {
    for (const name of names) {
      try {
        lengths[String(name)] = await api.pcb_Net.getNetLength(String(name));
      } catch {
        // ignore
      }
    }
  }
  return { names: serializeValue(names), nets: serializeValue(nets), lengths };
}

async function getApiPaths(params: { paths: string[] }): Promise<any> {
  const api = anyEda();
  const paths = Array.isArray(params?.paths) ? params.paths : [];
  if (paths.length === 0) throw new Error('paths is required');
  const result: Record<string, any> = {};
  for (const path of paths.slice(0, 200)) {
    const parts = String(path).split('.').filter(Boolean);
    let value: any = api;
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined || value === null) break;
    }
    result[path] = {
      exists: value !== undefined && value !== null,
      type: typeof value,
      keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 100) : undefined,
    };
  }
  return result;
}

async function getPcbComponentPins(params: { primitiveId: string }): Promise<any> {
  const api = anyEda();
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  if (!api?.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.getAllPinsByPrimitiveId');
  }
  const rows = await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
  const pins = (Array.isArray(rows) ? rows : []).map((pad: any) => ({
    primitiveId: pad?.getState_PrimitiveId?.() || '',
    padNumber: pad?.getState_PadNumber?.() || '',
    net: pad?.getState_Net?.() || '',
    layer: pad?.getState_Layer?.(),
    x: pad?.getState_X?.(),
    y: pad?.getState_Y?.(),
  }));
  return { primitiveId, pins };
}

async function modifyPcbComponent(params: {
  primitiveId: string;
  layer?: number;
  x?: number;
  y?: number;
  rotation?: number;
  primitiveLock?: boolean;
  addIntoBom?: boolean;
  designator?: string | null;
  name?: string | null;
  uniqueId?: string | null;
  manufacturer?: string | null;
  manufacturerId?: string | null;
  supplier?: string | null;
  supplierId?: string | null;
  otherProperty?: Record<string, any>;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  const property: Record<string, any> = {};
  for (const key of ['layer', 'x', 'y', 'rotation', 'primitiveLock', 'addIntoBom', 'designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId', 'otherProperty']) {
    if ((params as any)?.[key] !== undefined) property[key] = (params as any)[key];
  }
  if (Object.keys(property).length === 0) throw new Error('no component properties to modify');
  const result = await api.pcb_PrimitiveComponent.modify(primitiveId, property);
  return serializePcbComponent(result);
}

async function deletePcbComponent(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.delete) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveComponent.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createPcbDocument(params?: {
  projectFriendlyName?: string;
  projectName?: string;
  boardName?: string;
  createProject?: boolean;
}): Promise<any> {
  const api = anyEda();
  const friendlyName = String(params?.projectFriendlyName || 'mp3120_boost_converter').trim();
  const projectName = String(params?.projectName || friendlyName.replace(/[^a-zA-Z0-9-]/g, '-')).trim();
  const boardName = String(params?.boardName || friendlyName).trim();
  const shouldCreateProject = params?.createProject !== false;

  let projectUuid = '';
  if (shouldCreateProject && api?.dmt_Project?.createProject) {
    projectUuid = (await api.dmt_Project.createProject(friendlyName, projectName)) || '';
    if (projectUuid && api?.dmt_Project?.openProject) {
      await api.dmt_Project.openProject(projectUuid);
    }
  }

  let schematicUuid = '';
  if (api?.dmt_Schematic?.createSchematic) {
    schematicUuid = (await api.dmt_Schematic.createSchematic(boardName)) || '';
    if (schematicUuid && api?.dmt_Schematic?.createSchematicPage) {
      await api.dmt_Schematic.createSchematicPage(schematicUuid);
    }
  }

  let pcbUuid = '';
  if (api?.dmt_Pcb?.createPcb) {
    pcbUuid = (await api.dmt_Pcb.createPcb(boardName)) || '';
  } else {
    throw new Error('current EDA does not support dmt_Pcb.createPcb');
  }

  let createdBoardName = '';
  if (api?.dmt_Board?.createBoard) {
    createdBoardName = (await api.dmt_Board.createBoard(schematicUuid || undefined, pcbUuid || undefined)) || '';
  }

  let tabId = '';
  if (pcbUuid && api?.dmt_EditorControl?.openDocument) {
    tabId = (await api.dmt_EditorControl.openDocument(pcbUuid)) || '';
  }

  return { projectUuid, schematicUuid, pcbUuid, boardName: createdBoardName || boardName, tabId };
}

async function createPcbPad(params: {
  layer?: number;
  padNumber?: string;
  x: number;
  y: number;
  rotation?: number;
  shape?: string;
  width?: number;
  height?: number;
  radius?: number;
  net?: string;
  holeShape?: string;
  holeDiameter?: number;
  holeLength?: number;
  metallization?: boolean;
  padType?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePad?.create) {
    throw new Error('current EDA does not support pcb_PrimitivePad.create');
  }
  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y are required');

  const shapeName = String(params?.shape || 'RECT').toUpperCase();
  const width = Math.max(1, toFinite(params?.width, 40));
  const height = Math.max(1, toFinite(params?.height, 40));
  const round = Math.max(0, toFinite(params?.radius, 0));
  const padShape = shapeName === 'ELLIPSE' || shapeName === 'OVAL'
    ? [shapeName === 'OVAL' ? 'OVAL' : 'ELLIPSE', width, height]
    : ['RECT', width, height, round];

  let hole: any = null;
  const holeDiameter = toFinite(params?.holeDiameter, 0);
  if (holeDiameter > 0) {
    const holeShape = String(params?.holeShape || 'ROUND').toUpperCase();
    hole = holeShape === 'SLOT'
      ? ['SLOT', holeDiameter, Math.max(holeDiameter, toFinite(params?.holeLength, holeDiameter))]
      : ['ROUND', holeDiameter];
  }

  const pad = await api.pcb_PrimitivePad.create(
    Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1,
    String(params?.padNumber || ''),
    x,
    y,
    toFinite(params?.rotation, 0),
    padShape,
    String(params?.net || ''),
    hole,
    0,
    0,
    0,
    params?.metallization !== undefined ? Boolean(params.metallization) : Boolean(hole),
    Number.isFinite(Number(params?.padType)) ? Number(params.padType) : 0,
    undefined,
    null,
    null,
    params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false,
  );
  return {
    primitiveId: getPrimitiveId(pad),
    layer: Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1,
    padNumber: String(params?.padNumber || ''),
    x,
    y,
    net: String(params?.net || ''),
  };
}

async function createPcbText(params: {
  layer?: number;
  x: number;
  y: number;
  text: string;
  fontFamily?: string;
  fontSize?: number;
  lineWidth?: number;
  alignMode?: number;
  rotation?: number;
  reverse?: boolean;
  expansion?: number;
  mirror?: boolean;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveString?.create) {
    throw new Error('current EDA does not support pcb_PrimitiveString.create');
  }
  const text = String(params?.text || '');
  if (!text) throw new Error('text is required');
  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y are required');
  const result = await api.pcb_PrimitiveString.create(
    Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 3,
    x,
    y,
    text,
    String(params?.fontFamily || 'Arial'),
    Math.max(1, toFinite(params?.fontSize, 40)),
    Math.max(0, toFinite(params?.lineWidth, 6)),
    Number.isFinite(Number(params?.alignMode)) ? Number(params.alignMode) : 5,
    toFinite(params?.rotation, 0),
    Boolean(params?.reverse),
    Math.max(0, toFinite(params?.expansion, 0)),
    Boolean(params?.mirror),
    params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false,
  );
  return { primitiveId: getPrimitiveId(result), x, y, text };
}

async function modifyPcbText(params: {
  primitiveId: string;
  layer?: number;
  x?: number;
  y?: number;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  lineWidth?: number;
  alignMode?: number;
  rotation?: number;
  reverse?: boolean;
  expansion?: number;
  mirror?: boolean;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveString?.modify) {
    throw new Error('current EDA does not support pcb_PrimitiveString.modify');
  }
  const primitiveId = String(params?.primitiveId || '').trim();
  if (!primitiveId) throw new Error('primitiveId is required');
  const property: Record<string, any> = {};
  for (const key of ['layer', 'x', 'y', 'text', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock']) {
    if ((params as any)?.[key] !== undefined) property[key] = (params as any)[key];
  }
  if (Object.keys(property).length === 0) throw new Error('no text properties to modify');
  const result = await api.pcb_PrimitiveString.modify(primitiveId, property);
  return { primitiveId: getPrimitiveId(result) || primitiveId, property };
}

async function deletePcbText(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveString?.delete) {
    throw new Error('current EDA does not support pcb_PrimitiveString.delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveString.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

function errorToString(error: any): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function describeObject(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  const data: Record<string, any> = {};
  for (const key of [
    'primitiveId',
    'uuid',
    'name',
    'displayName',
    'documentType',
    'tabId',
    'id',
    'type',
    'layer',
    'net',
    'x',
    'y',
  ]) {
    if (value?.[key] !== undefined) data[key] = value[key];
  }
  for (const method of [
    'getState_PrimitiveId',
    'getState_Net',
    'getState_Layer',
    'getState_X',
    'getState_Y',
    'getState_StartX',
    'getState_StartY',
    'getState_EndX',
    'getState_EndY',
    'getState_Text',
  ]) {
    try {
      if (typeof value?.[method] === 'function') data[method.replace('getState_', '')] = value[method]();
    } catch {
      // ignore state getter failures
    }
  }
  return Object.keys(data).length > 0 ? data : { type: Object.prototype.toString.call(value) };
}

function serializeValue(value: any, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 5) return describeObject(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => serializeValue(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  const out: Record<string, any> = {};
  for (const key of Object.keys(value).slice(0, 100)) {
    try {
      const item = value[key];
      if (typeof item !== 'function') out[key] = serializeValue(item, depth + 1);
    } catch {
      // ignore unreadable property
    }
  }

  const described = describeObject(value);
  if (described && typeof described === 'object' && described.type === undefined) {
    Object.assign(out, described);
  }
  return Object.keys(out).length > 0 ? out : describeObject(value);
}

async function extractProjectInfoFromFile(params: { filePath: string }): Promise<any> {
  const api = anyEda();
  if (!api?.sys_FileManager?.extractProjectInfo) {
    throw new Error('current EDA does not support sys_FileManager.extractProjectInfo');
  }
  const file = await readLocalFile(params?.filePath);
  const info = await api.sys_FileManager.extractProjectInfo(file);
  return serializeValue(info);
}

async function importProjectFile(params: {
  filePath: string;
  fileType?: string;
  props?: any;
  saveTo?: any;
  librariesImportSetting?: any;
}): Promise<any> {
  const api = anyEda();
  if (!api?.sys_FileManager?.importProjectByProjectFile) {
    throw new Error('current EDA does not support sys_FileManager.importProjectByProjectFile');
  }
  const file = await readLocalFile(params?.filePath);
  const result = await api.sys_FileManager.importProjectByProjectFile(
    file,
    params?.fileType,
    params?.props,
    params?.saveTo,
    params?.librariesImportSetting,
  );
  return serializeValue(result);
}

async function getProjectContext(): Promise<any> {
  const api = anyEda();
  const result: Record<string, any> = { bridgeVersion: APP_VERSION };
  const add = async (key: string, fn: () => Promise<any>) => {
    try {
      result[key] = serializeValue(await fn());
    } catch (error) {
      result[key] = { error: errorToString(error) };
    }
  };

  await add('currentWorkspace', async () => api?.dmt_Workspace?.getCurrentWorkspaceInfo?.());
  await add('workspaces', async () => api?.dmt_Workspace?.getAllWorkspacesInfo?.());
  await add('currentTeam', async () => api?.dmt_Team?.getCurrentTeamInfo?.());
  await add('teams', async () => api?.dmt_Team?.getAllTeamsInfo?.());
  await add('involvedTeams', async () => api?.dmt_Team?.getAllInvolvedTeamInfo?.());
  await add('currentProject', async () => api?.dmt_Project?.getCurrentProjectInfo?.());
  await add('allBoards', async () => api?.dmt_Board?.getAllBoardsInfo?.());
  await add('currentBoard', async () => api?.dmt_Board?.getCurrentBoardInfo?.());
  await add('libraries', async () => ({
    system: await api?.lib_LibrariesList?.getSystemLibraryUuid?.(),
    personal: await api?.lib_LibrariesList?.getPersonalLibraryUuid?.(),
    project: await api?.lib_LibrariesList?.getProjectLibraryUuid?.(),
    favorite: await api?.lib_LibrariesList?.getFavoriteLibraryUuid?.(),
    all: await api?.lib_LibrariesList?.getAllLibrariesList?.(),
  }));

  const teamUuid = result.currentTeam?.uuid || result.teams?.[0]?.uuid || result.involvedTeams?.[0]?.uuid;
  if (teamUuid && api?.dmt_Project?.getAllProjectsUuid) {
    await add('teamProjects', async () => {
      const uuids = await api.dmt_Project.getAllProjectsUuid(teamUuid);
      const items = [];
      for (const uuid of Array.isArray(uuids) ? uuids.slice(0, 50) : []) {
        try {
          items.push(await api.dmt_Project.getProjectInfo(uuid));
        } catch {
          items.push({ uuid });
        }
      }
      return items;
    });
  }

  return result;
}

async function searchLibrary(params: {
  type?: 'device' | 'footprint' | 'symbol';
  key: string;
  libraryUuid?: string;
  itemsOfPage?: number;
  page?: number;
}): Promise<any> {
  const api = anyEda();
  const type = String(params?.type || 'device');
  const key = String(params?.key || '').trim();
  if (!key) throw new Error('key is required');
  const count = Math.max(1, Math.min(50, Math.floor(toFinite(params?.itemsOfPage, 10))));
  const page = Math.max(1, Math.floor(toFinite(params?.page, 1)));

  let rows: any[] = [];
  if (type === 'footprint') {
    if (!api?.lib_Footprint?.search) throw new Error('current EDA does not support lib_Footprint.search');
    rows = await api.lib_Footprint.search(key, params?.libraryUuid, undefined, count, page);
  } else if (type === 'symbol') {
    if (!api?.lib_Symbol?.search) throw new Error('current EDA does not support lib_Symbol.search');
    rows = await api.lib_Symbol.search(key, params?.libraryUuid, undefined, undefined, count, page);
  } else {
    if (!api?.lib_Device?.search) throw new Error('current EDA does not support lib_Device.search');
    rows = await api.lib_Device.search(key, params?.libraryUuid, undefined, undefined, count, page);
  }
  return {
    type,
    key,
    count: Array.isArray(rows) ? rows.length : 0,
    items: serializeValue(rows),
  };
}

function getAvailableCommands(): any {
  const commands = [
    'ping',
    'get_state',
    'get_feature_support',
    'get_available_commands',
    'debug_pcb_context',
    'debug_create_primitives',
    'get_api_paths',
    'get_project_context',
    'search_library',
    'extract_project_info_from_file',
    'import_project_file',
    'screenshot',
    'get_board_info',
    'open_document',
    'create_pcb_document',
    'save_schematic_document',
    'save_pcb_document',
    'get_schematic_state',
    'get_netlist',
    'set_schematic_netlist',
    'get_schematic_nets',
    'run_sch_drc',
    'create_schematic_component',
    'modify_schematic_component',
    'delete_schematic_component',
    'get_schematic_component_pins',
    'create_schematic_wire',
    'modify_schematic_wire',
    'delete_schematic_wire',
    'create_schematic_text',
    'modify_schematic_text',
    'delete_schematic_text',
    'create_schematic_net_port',
    'create_schematic_net_flag',
    'import_pcb_changes',
    'import_schematic_changes',
    'get_pcb_components',
    'get_pcb_nets',
    'get_pcb_component_pins',
    'create_pcb_component',
    'modify_pcb_component',
    'delete_pcb_component',
    'get_pads',
    'create_pcb_pad',
    'modify_pcb_pad',
    'delete_pcb_pad',
    'create_pcb_text',
    'modify_pcb_text',
    'delete_pcb_text',
    'get_silkscreens',
    'move_silkscreen',
    'auto_silkscreen',
    'route_track',
    'get_tracks',
    'delete_tracks',
    'create_via',
    'delete_via',
    'create_pour_rect',
    'create_pour_polygon',
    'create_pour_rounded_rect',
    'get_pours',
    'rebuild_pours',
    'delete_pour',
    'delete_poured',
    'delete_fill',
    'delete_all_pours',
    'create_keepout_rect',
    'delete_region',
    'run_drc',
    'get_net_primitives',
    'move_component',
    'relocate_component',
    'select_component',
    'delete_selected',
    'create_differential_pair',
    'delete_differential_pair',
    'list_differential_pairs',
    'create_equal_length_group',
    'delete_equal_length_group',
    'list_equal_length_groups',
  ];
  return {
    bridgeVersion: APP_VERSION,
    count: commands.length,
    commands,
  };
}

async function debugPcbContext(): Promise<any> {
  const api = anyEda();
  const result: Record<string, any> = {
    bridgeVersion: APP_VERSION,
    api: {
      fileSystem: Boolean(api?.sys_FileSystem?.readFileFromFileSystem),
      fileManager: {
        extractProjectInfo: Boolean(api?.sys_FileManager?.extractProjectInfo),
        importProjectByProjectFile: Boolean(api?.sys_FileManager?.importProjectByProjectFile),
      },
      pcb: {
        lineCreate: Boolean(api?.pcb_PrimitiveLine?.create),
        padCreate: Boolean(api?.pcb_PrimitivePad?.create),
        stringCreate: Boolean(api?.pcb_PrimitiveString?.create),
        viaCreate: Boolean(api?.pcb_PrimitiveVia?.create),
      },
    },
  };

  const add = async (key: string, fn: () => Promise<any>) => {
    try {
      result[key] = await fn();
    } catch (error) {
      result[key] = { error: errorToString(error) };
    }
  };

  await add('boardInfo', async () => getBoardInfo());
  await add('splitScreenTree', async () => describeObject(await api?.dmt_EditorControl?.getSplitScreenTree?.()));
  await add('canvasOrigin', async () => api?.pcb_Document?.getCanvasOrigin?.());
  await add('ratlineStatus', async () => api?.pcb_Document?.getCalculatingRatlineStatus?.());
  await add('padsCount', async () => {
    const rows = await api?.pcb_PrimitivePad?.getAll?.();
    return Array.isArray(rows) ? rows.length : rows;
  });
  await add('tracksCount', async () => {
    const rows = await api?.pcb_PrimitiveLine?.getAll?.();
    return Array.isArray(rows) ? rows.length : rows;
  });
  await add('stringsCount', async () => {
    const rows = await api?.pcb_PrimitiveString?.getAll?.();
    return Array.isArray(rows) ? rows.length : rows;
  });

  return result;
}

async function debugCreatePrimitives(params: { x?: number; y?: number; net?: string; cleanup?: boolean }): Promise<any> {
  const api = anyEda();
  const x = toFinite(params?.x, 200);
  const y = toFinite(params?.y, 200);
  const net = String(params?.net || '');
  const attempts: any[] = [];

  const attempt = async (name: string, fn: () => Promise<any>, cleanup?: (created: any) => Promise<any>) => {
    try {
      const created = await fn();
      const item = { name, ok: true, result: describeObject(created) };
      attempts.push(item);
      if (params?.cleanup && cleanup && created) {
        try {
          await cleanup(created);
          item.cleanup = true;
        } catch (error) {
          item.cleanupError = errorToString(error);
        }
      }
    } catch (error) {
      attempts.push({ name, ok: false, error: errorToString(error) });
    }
  };

  await attempt(
    'line_top',
    () => api.pcb_PrimitiveLine.create(net, 1, x, y, x + 80, y, 10, false),
    (created) => api.pcb_PrimitiveLine.delete(created),
  );
  await attempt(
    'line_outline',
    () => api.pcb_PrimitiveLine.create('', 11, x, y + 20, x + 80, y + 20, 10, false),
    (created) => api.pcb_PrimitiveLine.delete(created),
  );
  await attempt(
    'text_top_silk',
    () => api.pcb_PrimitiveString.create(3, x, y + 40, 'JLC_DEBUG', 'Arial', 40, 6, 5, 0, false, 0, false, false),
    (created) => api.pcb_PrimitiveString.delete(created),
  );
  await attempt(
    'pad_rect_top',
    () => api.pcb_PrimitivePad.create(1, 'TP1', x, y + 80, 0, ['RECT', 50, 50, 0], net, null, 0, 0, 0, false, 0, undefined, null, null, false),
    (created) => api.pcb_PrimitivePad.delete(created),
  );
  await attempt(
    'pad_ellipse_top',
    () => api.pcb_PrimitivePad.create(1, 'TP2', x + 80, y + 80, 0, ['ELLIPSE', 50, 50], net, null, 0, 0, 0, false, 0, undefined, null, null, false),
    (created) => api.pcb_PrimitivePad.delete(created),
  );
  await attempt(
    'via',
    () => api.pcb_PrimitiveVia.create(net, x, y + 120, 12, 24, undefined, null, null, false),
    (created) => api.pcb_PrimitiveVia.delete(created),
  );

  return { x, y, net, cleanup: Boolean(params?.cleanup), attempts };
}

async function getFeatureSupport(): Promise<any> {
  const api = anyEda();
  return {
    bridgeVersion: APP_VERSION,
    screenshot: {
      renderedAreaImage: Boolean(api?.dmt_EditorControl?.getCurrentRenderedAreaImage),
      exportImage: Boolean(api?.pcb_Document?.exportImage),
      canvasToDataUrl: Boolean(api?.sys_Canvas?.toDataURL),
    },
    silkscreen: {
      query: Boolean(api?.pcb_PrimitiveString?.getAll),
      modify: Boolean(api?.pcb_PrimitiveString?.modify),
      auto: Boolean(api?.pcb_PrimitiveString?.modify),
    },
    via: {
      create: Boolean(api?.pcb_PrimitiveVia?.create),
      delete: Boolean(api?.pcb_PrimitiveVia?.delete),
    },
    keepout: {
      create: Boolean(api?.pcb_PrimitiveRegion?.create && api?.pcb_MathPolygon?.createPolygon),
      delete: Boolean(api?.pcb_PrimitiveRegion?.delete),
    },
    pour: {
      create: Boolean(api?.pcb_PrimitivePour?.create && api?.pcb_MathPolygon?.createPolygon),
      getAll: Boolean(api?.pcb_PrimitivePour?.getAll),
      delete: Boolean(api?.pcb_PrimitivePour?.delete),
      rebuildCopperRegion: 'runtime-checked',
      pouredGetAll: Boolean(api?.pcb_PrimitivePoured?.getAll),
      pouredDelete: Boolean(api?.pcb_PrimitivePoured?.delete),
      fillGetAll: Boolean(api?.pcb_PrimitiveFill?.getAll),
      fillDelete: Boolean(api?.pcb_PrimitiveFill?.delete),
    },
    routingRules: {
      differentialPair: Boolean(api?.pcb_Drc?.createDifferentialPair),
      equalLengthGroup: Boolean(api?.pcb_Drc?.createEqualLengthNetGroup),
      drcCheck: Boolean(api?.pcb_Drc?.check || api?.pcb_Drc?.runDrc),
      padPairGroup: Boolean(api?.pcb_Drc?.createPadPairGroup),
    },
    schematic: {
      getBoardInfo: Boolean(api?.dmt_Board?.getCurrentBoardInfo),
      openDocument: Boolean(api?.dmt_EditorControl?.openDocument),
      getComponents: Boolean(api?.sch_PrimitiveComponent?.getAll),
      createComponent: Boolean(api?.sch_PrimitiveComponent?.create),
      modifyComponent: Boolean(api?.sch_PrimitiveComponent?.modify),
      deleteComponent: Boolean(api?.sch_PrimitiveComponent?.delete),
      createWire: Boolean(api?.sch_PrimitiveWire?.create),
      modifyWire: Boolean(api?.sch_PrimitiveWire?.modify),
      deleteWire: Boolean(api?.sch_PrimitiveWire?.delete),
      createText: Boolean(api?.sch_PrimitiveText?.create),
      modifyText: Boolean(api?.sch_PrimitiveText?.modify),
      deleteText: Boolean(api?.sch_PrimitiveText?.delete),
      createNetPort: Boolean(api?.sch_PrimitiveComponent?.createNetPort),
      createNetFlag: Boolean(api?.sch_PrimitiveComponent?.createNetFlag),
      getNetlist: Boolean(api?.sch_Netlist?.getNetlist),
      setNetlist: Boolean(api?.sch_Netlist?.setNetlist),
      getNets: Boolean(api?.sch_Net?.getAllNetsName || api?.sch_Net?.getAllNets),
      schDrc: Boolean(api?.sch_Drc?.check),
      save: Boolean(api?.sch_Document?.save),
      importChanges: Boolean(api?.sch_Document?.importChanges),
      createPcbComponent: Boolean(api?.pcb_PrimitiveComponent?.create),
    },
    rebuild: {
      createPcbDocument: Boolean(api?.dmt_Pcb?.createPcb),
      getPcbComponents: Boolean(api?.pcb_PrimitiveComponent?.getAll),
      getPcbNets: Boolean(api?.pcb_Net?.getAllNetsName || api?.pcb_Net?.getAllNets),
      modifyPcbComponent: Boolean(api?.pcb_PrimitiveComponent?.modify),
      deletePcbComponent: Boolean(api?.pcb_PrimitiveComponent?.delete),
      createPad: Boolean(api?.pcb_PrimitivePad?.create),
      modifyPad: Boolean(api?.pcb_PrimitivePad?.modify),
      deletePad: Boolean(api?.pcb_PrimitivePad?.delete),
      createText: Boolean(api?.pcb_PrimitiveString?.create),
      modifyText: Boolean(api?.pcb_PrimitiveString?.modify),
      deleteText: Boolean(api?.pcb_PrimitiveString?.delete),
      createLine: Boolean(api?.pcb_PrimitiveLine?.create),
      savePcb: Boolean(api?.pcb_Document?.save),
      importPcbChanges: Boolean(api?.pcb_Document?.importChanges),
      extractProjectInfoFromFile: Boolean(api?.sys_FileManager?.extractProjectInfo && api?.sys_FileSystem?.readFileFromFileSystem),
      importProjectFile: Boolean(api?.sys_FileManager?.importProjectByProjectFile && api?.sys_FileSystem?.readFileFromFileSystem),
      searchLibrary: Boolean(api?.lib_Device?.search && api?.lib_Footprint?.search),
    },
    diagnostics: {
      getApiPaths: true,
      availableCommands: true,
    },
  };
}

// ─── Track / net query & delete ───

async function getTracks(params: { net?: string; layer?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.getAll) {
    throw new Error('current EDA does not support track query');
  }
  const rows = await api.pcb_PrimitiveLine.getAll(params.net, params.layer);
  const tracks = (Array.isArray(rows) ? rows : []).map((r: any) => ({
    primitiveId: r?.getState_PrimitiveId?.() || '',
    net: r?.getState_Net?.() || '',
    layer: r?.getState_Layer?.() ?? '',
    startX: Number(r?.getState_StartX?.() ?? 0),
    startY: Number(r?.getState_StartY?.() ?? 0),
    endX: Number(r?.getState_EndX?.() ?? 0),
    endY: Number(r?.getState_EndY?.() ?? 0),
    width: Number(r?.getState_Width?.() ?? 0),
  })).filter((t: any) => t.primitiveId);
  return { tracks, count: tracks.length };
}

async function deleteTracks(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.delete) {
    throw new Error('current EDA does not support track delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveLine.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function getNetPrimitives(params: { net: string }): Promise<any> {
  const api = anyEda();
  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');

  const result: { tracks: any[]; vias: any[]; pads: any[] } = { tracks: [], vias: [], pads: [] };

  // Tracks on this net
  if (api?.pcb_PrimitiveLine?.getAll) {
    const rows = await api.pcb_PrimitiveLine.getAll(net);
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = r?.getState_PrimitiveId?.();
      if (!id) continue;
      result.tracks.push({
        primitiveId: id,
        startX: Number(r?.getState_StartX?.() ?? 0),
        startY: Number(r?.getState_StartY?.() ?? 0),
        endX: Number(r?.getState_EndX?.() ?? 0),
        endY: Number(r?.getState_EndY?.() ?? 0),
        layer: r?.getState_Layer?.() ?? '',
        width: Number(r?.getState_Width?.() ?? 0),
      });
    }
  }

  // Vias on this net
  if (api?.pcb_PrimitiveVia?.getAll) {
    try {
      const rows = await api.pcb_PrimitiveVia.getAll();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const viaNet = r?.getState_Net?.() || '';
        if (viaNet !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.vias.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? 0),
        });
      }
    } catch { /* ignore */ }
  }

  // Pads on this net
  if (api?.pcb_PrimitivePad?.getAll) {
    try {
      const rows = await api.pcb_PrimitivePad.getAll();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const padNet = r?.getState_Net?.() || r?.getState_NetName?.() || '';
        if (padNet !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.pads.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? r?.getState_CenterX?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? r?.getState_CenterY?.() ?? 0),
          designator: r?.getState_Designator?.() || '',
        });
      }
    } catch { /* ignore */ }
  }

  return result;
}

async function relocateComponent(params: {
  designator: string; x: number; y: number; rotation?: number;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.getAll || !api?.pcb_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support component modify');
  }

  // 1. Find the component and read its pad nets
  const rows = await api.pcb_PrimitiveComponent.getAll();
  let targetId: string | null = null;
  let targetRow: any = null;
  for (const row of rows) {
    if ((row?.getState_Designator?.() || '') === params.designator) {
      targetId = row?.getState_PrimitiveId?.() || null;
      targetRow = row;
      break;
    }
  }
  if (!targetId) throw new Error(`component not found: ${params.designator}`);
  if (targetRow?.getState_PrimitiveLock?.()) {
    throw new Error(`component locked: ${params.designator}`);
  }

  const padNets = normalizeNetArray(targetRow?.getState_Pads?.());
  const uniqueNets = [...new Set(padNets.map((p: any) => p.net).filter(Boolean))];

  // 2. Collect pad positions for this component
  const padPositions: { x: number; y: number }[] = [];
  if (api?.pcb_PrimitivePad?.getAll) {
    try {
      const allPads = await api.pcb_PrimitivePad.getAll();
      for (const p of (Array.isArray(allPads) ? allPads : [])) {
        const des = p?.getState_Designator?.() || '';
        const parentId = p?.getState_ParentPrimitiveId?.()
          || p?.getState_BelongPrimitiveId?.()
          || p?.getState_ComponentPrimitiveId?.() || '';
        if (des === params.designator || parentId === targetId) {
          padPositions.push({
            x: Number(p?.getState_X?.() ?? p?.getState_CenterX?.() ?? 0),
            y: Number(p?.getState_Y?.() ?? p?.getState_CenterY?.() ?? 0),
          });
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Find and delete tracks directly connected to this component's pads
  const deletedTracks: string[] = [];
  const COORD_TOLERANCE = 2; // mil tolerance for coordinate matching
  if (api?.pcb_PrimitiveLine?.getAll && api?.pcb_PrimitiveLine?.delete && padPositions.length > 0) {
    for (const net of uniqueNets) {
      try {
        const trackRows = await api.pcb_PrimitiveLine.getAll(net);
        const toDelete: string[] = [];
        for (const t of (Array.isArray(trackRows) ? trackRows : [])) {
          const sx = Number(t?.getState_StartX?.() ?? 0);
          const sy = Number(t?.getState_StartY?.() ?? 0);
          const ex = Number(t?.getState_EndX?.() ?? 0);
          const ey = Number(t?.getState_EndY?.() ?? 0);
          // Check if either endpoint touches a pad of this component
          const touchesPad = padPositions.some(pad =>
            (Math.abs(sx - pad.x) <= COORD_TOLERANCE && Math.abs(sy - pad.y) <= COORD_TOLERANCE) ||
            (Math.abs(ex - pad.x) <= COORD_TOLERANCE && Math.abs(ey - pad.y) <= COORD_TOLERANCE)
          );
          if (touchesPad) {
            const id = t?.getState_PrimitiveId?.();
            if (id) toDelete.push(id);
          }
        }
        if (toDelete.length > 0) {
          await api.pcb_PrimitiveLine.delete(toDelete as any);
          deletedTracks.push(...toDelete);
        }
      } catch { /* ignore per-net errors */ }
    }
  }

  // 4. Move the component
  await api.pcb_PrimitiveComponent.modify(targetId, {
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  });

  return {
    moved: params.designator,
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
    deletedTracks,
    deletedTrackCount: deletedTracks.length,
    netsToReroute: uniqueNets,
  };
}

async function routeTrack(params: { net: string; points: any[]; layer: number; width?: number; strict?: boolean }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.create) {
    throw new Error('current EDA does not support track create');
  }

  const width = params.width ?? 10;
  let created = 0;
  const errors: Array<{ segment: number; error: string }> = [];

  for (let i = 0; i < params.points.length - 1; i += 1) {
    const p1 = params.points[i];
    const p2 = params.points[i + 1];
    try {
      await api.pcb_PrimitiveLine.create(params.net, params.layer, p1.x, p1.y, p2.x, p2.y, width, false);
      created += 1;
    } catch (error) {
      errors.push({ segment: i, error: errorToString(error) });
      console.error(`[${APP_NAME}] route segment failed`, i, error);
    }
  }

  if (params?.strict && errors.length > 0) {
    throw new Error(`route_track failed: ${errors.map((item) => `${item.segment}: ${item.error}`).join('; ')}`);
  }

  return { createdSegments: created, errors };
}

async function runDRC(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.check && !api?.pcb_Drc?.runDrc) {
    throw new Error('current EDA does not support DRC');
  }

  let passed: boolean | undefined;
  let issues: any[] = [];

  if (api?.pcb_Drc?.check) {
    try {
      const verbose = await api.pcb_Drc.check(true, false, true);
      if (Array.isArray(verbose)) {
        issues = verbose;
        passed = verbose.length === 0;
      } else if (typeof verbose === 'boolean') {
        passed = verbose;
      }
    } catch {
      // try non-verbose branch
      try {
        const quick = await api.pcb_Drc.check(true, false, false);
        if (typeof quick === 'boolean') {
          passed = quick;
        }
      } catch {
        // ignore
      }
    }
  }

  if (issues.length === 0 && api?.pcb_Drc?.runDrc) {
    try {
      const raw = await api.pcb_Drc.runDrc();
      if (Array.isArray(raw)) {
        issues = raw;
        if (passed === undefined) passed = raw.length === 0;
      }
    } catch {
      // ignore runDrc fallback
    }
  }

  const normalized = issues.map((item: any, index: number) => {
    const rule = String(item?.rule || item?.type || item?.name || '').trim();
    const message = String(item?.message || item?.description || '').trim();
    const refs = Array.isArray(item?.primitiveIds)
      ? item.primitiveIds.map((id: any) => String(id || '')).filter(Boolean)
      : [];
    const text = `${rule} ${message}`.toLowerCase();
    let severity = 'unknown';
    if (/error|错误|违规/.test(text)) severity = 'error';
    else if (/warning|警告/.test(text)) severity = 'warning';
    else if (/info|提示/.test(text)) severity = 'info';

    return {
      index: index + 1,
      severity,
      rule,
      message,
      primitiveIds: refs,
      raw: item,
    };
  });

  if (passed === undefined) {
    passed = normalized.length === 0;
  }

  const summary = {
    errors: normalized.filter((item) => item.severity === 'error').length,
    warnings: normalized.filter((item) => item.severity === 'warning').length,
    infos: normalized.filter((item) => item.severity === 'info').length,
    unknown: normalized.filter((item) => item.severity === 'unknown').length,
  };

  return {
    passed: Boolean(passed),
    totalCount: normalized.length,
    summary,
    issues: normalized,
  };
}

async function takeScreenshot(): Promise<any> {
  const api = anyEda();

  const renderedAreaDataUrl = await tryCaptureRenderedAreaImageDataUrl();
  if (typeof renderedAreaDataUrl === 'string' && renderedAreaDataUrl.startsWith('data:')) {
    return { imageDataUrl: renderedAreaDataUrl };
  }

  if (api?.pcb_Document?.exportImage) {
    try {
      const dataUrl = await api.pcb_Document.exportImage('png');
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        return { imageDataUrl: dataUrl };
      }
    } catch {
      // ignore
    }
  }

  if (api?.sys_Canvas?.toDataURL) {
    try {
      const dataUrl = await api.sys_Canvas.toDataURL('image/png');
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        return { imageDataUrl: dataUrl };
      }
    } catch {
      // ignore
    }
  }

  throw new Error(`screenshot unavailable, save manually to ${BRIDGE_DIR}\\screenshot.png`);
}

async function executeCommand(cmd: BridgeCommand): Promise<BridgeResult> {
  const start = Date.now();
  try {
    let data: any;

    switch (cmd.action) {
      case 'ping':
        data = { message: 'pong', timestamp: Date.now() };
        break;
      case 'get_state':
        data = await getPCBState();
        break;
      case 'get_feature_support':
        data = await getFeatureSupport();
        break;
      case 'get_available_commands':
        data = getAvailableCommands();
        break;
      case 'get_api_paths':
        data = await getApiPaths(cmd.params);
        break;
      case 'debug_pcb_context':
        data = await debugPcbContext();
        break;
      case 'get_project_context':
        data = await getProjectContext();
        break;
      case 'search_library':
        data = await searchLibrary(cmd.params);
        break;
      case 'debug_create_primitives':
        data = await debugCreatePrimitives(cmd.params);
        break;
      case 'extract_project_info_from_file':
        data = await extractProjectInfoFromFile(cmd.params);
        break;
      case 'import_project_file':
        data = await importProjectFile(cmd.params);
        break;
      case 'screenshot':
        data = await takeScreenshot();
        break;
      case 'get_silkscreens':
        data = await getSilkscreens(cmd.params);
        break;
      case 'move_silkscreen':
        data = await moveSilkscreen(cmd.params);
        break;
      case 'auto_silkscreen':
        data = await autoSilkscreen(cmd.params);
        break;
      case 'move_component':
        data = await moveComponent(cmd.params);
        break;
      case 'route_track':
        data = await routeTrack(cmd.params);
        break;
      case 'create_via':
        data = await createVia(cmd.params);
        break;
      case 'delete_via':
        data = await deleteVia(cmd.params);
        break;
      case 'get_tracks':
        data = await getTracks(cmd.params);
        break;
      case 'delete_tracks':
        data = await deleteTracks(cmd.params);
        break;
      case 'get_net_primitives':
        data = await getNetPrimitives(cmd.params);
        break;
      case 'relocate_component':
        data = await relocateComponent(cmd.params);
        break;
      case 'create_keepout_rect':
        data = await createKeepoutRect(cmd.params);
        break;
      case 'delete_region':
        data = await deleteRegion(cmd.params);
        break;
      case 'create_pour_rect':
        data = await createPourRect(cmd.params);
        break;
      case 'create_pour_polygon':
        data = await createPourPolygon(cmd.params);
        break;
      case 'create_pour_rounded_rect':
        data = await createPourRoundedRect(cmd.params);
        break;
      case 'get_pours':
        data = await getPours(cmd.params);
        break;
      case 'rebuild_pours':
        data = await rebuildPours(cmd.params);
        break;
      case 'delete_pour':
        data = await deletePour(cmd.params);
        break;
      case 'delete_poured':
        data = await deletePoured(cmd.params);
        break;
      case 'delete_fill':
        data = await deleteFills(cmd.params);
        break;
      case 'delete_all_pours':
        data = await deleteAllPours(cmd.params);
        break;
      case 'create_differential_pair':
        data = await createDifferentialPair(cmd.params);
        break;
      case 'delete_differential_pair':
        data = await deleteDifferentialPair(cmd.params);
        break;
      case 'list_differential_pairs':
        data = await listDifferentialPairs();
        break;
      case 'create_equal_length_group':
        data = await createEqualLengthGroup(cmd.params);
        break;
      case 'delete_equal_length_group':
        data = await deleteEqualLengthGroup(cmd.params);
        break;
      case 'list_equal_length_groups':
        data = await listEqualLengthGroups();
        break;
      case 'run_drc':
        data = await runDRC();
        break;
      case 'get_pads':
        data = await getPads(cmd.params);
        break;
      case 'modify_pcb_pad':
        data = await modifyPcbPad(cmd.params);
        break;
      case 'delete_pcb_pad':
        data = await deletePcbPad(cmd.params);
        break;
      case 'get_pcb_components':
        data = await getPcbComponents(cmd.params);
        break;
      case 'get_pcb_nets':
        data = await getPcbNets();
        break;
      case 'get_pcb_component_pins':
        data = await getPcbComponentPins(cmd.params);
        break;
      case 'modify_pcb_component':
        data = await modifyPcbComponent(cmd.params);
        break;
      case 'delete_pcb_component':
        data = await deletePcbComponent(cmd.params);
        break;
      case 'modify_pcb_text':
        data = await modifyPcbText(cmd.params);
        break;
      case 'delete_pcb_text':
        data = await deletePcbText(cmd.params);
        break;
      case 'select_component': {
        const api = anyEda();
        if (!api?.pcb_SelectControl?.selectByDesignator) {
          throw new Error('select not supported');
        }
        await api.pcb_SelectControl.selectByDesignator(cmd.params.designator);
        data = { selected: cmd.params.designator };
        break;
      }
      case 'delete_selected': {
        const api = anyEda();
        if (!api?.pcb_SelectControl?.deleteSelected) {
          throw new Error('delete not supported');
        }
        await api.pcb_SelectControl.deleteSelected();
        data = { deleted: true };
        break;
      }
      case 'get_board_info':
        data = await getBoardInfo();
        break;
      case 'open_document':
        data = await openDocument(cmd.params);
        break;
      case 'get_schematic_state':
        data = await getSchematicState();
        break;
      case 'get_netlist':
        data = await getNetlist(cmd.params);
        break;
      case 'set_schematic_netlist':
        data = await setSchematicNetlist(cmd.params);
        break;
      case 'get_schematic_nets':
        data = await getSchematicNets();
        break;
      case 'run_sch_drc':
        data = await runSchDrc(cmd.params);
        break;
      case 'save_schematic_document':
        data = await saveSchematicDocument();
        break;
      case 'save_pcb_document':
        data = await savePcbDocument(cmd.params);
        break;
      case 'create_schematic_component':
        data = await createSchematicComponent(cmd.params);
        break;
      case 'modify_schematic_component':
        data = await modifySchematicComponent(cmd.params);
        break;
      case 'delete_schematic_component':
        data = await deleteSchematicComponent(cmd.params);
        break;
      case 'get_schematic_component_pins':
        data = await getSchematicComponentPins(cmd.params);
        break;
      case 'create_schematic_wire':
        data = await createSchematicWire(cmd.params);
        break;
      case 'modify_schematic_wire':
        data = await modifySchematicWire(cmd.params);
        break;
      case 'delete_schematic_wire':
        data = await deleteSchematicWire(cmd.params);
        break;
      case 'create_schematic_text':
        data = await createSchematicText(cmd.params);
        break;
      case 'modify_schematic_text':
        data = await modifySchematicText(cmd.params);
        break;
      case 'delete_schematic_text':
        data = await deleteSchematicText(cmd.params);
        break;
      case 'create_schematic_net_port':
        data = await createSchematicNetPort(cmd.params);
        break;
      case 'create_schematic_net_flag':
        data = await createSchematicNetFlag(cmd.params);
        break;
      case 'import_pcb_changes':
        data = await importPcbChanges(cmd.params);
        break;
      case 'import_schematic_changes':
        data = await importSchematicChanges();
        break;
      case 'create_pcb_document':
        data = await createPcbDocument(cmd.params);
        break;
      case 'create_pcb_component':
        data = await createPcbComponent(cmd.params);
        break;
      case 'create_pcb_pad':
        data = await createPcbPad(cmd.params);
        break;
      case 'create_pcb_text':
        data = await createPcbText(cmd.params);
        break;
      default:
        throw new Error(`unknown action: ${cmd.action}`);
    }

    return { id: cmd.id, success: true, data, durationMs: Date.now() - start };
  } catch (error) {
    return {
      id: cmd.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
}

async function readCommand(): Promise<BridgeCommand | null> {
  const content = await readTextFile(COMMAND_FILE);
  if (!content || !content.trim()) return null;

  try {
    const cmd = JSON.parse(content) as BridgeCommand;
    if (!cmd || typeof cmd.timestamp !== 'number') return null;
    if (cmd.timestamp <= lastCommandTime) return null;
    return cmd;
  } catch {
    return null;
  }
}

async function clearCommand(): Promise<void> {
  await writeTextFile(COMMAND_FILE, '');
}

async function writeResult(result: BridgeResult): Promise<void> {
  await writeTextFile(RESULT_FILE, JSON.stringify(result, null, 2));
}

async function pollOnce(): Promise<void> {
  if (!bridgeEnabled || pollInProgress) return;

  pollInProgress = true;
  try {
    const cmd = await readCommand();
    if (!cmd) return;

    lastCommandTime = cmd.timestamp;
    await clearCommand();
    const result = await executeCommand(cmd);
    await writeResult(result);
    log(`command done: ${cmd.action} -> ${result.success ? 'ok' : 'fail'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`poll error: ${message}`);
  } finally {
    pollInProgress = false;
  }
}

function startNativeInterval(): boolean {
  if (nativeIntervalHandle) return true;
  if (typeof setInterval !== 'function') return false;

  nativeIntervalHandle = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);

  usingNativeTimer = true;
  usingSysTimer = false;
  return true;
}

function startSysInterval(): boolean {
  const timerApi = anyEda()?.sys_Timer;
  if (!timerApi?.setIntervalTimer) return false;

  const ok = timerApi.setIntervalTimer(TIMER_ID, POLL_INTERVAL_MS, () => {
    void pollOnce();
  });

  if (!ok) return false;

  usingNativeTimer = false;
  usingSysTimer = true;
  return true;
}

function stopIntervals(): void {
  if (nativeIntervalHandle) {
    try {
      clearInterval(nativeIntervalHandle);
    } catch {
      // ignore
    }
    nativeIntervalHandle = null;
  }

  if (usingSysTimer) {
    try {
      anyEda()?.sys_Timer?.clearIntervalTimer?.(TIMER_ID);
    } catch {
      // ignore
    }
  }

  usingNativeTimer = false;
  usingSysTimer = false;
}

async function ensureBridgeFiles(): Promise<void> {
  await ensureBridgeDir();
  const existing = await readTextFile(COMMAND_FILE);
  if (existing === undefined) {
    await writeTextFile(COMMAND_FILE, '');
  }
}

// ─── WebSocket transport ───

const EDA_WS_ID = 'jlc_bridge_ws';
let usingSysWs = false;

function wsCleanup(): void {
  if (wsReconnectHandle) {
    clearTimeout(wsReconnectHandle);
    wsReconnectHandle = null;
  }
  if (usingSysWs) {
    try { anyEda()?.sys_WebSocket?.close?.(EDA_WS_ID); } catch { /* ignore */ }
  }
  if (wsConnection) {
    try { wsConnection.close(); } catch { /* ignore */ }
    wsConnection = null;
  }
  wsConnected = false;
  usingSysWs = false;
}

function wsSend(data: Record<string, unknown>): void {
  const json = JSON.stringify(data);
  if (usingSysWs && wsConnected) {
    try { anyEda()?.sys_WebSocket?.send?.(EDA_WS_ID, json); return; } catch { /* fallthrough */ }
  }
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
  try { wsConnection.send(json); } catch { /* ignore */ }
}

function wsPushEvent(event: string, payload?: Record<string, unknown>): void {
  wsSend({ type: 'event', event, data: payload ?? {} });
}

async function handleWsMessage(raw: string): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Handle ping from gateway
  if (msg?.type === 'ping') {
    wsSend({ type: 'pong', id: msg.id, timestamp: Date.now(), payload: null });
    return;
  }

  // Handle command — support both flat and payload-wrapped formats
  if (msg?.type === 'command') {
    const action = msg.action ?? msg.payload?.action;
    const params = msg.params ?? msg.payload?.params ?? {};
    const cmdId = msg.id;
    if (!action || !cmdId) return;

    const cmd: BridgeCommand = {
      id: cmdId,
      action,
      params,
      timestamp: msg.timestamp ?? Date.now(),
    };
    lastCommandTime = cmd.timestamp;
    const result = await executeCommand(cmd);

    // Reply in gateway-expected format: { type: 'result', payload: { commandId, success, data, error } }
    wsSend({
      type: 'result',
      id: cmdId,
      timestamp: Date.now(),
      payload: {
        commandId: cmdId,
        success: result.success,
        data: result.data,
        error: result.error,
        durationMs: result.durationMs,
      },
    });
    log(`ws command done: ${cmd.action} -> ${result.success ? 'ok' : 'fail'}`);
  }
}

function scheduleWsReconnect(): void {
  if (wsReconnectHandle || !bridgeEnabled) return;
  wsReconnectHandle = setTimeout(() => {
    wsReconnectHandle = null;
    if (bridgeEnabled) {
      void connectWebSocket();
    }
  }, WS_RECONNECT_MS);
}

async function connectWebSocket(): Promise<boolean> {
  // Strategy 1: Use EDA's sys_WebSocket API (bypasses browser security restrictions)
  const sysWs = anyEda()?.sys_WebSocket;
  if (sysWs?.register) {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { resolve(false); }, 5000);
      try {
        sysWs.register(
          EDA_WS_ID,
          WS_URL,
          // onMessage
          (ev: MessageEvent) => {
            const data = typeof ev.data === 'string' ? ev.data : '';
            if (data) void handleWsMessage(data);
          },
          // onConnected
          () => {
            clearTimeout(timeout);
            usingSysWs = true;
            wsConnection = null; // not using native WS
            wsConnected = true;
            stopIntervals();
            log('ws connected via sys_WebSocket, file polling stopped');
            wsSend({ type: 'hello', name: APP_NAME, version: APP_VERSION });
            resolve(true);
          },
        );
      } catch (e) {
        clearTimeout(timeout);
        log(`sys_WebSocket failed: ${e instanceof Error ? e.message : String(e)}`);
        resolve(false);
      }
    });
  }

  // Strategy 2: Native WebSocket (may be blocked by EDA security)
  if (typeof WebSocket === 'undefined') return false;

  return new Promise<boolean>((resolve) => {
    try {
      const ws = new WebSocket(WS_URL);

      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolve(false);
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        wsConnection = ws;
        wsConnected = true;
        usingSysWs = false;

        stopIntervals();
        log('ws connected via native WebSocket, file polling stopped');

        wsSend({ type: 'hello', name: APP_NAME, version: APP_VERSION });
        resolve(true);
      };

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (data) void handleWsMessage(data);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        const wasConnected = wsConnected;
        wsConnection = null;
        wsConnected = false;

        if (wasConnected && bridgeEnabled) {
          log('ws disconnected, falling back to file polling');
          const timerStarted = startSysInterval() || startNativeInterval();
          if (!timerStarted) {
            log('warning: could not restart file polling after ws disconnect');
          }
        }

        scheduleWsReconnect();

        if (!wasConnected) resolve(false);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
      };
    } catch {
      resolve(false);
    }
  });
}

async function startPolling(silent = false): Promise<void> {
  if (bridgeEnabled) return;

  await ensureBridgeFiles();
  bridgeEnabled = true;

  // Try WebSocket first
  const wsOk = await connectWebSocket();
  if (wsOk) {
    await saveEnabledPref(true);
    log(`bridge enabled (WebSocket)`);
    if (!silent) {
      showInfo([
        'Bridge enabled (WebSocket)',
        `WS endpoint: ${WS_URL}`,
        `Fallback: file polling`,
      ].join('\n'));
    }
    return;
  }

  // Fallback to file polling
  const timerStarted = startSysInterval() || startNativeInterval();
  if (!timerStarted) {
    bridgeEnabled = false;
    throw new Error('no available timer API (sys_Timer/setInterval)');
  }

  // Schedule WS reconnect in background
  scheduleWsReconnect();

  await saveEnabledPref(true);
  log(`bridge enabled (${getTimerMode()}, ws reconnecting in background)`);

  if (!silent) {
    showInfo([
      'Bridge enabled (file polling)',
      `Command file: ${COMMAND_FILE}`,
      `Result file: ${RESULT_FILE}`,
      `Poll interval: ${POLL_INTERVAL_MS}ms`,
      `Timer: ${getTimerMode()}`,
      `File API: ${getFileApiMode()}`,
      `WS: reconnecting in background...`,
    ].join('\n'));
  }
}

async function stopPolling(silent = false): Promise<void> {
  wsCleanup();
  stopIntervals();
  bridgeEnabled = false;
  await saveEnabledPref(false);
  log('bridge disabled');

  if (!silent) {
    showInfo('Bridge disabled');
  }
}

export function toggleBridge(): void {
  log('toggleBridge clicked');
  void (async () => {
    const enabled = bridgeEnabled || readEnabledPref();
    if (enabled) {
      await stopPolling();
      return;
    }

    try {
      await startPolling();
    } catch (error) {
      showError('Failed to enable bridge', error);
    }
  })();
}

export function showStatus(): void {
  log('showStatus clicked');
  void (async () => {
    const persisted = readEnabledPref();

    if (persisted && !bridgeEnabled) {
      try {
        await startPolling(true);
      } catch {
        // keep reporting stopped below
      }
    }

    const runtime = bridgeEnabled ? 'running' : 'stopped';
    const transport = wsConnected ? 'WebSocket' : (bridgeEnabled ? `file polling (${getTimerMode()})` : 'none');
    const lines = [
      `Runtime: ${runtime}`,
      `Transport: ${transport}`,
      `Persisted enabled: ${persisted ? 'yes' : 'no'}`,
      `Command file: ${COMMAND_FILE}`,
      `Result file: ${RESULT_FILE}`,
      `Poll interval: ${POLL_INTERVAL_MS}ms`,
      `Timer: ${getTimerMode()}`,
      `File API: ${getFileApiMode()}`,
      `WS: ${wsConnected ? 'connected' : 'disconnected'}`,
      `Last command time: ${lastCommandTime || '(none)'}`,
    ];
    showInfo(lines.join('\n'), `${APP_NAME} Status`);
  })();
}

export async function testCommand(): Promise<void> {
  log('testCommand clicked');
  try {
    showInfo('Reading PCB state...', `${APP_NAME} Test`);
    const state = await getPCBState();
    const preview = state.components
      .slice(0, 5)
      .map((c: any) => `${c.designator}: (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);

    showInfo(
      [
        'Test success',
        `Components: ${state.components.length}`,
        `Nets: ${state.nets.length}`,
        `Bounds: (${state.boardBounds.minX.toFixed(1)}, ${state.boardBounds.minY.toFixed(1)}) - (${state.boardBounds.maxX.toFixed(1)}, ${state.boardBounds.maxY.toFixed(1)})`,
        '',
        'Top 5 components:',
        ...preview,
      ].join('\n'),
      `${APP_NAME} Test`,
    );
  } catch (error) {
    showError('Test failed', error);
  }
}

// ─── EDA event push via WebSocket ───

export function notifyPcbChanged(detail?: Record<string, unknown>): void {
  if (!wsConnected) return;
  wsPushEvent('pcb_changed', detail);
}

export function notifySelectionChanged(detail?: Record<string, unknown>): void {
  if (!wsConnected) return;
  wsPushEvent('selection_changed', detail);
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
  void (async () => {
    try {
      await anyEda()?.sys_HeaderMenu?.replaceHeaderMenus?.((extensionConfig as any).headerMenus);
    } catch (error) {
      console.error(`[${APP_NAME}] replaceHeaderMenus failed`, error);
    }

    log(`plugin loaded (v${APP_VERSION})`);

    try {
      await startPolling(true);
      log('bridge auto-started to running state');
    } catch (error) {
      showError('Auto-start bridge failed', error);
    }
  })();
}
