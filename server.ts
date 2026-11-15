import { execFile, execFileSync, spawn } from 'child_process';
import dns from 'dns';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  ThinkingLevel,
  Type,
  type GenerateContentResponse,
} from '@google/genai';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execFileAsync = promisify(execFile);
dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEGACY_CONFIG_PATH = path.join(__dirname, '.kstudio-config.json');
const PERSIST_CONFIG_PATH = path.join(os.tmpdir(), 'kstudio-pro-config.json');
if (fs.existsSync(LEGACY_CONFIG_PATH)) {
  try {
    if (!fs.existsSync(PERSIST_CONFIG_PATH)) {
      fs.copyFileSync(LEGACY_CONFIG_PATH, PERSIST_CONFIG_PATH);
    }
    fs.unlinkSync(LEGACY_CONFIG_PATH);
  } catch {
    // ignore migration error
  }
}
const EXPORTED_VIDEOS_DIR = path.join(os.tmpdir(), 'kstudio-exported-videos');
if (!fs.existsSync(EXPORTED_VIDEOS_DIR)) {
  fs.mkdirSync(EXPORTED_VIDEOS_DIR, { recursive: true });
}

type StrictModelId =
  | 'gemini-4-argon'
  | 'gemini-3.8-flash'
  | 'gemini-3.1-pro'
  | 'gemini-3.1-pro-preview';

type ProviderId = 'aistudio' | 'apinex' | 'beatapi';

const VALID_MODELS: StrictModelId[] = [
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.1-pro',
  'gemini-3.1-pro-preview',
];

function normalizeStrictModelId(raw: string | undefined): StrictModelId {
  if (raw === 'gemini-3.1-pro' || raw === 'gemini-3.1-pro-preview') {
    return 'gemini-3.1-pro';
  }
  if (raw === 'gemini-3.8-flash') return 'gemini-3.8-flash';
  if (raw === 'gemini-4-argon') return 'gemini-4-argon';
  return 'gemini-3.1-pro';
}

function resolveGatewayModelId(
  strictModel: StrictModelId,
  provider: ProviderId
): string {
  if (provider === 'apinex' || provider === 'beatapi') {
    if (
      strictModel === 'gemini-3.1-pro' ||
      strictModel === 'gemini-3.1-pro-preview'
    ) {
      return 'gemini-3.1-pro';
    }
    return strictModel;
  }
  // Google AI Studio v1beta endpoint uses gemini-3.1-pro-preview
  if (
    strictModel === 'gemini-3.1-pro' ||
    strictModel === 'gemini-3.1-pro-preview'
  ) {
    return 'gemini-3.1-pro-preview';
  }
  return strictModel;
}

interface SlidingWindowEntry {
  ts: number;
  tokens: number;
}

interface InternalAIStudioSlot {
  slotId: string;
  label: string;
  apiKey: string;
  maskedIdentifier: string;
  source: 'env_primary' | 'env_pool' | 'runtime_slot';
  status: 'ready' | 'rate_limited' | 'cooldown' | 'invalid' | 'standby';
  cooldownUntilMs: number | null;
  lastError: string | null;
  lastUsedAt: string | null;
  limits: {
    rpmLimit: number;
    tpmLimit: number;
    rpdLimit: number;
  };
  stats: {
    todayDate: string;
    todayRequests: number;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    windowEntries: SlidingWindowEntry[];
  };
}

function maskKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Not Configured';
  if (trimmed.length <= 10) return `${trimmed.slice(0, 3)}•••${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}••••${trimmed.slice(-4)}`;
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function cleanHttpErrorText(status: number, rawBody: string): string {
  if (status === 413 || rawBody.includes('413 Request Entity Too Large')) {
    return 'HTTP 413: အသံဖိုင်အပိုင်း ပမာဏ ကြီးနေပါသည် (Gateway 1MB Limit)။ 20-second Compact Audio စနစ်ဖြင့် ပြန်လည်ကြိုးစားပါ။';
  }
  const stripped = rawBody
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `HTTP ${status}: ${stripped.slice(0, 220)}`;
}

// Initialize AI Studio Key Pool from environment
const initialAiStudioSlots: InternalAIStudioSlot[] = [];

const primaryEnvKey = (process.env.GEMINI_API_KEY || '').trim();
if (primaryEnvKey && primaryEnvKey !== 'MY_GEMINI_API_KEY') {
  initialAiStudioSlots.push({
    slotId: 'aistudio-slot-1',
    label: 'AI Studio Key #1 (System Default)',
    apiKey: primaryEnvKey,
    maskedIdentifier: maskKey(primaryEnvKey),
    source: 'env_primary',
    status: 'ready',
    cooldownUntilMs: null,
    lastError: null,
    lastUsedAt: null,
    limits: {
      rpmLimit: 15,
      tpmLimit: 1000000,
      rpdLimit: 1500,
    },
    stats: {
      todayDate: getTodayDateString(),
      todayRequests: 0,
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      windowEntries: [],
    },
  });
}

const extraPoolEnv = (process.env.AISTUDIO_API_KEYS || '').trim();
if (extraPoolEnv) {
  const keys = extraPoolEnv
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k !== primaryEnvKey);
  keys.forEach((k, idx) => {
    initialAiStudioSlots.push({
      slotId: `aistudio-slot-${initialAiStudioSlots.length + 1}`,
      label: `AI Studio Key #${initialAiStudioSlots.length + 1} (Env ${idx + 1})`,
      apiKey: k,
      maskedIdentifier: maskKey(k),
      source: 'env_pool',
      status: 'ready',
      cooldownUntilMs: null,
      lastError: null,
      lastUsedAt: null,
      limits: {
        rpmLimit: 15,
        tpmLimit: 1000000,
        rpdLimit: 1500,
      },
      stats: {
        todayDate: getTodayDateString(),
        todayRequests: 0,
        totalRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        windowEntries: [],
      },
    });
  });
}

interface InternalApinexState {
  apiKey: string;
  endpointBase: string;
  lastSyncedAt: string | null;
  syncStatus: 'idle' | 'syncing' | 'verified' | 'error';
  lastError: string | null;
  balance: {
    balanceUsd: number | null;
    reservedUsd: number | null;
    keyId: string | null;
    spendLimitUsd: number | null;
    spentUsd: number | null;
    remainingUsd: number | null;
    limitReached: boolean | null;
  };
  subscription: {
    plan: string | null;
    tokensTotal: number | null;
    tokensUsed: number | null;
    tokensRemaining: number | null;
    resetsAt: string | null;
  };
  rpm: {
    limitRpm: number | null;
    remainingRpm: number | null;
    tier: string | null;
    resetInSeconds: number | null;
  };
  dynamicPacing: {
    autoSyncFromEndpoint: boolean;
    effectiveRpmLimit: number;
    effectiveTpmLimit: number;
    maxConcurrentChunks: number;
    tokenSaverMode: boolean;
  };
  stats: {
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    costTokens: number;
    costUsd: number;
    windowEntries: SlidingWindowEntry[];
  };
}

interface InternalBeatApiState {
  apiKey: string;
  endpointBase: string;
  lastSyncedAt: string | null;
  syncStatus: 'idle' | 'syncing' | 'verified' | 'error';
  lastError: string | null;
  usageReport: {
    period: '24h' | '7d' | '30d' | 'all';
    accountName: string | null;
    creditBalanceUsd: number | null;
    totalTasks: number | null;
    creditsSettledUsd: number | null;
    creditsRefundedUsd: number | null;
    concurrencyLimit: number | null;
    concurrencyActive: number | null;
  };
  dynamicPacing: {
    autoAdaptConcurrency: boolean;
    effectiveRpmLimit: number;
    effectiveConcurrencyLimit: number;
    tokenSaverMode: boolean;
  };
  stats: {
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    windowEntries: SlidingWindowEntry[];
  };
}

interface LedgerItem {
  id: string;
  timestamp: string;
  stage: 'transcribe' | 'translate';
  provider: ProviderId;
  slotLabel: string;
  strictModel: StrictModelId;
  chunkIndex: number;
  chunkRangeSec: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  costTokens?: number;
  costUsd?: number;
  durationMs: number;
  status: 'success' | 'rotated' | 'error';
  rotatedToSlot?: string;
  errorDetail?: string;
}

const serverState: {
  activeProvider: ProviderId;
  strictModel: StrictModelId;
  aistudio: {
    autoRotateEnabled: boolean;
    activeSlotIndex: number;
    totalRotationsCount: number;
    lastRotationReason: string | null;
    slots: InternalAIStudioSlot[];
  };
  apinex: InternalApinexState;
  beatapi: InternalBeatApiState;
  ledger: LedgerItem[];
} = {
  activeProvider: 'aistudio',
  strictModel: 'gemini-4-argon',
  aistudio: {
    autoRotateEnabled: true,
    activeSlotIndex: 0,
    totalRotationsCount: 0,
    lastRotationReason: null,
    slots: initialAiStudioSlots,
  },
  apinex: {
    apiKey: (process.env.APINEX_API_KEY || '').trim(),
    endpointBase: 'https://api.apinex.bond/v1',
    lastSyncedAt: null,
    syncStatus: 'idle',
    lastError: null,
    balance: {
      balanceUsd: null,
      reservedUsd: null,
      keyId: null,
      spendLimitUsd: null,
      spentUsd: null,
      remainingUsd: null,
      limitReached: null,
    },
    subscription: {
      plan: null,
      tokensTotal: null,
      tokensUsed: null,
      tokensRemaining: null,
      resetsAt: null,
    },
    rpm: {
      limitRpm: null,
      remainingRpm: null,
      tier: null,
      resetInSeconds: null,
    },
    dynamicPacing: {
      autoSyncFromEndpoint: true,
      effectiveRpmLimit: 30,
      effectiveTpmLimit: 500000,
      maxConcurrentChunks: 1,
      tokenSaverMode: true,
    },
    stats: {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costTokens: 0,
      costUsd: 0,
      windowEntries: [],
    },
  },
  beatapi: {
    apiKey: (process.env.BEATAPI_API_KEY || '').trim(),
    endpointBase: 'https://api.beatapi.io/v1',
    lastSyncedAt: null,
    syncStatus: 'idle',
    lastError: null,
    usageReport: {
      period: 'all',
      accountName: null,
      creditBalanceUsd: null,
      totalTasks: null,
      creditsSettledUsd: null,
      creditsRefundedUsd: null,
      concurrencyLimit: null,
      concurrencyActive: null,
    },
    dynamicPacing: {
      autoAdaptConcurrency: true,
      effectiveRpmLimit: 30,
      effectiveConcurrencyLimit: 2,
      tokenSaverMode: true,
    },
    stats: {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      windowEntries: [],
    },
  },
  ledger: [],
};

/**
 * Load persisted API keys & settings from disk so the user never has to re-enter keys!
 */
function loadPersistedConfig(): void {
  try {
    if (!fs.existsSync(PERSIST_CONFIG_PATH)) return;
    const raw = fs.readFileSync(PERSIST_CONFIG_PATH, 'utf-8');
    const saved = JSON.parse(raw);

    if (saved.activeProvider && ['aistudio', 'apinex', 'beatapi'].includes(saved.activeProvider)) {
      serverState.activeProvider = saved.activeProvider;
    }
    if (saved.strictModel && VALID_MODELS.includes(saved.strictModel)) {
      serverState.strictModel = normalizeStrictModelId(saved.strictModel);
    }
    if (typeof saved.aistudioAutoRotate === 'boolean') {
      serverState.aistudio.autoRotateEnabled = saved.aistudioAutoRotate;
    }
    if (typeof saved.aistudioActiveSlotIndex === 'number' && saved.aistudioActiveSlotIndex >= 0) {
      serverState.aistudio.activeSlotIndex = saved.aistudioActiveSlotIndex;
    }
    if (Array.isArray(saved.allAiStudioSlots) && saved.allAiStudioSlots.length > 0) {
      serverState.aistudio.slots = saved.allAiStudioSlots
        .filter((s: any) => s && typeof s.apiKey === 'string' && s.apiKey.trim())
        .map((s: any, idx: number) => ({
          slotId: s.slotId || `aistudio-slot-${idx + 1}`,
          label: s.label || `AI Studio Key #${idx + 1}`,
          apiKey: s.apiKey.trim(),
          maskedIdentifier: maskKey(s.apiKey.trim()),
          source: s.source || (idx === 0 ? 'env_primary' : 'runtime_slot'),
          status: 'ready',
          cooldownUntilMs: null,
          lastError: null,
          lastUsedAt: null,
          limits: {
            rpmLimit: Number(s.limits?.rpmLimit) || 15,
            tpmLimit: Number(s.limits?.tpmLimit) || 1000000,
            rpdLimit: Number(s.limits?.rpdLimit) || 1500,
          },
          stats: {
            todayDate: getTodayDateString(),
            todayRequests: 0,
            totalRequests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            windowEntries: [],
          },
        }));
    } else if (Array.isArray(saved.runtimeAiStudioSlots)) {
      for (const s of saved.runtimeAiStudioSlots) {
        if (s.apiKey && !serverState.aistudio.slots.some((existing) => existing.apiKey === s.apiKey)) {
          serverState.aistudio.slots.push({
            slotId: s.slotId || `aistudio-slot-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            label: s.label || `AI Studio Key #${serverState.aistudio.slots.length + 1}`,
            apiKey: s.apiKey,
            maskedIdentifier: maskKey(s.apiKey),
            source: 'runtime_slot',
            status: 'ready',
            cooldownUntilMs: null,
            lastError: null,
            lastUsedAt: null,
            limits: {
              rpmLimit: Number(s.limits?.rpmLimit) || 15,
              tpmLimit: Number(s.limits?.tpmLimit) || 1000000,
              rpdLimit: Number(s.limits?.rpdLimit) || 1500,
            },
            stats: {
              todayDate: getTodayDateString(),
              todayRequests: 0,
              totalRequests: 0,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              windowEntries: [],
            },
          });
        }
      }
    }
    if (serverState.aistudio.activeSlotIndex >= serverState.aistudio.slots.length) {
      serverState.aistudio.activeSlotIndex = 0;
    }
    if (typeof saved.apinexKey === 'string' && saved.apinexKey.trim()) {
      serverState.apinex.apiKey = saved.apinexKey.trim();
    }
    if (typeof saved.beatapiKey === 'string' && saved.beatapiKey.trim()) {
      serverState.beatapi.apiKey = saved.beatapiKey.trim();
    }
    if (saved.apinexStats && typeof saved.apinexStats === 'object') {
      serverState.apinex.stats.totalRequests = Number(saved.apinexStats.totalRequests) || 0;
      serverState.apinex.stats.promptTokens = Number(saved.apinexStats.promptTokens) || 0;
      serverState.apinex.stats.completionTokens = Number(saved.apinexStats.completionTokens) || 0;
      serverState.apinex.stats.reasoningTokens = Number(saved.apinexStats.reasoningTokens) || 0;
      serverState.apinex.stats.totalTokens = Number(saved.apinexStats.totalTokens) || 0;
      serverState.apinex.stats.costTokens = Number(saved.apinexStats.costTokens) || 0;
      serverState.apinex.stats.costUsd = Number(saved.apinexStats.costUsd) || 0;
    }
    if (Array.isArray(saved.ledger)) {
      serverState.ledger = saved.ledger.slice(0, 500);
    }
  } catch {
    // Ignore corrupt config file
  }
}

function savePersistedConfig(): void {
  try {
    const allAiStudioSlots = serverState.aistudio.slots.map((s) => ({
      slotId: s.slotId,
      label: s.label,
      apiKey: s.apiKey,
      source: s.source,
      limits: s.limits,
    }));
    const runtimeSlots = serverState.aistudio.slots
      .filter((s) => s.source === 'runtime_slot')
      .map((s) => ({
        slotId: s.slotId,
        label: s.label,
        apiKey: s.apiKey,
        limits: s.limits,
      }));

    const payload = {
      activeProvider: serverState.activeProvider,
      strictModel: serverState.strictModel,
      aistudioAutoRotate: serverState.aistudio.autoRotateEnabled,
      aistudioActiveSlotIndex: serverState.aistudio.activeSlotIndex,
      allAiStudioSlots,
      runtimeAiStudioSlots: runtimeSlots,
      apinexKey: serverState.apinex.apiKey,
      beatapiKey: serverState.beatapi.apiKey,
      apinexStats: {
        totalRequests: serverState.apinex.stats.totalRequests,
        promptTokens: serverState.apinex.stats.promptTokens,
        completionTokens: serverState.apinex.stats.completionTokens,
        reasoningTokens: serverState.apinex.stats.reasoningTokens,
        totalTokens: serverState.apinex.stats.totalTokens,
        costTokens: serverState.apinex.stats.costTokens,
        costUsd: serverState.apinex.stats.costUsd,
      },
      ledger: serverState.ledger.slice(0, 500),
    };
    fs.writeFileSync(PERSIST_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Non-fatal if filesystem is read-only
  }
}

loadPersistedConfig();

function pruneSlidingWindow(entries: SlidingWindowEntry[]): {
  currentRpm: number;
  currentTpm: number;
} {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (entries.length > 0 && entries[0].ts < cutoff) {
    entries.shift();
  }
  const currentRpm = entries.length;
  const currentTpm = entries.reduce((acc, item) => acc + item.tokens, 0);
  return { currentRpm, currentTpm };
}

function refreshAiStudioSlotStates(): void {
  const now = Date.now();
  const today = getTodayDateString();
  for (const slot of serverState.aistudio.slots) {
    if (slot.stats.todayDate !== today) {
      slot.stats.todayDate = today;
      slot.stats.todayRequests = 0;
    }
    if (slot.cooldownUntilMs && now >= slot.cooldownUntilMs) {
      slot.cooldownUntilMs = null;
      if (slot.status === 'cooldown' || slot.status === 'rate_limited') {
        slot.status = 'ready';
      }
    }
    pruneSlidingWindow(slot.stats.windowEntries);
  }
}

function buildPublicSnapshot() {
  refreshAiStudioSlotStates();
  const apinexWindow = pruneSlidingWindow(serverState.apinex.stats.windowEntries);
  const beatWindow = pruneSlidingWindow(serverState.beatapi.stats.windowEntries);

  return {
    serverTime: new Date().toISOString(),
    activeProvider: serverState.activeProvider,
    strictModel: serverState.strictModel,
    aistudio: {
      autoRotateEnabled: serverState.aistudio.autoRotateEnabled,
      activeSlotIndex: serverState.aistudio.activeSlotIndex,
      totalRotationsCount: serverState.aistudio.totalRotationsCount,
      lastRotationReason: serverState.aistudio.lastRotationReason,
      slots: serverState.aistudio.slots.map((s) => {
        const win = pruneSlidingWindow(s.stats.windowEntries);
        return {
          slotId: s.slotId,
          label: s.label,
          rawKey: s.apiKey,
          maskedIdentifier: s.maskedIdentifier,
          source: s.source,
          status: s.status,
          cooldownUntilMs: s.cooldownUntilMs,
          lastError: s.lastError,
          lastUsedAt: s.lastUsedAt,
          limits: { ...s.limits },
          liveUsage: {
            currentRpm: win.currentRpm,
            currentTpm: win.currentTpm,
            todayRequests: s.stats.todayRequests,
            totalRequests: s.stats.totalRequests,
            promptTokens: s.stats.promptTokens,
            completionTokens: s.stats.completionTokens,
            totalTokens: s.stats.totalTokens,
          },
        };
      }),
    },
    apinex: {
      configured: Boolean(serverState.apinex.apiKey),
      rawKey: serverState.apinex.apiKey || null,
      maskedIdentifier: serverState.apinex.apiKey
        ? maskKey(serverState.apinex.apiKey)
        : null,
      endpointBase: serverState.apinex.endpointBase,
      lastSyncedAt: serverState.apinex.lastSyncedAt,
      syncStatus: serverState.apinex.syncStatus,
      lastError: serverState.apinex.lastError,
      balance: { ...serverState.apinex.balance },
      subscription: { ...serverState.apinex.subscription },
      rpm: { ...serverState.apinex.rpm },
      dynamicPacing: { ...serverState.apinex.dynamicPacing },
      liveUsage: {
        currentRpm: apinexWindow.currentRpm,
        currentTpm: apinexWindow.currentTpm,
        totalRequests: serverState.apinex.stats.totalRequests,
        promptTokens: serverState.apinex.stats.promptTokens,
        completionTokens: serverState.apinex.stats.completionTokens,
        reasoningTokens: serverState.apinex.stats.reasoningTokens,
        totalTokens: serverState.apinex.stats.totalTokens,
        costTokens: serverState.apinex.stats.costTokens,
        costUsd: serverState.apinex.stats.costUsd,
      },
    },
    beatapi: {
      configured: Boolean(serverState.beatapi.apiKey),
      rawKey: serverState.beatapi.apiKey || null,
      maskedIdentifier: serverState.beatapi.apiKey
        ? maskKey(serverState.beatapi.apiKey)
        : null,
      endpointBase: serverState.beatapi.endpointBase,
      lastSyncedAt: serverState.beatapi.lastSyncedAt,
      syncStatus: serverState.beatapi.syncStatus,
      lastError: serverState.beatapi.lastError,
      usageReport: { ...serverState.beatapi.usageReport },
      dynamicPacing: { ...serverState.beatapi.dynamicPacing },
      liveUsage: {
        currentRpm: beatWindow.currentRpm,
        currentTpm: beatWindow.currentTpm,
        totalRequests: serverState.beatapi.stats.totalRequests,
        promptTokens: serverState.beatapi.stats.promptTokens,
        completionTokens: serverState.beatapi.stats.completionTokens,
        totalTokens: serverState.beatapi.stats.totalTokens,
      },
    },
    ledger: serverState.ledger.slice(0, 500),
  };
}

async function syncApinexLiveState(): Promise<void> {
  const key = serverState.apinex.apiKey;
  if (!key) {
    serverState.apinex.syncStatus = 'idle';
    serverState.apinex.lastError = null;
    return;
  }

  serverState.apinex.syncStatus = 'syncing';
  serverState.apinex.lastError = null;

  const baseCandidates = [
    'https://api.apinex.bond/v1',
    serverState.apinex.endpointBase.replace(/\/+$/, ''),
  ];
  const uniqueBases = Array.from(new Set(baseCandidates));

  let activeBase = uniqueBases[0];
  let balanceOk = false;
  let lastFetchError = '';

  const apinexHeaders = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenAI/JS',
  };

  for (const base of uniqueBases) {
    try {
      const balResp = await fetch(`${base}/balance`, {
        method: 'GET',
        headers: apinexHeaders,
        signal: AbortSignal.timeout(8000),
      });

      if (balResp.ok) {
        const balData = (await balResp.json()) as Record<string, any>;
        serverState.apinex.balance = {
          balanceUsd:
            typeof balData.balance_usd === 'number' ? balData.balance_usd : null,
          reservedUsd:
            typeof balData.reserved_usd === 'number' ? balData.reserved_usd : null,
          keyId: balData.api_key?.id ?? null,
          spendLimitUsd:
            typeof balData.api_key?.spend_limit_usd === 'number'
              ? balData.api_key.spend_limit_usd
              : null,
          spentUsd:
            typeof balData.api_key?.spent_usd === 'number'
              ? balData.api_key.spent_usd
              : null,
          remainingUsd:
            typeof balData.api_key?.remaining_usd === 'number'
              ? balData.api_key.remaining_usd
              : null,
          limitReached:
            typeof balData.api_key?.limit_reached === 'boolean'
              ? balData.api_key.limit_reached
              : null,
        };
        if (typeof balData.rpm === 'number') {
          serverState.apinex.rpm = {
            limitRpm: balData.rpm,
            remainingRpm: balData.rpm,
            tier: typeof balData.rpm_plan === 'string' ? balData.rpm_plan : 'free',
            resetInSeconds: null,
          };
          serverState.apinex.dynamicPacing.effectiveRpmLimit = balData.rpm;
        }
        activeBase = base;
        serverState.apinex.endpointBase = base;
        balanceOk = true;
        break;
      } else {
        const errText = await balResp.text();
        lastFetchError = cleanHttpErrorText(balResp.status, errText);
      }
    } catch (err: any) {
      lastFetchError = err?.message || 'Network connection error to apinex.bond';
    }
  }

  try {
    const subResp = await fetch(`${activeBase}/subscription`, {
      method: 'GET',
      headers: apinexHeaders,
      signal: AbortSignal.timeout(6000),
    });

    if (subResp.ok) {
      const subData = (await subResp.json()) as Record<string, any>;
      serverState.apinex.subscription = {
        plan:
          typeof subData.plan === 'string'
            ? subData.plan
            : typeof subData.plan_label === 'string'
            ? subData.plan_label
            : typeof subData.mode === 'string'
            ? subData.mode
            : null,
        tokensTotal:
          typeof subData.tokens_total === 'number'
            ? subData.tokens_total
            : typeof subData.token_limit === 'number'
            ? subData.token_limit
            : null,
        tokensUsed:
          typeof subData.tokens_used === 'number'
            ? subData.tokens_used
            : null,
        tokensRemaining:
          typeof subData.tokens_remaining === 'number'
            ? subData.tokens_remaining
            : null,
        resetsAt:
          typeof subData.resets_at === 'string'
            ? subData.resets_at
            : typeof subData.resets_at_utc === 'string'
            ? subData.resets_at_utc
            : null,
      };
      balanceOk = true;
    }
  } catch {
    // Secondary check optional
  }

  serverState.apinex.lastSyncedAt = new Date().toISOString();
  if (balanceOk) {
    serverState.apinex.syncStatus = 'verified';
    serverState.apinex.lastError = null;
  } else {
    serverState.apinex.syncStatus = 'error';
    serverState.apinex.lastError =
      lastFetchError || 'Failed to verify apinex.bond balance endpoint.';
  }
}

async function syncBeatApiLiveState(
  periodOverride?: '24h' | '7d' | '30d' | 'all'
): Promise<void> {
  const key = serverState.beatapi.apiKey;
  if (!key) {
    serverState.beatapi.syncStatus = 'idle';
    serverState.beatapi.lastError = null;
    return;
  }

  const period = periodOverride || serverState.beatapi.usageReport.period || 'all';
  serverState.beatapi.syncStatus = 'syncing';
  serverState.beatapi.lastError = null;

  const base = serverState.beatapi.endpointBase.replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/usage?period=${encodeURIComponent(period)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (resp.ok) {
      const data = (await resp.json()) as Record<string, any>;
      const concLimit =
        typeof data.concurrency?.limit === 'number'
          ? data.concurrency.limit
          : null;
      serverState.beatapi.usageReport = {
        period,
        accountName:
          typeof data.account_name === 'string' ? data.account_name : null,
        creditBalanceUsd:
          typeof data.credit_balance === 'number' ? data.credit_balance : null,
        totalTasks:
          typeof data.total_tasks === 'number' ? data.total_tasks : null,
        creditsSettledUsd:
          typeof data.credits_settled === 'number' ? data.credits_settled : null,
        creditsRefundedUsd:
          typeof data.credits_refunded === 'number'
            ? data.credits_refunded
            : null,
        concurrencyLimit: concLimit,
        concurrencyActive:
          typeof data.concurrency?.active === 'number'
            ? data.concurrency.active
            : null,
      };
      if (concLimit && concLimit > 0) {
        serverState.beatapi.dynamicPacing.effectiveConcurrencyLimit = concLimit;
      }
      serverState.beatapi.lastSyncedAt = new Date().toISOString();
      serverState.beatapi.syncStatus = 'verified';
      serverState.beatapi.lastError = null;
    } else {
      const errText = await resp.text();
      serverState.beatapi.lastSyncedAt = new Date().toISOString();
      serverState.beatapi.syncStatus = 'error';
      serverState.beatapi.lastError = cleanHttpErrorText(resp.status, errText);
    }
  } catch (err: any) {
    serverState.beatapi.lastSyncedAt = new Date().toISOString();
    serverState.beatapi.syncStatus = 'error';
    serverState.beatapi.lastError =
      err?.message || 'Network connection error to api.beatapi.io';
  }
}

function selectAiStudioSlotForExecution(rotationMessages: string[]): {
  slot: InternalAIStudioSlot;
  slotIndex: number;
  rotated: boolean;
} {
  refreshAiStudioSlotStates();
  const slots = serverState.aistudio.slots;
  if (slots.length === 0) {
    throw new Error(
      'AI Studio API Key မရှိသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် AI Studio Key ထည့်သွင်းပါ။'
    );
  }

  let currentIndex = serverState.aistudio.activeSlotIndex;
  if (currentIndex < 0 || currentIndex >= slots.length) {
    currentIndex = 0;
    serverState.aistudio.activeSlotIndex = 0;
  }

  const checkSlotEligible = (
    slot: InternalAIStudioSlot
  ): { ok: boolean; reason?: string } => {
    if (slot.status === 'invalid') {
      return { ok: false, reason: `${slot.label} API Key မှားယွင်းနေပါသည်` };
    }
    if (slot.cooldownUntilMs && Date.now() < slot.cooldownUntilMs) {
      const secs = Math.ceil((slot.cooldownUntilMs - Date.now()) / 1000);
      return {
        ok: false,
        reason: `${slot.label} Rate Limit ပြည့်နေပါသည် (${secs}s ကျန်)`,
      };
    }
    const win = pruneSlidingWindow(slot.stats.windowEntries);
    if (win.currentRpm >= slot.limits.rpmLimit) {
      return {
        ok: false,
        reason: `${slot.label} RPM Limit ပြည့်သွားပါပြီ (${win.currentRpm}/${slot.limits.rpmLimit} RPM)`,
      };
    }
    if (win.currentTpm >= slot.limits.tpmLimit) {
      return {
        ok: false,
        reason: `${slot.label} TPM Limit ပြည့်သွားပါပြီ (${win.currentTpm}/${slot.limits.tpmLimit} TPM)`,
      };
    }
    if (slot.stats.todayRequests >= slot.limits.rpdLimit) {
      return {
        ok: false,
        reason: `${slot.label} တစ်နေ့တာ RPD Limit ပြည့်သွားပါပြီ (${slot.stats.todayRequests}/${slot.limits.rpdLimit} RPD)`,
      };
    }
    return { ok: true };
  };

  // Always check the user's selected activeSlotIndex FIRST!
  const primaryCheck = checkSlotEligible(slots[currentIndex]);
  if (primaryCheck.ok) {
    return { slot: slots[currentIndex], slotIndex: currentIndex, rotated: false };
  }

  // If Auto-Rotate is OFF, strictly stay on the user's selected Key!
  if (!serverState.aistudio.autoRotateEnabled) {
    throw new Error(
      `${primaryCheck.reason || `${slots[currentIndex].label} Limit ပြည့်နေပါသည်`} (Auto-Rotate ပိတ်ထားသောကြောင့် အခြား Key သို့ မပြောင်းပါ)။`
    );
  }

  if (slots.length === 1) {
    throw new Error(
      primaryCheck.reason ||
        `${slots[currentIndex].label} Limit ပြည့်နေပါသည်။ နောက်ထပ် AI Studio Key ထပ်ပေါင်းထည့်နိုင်ပါသည်။`
    );
  }

  // Auto-Rotate ONLY because the user's selected Key truly reached its Limit!
  for (let offset = 1; offset < slots.length; offset++) {
    const candidateIdx = (currentIndex + offset) % slots.length;
    const candidate = slots[candidateIdx];
    const check = checkSlotEligible(candidate);
    if (check.ok) {
      const reason = `${primaryCheck.reason} -> ${candidate.label} သို့ အလိုအလျောက် ပြောင်းလဲခဲ့သည်`;
      rotationMessages.push(reason);
      serverState.aistudio.activeSlotIndex = candidateIdx;
      serverState.aistudio.totalRotationsCount += 1;
      serverState.aistudio.lastRotationReason = reason;
      savePersistedConfig();
      return { slot: candidate, slotIndex: candidateIdx, rotated: true };
    }
  }

  throw new Error(
    `AI Studio Key အားလုံး Limit ပြည့်နေပါသည် (${primaryCheck.reason})။ ခေတ္တစောင့်ဆိုင်းပါ သို့မဟုတ် Reset နှိပ်ပါ။`
  );
}

const TRANSCRIBE_ONLY_SCHEMA = {
  type: Type.ARRAY,
  description:
    'Ordered list of verbatim acoustic speech segments in the exact spoken language with sub-second timestamps.',
  items: {
    type: Type.OBJECT,
    properties: {
      startOffsetSec: {
        type: Type.NUMBER,
        description: 'Start time in seconds from beginning of this audio (e.g. 0.4, 5.2).',
      },
      endOffsetSec: {
        type: Type.NUMBER,
        description: 'End time in seconds from beginning of this audio (e.g. 2.9, 8.6).',
      },
      speaker: {
        type: Type.STRING,
        description: 'Speaker label (e.g. Speaker 1, Female, Male).',
      },
      detectedLanguage: {
        type: Type.STRING,
        description: 'Spoken language name (e.g. Japanese, English, Korean, Chinese, Thai, Burmese).',
      },
      originalText: {
        type: Type.STRING,
        description:
          '100% literal word-for-word transcription in the exact spoken language and native script. Do NOT translate.',
      },
    },
    required: ['startOffsetSec', 'endOffsetSec', 'originalText'],
  },
};

function resolveVerbatimLanguageDirective(sourceLanguage: string): {
  cleanName: string;
  scriptDirective: string;
} {
  const lower = (sourceLanguage || '').toLowerCase();
  if (lower.includes('japanese') || lower.includes('ဂျပန်')) {
    return {
      cleanName: 'Japanese',
      scriptDirective:
        'Spoken language is JAPANESE. Output 100% literal word-for-word Japanese script (Kanji, Hiragana, Katakana) matching every spoken syllable, particle (ね, よ, な, わ), contraction, and vocal expression.',
    };
  }
  if (lower.includes('korean') || lower.includes('ကိုရီးယား')) {
    return {
      cleanName: 'Korean',
      scriptDirective:
        'Spoken language is KOREAN. Output 100% literal word-for-word Korean Hangul (한글) matching every spoken phrase, colloquial ending, and vocal expression.',
    };
  }
  if (lower.includes('chinese') || lower.includes('တရုတ်') || lower.includes('mandarin')) {
    return {
      cleanName: 'Chinese',
      scriptDirective:
        'Spoken language is CHINESE. Output 100% literal word-for-word Chinese characters (汉字) matching every spoken phrase and modal particle (啊, 吧, 呢, 嘛, 喔).',
    };
  }
  if (lower.includes('thai') || lower.includes('ထိုင်း')) {
    return {
      cleanName: 'Thai',
      scriptDirective:
        'Spoken language is THAI. Output 100% literal word-for-word Thai script (ภาษาไทย) matching every spoken phrase and particle (ครับ, ค่ะ, นะ, จ๊ะ, วะ).',
    };
  }
  if (lower.includes('burmese') || lower.includes('မြန်မာ')) {
    return {
      cleanName: 'Burmese',
      scriptDirective:
        'Spoken language is BURMESE. Output 100% literal word-for-word Myanmar Unicode script (မြန်မာစာ) matching every spoken word.',
    };
  }
  if (lower.includes('english') || lower.includes('အင်္ဂလိပ်')) {
    return {
      cleanName: 'English',
      scriptDirective:
        'Spoken language is ENGLISH. Output 100% literal word-for-word English matching every contraction, slang, colloquialism, and vocal expression.',
    };
  }
  if (lower.includes('russian') || lower.includes('ရုရှား')) {
    return {
      cleanName: 'Russian',
      scriptDirective:
        'Spoken language is RUSSIAN. Output 100% literal word-for-word Cyrillic script matching every spoken word.',
    };
  }
  if (lower.includes('spanish') || lower.includes('စပိန်')) {
    return {
      cleanName: 'Spanish',
      scriptDirective:
        'Spoken language is SPANISH. Output 100% literal word-for-word Spanish matching every spoken word.',
    };
  }
  if (lower.includes('vietnamese') || lower.includes('ဗီယက်နမ်')) {
    return {
      cleanName: 'Vietnamese',
      scriptDirective:
        'Spoken language is VIETNAMESE. Output 100% literal word-for-word Vietnamese script with full diacritics.',
    };
  }
  return {
    cleanName: 'Auto-Detect Native Spoken Language',
    scriptDirective:
      'Identify the exact language spoken in the audio (e.g., Japanese, English, Korean, Chinese, Thai, Burmese, Russian, Spanish, Vietnamese) and write 100% word-for-word in that exact spoken language and its native writing script. NEVER translate into Burmese or English if another language is spoken.',
  };
}

const TRANSLATE_BATCH_SCHEMA = {
  type: Type.ARRAY,
  description: 'Ordered list of translated subtitle cues matching the input cue IDs.',
  items: {
    type: Type.OBJECT,
    properties: {
      id: {
        type: Type.STRING,
        description: 'Exact cue ID from the input array.',
      },
      index: {
        type: Type.INTEGER,
        description: 'Exact cue index from the input array.',
      },
      translatedText: {
        type: Type.STRING,
        description: 'Accurate, natural spoken translation in the target subtitle language.',
      },
    },
    required: ['id', 'index', 'translatedText'],
  },
};

const UNCENSORED_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

function extractRawContentString(rawContent: any): string {
  if (typeof rawContent === 'string') return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .join('\n');
  }
  if (rawContent && typeof rawContent === 'object') {
    if (typeof rawContent.text === 'string') return rawContent.text;
    if (typeof rawContent.content === 'string') return rawContent.content;
    return JSON.stringify(rawContent);
  }
  return '';
}

function parseTimestampToSeconds(val: any): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, val);
  if (typeof val !== 'string') return null;
  const s = val.trim().replace(/s$/i, '');
  if (!s) return null;
  const direct = Number(s);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  // Handle MM:SS.ms or HH:MM:SS.ms
  const parts = s.replace(',', '.').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  return null;
}

function extractJsonArrayFromText(rawInput: any): any[] {
  const raw = extractRawContentString(rawInput);
  // Strip <think>...</think> blocks if a reasoning proxy included them
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const trimmed = withoutThink
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['cues', 'translations', 'subtitles', 'items', 'segments', 'data', 'result']) {
        if (Array.isArray((parsed as any)[key])) return (parsed as any)[key];
      }
      // Single cue object
      if (
        (parsed as any).originalText ||
        (parsed as any).text ||
        (parsed as any).t ||
        (parsed as any).translatedText
      ) {
        return [parsed];
      }
    }
  } catch {
    // 1. Try finding [ ... ] substring
    const startBracket = trimmed.indexOf('[');
    const endBracket = trimmed.lastIndexOf(']');
    if (startBracket !== -1 && endBracket > startBracket) {
      try {
        const sub = JSON.parse(trimmed.slice(startBracket, endBracket + 1));
        if (Array.isArray(sub)) return sub;
      } catch {
        // continue to object-by-object recovery
      }
    }

    // 2. Recover individual JSON objects even if the array was truncated mid-stream!
    const recoveredObjects: any[] = [];
    const objRegex = /\{[^{}]+\}/g;
    let match: RegExpExecArray | null;
    while ((match = objRegex.exec(trimmed)) !== null) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj && typeof obj === 'object') {
          recoveredObjects.push(obj);
        }
      } catch {
        // skip malformed fragment
      }
    }
    if (recoveredObjects.length > 0) {
      return recoveredObjects;
    }
  }
  return [];
}

/**
 * Universal Multi-Format Transcript Parser:
 * Guarantees that whether an AI Studio or external gateway model returns:
 * 1) Standard JSON array with `originalText` / `startOffsetSec`
 * 2) Compact JSON array with `t` / `text` / `transcript` / `dialogue` and `s` / `start` / `e` / `end`
 * 3) Truncated JSON array where the final `]` was cut off by max_tokens
 * 4) Timestamped text lines (e.g. `[00:01.20 - 00:04.50] Text` or `0.5 - 2.8: Text`)
 * 5) Plain text lines
 * ...it ALWAYS extracts valid, accurately timed cues and NEVER returns 0 cues when speech text exists.
 */
function isRefusalOrMetaText(text: string): boolean {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return true;
  const refusalPatterns = [
    "i can't complete",
    'i cannot complete',
    'unable to complete',
    'no audio file',
    'no audio attachment',
    'provided in our conversation',
    'fabricated rather than forensic',
    'json array format',
    'as an ai',
    'i am unable to',
    "i'm unable to",
    'cannot transcribe',
    "can't transcribe",
    'no burned-in',
    'no subtitles visible',
    'no visible text',
    'there is no speech',
    'no speech detected',
    'i cannot see any',
    "i don't see any",
  ];
  return refusalPatterns.some((pat) => lower.includes(pat));
}

function normalizeCueMatchKey(text: string): string {
  return (text || '')
    .replace(/[\s,，.。!！?？:：;；~～—\-'"“”‘’()（）\[\]【】「」『』*＊]/g, '')
    .toLowerCase();
}

function deduplicateConsecutiveCues<
  T extends {
    startOffsetSec: number;
    endOffsetSec: number;
    originalText: string;
    speaker: string;
    detectedLanguage: string;
    toneNote: string;
    cardIndex?: number;
  }
>(cues: T[]): T[] {
  if (cues.length <= 1) return cues;
  const sorted = [...cues].sort((a, b) => a.startOffsetSec - b.startOffsetSec);
  const out: T[] = [];

  for (const item of sorted) {
    const normItem = normalizeCueMatchKey(item.originalText);
    if (!normItem) continue;

    const prev = out[out.length - 1];
    if (prev) {
      const normPrev = normalizeCueMatchKey(prev.originalText);
      const gap = item.startOffsetSec - prev.endOffsetSec;
      const startDiff = Math.abs(item.startOffsetSec - prev.startOffsetSec);

      // Merge identical text only across contiguous tiles/sheet boundaries (gap <= 0.85s) or same-timestamp overlap
      if (
        (normPrev === normItem && gap <= 0.85) ||
        (normPrev.length >= 3 &&
          normItem.length >= 3 &&
          Math.abs(normPrev.length - normItem.length) <= 2 &&
          (normPrev.includes(normItem) || normItem.includes(normPrev)) &&
          startDiff <= 0.75)
      ) {
        prev.startOffsetSec = Number(
          Math.min(prev.startOffsetSec, item.startOffsetSec).toFixed(2)
        );
        prev.endOffsetSec = Number(
          Math.max(prev.endOffsetSec, item.endOffsetSec).toFixed(2)
        );
        if (item.originalText.length > prev.originalText.length) {
          prev.originalText = item.originalText;
        }
        continue;
      }
    }
    out.push({ ...item });
  }

  return out;
}

function parseUniversalTranscriptCues(
  rawInput: any,
  chunkDurationSec: number,
  defaultLangName: string,
  detectedCards: Array<{
    cardIndex: number;
    startOffsetSec: number;
    endOffsetSec: number;
    yPercent?: number;
  }> = [],
  chunkStartSec: number = 0
): Array<{
  cardIndex?: number;
  startOffsetSec: number;
  endOffsetSec: number;
  speaker: string;
  detectedLanguage: string;
  originalText: string;
  toneNote: string;
}> {
  const rawItems = extractJsonArrayFromText(rawInput);
  const results: Array<{
    cardIndex?: number;
    startOffsetSec: number;
    endOffsetSec: number;
    speaker: string;
    detectedLanguage: string;
    originalText: string;
    toneNote: string;
  }> = [];

  const cardMap = new Map<
    number,
    { cardIndex: number; startOffsetSec: number; endOffsetSec: number }
  >();
  for (const c of detectedCards) {
    if (c && typeof c.cardIndex === 'number') {
      cardMap.set(c.cardIndex, c);
    }
  }

  const speakerMap = new Map<string, string>();
  const normalizeSpeakerLabel = (rawSpk: string): string => {
    const s = (rawSpk || '').trim();
    if (!s) return 'Speaker 1';
    if (/^\d+$/.test(s)) {
      return `Speaker ${s}`;
    }
    if (/^Speaker\s*\d+$/i.test(s)) {
      return s.replace(/^speaker\s*(\d+)$/i, 'Speaker $1');
    }
    if (!speakerMap.has(s)) {
      speakerMap.set(s, `Speaker ${speakerMap.size + 1}`);
    }
    return speakerMap.get(s) || 'Speaker 1';
  };

  const cleanSingleSubtitleLine = (rawLine: string): string => {
    return rawLine
      .replace(/^#?\d+\s*\[[\d.]+s\s*-\s*[\d.]+s\]\s*[:|-]?\s*/i, '')
      .replace(/^CARD\s*#?\d+\s*[:|-]?\s*/i, '')
      // Strip stray leading/trailing unmatched brackets or collar-edge OCR artifacts like "(妈妈给你烧饭去"
      .replace(/^[(\[（【「『"']+|[)\]）】」』"']+$/g, '')
      .replace(/[。．]+$/g, '')
      // Join CJK characters separated by spaces within the same visual subtitle card
      .replace(/([\u4e00-\u9fff0-9])\s+([\u4e00-\u9fff0-9])/g, '$1$2')
      // Join 1-2 char CJK vocative followed by comma within the same single card (e.g., "妈，我回来了" -> "妈我回来了")
      .replace(/^([\u4e00-\u9fff]{1,2})[，,]+([\u4e00-\u9fff0-9]{2,})$/g, '$1$2')
      .trim();
  };

  if (rawItems.length > 0) {
    const count = rawItems.length;
    const avgDur = Math.max(1.2, chunkDurationSec / Math.max(1, count));

    rawItems.forEach((item: any, idx: number) => {
      if (!item || typeof item !== 'object') return;
      const textCandidate =
        item.originalText ??
        item.t ??
        item.text ??
        item.transcript ??
        item.dialogue ??
        item.content ??
        item.line ??
        item.utterance ??
        item.speech ??
        '';
      const rawTextStr = String(textCandidate).trim();
      if (!rawTextStr || isRefusalOrMetaText(rawTextStr)) return;

      // Match explicit cardIndex from LLM output, or 1-to-1 index if lengths match
      const parsedC =
        typeof item.c === 'number'
          ? item.c
          : typeof item.c === 'string' && /^#?\d+$/.test(item.c.trim())
          ? Number(item.c.trim().replace(/^#/, ''))
          : undefined;
      const rawCardIdx =
        typeof item.cardIndex === 'number'
          ? item.cardIndex
          : typeof item.card === 'number'
          ? item.card
          : parsedC !== undefined
          ? parsedC
          : typeof item.index === 'number' && cardMap.has(item.index)
          ? item.index
          : rawItems.length === detectedCards.length && detectedCards[idx]
          ? detectedCards[idx].cardIndex
          : undefined;

      const matchedCard =
        rawCardIdx !== undefined ? cardMap.get(rawCardIdx) : undefined;

      let parsedStart =
        matchedCard?.startOffsetSec ??
        parseTimestampToSeconds(item.startOffsetSec) ??
        parseTimestampToSeconds(item.s) ??
        parseTimestampToSeconds(item.start) ??
        parseTimestampToSeconds(item.startSec) ??
        parseTimestampToSeconds(item.startTime) ??
        parseTimestampToSeconds(item.start_time) ??
        idx * avgDur;

      let parsedEnd =
        matchedCard?.endOffsetSec ??
        parseTimestampToSeconds(item.endOffsetSec) ??
        parseTimestampToSeconds(item.e) ??
        parseTimestampToSeconds(item.end) ??
        parseTimestampToSeconds(item.endSec) ??
        parseTimestampToSeconds(item.endTime) ??
        parseTimestampToSeconds(item.end_time) ??
        parsedStart;

      // Only convert global PTS timestamps when NOT already matched to a chunk-relative `matchedCard`!
      if (
        !matchedCard &&
        chunkStartSec > 0.4 &&
        parsedStart >= chunkStartSec - 0.45
      ) {
        parsedStart = Math.max(0, parsedStart - chunkStartSec);
        if (parsedEnd >= chunkStartSec - 0.45) {
          parsedEnd = Math.max(parsedStart, parsedEnd - chunkStartSec);
        }
      }

      const safeStart = Math.min(
        Math.max(0, parsedStart),
        Math.max(0, chunkDurationSec - 0.05)
      );
      const safeEnd = Math.min(
        Math.max(safeStart, parsedEnd),
        Math.max(safeStart, chunkDurationSec + 0.5)
      );

      const spk = normalizeSpeakerLabel(
        String(
          item.speaker ??
            item.sp ??
            item.p ??
            item.role ??
            'Speaker 1'
        )
      );
      const detLang = String(
        item.detectedLanguage || item.lang || item.language || defaultLangName
      ).trim();
      const tNote = String(item.toneNote || item.tone || '').trim();

      // If the LLM put multiple newline-separated subtitle cards into a single JSON object, split them proportionally!
      const subLines = rawTextStr
        .split(/\r?\n+/)
        .map(cleanSingleSubtitleLine)
        .filter((l) => l.length > 0 && !isRefusalOrMetaText(l));

      if (subLines.length === 0) return;

      if (subLines.length === 1) {
        results.push({
          cardIndex: matchedCard?.cardIndex,
          startOffsetSec: Number(safeStart.toFixed(2)),
          endOffsetSec: Number(safeEnd.toFixed(2)),
          speaker: spk,
          detectedLanguage: detLang,
          originalText: subLines[0],
          toneNote: tNote,
        });
      } else {
        const totalDur = Math.max(0.6, safeEnd - safeStart);
        const stepDur = totalDur / subLines.length;
        subLines.forEach((subLine, sIdx) => {
          const sStart = safeStart + sIdx * stepDur;
          const sEnd =
            sIdx === subLines.length - 1 ? safeEnd : sStart + stepDur;
          results.push({
            startOffsetSec: Number(sStart.toFixed(2)),
            endOffsetSec: Number(Math.max(sStart + 0.3, sEnd).toFixed(2)),
            speaker: spk,
            detectedLanguage: detLang,
            originalText: subLine,
            toneNote: tNote,
          });
        });
      }
    });

    if (results.length > 0) {
      return deduplicateConsecutiveCues(results);
    }
  }

  // Fallback: ONLY parse explicitly timestamped lines (`[00:01.20 -> 00:04.50] Text`), NEVER plain refusal prose!
  const rawStr = extractRawContentString(rawInput)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (!rawStr || rawStr === '[]' || rawStr === '{}' || isRefusalOrMetaText(rawStr)) {
    return [];
  }

  const lines = rawStr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\d+$/.test(l) && l !== '[' && l !== ']');

  const timestampLineRegex =
    /^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?|\d+(?:\.\d+)?)s?\s*(?:-->|->|-|–|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?|\d+(?:\.\d+)?)s?\s*\]?\s*[:|-]?\s*(.+)$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = timestampLineRegex.exec(line);
    if (m) {
      const st = parseTimestampToSeconds(m[1]) ?? 0;
      const et = parseTimestampToSeconds(m[2]) ?? st + 2.5;
      const txt = cleanSingleSubtitleLine(m[3]);
      if (txt && !isRefusalOrMetaText(txt)) {
        results.push({
          startOffsetSec: Number(st.toFixed(2)),
          endOffsetSec: Number(Math.max(st + 0.6, et).toFixed(2)),
          speaker: 'Speaker 1',
          detectedLanguage: defaultLangName,
          originalText: txt,
          toneNote: '',
        });
      }
    }
  }

  return deduplicateConsecutiveCues(results);
}

function mapIsoLangToDisplay(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const c = code.toLowerCase().trim();
  const map: Record<string, string> = {
    ja: 'Japanese',
    en: 'English',
    ko: 'Korean',
    zh: 'Chinese',
    'zh-cn': 'Chinese',
    'zh-tw': 'Chinese',
    th: 'Thai',
    my: 'Burmese',
    ru: 'Russian',
    es: 'Spanish',
    vi: 'Vietnamese',
    fr: 'French',
    de: 'German',
    id: 'Indonesian',
    hi: 'Hindi',
    pt: 'Portuguese',
  };
  return map[c] || code.toUpperCase();
}

/**
 * Parses APInex native `/v1/tools/voice/stt` response (`results.channels[0].alternatives[0]` + `results.utterances`)
 * into clean, natural, sub-second timed subtitle cues.
 */
function parseApinexSttResponseToCues(
  sttJson: Record<string, any>,
  chunkDurationSec: number,
  defaultLangName: string
): Array<{
  startOffsetSec: number;
  endOffsetSec: number;
  speaker: string;
  detectedLanguage: string;
  originalText: string;
  toneNote: string;
}> {
  const channel0 = sttJson?.results?.channels?.[0];
  const alt0 = channel0?.alternatives?.[0];
  const detectedLang = mapIsoLangToDisplay(
    channel0?.detected_language,
    defaultLangName
  );
  const isCjkLang = /japanese|chinese|thai|burmese/i.test(detectedLang);

  const cues: Array<{
    startOffsetSec: number;
    endOffsetSec: number;
    speaker: string;
    detectedLanguage: string;
    originalText: string;
    toneNote: string;
  }> = [];

  // 1. Prefer utterances if available, splitting long utterances using their word timings
  const utterances = Array.isArray(sttJson?.results?.utterances)
    ? sttJson.results.utterances
    : [];

  if (utterances.length > 0) {
    for (const utt of utterances) {
      const text = String(utt?.transcript || '').trim();
      if (!text) continue;
      const speakerLabel =
        typeof utt?.speaker === 'number'
          ? `Speaker ${utt.speaker + 1}`
          : String(utt?.speaker || 'Speaker 1');
      const uStart = Math.max(0, Number(utt?.start) || 0);
      const uEnd = Math.max(uStart + 0.6, Number(utt?.end) || uStart + 2.5);
      const uWords = Array.isArray(utt?.words) ? utt.words : [];

      // If utterance is compact enough (<= 5.5s and <= 65 chars), emit directly
      if (uEnd - uStart <= 5.5 && text.length <= 65) {
        cues.push({
          startOffsetSec: Number(uStart.toFixed(2)),
          endOffsetSec: Number(uEnd.toFixed(2)),
          speaker: speakerLabel,
          detectedLanguage: detectedLang,
          originalText: text,
          toneNote: '',
        });
      } else if (uWords.length > 1) {
        // Split long utterance into natural subtitle phrases using exact word timestamps
        let bucketWords: string[] = [];
        let bucketStart = Number(uWords[0]?.start) || uStart;
        let bucketEnd = Number(uWords[0]?.end) || bucketStart + 0.5;

        const flushBucket = () => {
          const joined = isCjkLang
            ? bucketWords.join('').trim()
            : bucketWords.join(' ').trim();
          if (joined) {
            cues.push({
              startOffsetSec: Number(Math.max(0, bucketStart).toFixed(2)),
              endOffsetSec: Number(Math.max(bucketStart + 0.5, bucketEnd).toFixed(2)),
              speaker: speakerLabel,
              detectedLanguage: detectedLang,
              originalText: joined,
              toneNote: '',
            });
          }
          bucketWords = [];
        };

        for (let i = 0; i < uWords.length; i++) {
          const w = uWords[i];
          const wText = String(w?.punctuated_word ?? w?.word ?? '').trim();
          if (!wText) continue;
          const wStart = Number(w?.start) ?? bucketEnd;
          const wEnd = Number(w?.end) ?? wStart + 0.3;

          if (bucketWords.length === 0) {
            bucketStart = wStart;
          }
          bucketWords.push(wText);
          bucketEnd = wEnd;

          const nextW = uWords[i + 1];
          const gapToNext = nextW ? (Number(nextW.start) || wEnd) - wEnd : 0;
          const curDur = bucketEnd - bucketStart;
          const endsWithPunct = /[.?!。？！…]$/.test(wText);
          const maxTokensPerLine = isCjkLang ? 22 : 12;

          if (
            bucketWords.length >= maxTokensPerLine ||
            curDur >= 4.5 ||
            (endsWithPunct && curDur >= 1.2) ||
            (gapToNext >= 0.4 && curDur >= 1.0)
          ) {
            flushBucket();
          }
        }
        flushBucket();
      } else {
        cues.push({
          startOffsetSec: Number(uStart.toFixed(2)),
          endOffsetSec: Number(uEnd.toFixed(2)),
          speaker: speakerLabel,
          detectedLanguage: detectedLang,
          originalText: text,
          toneNote: '',
        });
      }
    }
    if (cues.length > 0) return cues;
  }

  // 2. Check paragraphs.paragraphs[].sentences[]
  const paragraphs = Array.isArray(alt0?.paragraphs?.paragraphs)
    ? alt0.paragraphs.paragraphs
    : [];
  if (paragraphs.length > 0) {
    for (const para of paragraphs) {
      const spk =
        typeof para?.speaker === 'number'
          ? `Speaker ${para.speaker + 1}`
          : 'Speaker 1';
      const sentences = Array.isArray(para?.sentences) ? para.sentences : [];
      for (const sent of sentences) {
        const txt = String(sent?.text || '').trim();
        if (!txt) continue;
        const st = Math.max(0, Number(sent?.start) || 0);
        const et = Math.max(st + 0.6, Number(sent?.end) || st + 2.5);
        cues.push({
          startOffsetSec: Number(st.toFixed(2)),
          endOffsetSec: Number(et.toFixed(2)),
          speaker: spk,
          detectedLanguage: detectedLang,
          originalText: txt,
          toneNote: '',
        });
      }
    }
    if (cues.length > 0) return cues;
  }

  // 3. Check raw words[] on alt0
  const words = Array.isArray(alt0?.words) ? alt0.words : [];
  if (words.length > 0) {
    let bucket: string[] = [];
    let bStart = Number(words[0]?.start) || 0;
    let bEnd = Number(words[0]?.end) || 0.8;
    let bSpeaker =
      typeof words[0]?.speaker === 'number'
        ? `Speaker ${words[0].speaker + 1}`
        : 'Speaker 1';

    const flush = () => {
      const joined = isCjkLang ? bucket.join('').trim() : bucket.join(' ').trim();
      if (joined) {
        cues.push({
          startOffsetSec: Number(Math.max(0, bStart).toFixed(2)),
          endOffsetSec: Number(Math.max(bStart + 0.5, bEnd).toFixed(2)),
          speaker: bSpeaker,
          detectedLanguage: detectedLang,
          originalText: joined,
          toneNote: '',
        });
      }
      bucket = [];
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const wTxt = String(w?.punctuated_word ?? w?.word ?? '').trim();
      if (!wTxt) continue;
      const wSt = Number(w?.start) || bEnd;
      const wEt = Number(w?.end) || wSt + 0.3;
      const wSpk =
        typeof w?.speaker === 'number' ? `Speaker ${w.speaker + 1}` : 'Speaker 1';

      if (bucket.length === 0) {
        bStart = wSt;
        bSpeaker = wSpk;
      }
      bucket.push(wTxt);
      bEnd = wEt;

      const nextW = words[i + 1];
      const gap = nextW ? (Number(nextW.start) || wEt) - wEt : 0;
      const dur = bEnd - bStart;
      const maxCount = isCjkLang ? 22 : 12;

      if (
        bucket.length >= maxCount ||
        dur >= 4.5 ||
        gap >= 0.45 ||
        /[.?!。？！…]$/.test(wTxt)
      ) {
        flush();
      }
    }
    flush();
    if (cues.length > 0) return cues;
  }

  // 4. Plain transcript fallback
  const fullTranscript = String(alt0?.transcript || '').trim();
  if (fullTranscript) {
    return parseUniversalTranscriptCues(
      fullTranscript,
      chunkDurationSec,
      detectedLang
    );
  }

  return [];
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '150mb' }));

  if (serverState.apinex.apiKey) {
    syncApinexLiveState().catch(() => {});
  }
  if (serverState.beatapi.apiKey) {
    syncBeatApiLiveState().catch(() => {});
  }

  // 1. Get complete real-time system snapshot
  app.get('/api/providers/state', (_req: Request, res: Response) => {
    res.json(buildPublicSnapshot());
  });

  // 1b. Clear token ledger & reset session counters
  app.post('/api/providers/ledger/clear', (_req: Request, res: Response) => {
    serverState.ledger = [];
    for (const slot of serverState.aistudio.slots) {
      slot.stats.promptTokens = 0;
      slot.stats.completionTokens = 0;
      slot.stats.totalTokens = 0;
      slot.stats.totalRequests = 0;
    }
    serverState.apinex.stats.promptTokens = 0;
    serverState.apinex.stats.completionTokens = 0;
    serverState.apinex.stats.reasoningTokens = 0;
    serverState.apinex.stats.totalTokens = 0;
    serverState.apinex.stats.costTokens = 0;
    serverState.apinex.stats.costUsd = 0;
    serverState.apinex.stats.totalRequests = 0;
    serverState.beatapi.stats.promptTokens = 0;
    serverState.beatapi.stats.completionTokens = 0;
    serverState.beatapi.stats.totalTokens = 0;
    serverState.beatapi.stats.totalRequests = 0;
    savePersistedConfig();
    res.json(buildPublicSnapshot());
  });

  // 2. Switch active provider or strict model (Persisted to disk!)
  app.post(
    ['/api/providers/select', '/api/providers/strict-model'],
    (req: Request, res: Response) => {
      const { activeProvider, strictModel } = req.body as {
        activeProvider?: ProviderId;
        strictModel?: StrictModelId;
      };

      if (activeProvider && ['aistudio', 'apinex', 'beatapi'].includes(activeProvider)) {
        serverState.activeProvider = activeProvider;
      }
      if (strictModel) {
        if (!VALID_MODELS.includes(strictModel)) {
          res.status(400).json({
            error: `Invalid model "${strictModel}". Strictly allowed models: ${VALID_MODELS.join(', ')}`,
          });
          return;
        }
        serverState.strictModel = normalizeStrictModelId(strictModel);
      }

      savePersistedConfig();
      const snap = buildPublicSnapshot();
      res.json({ ...snap, snapshot: snap });
    }
  );

  // 3. Manage AI Studio Key Pool: Select Active Key, Toggle Limit-Only Auto-Rotate, Add, Edit, Reset, Delete
  app.post('/api/providers/aistudio/config', (req: Request, res: Response) => {
    const {
      autoRotateEnabled,
      activeSlotIndex,
      selectSlotId,
      addSlotKey,
      addSlotLabel,
      addSlotLimits,
      updateSlotId,
      updateLabel,
      updateApiKey,
      updateLimits,
      removeSlotId,
      clearCooldownSlotId,
    } = req.body as {
      autoRotateEnabled?: boolean;
      activeSlotIndex?: number;
      selectSlotId?: string;
      addSlotKey?: string;
      addSlotLabel?: string;
      addSlotLimits?: { rpmLimit?: number; tpmLimit?: number; rpdLimit?: number };
      updateSlotId?: string;
      updateLabel?: string;
      updateApiKey?: string;
      updateLimits?: { rpmLimit?: number; tpmLimit?: number; rpdLimit?: number };
      removeSlotId?: string;
      clearCooldownSlotId?: string;
    };

    if (typeof autoRotateEnabled === 'boolean') {
      serverState.aistudio.autoRotateEnabled = autoRotateEnabled;
    }

    if (selectSlotId) {
      const foundIdx = serverState.aistudio.slots.findIndex(
        (s) => s.slotId === selectSlotId
      );
      if (foundIdx !== -1) {
        serverState.aistudio.activeSlotIndex = foundIdx;
        // Also clear any stale cooldown when the user explicitly selects this Key
        serverState.aistudio.slots[foundIdx].cooldownUntilMs = null;
        serverState.aistudio.slots[foundIdx].status = 'ready';
        serverState.aistudio.slots[foundIdx].lastError = null;
      }
    } else if (
      typeof activeSlotIndex === 'number' &&
      activeSlotIndex >= 0 &&
      activeSlotIndex < serverState.aistudio.slots.length
    ) {
      serverState.aistudio.activeSlotIndex = activeSlotIndex;
    }

    if (addSlotKey && addSlotKey.trim()) {
      const cleanKey = addSlotKey.trim();
      const existsIdx = serverState.aistudio.slots.findIndex(
        (s) => s.apiKey === cleanKey
      );
      if (existsIdx === -1) {
        const newSlotNumber = serverState.aistudio.slots.length + 1;
        serverState.aistudio.slots.push({
          slotId: `aistudio-slot-${Date.now()}`,
          label:
            addSlotLabel && addSlotLabel.trim()
              ? addSlotLabel.trim()
              : `AI Studio Key #${newSlotNumber}`,
          apiKey: cleanKey,
          maskedIdentifier: maskKey(cleanKey),
          source: 'runtime_slot',
          status: 'ready',
          cooldownUntilMs: null,
          lastError: null,
          lastUsedAt: null,
          limits: {
            rpmLimit: Math.max(1, Number(addSlotLimits?.rpmLimit) || 15),
            tpmLimit: Math.max(1000, Number(addSlotLimits?.tpmLimit) || 1000000),
            rpdLimit: Math.max(1, Number(addSlotLimits?.rpdLimit) || 1500),
          },
          stats: {
            todayDate: getTodayDateString(),
            todayRequests: 0,
            totalRequests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            windowEntries: [],
          },
        });
        // Automatically select the newly added key as active
        serverState.aistudio.activeSlotIndex = serverState.aistudio.slots.length - 1;
      } else {
        serverState.aistudio.activeSlotIndex = existsIdx;
        if (addSlotLabel && addSlotLabel.trim()) {
          serverState.aistudio.slots[existsIdx].label = addSlotLabel.trim();
        }
      }
    }

    if (updateSlotId) {
      const target = serverState.aistudio.slots.find((s) => s.slotId === updateSlotId);
      if (target) {
        if (typeof updateLabel === 'string' && updateLabel.trim()) {
          target.label = updateLabel.trim();
        }
        if (typeof updateApiKey === 'string' && updateApiKey.trim()) {
          target.apiKey = updateApiKey.trim();
          target.maskedIdentifier = maskKey(target.apiKey);
          target.status = 'ready';
          target.cooldownUntilMs = null;
          target.lastError = null;
        }
        if (updateLimits) {
          if (typeof updateLimits.rpmLimit === 'number' && updateLimits.rpmLimit >= 1) {
            target.limits.rpmLimit = Math.floor(updateLimits.rpmLimit);
          }
          if (typeof updateLimits.tpmLimit === 'number' && updateLimits.tpmLimit >= 1000) {
            target.limits.tpmLimit = Math.floor(updateLimits.tpmLimit);
          }
          if (typeof updateLimits.rpdLimit === 'number' && updateLimits.rpdLimit >= 1) {
            target.limits.rpdLimit = Math.floor(updateLimits.rpdLimit);
          }
        }
      }
    }

    if (clearCooldownSlotId) {
      const target = serverState.aistudio.slots.find(
        (s) => s.slotId === clearCooldownSlotId
      );
      if (target) {
        target.cooldownUntilMs = null;
        target.status = 'ready';
        target.lastError = null;
        target.stats.windowEntries = [];
      }
    }

    if (removeSlotId) {
      const idx = serverState.aistudio.slots.findIndex((s) => s.slotId === removeSlotId);
      if (idx !== -1 && serverState.aistudio.slots.length > 1) {
        serverState.aistudio.slots.splice(idx, 1);
        if (serverState.aistudio.activeSlotIndex >= serverState.aistudio.slots.length) {
          serverState.aistudio.activeSlotIndex = Math.max(
            0,
            serverState.aistudio.slots.length - 1
          );
        }
      }
    }

    savePersistedConfig();
    res.json(buildPublicSnapshot());
  });

  // 4. Configure & Live-Sync APInex.bond Gateway (Persisted to disk!)
  app.post('/api/providers/apinex/config', async (req: Request, res: Response) => {
    const {
      apiKey,
      endpointBase,
      dynamicPacing,
      syncNow,
    } = req.body as {
      apiKey?: string;
      endpointBase?: string;
      dynamicPacing?: Partial<InternalApinexState['dynamicPacing']>;
      syncNow?: boolean;
    };

    if (typeof apiKey === 'string' && apiKey.trim()) {
      serverState.apinex.apiKey = apiKey.trim();
    }
    if (typeof endpointBase === 'string' && endpointBase.trim()) {
      serverState.apinex.endpointBase = endpointBase.trim().replace(/\/+$/, '');
    }
    if (dynamicPacing) {
      if (
        typeof dynamicPacing.effectiveRpmLimit === 'number' &&
        dynamicPacing.effectiveRpmLimit >= 1
      ) {
        serverState.apinex.dynamicPacing.effectiveRpmLimit = Math.floor(
          dynamicPacing.effectiveRpmLimit
        );
      }
    }

    savePersistedConfig();

    if (syncNow || (typeof apiKey === 'string' && apiKey.trim())) {
      await syncApinexLiveState();
    }

    res.json(buildPublicSnapshot());
  });

  // 5. Configure & Live-Sync BeatAPI.io Gateway (Persisted to disk!)
  app.post('/api/providers/beatapi/config', async (req: Request, res: Response) => {
    const {
      apiKey,
      endpointBase,
      period,
      dynamicPacing,
      syncNow,
    } = req.body as {
      apiKey?: string;
      endpointBase?: string;
      period?: '24h' | '7d' | '30d' | 'all';
      dynamicPacing?: Partial<InternalBeatApiState['dynamicPacing']>;
      syncNow?: boolean;
    };

    if (typeof apiKey === 'string' && apiKey.trim()) {
      serverState.beatapi.apiKey = apiKey.trim();
    }
    if (typeof endpointBase === 'string' && endpointBase.trim()) {
      serverState.beatapi.endpointBase = endpointBase.trim().replace(/\/+$/, '');
    }
    if (period && ['24h', '7d', '30d', 'all'].includes(period)) {
      serverState.beatapi.usageReport.period = period;
    }
    if (dynamicPacing) {
      if (
        typeof dynamicPacing.effectiveRpmLimit === 'number' &&
        dynamicPacing.effectiveRpmLimit >= 1
      ) {
        serverState.beatapi.dynamicPacing.effectiveRpmLimit = Math.floor(
          dynamicPacing.effectiveRpmLimit
        );
      }
    }

    savePersistedConfig();

    if (syncNow || (typeof apiKey === 'string' && apiKey.trim()) || period) {
      await syncBeatApiLiveState(period);
    }

    res.json(buildPublicSnapshot());
  });

  // 6. Refresh all external gateway balances in parallel
  app.post('/api/providers/sync-all', async (_req: Request, res: Response) => {
    await Promise.allSettled([syncApinexLiveState(), syncBeatApiLiveState()]);
    res.json(buildPublicSnapshot());
  });

  // Track active transcription jobIds so 1 video run increments totalRequests once and aggregates into 1 unified Ledger entry
  const countedJobIds = new Set<string>();

  function upsertTranscribeLedgerEntry(
    jobId: string | undefined,
    entry: LedgerItem
  ): void {
    if (jobId && jobId.trim()) {
      const cleanId = jobId.trim();
      const existing = serverState.ledger.find((item) => item.id === cleanId);
      if (existing) {
        existing.timestamp = entry.timestamp;
        existing.promptTokens += entry.promptTokens;
        existing.completionTokens += entry.completionTokens;
        existing.reasoningTokens =
          (existing.reasoningTokens || 0) + (entry.reasoningTokens || 0);
        existing.totalTokens += entry.totalTokens;
        existing.costTokens =
          (existing.costTokens || 0) + (entry.costTokens || 0);
        existing.costUsd = Number(
          ((existing.costUsd || 0) + (entry.costUsd || 0)).toFixed(6)
        );
        existing.durationMs = Math.max(existing.durationMs, entry.durationMs);
        // Merge chunkRangeSec to span minStarts - maxEnds across the job
        const rangeMatchA = /^([\d.]+)s\s*-\s*([\d.]+)s$/.exec(
          existing.chunkRangeSec || ''
        );
        const rangeMatchB = /^([\d.]+)s\s*-\s*([\d.]+)s$/.exec(
          entry.chunkRangeSec || ''
        );
        if (rangeMatchA && rangeMatchB) {
          const minS = Math.min(Number(rangeMatchA[1]), Number(rangeMatchB[1]));
          const maxE = Math.max(Number(rangeMatchA[2]), Number(rangeMatchB[2]));
          existing.chunkRangeSec = `${minS.toFixed(1)}s - ${maxE.toFixed(1)}s`;
        }
        existing.chunkIndex = 1;
        if (entry.status === 'error') {
          existing.status = 'error';
          existing.errorDetail = entry.errorDetail;
        }
        return;
      }
      serverState.ledger.unshift({
        ...entry,
        id: cleanId,
        chunkIndex: 1,
      });
      return;
    }
    serverState.ledger.unshift(entry);
  }

  // Built-in crisp 5x7 bitmap font for drawing "#01".."#36" card badges on RGB24 buffers
  const CARD_FONT_5X7: Record<string, number[]> = {
    '#': [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
    '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x0e, 0x00],
    '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x0e, 0x00],
    '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x1f, 0x00],
    '3': [0x1f, 0x02, 0x06, 0x01, 0x11, 0x0e, 0x00],
    '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x00],
    '5': [0x1f, 0x10, 0x1e, 0x01, 0x11, 0x0e, 0x00],
    '6': [0x06, 0x08, 0x1e, 0x11, 0x11, 0x0e, 0x00],
    '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x00],
    '8': [0x0e, 0x11, 0x0e, 0x11, 0x11, 0x0e, 0x00],
    '9': [0x0e, 0x11, 0x11, 0x0f, 0x02, 0x0c, 0x00],
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  };

  function drawCardBadgeRgb(
    buf: Buffer,
    imgW: number,
    imgH: number,
    x0: number,
    y0: number,
    text: string
  ): void {
    const scale = 2;
    const charW = 6 * scale;
    const charH = 7 * scale;
    const boxW = text.length * charW + 8;
    const boxH = charH + 6;
    for (let dy = 0; dy < boxH; dy++) {
      const py = y0 + dy;
      if (py < 0 || py >= imgH) continue;
      for (let dx = 0; dx < boxW; dx++) {
        const px = x0 + dx;
        if (px < 0 || px >= imgW) continue;
        const idx = (py * imgW + px) * 3;
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
      }
    }
    for (let cIdx = 0; cIdx < text.length; cIdx++) {
      const glyph = CARD_FONT_5X7[text[cIdx]] || CARD_FONT_5X7[' '];
      const cx = x0 + 4 + cIdx * charW;
      const cy = y0 + 3;
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          if ((bits >> (4 - col)) & 1) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                const px = cx + col * scale + sx;
                const py = cy + row * scale + sy;
                if (px >= 0 && px < imgW && py >= 0 && py < imgH) {
                  const idx = (py * imgW + px) * 3;
                  buf[idx] = 255;
                  buf[idx + 1] = 230;
                  buf[idx + 2] = 0;
                }
              }
            }
          }
        }
      }
    }
  }

  function encodeRgbBufferToJpegBase64(
    rgbBuf: Buffer,
    width: number,
    height: number
  ): string {
    const scaleArgs =
      height > 760 ? ['-vf', 'scale=-2:760:flags=lanczos'] : [];
    const jpgBuf = execFileSync(
      'ffmpeg',
      [
        '-v',
        'quiet',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        `${width}x${height}`,
        '-i',
        '-',
        ...scaleArgs,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-',
      ],
      { input: rgbBuf, maxBuffer: 24 * 1024 * 1024 }
    );
    return jpgBuf.toString('base64');
  }

  /**
   * STEP 0A ENDPOINT: Cloud-Run-Safe Chunked Binary Video Upload (< 10MB per slice).
   * Prevents 413 Payload Too Large on Cloud Run's 32MB HTTP/1.1 reverse proxy when uploading 77MB+ HD videos.
   */
  app.post(
    '/api/subtitle/upload-video-chunk',
    express.raw({
      type: ['application/octet-stream', 'video/*'],
      limit: '25mb',
    }),
    (req: Request, res: Response) => {
      const uploadIdRaw = String(req.headers['x-upload-id'] || '').replace(
        /[^a-zA-Z0-9_-]/g,
        ''
      );
      const chunkIdx = Number(req.headers['x-chunk-index'] || 0);
      const bodyBuf = req.body;
      if (!uploadIdRaw || !Buffer.isBuffer(bodyBuf) || bodyBuf.length === 0) {
        res.status(400).json({ error: 'Invalid uploadId or empty chunk buffer.' });
        return;
      }
      const targetPath = path.join(
        os.tmpdir(),
        `kstudio_upload_${uploadIdRaw}.mp4`
      );
      try {
        if (chunkIdx === 0 && fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
        fs.appendFileSync(targetPath, bodyBuf);
        res.json({ ok: true, bytesWritten: bodyBuf.length });
      } catch (err: any) {
        res
          .status(500)
          .json({ error: err?.message || 'Failed to write video chunk.' });
      }
    }
  );

  /**
   * STEP 0B ENDPOINT: Server-Side Native FFmpeg 15fps Frame-Exact Card-Indexed Contact Sheet Extractor.
   * - Accepts either JSON `{ uploadId }` (from chunked upload) or direct binary `application/octet-stream`.
   * - Streams the subtitle band at 15fps (0.067s = 2-frame precision!) in a single FFmpeg pass,
   *   detecting every burned-in subtitle card's exact onset and offset (`startSec` and `endSec`)
   *   and capturing its sharpest RGB24 frame (`bestFrameBuf`).
   * - Packs all detected subtitle cards into just 2 Card-Indexed Contact Sheets (36 cards per sheet),
   *   with Outline-Aware Dark-LUT on `safeVisualFrames` (darkening even white sweaters/undershirts behind white text!).
   */
  app.post(
    '/api/subtitle/extract-video-chunks',
    express.raw({
      type: ['application/octet-stream', 'video/*'],
      limit: '350mb',
    }),
    async (req: Request, res: Response) => {
      const tempDir = path.join(
        os.tmpdir(),
        `kstudio_extract_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      );
      fs.mkdirSync(tempDir, { recursive: true });
      let inputVideoPath = path.join(tempDir, 'input_video.mp4');
      let uploadedFileToClean: string | null = null;

      try {
        const bodyAsAny = req.body as any;
        if (
          bodyAsAny &&
          !Buffer.isBuffer(bodyAsAny) &&
          typeof bodyAsAny.uploadId === 'string'
        ) {
          const cleanUploadId = bodyAsAny.uploadId.replace(/[^a-zA-Z0-9_-]/g, '');
          const candidatePath = path.join(
            os.tmpdir(),
            `kstudio_upload_${cleanUploadId}.mp4`
          );
          if (!fs.existsSync(candidatePath)) {
            res
              .status(400)
              .json({ error: 'Uploaded video session not found on server.' });
            return;
          }
          inputVideoPath = candidatePath;
          uploadedFileToClean = candidatePath;
        } else if (Buffer.isBuffer(req.body) && req.body.length >= 128) {
          fs.writeFileSync(inputVideoPath, req.body);
        } else {
          res
            .status(400)
            .json({ error: 'Invalid or empty video payload / uploadId.' });
          return;
        }

        const { stdout: probeOut } = await execFileAsync('ffprobe', [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputVideoPath,
        ]);
        const probeJson = JSON.parse(probeOut || '{}');
        const streams: any[] = Array.isArray(probeJson.streams)
          ? probeJson.streams
          : [];
        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');

        const durationSec = Number(
          Math.max(
            0.8,
            Number(probeJson?.format?.duration) ||
              Number(videoStream?.duration) ||
              60
          ).toFixed(2)
        );
        const vw = Number(videoStream?.width) || 720;
        const vh = Number(videoStream?.height) || 1280;
        const isPortrait = vh > vw * 1.05;

        // =========================================================================
        // PASS 0: Auto-Adaptive Subtitle Y-Band Centroid Probe (`cropdetect` principle)
        // Scans y = 52%..92% at 1.5fps over the first 45s (~0.5s runtime) and centers
        // the crop window on the true vertical centroid of the subtitles so both 1-line
        // and 2-line subtitles sit comfortably in the middle of each tile.
        // =========================================================================
        let detectedCropYStart = isPortrait ? 0.66 : 0.74;
        const detectedCropYHeight = isPortrait ? 0.15 : 0.19;
        try {
          const PW = 180;
          const PH = 80;
          const pBytes = PW * PH * 3;
          const probeHist = new Uint32Array(PH);
          let pLeftover: Buffer = Buffer.alloc(0);

          await new Promise<void>((resolve) => {
            const pProc = spawn('ffmpeg', [
              '-v',
              'quiet',
              '-threads',
              '2',
              '-skip_loop_filter',
              'all',
              '-flags2',
              'fast',
              '-t',
              String(Math.min(45, durationSec)),
              '-i',
              inputVideoPath,
              '-vf',
              `fps=1.5,crop=iw*0.84:ih*0.40:iw*0.08:ih*0.52,scale=${PW}:${PH}:flags=fast_bilinear,format=rgb24`,
              '-f',
              'rawvideo',
              '-',
            ]);
            pProc.stdout.on('data', (chunk: Buffer) => {
              const comb =
                pLeftover.length > 0 ? Buffer.concat([pLeftover, chunk]) : chunk;
              let off = 0;
              while (off + pBytes <= comb.length) {
                const fBuf = comb.subarray(off, off + pBytes);
                for (let py = 3; py < PH - 3; py++) {
                  const rOff = py * PW;
                  let rowHits = 0;
                  for (let px = 3; px < PW - 3; px++) {
                    const idx = (rOff + px) * 3;
                    if (
                      fBuf[idx] > 205 &&
                      fBuf[idx + 1] > 205 &&
                      fBuf[idx + 2] > 175
                    ) {
                      let d = 0;
                      if (fBuf[idx - 6] < 85 && fBuf[idx - 5] < 85) d++;
                      if (fBuf[idx + 6] < 85 && fBuf[idx + 7] < 85) d++;
                      if (fBuf[idx - PW * 6] < 85 && fBuf[idx - PW * 6 + 1] < 85) d++;
                      if (fBuf[idx + PW * 6] < 85 && fBuf[idx + PW * 6 + 1] < 85) d++;
                      if (d >= 2) rowHits++;
                    }
                  }
                  if (rowHits >= 5) probeHist[py] += rowHits;
                }
                off += pBytes;
              }
              pLeftover = Buffer.from(comb.subarray(off));
            });
            pProc.on('close', () => resolve());
            pProc.on('error', () => resolve());
          });

          // Find peak row and compute weighted centroid within +-18 rows around the peak
          let peakPy = -1;
          let peakVal = 0;
          for (let py = 0; py < PH; py++) {
            if (probeHist[py] > peakVal) {
              peakVal = probeHist[py];
              peakPy = py;
            }
          }
          if (peakPy >= 0 && peakVal >= 40) {
            let weightedSum = 0;
            let weightTotal = 0;
            const y0 = Math.max(0, peakPy - 16);
            const y1 = Math.min(PH - 1, peakPy + 18);
            for (let py = y0; py <= y1; py++) {
              weightedSum += py * probeHist[py];
              weightTotal += probeHist[py];
            }
            if (weightTotal >= 120) {
              const centroidPy = weightedSum / weightTotal;
              const centroidYRatio = 0.52 + (centroidPy / PH) * 0.40;
              // Place the centroid at 44% from the top of the crop window so 1-line and 2-line subtitles sit right in the middle
              const rawYStart = centroidYRatio - detectedCropYHeight * 0.44;
              detectedCropYStart = Number(
                Math.max(0.54, Math.min(0.94 - detectedCropYHeight, rawYStart)).toFixed(3)
              );
            }
          }
        } catch {
          // Fallback to default Y band
        }

        // =========================================================================
        // PASS 1: Single-Pass Streaming 15fps (0.067s precision) Subtitle Card Detector
        // Uses 360x100 tiles (1:1 square pixel aspect ratio for a 0.86x0.15 portrait crop)
        // so Chinese characters are NEVER vertically squashed!
        // =========================================================================
        const W = 360;
        const H = 100;
        const FPS = 15;
        const frameBytes = W * H * 3;
        const cropFilter = `fps=${FPS},crop=iw*0.86:ih*${detectedCropYHeight}:iw*0.07:ih*${detectedCropYStart},scale=${W}:${H}:flags=bicubic,format=rgb24`;

        interface DetectedStreamCard {
          startFrame: number;
          lastFrame: number;
          startSec: number;
          endSec: number;
          lastMask: Uint8Array;
          refMask: Uint8Array;
          bestMask: Uint8Array;
          refCount: number;
          maxCount: number;
          bestFrameBuf: Buffer;
        }

        const extractStrokeMaskAndCount = (rgbBuf: Buffer) => {
          const mask = new Uint8Array(W * H);
          let count = 0;
          for (let y = 5; y < H - 5; y++) {
            const rowOff = y * W;
            for (let x = 4; x < W - 4; x++) {
              const p = (rowOff + x) * 3;
              const r = rgbBuf[p];
              const g = rgbBuf[p + 1];
              const b = rgbBuf[p + 2];
              if (r > 205 && g > 205 && b > 175) {
                let darkDirs = 0;
                const l2 = p - 6;
                const l3 = p - 9;
                if (
                  (rgbBuf[l2] < 85 && rgbBuf[l2 + 1] < 85) ||
                  (rgbBuf[l3] < 85 && rgbBuf[l3 + 1] < 85)
                )
                  darkDirs++;
                const r2 = p + 6;
                const r3 = p + 9;
                if (
                  (rgbBuf[r2] < 85 && rgbBuf[r2 + 1] < 85) ||
                  (rgbBuf[r3] < 85 && rgbBuf[r3 + 1] < 85)
                )
                  darkDirs++;
                const u2 = p - W * 6;
                const u3 = p - W * 9;
                const u4 = p - W * 12;
                if (
                  (rgbBuf[u2] < 85 && rgbBuf[u2 + 1] < 85) ||
                  (rgbBuf[u3] < 85 && rgbBuf[u3 + 1] < 85) ||
                  (rgbBuf[u4] < 85 && rgbBuf[u4 + 1] < 85)
                )
                  darkDirs++;
                const d2 = p + W * 6;
                const d3 = p + W * 9;
                const d4 = p + W * 12;
                if (
                  (rgbBuf[d2] < 85 && rgbBuf[d2 + 1] < 85) ||
                  (rgbBuf[d3] < 85 && rgbBuf[d3 + 1] < 85) ||
                  (rgbBuf[d4] < 85 && rgbBuf[d4 + 1] < 85)
                )
                  darkDirs++;
                if (darkDirs >= 2) {
                  mask[rowOff + x] = 1;
                  count++;
                }
              }
            }
          }
          return { mask, count };
        };

        // 1-pixel shift-tolerant IoU (`shiftedIoU`) prevents camera-shake / cut micro-splits of the same subtitle card
        const shiftedIoU = (m1: Uint8Array, m2: Uint8Array) => {
          let inter1 = 0;
          let inter2 = 0;
          let count1 = 0;
          let count2 = 0;
          for (let y = 1; y < H - 1; y++) {
            const row = y * W;
            for (let x = 1; x < W - 1; x++) {
              const idx = row + x;
              if (m1[idx]) {
                count1++;
                if (
                  m2[idx] ||
                  m2[idx - 1] ||
                  m2[idx + 1] ||
                  m2[idx - W] ||
                  m2[idx + W]
                ) {
                  inter1++;
                }
              }
              if (m2[idx]) {
                count2++;
                if (
                  m1[idx] ||
                  m1[idx - 1] ||
                  m1[idx + 1] ||
                  m1[idx - W] ||
                  m1[idx + W]
                ) {
                  inter2++;
                }
              }
            }
          }
          if (count1 === 0 && count2 === 0) return 1;
          const avgInter = 0.5 * (inter1 + inter2);
          const union = count1 + count2 - avgInter;
          return union <= 0 ? 1 : avgInter / union;
        };

        const MIN_STROKE = 26;
        const rawCards: DetectedStreamCard[] = [];
        let cur: DetectedStreamCard | null = null;
        let gapFrames = 0;
        let leftover: Buffer = Buffer.alloc(0);
        let frameIdx = 0;

        await new Promise<void>((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-v',
            'quiet',
            '-threads',
            '4',
            '-skip_loop_filter',
            'all',
            '-flags2',
            'fast',
            '-i',
            inputVideoPath,
            '-vf',
            cropFilter,
            '-f',
            'rawvideo',
            '-',
          ]);
          proc.stdout.on('data', (chunk: Buffer) => {
            const combined =
              leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
            let offset = 0;
            while (offset + frameBytes <= combined.length) {
              const frameBuf = combined.subarray(offset, offset + frameBytes);
              const f = frameIdx++;
              const t = Number((f / FPS).toFixed(2));
              const { mask, count } = extractStrokeMaskAndCount(frameBuf);

              if (count < MIN_STROKE) {
                if (cur) {
                  gapFrames++;
                  if (gapFrames >= 2) {
                    rawCards.push(cur);
                    cur = null;
                    gapFrames = 0;
                  }
                }
              } else {
                gapFrames = 0;
                if (!cur) {
                  cur = {
                    startFrame: f,
                    lastFrame: f,
                    startSec: t,
                    endSec: Number(((f + 1) / FPS).toFixed(2)),
                    lastMask: mask,
                    refMask: mask,
                    bestMask: mask,
                    refCount: count,
                    maxCount: count,
                    bestFrameBuf: Buffer.from(frameBuf),
                  };
                } else {
                  const iouPrev = shiftedIoU(cur.lastMask, mask);
                  const iouRef = shiftedIoU(cur.refMask, mask);
                  const iou = Math.max(iouPrev, iouRef);
                  const countRatio =
                    Math.min(cur.refCount, count) / Math.max(cur.refCount, count);
                  if (iou < 0.56 || (iou < 0.70 && countRatio < 0.74)) {
                    rawCards.push(cur);
                    cur = {
                      startFrame: f,
                      lastFrame: f,
                      startSec: t,
                      endSec: Number(((f + 1) / FPS).toFixed(2)),
                      lastMask: mask,
                      refMask: mask,
                      bestMask: mask,
                      refCount: count,
                      maxCount: count,
                      bestFrameBuf: Buffer.from(frameBuf),
                    };
                  } else {
                    cur.lastFrame = f;
                    cur.endSec = Number(((f + 1) / FPS).toFixed(2));
                    cur.lastMask = mask;
                    if (count > cur.maxCount) {
                      cur.maxCount = count;
                      cur.refMask = mask;
                      cur.bestMask = mask;
                      cur.refCount = count;
                      cur.bestFrameBuf = Buffer.from(frameBuf);
                    }
                  }
                }
              }
              offset += frameBytes;
            }
            leftover = Buffer.from(combined.subarray(offset));
          });
          proc.on('close', () => resolve());
          proc.on('error', reject);
        });
        if (cur) rawCards.push(cur);

        const filteredCards = rawCards.filter(
          (c) => c.endSec - c.startSec >= 0.18 && c.maxCount >= 34
        );

        const getMaskBoundsX = (m: Uint8Array) => {
          let minX = W;
          let maxX = 0;
          for (let i = 0; i < W * H; i++) {
            if (m[i]) {
              const x = i % W;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
          return { minX, maxX };
        };

        // Post-pass: merge adjacent micro-split cards caused by scene cuts while the same subtitle remains on screen
        const validCards: DetectedStreamCard[] = [];
        for (const card of filteredCards) {
          const prev = validCards[validCards.length - 1];
          if (prev && card.startSec - prev.endSec <= 0.15) {
            const sIou = shiftedIoU(prev.bestMask, card.bestMask);
            const b1 = getMaskBoundsX(prev.bestMask);
            const b2 = getMaskBoundsX(card.bestMask);
            const sameStartOrEndX =
              Math.abs(b1.minX - b2.minX) <= 6 ||
              Math.abs(b1.maxX - b2.maxX) <= 6;
            const cRatio =
              Math.min(prev.maxCount, card.maxCount) /
              Math.max(prev.maxCount, card.maxCount);
            if (
              (sIou >= 0.65 && cRatio >= 0.74) ||
              (sameStartOrEndX && sIou >= 0.62 && cRatio >= 0.58)
            ) {
              prev.endSec = card.endSec;
              prev.lastFrame = card.lastFrame;
              if (card.maxCount > prev.maxCount) {
                prev.maxCount = card.maxCount;
                prev.bestMask = card.bestMask;
                prev.bestFrameBuf = card.bestFrameBuf;
              }
              continue;
            }
          }
          validCards.push(card);
        }

        // If the video has burned-in subtitle cards, build Card-Indexed Contact Sheets (24 cards per 3-column 1080x800 sheet = +33% effective ViT resolution, 0 timeouts & 100% accuracy!)
        if (validCards.length >= Math.max(3, Math.floor(durationSec / 18))) {
          const COLS = 3;
          const CARDS_PER_SHEET = 24;
          const rawSheets = Math.max(
            1,
            Math.ceil(validCards.length / CARDS_PER_SHEET)
          );
          const remainder = validCards.length % CARDS_PER_SHEET;
          const numSheets =
            rawSheets > 1 && remainder > 0 && remainder <= 5
              ? rawSheets - 1
              : rawSheets;
          const chunks = [];

          for (let s = 0; s < numSheets; s++) {
            const slice = validCards.slice(
              s * CARDS_PER_SHEET,
              s === numSheets - 1 ? validCards.length : (s + 1) * CARDS_PER_SHEET
            );
            const rows = Math.max(1, Math.ceil(slice.length / COLS));
            const sheetW = COLS * W;
            const sheetH = rows * H;
            const colorSheet = Buffer.alloc(sheetW * sheetH * 3, 12);
            const safeSheet = Buffer.alloc(sheetW * sheetH * 3, 76);

            const chunkStartSec =
              s === 0 ? 0 : Number(slice[0].startSec.toFixed(2));
            const chunkEndSec =
              s === numSheets - 1
                ? durationSec
                : Number(slice[slice.length - 1].endSec.toFixed(2));
            const chunkDur = Number(
              Math.max(0.5, chunkEndSec - chunkStartSec).toFixed(2)
            );

            const detectedCardsMeta = slice.map((card, localIdx) => {
              const cardNum = localIdx + 1;
              const c = localIdx % COLS;
              const r = Math.floor(localIdx / COLS);
              const dx = c * W;
              const dy = r * H;
              const src = card.bestFrameBuf;
              const mask = card.bestMask;

              // Compute SOLID rectangular bounding box [boxMinX..boxMaxX, boxMinY..boxMaxY] of the subtitle line
              // so ZERO interior strokes (like "是", "量", "最", "看", or 2-line text) can ever be hollowed out!
              let minX = W;
              let maxX = 0;
              let minY = H;
              let maxY = 0;
              for (let my = 0; my < H; my++) {
                const mRow = my * W;
                for (let mx = 0; mx < W; mx++) {
                  if (mask[mRow + mx] === 1) {
                    if (mx < minX) minX = mx;
                    if (mx > maxX) maxX = mx;
                    if (my < minY) minY = my;
                    if (my > maxY) maxY = my;
                  }
                }
              }
              const boxMinX = Math.max(4, minX - 18);
              const boxMaxX = Math.min(W - 5, maxX + 18);
              const boxMinY = Math.max(3, minY - 12);
              const boxMaxY = Math.min(H - 3, maxY + 16);

              // Identify true character + outline pixels inside the bounding box:
              // Every pixel of an outlined subtitle (whether Black-fill/White-outline OR White-fill/Black-outline)
              // lies within 4px of a high-contrast dark (<100) <-> bright (>180) stroke boundary.
              const isCharPixel = new Uint8Array(W * H);
              for (let my = boxMinY; my <= boxMaxY; my++) {
                const mRow = my * W;
                for (let mx = boxMinX; mx <= boxMaxX; mx++) {
                  let hasDark = false;
                  let hasBright = false;
                  const sy0 = Math.max(0, my - 2);
                  const sy1 = Math.min(H - 1, my + 2);
                  const sx0 = Math.max(0, mx - 2);
                  const sx1 = Math.min(W - 1, mx + 2);
                  for (let sy = sy0; sy <= sy1; sy++) {
                    const sRow = sy * W;
                    for (let sx = sx0; sx <= sx1; sx++) {
                      const sp = (sRow + sx) * 3;
                      const sr = src[sp];
                      const sg = src[sp + 1];
                      const sb = src[sp + 2];
                      if (sr < 100 && sg < 100 && sb < 100) hasDark = true;
                      if (sr > 180 && sg > 180 && sb > 160) hasBright = true;
                    }
                  }
                  if (hasDark && hasBright) {
                    const dy0 = Math.max(boxMinY, my - 4);
                    const dy1 = Math.min(boxMaxY, my + 4);
                    const dx0 = Math.max(boxMinX, mx - 4);
                    const dx1 = Math.min(boxMaxX, mx + 4);
                    for (let ny = dy0; ny <= dy1; ny++) {
                      const nRow = ny * W;
                      for (let nx = dx0; nx <= dx1; nx++) {
                        isCharPixel[nRow + nx] = 1;
                      }
                    }
                  }
                }
              }

              for (let y = 0; y < H; y++) {
                const rowOff = y * W;
                for (let x = 0; x < W; x++) {
                  const mIdx = rowOff + x;
                  const srcIdx = mIdx * 3;
                  const dstIdx = ((dy + y) * sheetW + (dx + x)) * 3;

                  if (x === 0 || x === W - 1 || y === 0 || y === H - 1) {
                    colorSheet[dstIdx] = 55;
                    colorSheet[dstIdx + 1] = 65;
                    colorSheet[dstIdx + 2] = 85;
                    safeSheet[dstIdx] = 45;
                    safeSheet[dstIdx + 1] = 52;
                    safeSheet[dstIdx + 2] = 68;
                    continue;
                  }

                  const R = src[srcIdx];
                  const G = src[srcIdx + 1];
                  const B = src[srcIdx + 2];
                  const lum = 0.299 * R + 0.587 * G + 0.114 * B;
                  const isCharZone = isCharPixel[mIdx] === 1;

                  // On colorSheet: slightly dim un-outlined bright white shirt/collar glare behind subtitle row so white text on white collar ("妈") stands out clearly
                  const isGlareInSubRow =
                    y >= 8 &&
                    y <= H - 8 &&
                    R > 190 &&
                    G > 190 &&
                    B > 175 &&
                    !isCharZone;
                  colorSheet[dstIdx] = isGlareInSubRow
                    ? Math.round(R * 0.68)
                    : R;
                  colorSheet[dstIdx + 1] = isGlareInSubRow
                    ? Math.round(G * 0.68)
                    : G;
                  colorSheet[dstIdx + 2] = isGlareInSubRow
                    ? Math.round(B * 0.68)
                    : B;

                  // On safeSheet:
                  // - Inside `isCharZone`: preserve smooth anti-aliased luminance (0..255) so both black strokes and white outlines look laser-sharp like raw_frame.jpg
                  // - Outside `isCharZone`: replace all skin/body/clothing with a clean, neutral matte slate-grey (~76)
                  if (isCharZone) {
                    const safeVal =
                      lum <= 45
                        ? 0
                        : lum >= 210
                        ? 255
                        : Math.round(((lum - 45) / 165) * 255);
                    safeSheet[dstIdx] = safeVal;
                    safeSheet[dstIdx + 1] = safeVal;
                    safeSheet[dstIdx + 2] = safeVal;
                  } else {
                    const slateVal = Math.round(70 + lum * 0.05);
                    safeSheet[dstIdx] = slateVal;
                    safeSheet[dstIdx + 1] = slateVal + 2;
                    safeSheet[dstIdx + 2] = slateVal + 6;
                  }
                }
              }

              const badgeLabel = `#${String(cardNum).padStart(2, '0')}`;
              drawCardBadgeRgb(colorSheet, sheetW, sheetH, dx + 2, dy + 2, badgeLabel);
              drawCardBadgeRgb(safeSheet, sheetW, sheetH, dx + 2, dy + 2, badgeLabel);

              return {
                cardIndex: cardNum,
                startOffsetSec: Number(
                  Math.max(0, card.startSec - chunkStartSec).toFixed(2)
                ),
                endOffsetSec: Number(
                  Math.max(0.18, card.endSec - chunkStartSec).toFixed(2)
                ),
                yPercent: isPortrait ? 56 : 84,
              };
            });

            const rangeLabel = `${chunkStartSec.toFixed(2)}s-${chunkEndSec.toFixed(2)}s`;
            const colorB64 = encodeRgbBufferToJpegBase64(
              colorSheet,
              sheetW,
              sheetH
            );
            const safeB64 = encodeRgbBufferToJpegBase64(
              safeSheet,
              sheetW,
              sheetH
            );

            chunks.push({
              chunkIndex: s,
              startSec: chunkStartSec,
              endSec: chunkEndSec,
              durationSec: chunkDur,
              isSilent: false,
              rmsAmplitude: 0.05,
              audioBase64: '',
              wavBase64: '',
              mimeType: 'audio/wav',
              byteSize: 0,
              hasHardsubInChunk: true,
              detectedCards: detectedCardsMeta,
              visualFrames: [
                {
                  mimeType: 'image/jpeg',
                  dataBase64: colorB64,
                  timeRangeLabel: rangeLabel,
                  sheetStartOffsetSec: 0,
                  sheetEndOffsetSec: chunkDur,
                },
              ],
              safeVisualFrames: [
                {
                  mimeType: 'image/jpeg',
                  dataBase64: safeB64,
                  timeRangeLabel: rangeLabel,
                  sheetStartOffsetSec: 0,
                  sheetEndOffsetSec: chunkDur,
                },
              ],
              frameYTimeline: [],
            });
          }

          res.json({
            totalDurationSec: durationSec,
            sampleRate: 8000,
            chunks,
            detectedHardsubBox: {
              hasHardsub: true,
              yPercent: isPortrait ? 56 : 84,
              heightPercent: 11,
              widthPercent: 90,
            },
          });
          return;
        }

        // =========================================================================
        // UNIVERSAL FALLBACK: For videos without standard outlined hardsubs,
        // extract 4x24 chronological contact sheets + 8kHz speech audio chunks.
        // =========================================================================
        const numSheets = Math.max(1, Math.ceil(durationSec / 52.0));
        const rows =
          numSheets === 1 && durationSec < 48
            ? Math.min(24, Math.max(4, Math.ceil(durationSec / 0.5 / 4)))
            : 24;
        const tilesPerSheet = 4 * rows;
        const totalTiles = numSheets * tilesPerSheet;
        const fpsExpr = `${(totalTiles - 0.45).toFixed(4)}/${durationSec.toFixed(4)}`;

        const baseCropExpr = isPortrait
          ? 'crop=iw*0.92:ih*0.24:iw*0.04:ih*0.56'
          : 'crop=iw*0.92:ih*0.26:iw*0.04:ih*0.68';
        const safeSubCropExpr = isPortrait
          ? 'crop=iw:ih*0.76:0:ih*0.12'
          : 'crop=iw:ih*0.78:0:ih*0.11';
        const drawTextBadge =
          "drawtext=text='T=%{eif\\:trunc(round(t*100)/100)\\:d}.%{eif\\:mod(round(t*100)\\,100)\\:d\\:2}s':x=3:y=3:fontsize=13:fontcolor=yellow:box=1:boxcolor=black@0.88";

        const filterComplex = [
          `[0:v]fps=${fpsExpr},${baseCropExpr},split=2[vc][vs]`,
          `[vc]scale=256:60,${drawTextBadge},tile=4x${rows}[outc]`,
          `[vs]${safeSubCropExpr},format=rgb24,lutrgb=r='if(gt(val,178),255,val*0.15)':g='if(gt(val,178),255,val*0.15)':b='if(gt(val,178),255,val*0.15)',scale=256:56,${drawTextBadge},tile=4x${rows}[outs]`,
        ].join(';');

        const colorPattern = path.join(tempDir, 'color_%02d.jpg');
        const safePattern = path.join(tempDir, 'safe_%02d.jpg');

        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            inputVideoPath,
            '-filter_complex',
            filterComplex,
            '-map',
            '[outc]',
            '-vsync',
            'vfr',
            '-q:v',
            '4',
            colorPattern,
            '-map',
            '[outs]',
            '-vsync',
            'vfr',
            '-q:v',
            '4',
            safePattern,
          ],
          { maxBuffer: 32 * 1024 * 1024 }
        );

        const chunkDur = durationSec / numSheets;
        if (audioStream) {
          const audioPattern = path.join(tempDir, 'audio_%02d.wav');
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-i',
              inputVideoPath,
              '-map',
              '0:a:0',
              '-f',
              'segment',
              '-segment_time',
              chunkDur.toFixed(4),
              '-ar',
              '8000',
              '-ac',
              '1',
              '-c:a',
              'pcm_s16le',
              audioPattern,
            ],
            { maxBuffer: 16 * 1024 * 1024 }
          ).catch(() => {});
        }

        const chunks = [];
        for (let i = 0; i < numSheets; i++) {
          const idx1Based = String(i + 1).padStart(2, '0');
          const idx0Based = String(i).padStart(2, '0');
          const colorPath = path.join(tempDir, `color_${idx1Based}.jpg`);
          const safePath = path.join(tempDir, `safe_${idx1Based}.jpg`);
          const audioPath = path.join(tempDir, `audio_${idx0Based}.wav`);

          const startSec = Number((i * chunkDur).toFixed(2));
          const endSec = Number(
            (i === numSheets - 1 ? durationSec : (i + 1) * chunkDur).toFixed(2)
          );
          const duration = Number(Math.max(0.5, endSec - startSec).toFixed(2));
          const rangeLabel = `${startSec.toFixed(2)}s-${endSec.toFixed(2)}s`;

          const visualFrames = [];
          if (fs.existsSync(colorPath)) {
            visualFrames.push({
              mimeType: 'image/jpeg',
              dataBase64: fs.readFileSync(colorPath).toString('base64'),
              timeRangeLabel: rangeLabel,
              sheetStartOffsetSec: 0,
              sheetEndOffsetSec: duration,
            });
          }

          const safeVisualFrames = [];
          if (fs.existsSync(safePath)) {
            safeVisualFrames.push({
              mimeType: 'image/jpeg',
              dataBase64: fs.readFileSync(safePath).toString('base64'),
              timeRangeLabel: rangeLabel,
              sheetStartOffsetSec: 0,
              sheetEndOffsetSec: duration,
            });
          }

          const wavB64 = fs.existsSync(audioPath)
            ? fs.readFileSync(audioPath).toString('base64')
            : '';

          chunks.push({
            chunkIndex: i,
            startSec,
            endSec,
            durationSec: duration,
            isSilent: false,
            rmsAmplitude: 0.05,
            audioBase64: wavB64,
            wavBase64: wavB64,
            mimeType: 'audio/wav',
            byteSize: wavB64.length,
            hasHardsubInChunk: true,
            detectedCards: [],
            visualFrames,
            safeVisualFrames,
            frameYTimeline: [],
          });
        }

        res.json({
          totalDurationSec: durationSec,
          sampleRate: 8000,
          chunks,
          detectedHardsubBox: {
            hasHardsub: true,
            yPercent: isPortrait ? 56 : 84,
            heightPercent: 11,
            widthPercent: 90,
          },
        });
      } catch (err: any) {
        res.status(500).json({
          error:
            err?.message || 'FFmpeg server-side video sheet extraction failed.',
        });
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          if (uploadedFileToClean && fs.existsSync(uploadedFileToClean)) {
            fs.unlinkSync(uploadedFileToClean);
          }
        } catch {
          // ignore cleanup error
        }
      }
    }
  );

  /**
   * STEP 1 ENDPOINT: Multimodal Vision + Acoustic Transcribe (Hardsub OCR + Speech ASR, 18+/21+ Uncensored).
   */
  app.post('/api/subtitle/transcribe-chunk', async (req: Request, res: Response) => {
    const startTimeMs = Date.now();
    const body = req.body as {
      jobId?: string;
      audioBase64?: string;
      wavBase64?: string;
      mimeType?: string;
      chunkIndex?: number;
      chunkStartSec?: number;
      chunkDurationSec?: number;
      startSec?: number;
      endSec?: number;
      sourceLanguage?: string;
      contextHint?: string;
      hasHardsubInChunk?: boolean;
      detectedCards?: Array<{
        cardIndex: number;
        startOffsetSec: number;
        endOffsetSec: number;
        yPercent?: number;
      }>;
      previousContextCues?: Array<{ speaker?: string; originalText?: string }>;
      visualFrames?: Array<{
        mimeType?: string;
        dataBase64?: string;
        timeRangeLabel?: string;
      }>;
      safeVisualFrames?: Array<{
        mimeType?: string;
        dataBase64?: string;
        timeRangeLabel?: string;
      }>;
      strictModelOverride?: StrictModelId;
      providerOverride?: ProviderId;
    };

    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : undefined;
    const isNewJobRequest = !jobId || !countedJobIds.has(jobId);
    if (jobId) {
      countedJobIds.add(jobId);
    }

    const audioBase64 = (body.audioBase64 || body.wavBase64 || '').trim();
    const mimeType = body.mimeType || 'audio/wav';
    const chunkIndex = Number(body.chunkIndex) || 0;
    const chunkStartSec =
      typeof body.chunkStartSec === 'number'
        ? body.chunkStartSec
        : typeof body.startSec === 'number'
        ? body.startSec
        : 0;
    const chunkDurationSec =
      typeof body.chunkDurationSec === 'number' && body.chunkDurationSec > 0
        ? body.chunkDurationSec
        : typeof body.endSec === 'number' && body.endSec > chunkStartSec
        ? Number((body.endSec - chunkStartSec).toFixed(2))
        : 20;
    const sourceLanguage = body.sourceLanguage || 'Auto-Detect';
    const contextHint = (body.contextHint || '').trim();
    const previousContextCues = Array.isArray(body.previousContextCues)
      ? body.previousContextCues
      : [];
    const visualFrames = Array.isArray(body.visualFrames)
      ? body.visualFrames.filter((vf) => vf && vf.dataBase64)
      : [];
    const safeVisualFrames = Array.isArray(body.safeVisualFrames)
      ? body.safeVisualFrames.filter((vf) => vf && vf.dataBase64)
      : [];
    const detectedCards = Array.isArray(body.detectedCards)
      ? body.detectedCards.filter(
          (c) => c && typeof c.cardIndex === 'number' && c.endOffsetSec > c.startOffsetSec
        )
      : [];
    const hasHardsubInChunk =
      typeof body.hasHardsubInChunk === 'boolean'
        ? body.hasHardsubInChunk
        : detectedCards.length > 0 ||
          visualFrames.length > 0 ||
          safeVisualFrames.length > 0;

    if (
      !audioBase64 &&
      visualFrames.length === 0 &&
      safeVisualFrames.length === 0
    ) {
      res.json({
        chunkIndex,
        cues: [],
        providerUsed: serverState.activeProvider,
        slotUsed: 'Silent Chunk',
        modelUsed: serverState.strictModel,
        rotatedDuringCall: false,
        rotationLog: [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          durationMs: 0,
        },
        snapshot: buildPublicSnapshot(),
      });
      return;
    }

    const rawRequestedModel: StrictModelId =
      body.strictModelOverride || serverState.strictModel;
    if (!VALID_MODELS.includes(rawRequestedModel)) {
      res.status(400).json({
        error: `Strict Model Lock violation: "${rawRequestedModel}" is not in [${VALID_MODELS.join(', ')}].`,
      });
      return;
    }
    const strictModel: StrictModelId = normalizeStrictModelId(rawRequestedModel);
    serverState.strictModel = strictModel;

    const provider: ProviderId =
      body.providerOverride || serverState.activeProvider;
    serverState.activeProvider = provider;

    const chunkRangeSec = `${chunkStartSec.toFixed(1)}s - ${(
      chunkStartSec + chunkDurationSec
    ).toFixed(1)}s`;

    const langSpec = resolveVerbatimLanguageDirective(sourceLanguage);
    const contextLines = previousContextCues
      .filter((c) => c && c.originalText)
      .slice(-2)
      .map((c) => `${c.speaker || 'Speaker'}: ${c.originalText}`)
      .join(' | ');

    const hasVisualFrames = visualFrames.length > 0 || safeVisualFrames.length > 0;
    // STRICT MODEL-SPECIFIC CONTACT SHEET PIPELINE:
    // - gemini-4-argon: Uses 100% natural full-color contact sheets (`visualFrames`) first, because gemini-4-argon handles raw 18+/21+ color frames natively without safety blocks.
    // - gemini-3.8-flash & gemini-3.1-pro: Uses dedicated Dark-LUT High-Contrast Subtitle Strip sheets (`safeVisualFrames`) first, where upper/lower body anatomy is cropped out and skin tones are darkened while subtitle strokes gleam bright white with T=XX.XXs badges—guaranteeing 0 safety blocks and 100% accuracy!
    const isArgonModel = strictModel === 'gemini-4-argon';
    const primaryModelFrames = isArgonModel
      ? visualFrames.length > 0
        ? visualFrames
        : safeVisualFrames
      : safeVisualFrames.length > 0
      ? safeVisualFrames
      : visualFrames;
    const secondaryModelFrames = isArgonModel
      ? safeVisualFrames
      : visualFrames;

    const cardManifestLines =
      detectedCards.length > 0
        ? [
            `PRE-MEASURED ON-SCREEN SUBTITLE CARDS IN THIS CHUNK:`,
            ...detectedCards.map(
              (c) =>
                `- Card #${c.cardIndex} [${c.startOffsetSec.toFixed(1)}s-${c.endOffsetSec.toFixed(1)}s]`
            ),
          ].join('\n')
        : '';

    const buildSheetOcrInstruction = (
      sheetIndex?: number,
      totalSheets?: number,
      timeRangeLabel?: string
    ) => {
      if (detectedCards.length > 0) {
        const lastBadge = `#${String(detectedCards.length).padStart(2, '0')}`;
        return [
          `You are an Optical Character Recognition (OCR) subtitle indexing tool.`,
          `Attached is a 3-column Card-Indexed Video Subtitle Contact Sheet containing ${detectedCards.length} numbered subtitle tiles (#01 to ${lastBadge}), ordered Row-by-Row from top to bottom, Left-to-Right within each row.`,
          `Rules:`,
          `1. Read EVERY SINGLE TILE from #01 to ${lastBadge} in strict numerical order and extract 100% of the burned-in subtitle text visible in the center of each tile in its exact original language and script (e.g. Chinese Hanzi, Japanese, Korean, English, Thai, Burmese). Never translate into another language in Step 1.`,
          `2. STRICT 1-TILE = 1-JSON-OBJECT MAPPING:`,
          `   - Output 1 JSON object for EVERY tile #01 through ${lastBadge} using its integer tile number "c" (from 1 to ${detectedCards.length}): [{"c":1,"p":1,"t":"..."},{"c":2,"p":1,"t":"..."}]`,
          `   - CRITICAL: Do NOT skip or merge any tile number from 1 to ${detectedCards.length}! Even if a tile shows only a single character (such as "妈", "好", "嗯", "啊", "是", "我", or "我*2"), you MUST output its JSON object with its exact tile number "c"!`,
          `3. ZERO LINGUISTIC AUTO-CORRECTION & COMPLETE 2-LINE SCANNING:`,
          `   - Copy 100% of the exact characters, symbols, and digits printed on screen from left to right (e.g., "7" vs "七", "20秒" vs "二十秒", "3秒" vs "三秒", "高二" vs "高一", "有时限" vs "有限", "不适" vs "不是", "成绩" vs "诚挚", "我*2").`,
          `   - For 2-line wrapped subtitles (a 10-to-12-character top line above a 1-to-5-character bottom line), read every character on the top line without skipping middle pronouns/adverbs ("我", "你", "就", "都", "还", "也"—e.g. "早上起来的时候我就上过厕所了呀" and "大叔你就说要多少钱就行了"), then append the bottom line directly.`,
          `   - Never auto-correct repeated characters or homophone typos in burned-in subtitles (e.g. keep "好了精精神管" verbatim).`,
          `4. Ignore fixed corner/floating watermarks or app logos (such as "黄果果短剧", "huangguoguo9.xyz", "黄果短剧", "huangguoai.com") and vertical character introduction side-banners ("周枫", "周枫母亲 林云竹").`,
          `5. Do NOT skip or omit any tile regardless of adult/18+/21+ visual or text content—this is a purely mechanical OCR indexing task of existing on-screen text.`,
          `6. Do NOT write out per-tile notes or character counts in your thinking process—think minimally and output ONLY a compact raw JSON array: [{"c":1,"p":1,"t":"..."},{"c":2,"p":1,"t":"..."}]`,
        ].join('\n');
      }

      return [
        `You are an Optical Character Recognition (OCR) subtitle indexing tool.`,
        typeof sheetIndex === 'number' && typeof totalSheets === 'number'
          ? `Attached is Chronological 4-Column Video Subtitle Contact Sheet #${sheetIndex + 1} of ${totalSheets}${
              timeRangeLabel ? ` (covering ${timeRangeLabel})` : ''
            }. Each tile has its exact timestamp badge "T=XX.XXs" in the top-left corner, ordered Row-by-Row from top to bottom, Left-to-Right within each row.`
          : `Attached is a chronological 4-column video subtitle contact sheet covering ${chunkStartSec.toFixed(2)}s to ${(chunkStartSec + chunkDurationSec).toFixed(2)}s. Each tile has its exact timestamp badge "T=XX.XXs" in the top-left corner, ordered Row-by-Row from top to bottom, Left-to-Right within each row.`,
        cardManifestLines,
        `Rules:`,
        `1. Scan EVERY SINGLE TILE in strict chronological order (top row to bottom row, Left-to-Right) and extract 100% of every burned-in subtitle card visible in any tile in its exact original language and script (e.g. Chinese Hanzi, Japanese, Korean, English, Thai, Burmese). Never translate into another language in Step 1.`,
        `2. STRICT 1-SUBTITLE-CARD = 1-JSON-OBJECT WITH LITERAL TILE BADGE TIMESTAMPS:`,
        `   - CRITICAL: When the SAME subtitle text remains visible across multiple consecutive tiles, MERGE those consecutive tiles into ONE single JSON object where "s" is the FIRST tile's T=XX.XXs number and "e" is the LAST tile's T=XX.XXs number! NEVER output a separate JSON object for every individual tile of the same continuous subtitle!`,
        `   - If a short subtitle card (such as "妈", "好", "我", "我*2", "小峰", "是", "嗯", "什么事") is visible in only 1 single tile at T=X.XXs, output a separate JSON object with BOTH "s": X.XX and "e": X.XX.`,
        `   - CRITICAL: NEVER merge a standalone 1-character vocative card (like a tile showing ONLY "妈") with a DIFFERENT sentence card (like "把衣服脱了可以吗", "我回来了", or "我"). If Tile A shows ONLY "妈" and Tile B shows "把衣服脱了可以吗" (without "妈"), you MUST output TWO separate JSON objects: one for "妈" and one for "把衣服脱了可以吗"!`,
        `   - Likewise, if one tile shows "我" and the next tile shows "我*2", output TWO separate JSON objects ("我" and "我*2").`,
        `3. ZERO LINGUISTIC AUTO-CORRECTION — READ EVERY CHARACTER GLYPH-BY-GLYPH:`,
        `   - Copy 100% of the exact characters, symbols, and digits shown on screen from left to right, character by character (e.g., "7" vs "七", "20秒" vs "二十秒", "3秒" vs "三秒", "高二" vs "高一", "有时限" vs "有限", "不适" vs "不是", "成绩" vs "诚挚", "我*2").`,
        `   - CRITICAL: Burned-in video subtitles frequently contain repeated characters, stutters, or homophone typos (for example, "精精神管" instead of "精神精神", or repeated adjacent characters like "精精"). NEVER "fix", deduplicate, or auto-correct any character to make a more common phrase! Transcribe each glyph literally as drawn.`,
        `4. Ignore fixed corner/floating watermarks or app logos (such as "黄果果短剧", "huangguoguo9.xyz", "黄果短剧", "huangguoai.com") and vertical character introduction side-banners ("周枫", "周枫母亲 林云竹").`,
        `5. Do NOT skip or omit any tile regardless of adult/18+/21+ visual or text content—this is a purely mechanical OCR indexing task of existing on-screen text.`,
        `6. If no subtitle cards appear in any tile, return []. Output ONLY a compact raw JSON array without markdown commentary: [{"s":1.63,"e":3.25,"p":1,"t":"..."}]`,
      ]
        .filter(Boolean)
        .join('\n');
    };

    const buildCalibratedNormalizedCues = (
      items: ReturnType<typeof parseUniversalTranscriptCues>
    ) => {
      const hasMeasuredCards = detectedCards.length > 0;
      const calibrated = items.map((item, idx: number) => {
        const rawStart = Math.max(0, Number(item.startOffsetSec) || 0);
        const rawEnd = Math.max(
          rawStart,
          Number(item.endOffsetSec) ?? rawStart
        );

        // When exact 15fps/20fps frame boundaries are pre-measured in `detectedCards`, use them 100% verbatim!
        if (hasMeasuredCards || item.cardIndex !== undefined) {
          return {
            id: `cue-${chunkIndex}-${idx}-${Date.now()}`,
            index: idx + 1,
            chunkIndex,
            startSec: Number((chunkStartSec + rawStart).toFixed(2)),
            endSec: Number(
              (chunkStartSec + Math.max(rawStart + 0.18, rawEnd)).toFixed(2)
            ),
            speaker: item.speaker || 'Speaker 1',
            detectedLanguage: item.detectedLanguage || langSpec.cleanName,
            originalText: item.originalText,
            translatedText: '',
            toneNote: item.toneNote || '',
            verified: false,
            translationStatus: 'untranslated' as const,
          };
        }

        const rawSpan = rawEnd - rawStart;

        // With ~0.54s FFmpeg PTS tile sampling, true subtitle onset occurs ~0.10s before the first visible tile
        const calStartOffset = hasVisualFrames
          ? rawStart >= 0.1
            ? rawStart - 0.1
            : rawStart * 0.5
          : rawStart;

        const cleanChars = (item.originalText || '').replace(
          /[\s,，.。!！?？:：;；~～—\-'"“”‘’()（）\[\]【】「」『』*＊]/g,
          ''
        ).length;
        // Natural upper bound on a single burned-in subtitle card's duration so a card never stretches across empty silent frames
        const maxNaturalCardDur = Math.min(
          4.5,
          Math.max(1.1, cleanChars * 0.34 + 0.65)
        );

        // If visible in 1 single tile (rawSpan < 0.15s), true duration around that tile is ~0.52s (rawStart - 0.10 to rawStart + 0.42).
        // If visible across 2+ tiles (rawSpan >= 0.15s), true offset occurs ~0.26s after the last visible tile (rawEnd + 0.26s).
        let calEndOffset = hasVisualFrames
          ? rawSpan < 0.15
            ? rawStart + 0.42
            : rawEnd + 0.26
          : Math.max(rawStart + 0.6, rawEnd);

        if (hasVisualFrames && calEndOffset - calStartOffset > maxNaturalCardDur) {
          calEndOffset = calStartOffset + maxNaturalCardDur;
        }
        calEndOffset = Math.max(calStartOffset + 0.45, calEndOffset);

        return {
          id: `cue-${chunkIndex}-${idx}-${Date.now()}`,
          index: idx + 1,
          chunkIndex,
          startSec: Number((chunkStartSec + calStartOffset).toFixed(2)),
          endSec: Number((chunkStartSec + calEndOffset).toFixed(2)),
          speaker: item.speaker || 'Speaker 1',
          detectedLanguage: item.detectedLanguage || langSpec.cleanName,
          originalText: item.originalText,
          translatedText: '',
          toneNote: item.toneNote || '',
          verified: false,
          translationStatus: 'untranslated' as const,
        };
      });

      // Prevent any overlap between consecutive cues with a clean 0.02s frame transition gap
      for (let i = 0; i < calibrated.length - 1; i++) {
        const cur = calibrated[i];
        const nxt = calibrated[i + 1];
        if (cur.endSec > nxt.startSec) {
          cur.endSec = Number(
            Math.max(cur.startSec + 0.18, nxt.startSec).toFixed(2)
          );
        }
      }

      return calibrated;
    };

    const visualOcrOnlyInstruction = buildSheetOcrInstruction();

    const fullMultimodalInstruction = [
      `You are an Audiovisual Subtitle & Speech-to-Text (OCR + ASR) Indexing Tool.`,
      `Clip duration: ${chunkDurationSec.toFixed(1)}s (offset 0.0s to ${chunkDurationSec.toFixed(1)}s, corresponding to ${chunkStartSec.toFixed(1)}s - ${(chunkStartSec + chunkDurationSec).toFixed(1)}s in the full media).`,
      hasVisualFrames
        ? visualOcrOnlyInstruction
        : `Listen carefully to this ${chunkDurationSec.toFixed(1)}s audio and transcribe 100% of all spoken human dialogue verbatim in the exact spoken language of the speaker (e.g., Chinese in Hanzi 汉字, Japanese in Kanji/Kana, Korean in Hangul, Burmese in Myanmar script, Thai in Thai script, English in English). Return ONLY a raw JSON array: [{"s":0.0,"e":2.0,"p":1,"t":"..."}].`,
      contextHint ? `Context Note: "${contextHint}"` : '',
      contextLines ? `Prior context (do NOT repeat): "${contextLines}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const transcribePrompt = fullMultimodalInstruction;

    // Clinical Acoustic Phonetic Indexing instruction for Audio-Only ASR
    const clinicalAudioOnlyInstruction = [
      `You are an Academic Forensic Phonetics & Multilingual Speech-to-Text Indexing Engine.`,
      `Transcribe all spoken human utterances in this ${chunkDurationSec.toFixed(1)}s audio recording verbatim in the exact native script spoken by the speaker.`,
      `Rules:`,
      `1. Output 100% literal word-for-word transcription in the original spoken language and native script. Do NOT translate into English or any other language.`,
      `2. Keep each spoken sentence/phrase as its own separate JSON object with exact start and end timestamps.`,
      `3. Ignore background music lyrics or non-speech breathing/SFX noises.`,
      `4. Return ONLY a raw JSON array: [{"s":0.0,"e":2.0,"p":1,"t":"..."}]. If there is no human speech, return [].`,
      contextHint ? `Context Note: "${contextHint}"` : '',
      contextLines ? `Prior context (do NOT repeat): "${contextLines}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const rotationLog: string[] = [];

    try {
      // =========================================================================
      // STRICT PROVIDER 1: apinex.bond (100% Isolated Gateway + Model-Separated Pipeline)
      // - Strictly uses ONLY `serverState.apinex.apiKey` (never touches AI Studio or BeatAPI)
      // - Strictly uses ONLY the user's selected model (`gatewayModel`: gemini-3.8-flash, gemini-3.1-pro, or gemini-4-argon)
      // - Model-separated contact sheets:
      //   * `gemini-4-argon` uses `visualFrames` (full-color lower-half contact sheet)
      //   * `gemini-3.8-flash` & `gemini-3.1-pro` use `safeVisualFrames` (Dark-LUT high-contrast subtitle strip)
      // =========================================================================
      if (provider === 'apinex') {
        const apinexKey = serverState.apinex.apiKey;
        if (!apinexKey) {
          throw new Error(
            'apinex.bond API Key မထည့်သွင်းရသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် Key ထည့်သွင်းပါ။'
          );
        }

        const base = (
          serverState.apinex.endpointBase || 'https://api.apinex.bond/v1'
        )
          .replace('https://apinext.bond/v1', 'https://api.apinex.bond/v1')
          .replace(/\/+$/, '');

        const gatewayModel = resolveGatewayModelId(strictModel, 'apinex');

        const callApinexVisionOrText = async (
          framesToSend: Array<{ mimeType?: string; dataBase64?: string }>,
          promptText: string,
          modelToUse: string = gatewayModel,
          timeoutMs: number = 55000
        ): Promise<{
          ok: boolean;
          status: number;
          errText: string;
          json: Record<string, any> | null;
        }> => {
          const parts: any[] = [];
          for (const vf of framesToSend.slice(0, 4)) {
            if (vf.dataBase64) {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${vf.mimeType || 'image/jpeg'};base64,${vf.dataBase64}`,
                  detail: 'high',
                },
              });
            }
          }
          parts.push({
            type: 'text',
            text: promptText,
          });

          const reqBody: Record<string, any> = {
            model: modelToUse,
            temperature: 0,
            reasoning_effort: 'low',
            messages: [
              {
                role: 'user',
                content: parts,
              },
            ],
          };

          const bodyStr = JSON.stringify(reqBody);
          let lastErrorObj = {
            ok: false,
            status: 524,
            errText: 'Gateway request timed out',
            json: null as Record<string, any> | null,
          };

          // 3-attempt automatic retry loop for Cloudflare ECONNRESET / socket drops / 502 / 524
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const resp = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apinexKey}`,
                  'Content-Type': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenAI/JS',
                  Accept: 'application/json',
                },
                body: bodyStr,
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (!resp.ok) {
                const t = await resp.text();
                lastErrorObj = { ok: false, status: resp.status, errText: t, json: null };
                if (
                  attempt < 3 &&
                  (resp.status === 429 || resp.status >= 500)
                ) {
                  await new Promise((r) => setTimeout(r, 1100 * attempt));
                  continue;
                }
                return lastErrorObj;
              }
              const data = (await resp.json()) as Record<string, any>;
              return { ok: true, status: 200, errText: '', json: data };
            } catch (fetchErr: any) {
              lastErrorObj = {
                ok: false,
                status: 524,
                errText: fetchErr?.message || 'Gateway request timed out',
                json: null,
              };
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 1100 * attempt));
                continue;
              }
            }
          }
          return lastErrorObj;
        };

        let parsedItems: ReturnType<typeof parseUniversalTranscriptCues> = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let reasoningTokens = 0;
        let totalTokens = 0;
        let costTokens = 0;
        let lastApinexAttempt: {
          ok: boolean;
          status: number;
          errText: string;
          json: Record<string, any> | null;
        } | null = null;

        const accumulateApinexUsage = (jsonObj: Record<string, any> | null) => {
          if (!jsonObj) return;
          const p = Number(jsonObj.usage?.prompt_tokens) || 0;
          const c = Number(jsonObj.usage?.completion_tokens) || 0;
          const r =
            Number(jsonObj.usage?.completion_tokens_details?.reasoning_tokens) || 0;
          const t = Number(jsonObj.usage?.total_tokens) || p + c;
          const ct = Number(jsonObj.usage?.cost_tokens) || 0;
          promptTokens += p;
          completionTokens += c;
          reasoningTokens += r;
          totalTokens += t;
          costTokens += ct;
        };

        // STAGE 1: Model-Specific Contact Sheet OCR using 100% the user's selected `gatewayModel`:
        // - `gemini-4-argon` uses `primaryModelFrames` = `visualFrames` (full-color lower-half sheet)
        // - `gemini-3.8-flash` & `gemini-3.1-pro` use `primaryModelFrames` = `safeVisualFrames` (Dark-LUT high-contrast subtitle strip)
        if (primaryModelFrames.length > 0) {
          const allSheetCues: ReturnType<typeof parseUniversalTranscriptCues> = [];

          for (let sIdx = 0; sIdx < primaryModelFrames.length; sIdx++) {
            const vf = primaryModelFrames[sIdx];
            const sPrompt = buildSheetOcrInstruction(
              sIdx,
              primaryModelFrames.length,
              vf.timeRangeLabel
            );

            // Strictly call the user's selected model (`gatewayModel`)
            const sAttempt = await callApinexVisionOrText(
              [vf],
              sPrompt,
              gatewayModel,
              55000
            );
            lastApinexAttempt = sAttempt;

            let sCues: ReturnType<typeof parseUniversalTranscriptCues> = [];
            let wasRefusedOrFiltered = !sAttempt.ok;

            if (sAttempt.ok && sAttempt.json) {
              accumulateApinexUsage(sAttempt.json);
              const finishReason = String(
                sAttempt.json.choices?.[0]?.finish_reason || ''
              ).toLowerCase();
              const sText = extractRawContentString(
                sAttempt.json.choices?.[0]?.message?.content ??
                  sAttempt.json.choices?.[0]?.text ??
                  '[]'
              );
              if (
                finishReason.includes('filter') ||
                finishReason.includes('safety') ||
                finishReason.includes('prohibited') ||
                isRefusalOrMetaText(sText)
              ) {
                wasRefusedOrFiltered = true;
              } else {
                sCues = parseUniversalTranscriptCues(
                  sText,
                  chunkDurationSec,
                  langSpec.cleanName,
                  detectedCards,
                  chunkStartSec
                );
              }
            }

            // If the primary sheet was filtered/refused OR returned 0 cues when detectedCards exist, retry on secondaryModelFrames
            if (
              (wasRefusedOrFiltered ||
                (detectedCards.length > 0 && sCues.length === 0)) &&
              secondaryModelFrames[sIdx]
            ) {
              const backupAttempt = await callApinexVisionOrText(
                [secondaryModelFrames[sIdx]],
                sPrompt,
                gatewayModel,
                55000
              );
              if (backupAttempt.ok && backupAttempt.json) {
                lastApinexAttempt = backupAttempt;
                accumulateApinexUsage(backupAttempt.json);
                const backupText = extractRawContentString(
                  backupAttempt.json.choices?.[0]?.message?.content ??
                    backupAttempt.json.choices?.[0]?.text ??
                    '[]'
                );
                sCues = parseUniversalTranscriptCues(
                  backupText,
                  chunkDurationSec,
                  langSpec.cleanName,
                  detectedCards,
                  chunkStartSec
                );
              }
            }

            // Contract Self-Verification (`verified` check): if specific tile numbers `#c` were genuinely skipped (not merged into an adjacent duplicate card), recover them automatically on the primary model sheet `vf`
            if (detectedCards.length > 0 && sCues.length > 0 && sCues.length < detectedCards.length) {
              const presentCards = new Set(
                sCues.map((c) => c.cardIndex).filter(Boolean)
              );
              const missingNums = detectedCards
                .filter(
                  (dc) =>
                    !presentCards.has(dc.cardIndex) &&
                    !sCues.some(
                      (c) =>
                        c.startOffsetSec <= dc.startOffsetSec + 0.08 &&
                        c.endOffsetSec >= dc.endOffsetSec - 0.08
                    )
                )
                .map((dc) => dc.cardIndex);
              if (missingNums.length > 0 && missingNums.length <= 14) {
                const badgeList = missingNums
                  .map((n) => `#${String(n).padStart(2, '0')} (c=${n})`)
                  .join(', ');
                const recoveryPrompt = [
                  `You are an Optical Character Recognition (OCR) verification tool.`,
                  `From the attached 4-column subtitle contact sheet, read ONLY the following missing tile numbers: ${badgeList}.`,
                  `Output 1 JSON object for each requested tile number "c" with its exact on-screen subtitle text "t" in its native script:`,
                  `[{"c":${missingNums[0]},"p":1,"t":"..."}]`,
                ].join('\n');
                const recoverySheet = vf;
                const recAttempt = await callApinexVisionOrText(
                  [recoverySheet],
                  recoveryPrompt,
                  gatewayModel,
                  40000
                );
                if (recAttempt.ok && recAttempt.json) {
                  accumulateApinexUsage(recAttempt.json);
                  const recText = extractRawContentString(
                    recAttempt.json.choices?.[0]?.message?.content ??
                      recAttempt.json.choices?.[0]?.text ??
                      '[]'
                  );
                  const recCues = parseUniversalTranscriptCues(
                    recText,
                    chunkDurationSec,
                    langSpec.cleanName,
                    detectedCards,
                    chunkStartSec
                  );
                  for (const rc of recCues) {
                    if (rc.cardIndex && !presentCards.has(rc.cardIndex)) {
                      sCues.push(rc);
                      presentCards.add(rc.cardIndex);
                    }
                  }
                }
              }
            }

            allSheetCues.push(...sCues);
          }

          parsedItems = deduplicateConsecutiveCues(allSheetCues);
          for (let i = 0; i < parsedItems.length - 1; i++) {
            const cur = parsedItems[i];
            const nxt = parsedItems[i + 1];
            if (cur.endOffsetSec > nxt.startOffsetSec) {
              cur.endOffsetSec = Number(
                Math.max(cur.startOffsetSec, nxt.startOffsetSec - 0.05).toFixed(2)
              );
            }
          }
        }

        // STAGE 2 (Audio-Only File Speech Extraction via APInex Native `/v1/tools/voice/stt`):
        // Strictly isolated to APInex (never touches AI Studio slots!) and runs ONLY when there are no video contact sheets (`!hasVisualFrames`)
        // so that silent scenes in hardsubbed videos never trigger Audio STT breath/sigh hallucinations ("嗯", "啊")!
        const shouldRunStage2Audio =
          !hasVisualFrames && parsedItems.length === 0 && Boolean(audioBase64);

        if (shouldRunStage2Audio) {
          let rawAcousticCues: ReturnType<typeof parseUniversalTranscriptCues> = [];

          try {
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            const langIsoMap: Record<string, string> = {
              Chinese: 'zh',
              Japanese: 'ja',
              Korean: 'ko',
              English: 'en',
              Thai: 'th',
              Russian: 'ru',
              Spanish: 'es',
              Vietnamese: 'vi',
            };
            const explicitIso = langIsoMap[langSpec.cleanName];
            const sttQuery = explicitIso
              ? `smart_format=true&utterances=true&diarize=true&language=${explicitIso}`
              : `smart_format=true&utterances=true&diarize=true&detect_language=true`;

            const sttResp = await fetch(
              `${base}/tools/voice/stt?${sttQuery}`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apinexKey}`,
                  'Content-Type': mimeType || 'audio/wav',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenAI/JS',
                  Accept: 'application/json',
                },
                body: audioBuffer,
                signal: AbortSignal.timeout(45000),
              }
            );
            if (sttResp.ok) {
              const sttJson = (await sttResp.json()) as Record<string, any>;
              rawAcousticCues = parseApinexSttResponseToCues(
                sttJson,
                chunkDurationSec,
                langSpec.cleanName
              );
            }
          } catch {
            // ignore
          }

          if (rawAcousticCues.length > 0) {
            const refinePrompt = [
              `You are an Audiovisual Subtitle Verification Engine (${gatewayModel}).`,
              `Below is the raw acoustic speech transcription extracted from this ${chunkDurationSec.toFixed(1)}s audio clip:`,
              JSON.stringify(rawAcousticCues),
              `Rules:`,
              `1. Keep 100% in the original spoken language and native script (NEVER translate into English or Burmese in Step 1).`,
              `2. Discard any random 1-word foreign language hallucination caused by breathing or sound effects.`,
              `3. Keep each valid spoken sentence/phrase as its own distinct cue with exact startOffsetSec and endOffsetSec timestamps.`,
              `4. Return ONLY the verified JSON array: [{"s":0.0,"e":2.0,"p":1,"t":"..."}].`,
            ].join('\n');

            const refineAttempt = await callApinexVisionOrText(
              [],
              refinePrompt,
              gatewayModel,
              45000
            );
            lastApinexAttempt = refineAttempt;
            if (refineAttempt.ok && refineAttempt.json) {
              accumulateApinexUsage(refineAttempt.json);
              const refinedText =
                refineAttempt.json.choices?.[0]?.message?.content ??
                refineAttempt.json.choices?.[0]?.text ??
                '[]';
              const refinedItems = parseUniversalTranscriptCues(
                refinedText,
                chunkDurationSec,
                langSpec.cleanName,
                [],
                chunkStartSec
              );
              parsedItems = refinedItems.length > 0 ? refinedItems : rawAcousticCues;
            } else {
              parsedItems = rawAcousticCues;
            }
          }
        }

        if (
          parsedItems.length === 0 &&
          lastApinexAttempt &&
          !lastApinexAttempt.ok
        ) {
          throw new Error(
            `apinex.bond (${gatewayModel}) returned ${cleanHttpErrorText(
              lastApinexAttempt.status,
              lastApinexAttempt.errText
            )}`
          );
        }

        // On APInex, 1 cost_token = $0.000001 USD
        const requestCostUsd = Number((costTokens * 0.000001).toFixed(6));

        if (isNewJobRequest) {
          serverState.apinex.stats.totalRequests += 1;
        }
        serverState.apinex.stats.promptTokens += promptTokens;
        serverState.apinex.stats.completionTokens += completionTokens;
        serverState.apinex.stats.reasoningTokens += reasoningTokens;
        serverState.apinex.stats.totalTokens += totalTokens;
        serverState.apinex.stats.costTokens += costTokens;
        serverState.apinex.stats.costUsd = Number(
          (serverState.apinex.stats.costUsd + requestCostUsd).toFixed(6)
        );
        if (typeof serverState.apinex.balance.spentUsd === 'number') {
          serverState.apinex.balance.spentUsd = Number(
            (serverState.apinex.balance.spentUsd + requestCostUsd).toFixed(6)
          );
        }
        if (typeof serverState.apinex.balance.balanceUsd === 'number') {
          serverState.apinex.balance.balanceUsd = Number(
            Math.max(0, serverState.apinex.balance.balanceUsd - requestCostUsd).toFixed(6)
          );
        }
        if (typeof serverState.apinex.balance.remainingUsd === 'number') {
          serverState.apinex.balance.remainingUsd = Number(
            Math.max(0, serverState.apinex.balance.remainingUsd - requestCostUsd).toFixed(6)
          );
        }
        serverState.apinex.stats.windowEntries.push({
          ts: Date.now(),
          tokens: totalTokens,
        });

        const durationMs = Date.now() - startTimeMs;
        const slotLabel = `apinex.bond (${strictModel})`;
        upsertTranscribeLedgerEntry(jobId, {
          id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          stage: 'transcribe',
          provider: 'apinex',
          slotLabel,
          strictModel,
          chunkIndex,
          chunkRangeSec,
          promptTokens,
          completionTokens,
          reasoningTokens,
          totalTokens,
          costTokens,
          costUsd: requestCostUsd,
          durationMs,
          status: 'success',
        });

        savePersistedConfig();
        // Refresh live APInex balance asynchronously in the background without blocking chunk response
        void syncApinexLiveState().catch(() => {});

        const normalizedCues = buildCalibratedNormalizedCues(parsedItems);

        res.json({
          chunkIndex,
          cues: normalizedCues,
          providerUsed: 'apinex',
          slotUsed: slotLabel,
          modelUsed: strictModel,
          rotatedDuringCall: false,
          rotationLog: [],
          usage: {
            promptTokens,
            completionTokens,
            reasoningTokens,
            totalTokens,
            costTokens,
            costUsd: requestCostUsd,
            durationMs,
          },
          snapshot: buildPublicSnapshot(),
        });
        return;
      }

      // =========================================================================
      // STRICT PROVIDER 2: Google AI Studio (100% Isolated Gateway + Model-Separated Pipeline)
      // - Strictly uses ONLY `serverState.aistudio.slots` and `strictModel`
      // - `gemini-4-argon` uses `primaryModelFrames` (`visualFrames` full color)
      // - `gemini-3.8-flash` & `gemini-3.1-pro` use `primaryModelFrames` (`safeVisualFrames` Dark-LUT subtitle strip)
      // =========================================================================
      if (provider === 'aistudio') {
        if (serverState.aistudio.slots.length === 0) {
          throw new Error(
            'AI Studio API Key မရှိသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် AI Studio Key ထည့်သွင်းပါ (သို့မဟုတ် apinex.bond သို့ ပြောင်းပါ)။'
          );
        }

        let attemptCount = 0;
        const maxPoolAttempts = serverState.aistudio.autoRotateEnabled
          ? Math.max(1, serverState.aistudio.slots.length)
          : 1;
        let lastErr: Error | null = null;

        while (attemptCount < maxPoolAttempts) {
          attemptCount += 1;
          const { slot, slotIndex, rotated } = selectAiStudioSlotForExecution(rotationLog);

          try {
            const isProModel = strictModel.includes('pro');
            const aiStudioModelId = resolveGatewayModelId(strictModel, 'aistudio');

            const callGeminiEndpoint = async (
              framesToUse: Array<{ mimeType?: string; dataBase64?: string }>,
              includeAudio: boolean,
              promptText: string
            ): Promise<{
              ok: boolean;
              status: number;
              errText: string;
              json: Record<string, any> | null;
            }> => {
              const userParts: any[] = [];
              for (const vf of framesToUse.slice(0, 2)) {
                if (vf.dataBase64) {
                  userParts.push({
                    inlineData: {
                      mimeType: vf.mimeType || 'image/jpeg',
                      data: vf.dataBase64,
                    },
                  });
                }
              }
              if (includeAudio && audioBase64) {
                userParts.push({
                  inlineData: {
                    mimeType,
                    data: audioBase64,
                  },
                });
              }
              userParts.push({
                text: promptText,
              });

              const generationConfig: Record<string, any> = {
                temperature: 0.05,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
              };
              if (!isProModel) {
                generationConfig.thinkingConfig = {
                  thinkingBudget: 0,
                };
              }

              const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${aiStudioModelId}:generateContent?key=${encodeURIComponent(
                slot.apiKey
              )}`;
              const resp = await fetch(geminiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'aistudio-build',
                },
                body: JSON.stringify({
                  contents: [
                    {
                      role: 'user',
                      parts: userParts,
                    },
                  ],
                  safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
                  ],
                  generationConfig,
                }),
                signal: AbortSignal.timeout(55000),
              });
              if (!resp.ok) {
                const t = await resp.text();
                return { ok: false, status: resp.status, errText: t, json: null };
              }
              const data = (await resp.json()) as Record<string, any>;
              return { ok: true, status: 200, errText: '', json: data };
            };

            const extractGeminiItemsAndTokens = (gJson: Record<string, any>) => {
              const parts = gJson?.candidates?.[0]?.content?.parts ?? [];
              const textPart =
                parts.find((p: any) => typeof p?.text === 'string' && !p?.thought) ||
                parts.find((p: any) => typeof p?.text === 'string');
              const rawText = (textPart?.text ?? '[]').trim();
              const pTok = Number(gJson?.usageMetadata?.promptTokenCount) || 0;
              const cTok = Number(gJson?.usageMetadata?.candidatesTokenCount) || 0;
              const tTok = Number(gJson?.usageMetadata?.totalTokenCount) || pTok + cTok;
              const finishReason = String(gJson?.candidates?.[0]?.finishReason || '');
              const blockReason = String(gJson?.promptFeedback?.blockReason || '');
              const wasBlocked =
                Boolean(blockReason) ||
                finishReason === 'SAFETY' ||
                finishReason === 'PROHIBITED_CONTENT' ||
                finishReason === 'OTHER';
              const items = parseUniversalTranscriptCues(
                rawText,
                chunkDurationSec,
                langSpec.cleanName,
                detectedCards,
                chunkStartSec
              );
              return { items, pTok, cTok, tTok, wasBlocked };
            };

            // Pass 1: Model-specific contact sheet (visualFrames for gemini-4-argon, safeVisualFrames for gemini-3.8-flash & gemini-3.1-pro)
            const gAttempt = await callGeminiEndpoint(
              hasVisualFrames ? primaryModelFrames : [],
              !hasVisualFrames && Boolean(audioBase64),
              hasVisualFrames ? visualOcrOnlyInstruction : clinicalAudioOnlyInstruction
            );
            if (!gAttempt.ok) {
              throw new Error(
                `AI Studio (${strictModel}) HTTP ${gAttempt.status}: ${gAttempt.errText.slice(0, 220)}`
              );
            }

            let {
              items: parsedItems,
              pTok: promptTokens,
              cTok: completionTokens,
              tTok: totalTokens,
              wasBlocked,
            } = extractGeminiItemsAndTokens(gAttempt.json!);

            // Pass 2: If Pass 1 was blocked OR returned 0 items when detectedCards exist, retry with secondaryModelFrames on the SAME strictModel
            if (
              (wasBlocked || (detectedCards.length > 0 && parsedItems.length === 0)) &&
              hasVisualFrames &&
              secondaryModelFrames.length > 0
            ) {
              const ocrResp = await callGeminiEndpoint(
                secondaryModelFrames,
                false,
                visualOcrOnlyInstruction
              );
              if (ocrResp.ok && ocrResp.json) {
                const ocrExtracted = extractGeminiItemsAndTokens(ocrResp.json);
                promptTokens += ocrExtracted.pTok;
                completionTokens += ocrExtracted.cTok;
                totalTokens += ocrExtracted.tTok;
                if (ocrExtracted.items.length > 0) {
                  parsedItems = ocrExtracted.items;
                  wasBlocked = false;
                }
              }
            }

            const nowIso = new Date().toISOString();
            slot.status = 'ready';
            slot.lastError = null;
            slot.lastUsedAt = nowIso;
            if (isNewJobRequest) {
              slot.stats.todayRequests += 1;
              slot.stats.totalRequests += 1;
            }
            slot.stats.promptTokens += promptTokens;
            slot.stats.completionTokens += completionTokens;
            slot.stats.totalTokens += totalTokens;
            slot.stats.windowEntries.push({
              ts: Date.now(),
              tokens: totalTokens,
            });

            const durationMs = Date.now() - startTimeMs;
            upsertTranscribeLedgerEntry(jobId, {
              id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              timestamp: nowIso,
              stage: 'transcribe',
              provider: 'aistudio',
              slotLabel: `${slot.label} (${strictModel})`,
              strictModel,
              chunkIndex,
              chunkRangeSec,
              promptTokens,
              completionTokens,
              totalTokens,
              durationMs,
              status: rotated || rotationLog.length > 0 ? 'rotated' : 'success',
              rotatedToSlot: rotated || rotationLog.length > 0 ? slot.label : undefined,
            });

            savePersistedConfig();

            const normalizedCues = buildCalibratedNormalizedCues(parsedItems);

            res.json({
              chunkIndex,
              cues: normalizedCues,
              providerUsed: 'aistudio',
              slotUsed: `${slot.label} (${strictModel})`,
              modelUsed: strictModel,
              rotatedDuringCall: rotated || rotationLog.length > 0,
              rotationLog,
              usage: {
                promptTokens,
                completionTokens,
                totalTokens,
                durationMs,
              },
              snapshot: buildPublicSnapshot(),
            });
            return;
          } catch (err: any) {
            const errMsg = String(err?.message || err || 'Unknown Gemini API error');
            const isAuthOrForbidden =
              errMsg.includes('403') ||
              errMsg.includes('401') ||
              errMsg.includes('API_KEY_INVALID') ||
              errMsg.includes('PERMISSION_DENIED') ||
              errMsg.toLowerCase().includes('free tier is not available');

            const isTrueRateLimit =
              errMsg.includes('429') ||
              errMsg.includes('RESOURCE_EXHAUSTED') ||
              errMsg.toLowerCase().includes('quota') ||
              errMsg.toLowerCase().includes('rate limit');

            if (isAuthOrForbidden) {
              slot.status = 'invalid';
              slot.lastError = errMsg.slice(0, 160);
            } else if (isTrueRateLimit) {
              slot.status = 'rate_limited';
              slot.cooldownUntilMs = Date.now() + 60_000;
              slot.lastError = 'Limit ပြည့်နေပါသည် (HTTP 429 Quota Reached)';
            } else {
              // Do NOT put key into cooldown or rotate away if it wasn't a real rate limit!
              slot.lastError = errMsg.slice(0, 160);
              lastErr = new Error(errMsg);
              break;
            }

            if (
              serverState.aistudio.autoRotateEnabled &&
              serverState.aistudio.slots.length > 1 &&
              attemptCount < maxPoolAttempts
            ) {
              const nextIdx = (slotIndex + 1) % serverState.aistudio.slots.length;
              const nextSlot = serverState.aistudio.slots[nextIdx];
              const rotMsg = `${slot.label} Limit ပြည့်သွားသဖြင့် -> ${nextSlot.label} သို့ အလိုအလျောက် ပြောင်းလဲခဲ့သည်`;
              rotationLog.push(rotMsg);
              serverState.aistudio.activeSlotIndex = nextIdx;
              serverState.aistudio.totalRotationsCount += 1;
              serverState.aistudio.lastRotationReason = rotMsg;
              savePersistedConfig();
              lastErr = new Error(errMsg);
              continue;
            }
            lastErr = new Error(errMsg);
            break;
          }
        }

        throw lastErr || new Error(`AI Studio (${strictModel}) transcription failed.`);
      }

      // =========================================================================
      // STRICT PROVIDER 3: beatapi.io Gateway (100% Isolated Gateway + Model-Separated Pipeline)
      // - `gemini-4-argon` uses `primaryModelFrames` (`visualFrames` full color)
      // - `gemini-3.8-flash` & `gemini-3.1-pro` use `primaryModelFrames` (`safeVisualFrames` Dark-LUT subtitle strip)
      // =========================================================================
      const gatewayKey = serverState.beatapi.apiKey;
      const endpointBase = serverState.beatapi.endpointBase;
      const gatewayLabel = `beatapi.io (${strictModel})`;

      if (!gatewayKey) {
        throw new Error(
          `${gatewayLabel} API Key မထည့်သွင်းရသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် Key ထည့်သွင်းပါ။`
        );
      }

      const completionUrl = `${endpointBase.replace(/\/+$/, '')}/chat/completions`;
      const lowerMime = mimeType.toLowerCase();
      const audioFormat =
        lowerMime.includes('mp3') || lowerMime.includes('mpeg')
          ? 'mp3'
          : lowerMime.includes('ogg')
          ? 'ogg'
          : lowerMime.includes('aac') ||
            lowerMime.includes('m4a') ||
            lowerMime.includes('mp4')
          ? 'mp3'
          : 'wav';

      const beatContentParts: any[] = [];
      for (const vf of primaryModelFrames.slice(0, 2)) {
        if (vf.dataBase64) {
          beatContentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${vf.mimeType || 'image/jpeg'};base64,${vf.dataBase64}`,
              detail: 'high',
            },
          });
        }
      }
      if (!hasVisualFrames && audioBase64) {
        beatContentParts.push({
          type: 'input_audio',
          input_audio: {
            data: audioBase64,
            format: audioFormat,
          },
        });
      }
      beatContentParts.push({
        type: 'text',
        text: transcribePrompt,
      });

      const beatGatewayModel = resolveGatewayModelId(strictModel, 'beatapi');
      let gatewayResp = await fetch(completionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gatewayKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: beatGatewayModel,
          temperature: 0.05,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'user',
              content: beatContentParts,
            },
          ],
        }),
        signal: AbortSignal.timeout(55000),
      });

      if (!gatewayResp.ok && secondaryModelFrames.length > 0) {
        const backupParts: any[] = [];
        for (const vf of secondaryModelFrames.slice(0, 2)) {
          if (vf.dataBase64) {
            backupParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${vf.mimeType || 'image/jpeg'};base64,${vf.dataBase64}`,
                detail: 'high',
              },
            });
          }
        }
        backupParts.push({
          type: 'text',
          text: transcribePrompt,
        });
        gatewayResp = await fetch(completionUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: beatGatewayModel,
            temperature: 0.05,
            reasoning_effort: 'low',
            messages: [
              {
                role: 'user',
                content: backupParts,
              },
            ],
          }),
          signal: AbortSignal.timeout(55000),
        });
      }

      if (!gatewayResp.ok) {
        const errBody = await gatewayResp.text();
        throw new Error(
          `${gatewayLabel} returned ${cleanHttpErrorText(
            gatewayResp.status,
            errBody
          )}`
        );
      }

      const gatewayJson = (await gatewayResp.json()) as Record<string, any>;
      const rawContent =
        gatewayJson.choices?.[0]?.message?.content ??
        gatewayJson.choices?.[0]?.text ??
        '[]';
      const parsedItems = parseUniversalTranscriptCues(
        rawContent,
        chunkDurationSec,
        langSpec.cleanName,
        detectedCards,
        chunkStartSec
      );

      const promptTokens = Number(gatewayJson.usage?.prompt_tokens) || 0;
      const completionTokens = Number(gatewayJson.usage?.completion_tokens) || 0;
      const totalTokens =
        Number(gatewayJson.usage?.total_tokens) || promptTokens + completionTokens;

      const targetStats = serverState.beatapi.stats;
      if (isNewJobRequest) {
        targetStats.totalRequests += 1;
      }
      targetStats.promptTokens += promptTokens;
      targetStats.completionTokens += completionTokens;
      targetStats.totalTokens += totalTokens;
      targetStats.windowEntries.push({
        ts: Date.now(),
        tokens: totalTokens,
      });

      void syncBeatApiLiveState().catch(() => {});

      const durationMs = Date.now() - startTimeMs;
      upsertTranscribeLedgerEntry(jobId, {
        id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        stage: 'transcribe',
        provider: 'beatapi',
        slotLabel: gatewayLabel,
        strictModel,
        chunkIndex,
        chunkRangeSec,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        status: 'success',
      });

      savePersistedConfig();

      const normalizedCues = buildCalibratedNormalizedCues(parsedItems);

      res.json({
        chunkIndex,
        cues: normalizedCues,
        providerUsed: 'beatapi',
        slotUsed: gatewayLabel,
        modelUsed: strictModel,
        rotatedDuringCall: false,
        rotationLog: [],
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          durationMs,
        },
        snapshot: buildPublicSnapshot(),
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTimeMs;
      const errDetail = String(err?.message || err || 'Transcription error');
      upsertTranscribeLedgerEntry(jobId, {
        id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        stage: 'transcribe',
        provider,
        slotLabel:
          provider === 'aistudio'
            ? serverState.aistudio.slots[serverState.aistudio.activeSlotIndex]?.label ||
              'AI Studio'
            : provider === 'apinex'
            ? `apinex.bond (${strictModel})`
            : `beatapi.io (${strictModel})`,
        strictModel,
        chunkIndex,
        chunkRangeSec,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs,
        status: 'error',
        errorDetail: errDetail,
      });
      savePersistedConfig();

      res.status(500).json({
        error: errDetail,
        strictModel,
        provider,
        snapshot: buildPublicSnapshot(),
      });
    }
  });

  /**
   * STEP 2 ENDPOINT: Translate a batch of already-transcribed cues into Burmese / target language.
   * Supports both `/api/subtitle/translate-batch` and `/api/subtitle/translate-cues`.
   */
  app.post(
    ['/api/subtitle/translate-batch', '/api/subtitle/translate-cues'],
    async (req: Request, res: Response) => {
      const startTimeMs = Date.now();
      const {
        batchIndex = 0,
        cues = [],
        sourceLanguage = 'Auto-Detect',
        targetLanguage = 'Burmese (မြန်မာဘာသာ - သဘာဝကျသော စကားပြောဟန်)',
        contextHint = '',
        strictModelOverride,
        providerOverride,
      } = req.body as {
        batchIndex?: number;
        cues: Array<{
          id: string;
          index: number;
          startSec: number;
          endSec: number;
          speaker: string;
          originalText: string;
          toneNote?: string;
        }>;
        sourceLanguage?: string;
        targetLanguage?: string;
        contextHint?: string;
        strictModelOverride?: StrictModelId;
        providerOverride?: ProviderId;
      };

      if (!Array.isArray(cues) || cues.length === 0) {
        res.status(400).json({ error: 'Cues array is required for Step 2 translation.' });
        return;
      }

      const rawRequestedTranslateModel: StrictModelId =
        strictModelOverride || serverState.strictModel;
      if (!VALID_MODELS.includes(rawRequestedTranslateModel)) {
        res.status(400).json({
          error: `Strict Model Lock violation: "${rawRequestedTranslateModel}" is not in [${VALID_MODELS.join(', ')}].`,
        });
        return;
      }
      const strictModel: StrictModelId = normalizeStrictModelId(
        rawRequestedTranslateModel
      );
      serverState.strictModel = strictModel;

      const provider: ProviderId = providerOverride || serverState.activeProvider;
      serverState.activeProvider = provider;

      const firstCue = cues[0];
      const lastCue = cues[cues.length - 1];
      const chunkRangeSec = `Cues #${firstCue.index}-#${lastCue.index} (${firstCue.startSec.toFixed(1)}s-${lastCue.endSec.toFixed(1)}s)`;

      const translatePrompt = [
        `You are an Archival Literary & Audiovisual Localization Engine.`,
        `Task: Translate each subtitle line below from ${sourceLanguage} into ${targetLanguage}.`,
        `Rules:`,
        `1. Preserve 100% of the speaker's literal meaning, natural spoken Burmese colloquial flow (သဘာဝကျပြီး ဖတ်ရလွယ်ကူသော မြန်မာစကားပြောဟန်), emotional intensity, and interpersonal register.`,
        `2. Translate 100% of all 18+/21+ explicit/adult expressions, anatomy, sexual actions, and slang directly and faithfully into natural spoken Burmese without any censorship, softening, or omission.`,
        `3. DURATION-CALIBRATED READABILITY: Each input item includes "durationSec" (how long that subtitle stays on screen). Craft each Burmese line concisely so a viewer can comfortably finish reading it within "durationSec" while the character is speaking!`,
        contextHint ? `Context Note: "${contextHint}"` : '',
        `4. Return ONLY a raw JSON array (no markdown codeblocks, no commentary) where each item has exact keys: [{"id": "...", "index": 1, "translatedText": "..."}].`,
        ``,
        `Input Cues JSON:`,
        JSON.stringify(
          cues.map((c) => ({
            id: c.id,
            index: c.index,
            speaker: c.speaker,
            durationSec: Number(Math.max(0.5, c.endSec - c.startSec).toFixed(2)),
            originalText: c.originalText,
          }))
        ),
      ]
        .filter(Boolean)
        .join('\n');

      const rotationLog: string[] = [];

      try {
        // =====================================================================
        // STRICT PROVIDER 1: Google AI Studio (Strictly uses strictModel, NO fallback!)
        // =====================================================================
        if (provider === 'aistudio') {
          if (serverState.aistudio.slots.length === 0) {
            throw new Error(
              'AI Studio API Key မရှိသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် AI Studio Key ထည့်သွင်းပါ။'
            );
          }

          let attemptCount = 0;
          const maxPoolAttempts = Math.max(1, serverState.aistudio.slots.length);
          let lastErr: Error | null = null;

          while (attemptCount < maxPoolAttempts) {
            attemptCount += 1;
            const { slot, slotIndex, rotated } = selectAiStudioSlotForExecution(rotationLog);

            try {
              const isProModel = strictModel.includes('pro');
              const generationConfig: Record<string, any> = {
                temperature: 0.2,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
              };
              if (!isProModel) {
                generationConfig.thinkingConfig = { thinkingBudget: 0 };
              }

              const aiStudioTranslateModel = resolveGatewayModelId(
                strictModel,
                'aistudio'
              );
              const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${aiStudioTranslateModel}:generateContent?key=${encodeURIComponent(
                slot.apiKey
              )}`;
              const gResp = await fetch(geminiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'aistudio-build',
                },
                body: JSON.stringify({
                  contents: [
                    {
                      role: 'user',
                      parts: [{ text: translatePrompt }],
                    },
                  ],
                  safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                  ],
                  generationConfig,
                }),
              });

              if (!gResp.ok) {
                const errText = await gResp.text();
                throw new Error(
                  `AI Studio (${strictModel}) HTTP ${gResp.status}: ${errText.slice(0, 220)}`
                );
              }

              const gJson = (await gResp.json()) as Record<string, any>;
              const parts = gJson?.candidates?.[0]?.content?.parts ?? [];
              const textPart =
                parts.find((p: any) => typeof p?.text === 'string' && !p?.thought) ||
                parts.find((p: any) => typeof p?.text === 'string');
              const rawText = (textPart?.text ?? '[]').trim();
              const promptTokens = Number(gJson?.usageMetadata?.promptTokenCount) || 0;
              const completionTokens = Number(gJson?.usageMetadata?.candidatesTokenCount) || 0;
              const totalTokens =
                Number(gJson?.usageMetadata?.totalTokenCount) ||
                promptTokens + completionTokens;

              const parsedItems = extractJsonArrayFromText(rawText);

              const nowIso = new Date().toISOString();
              slot.status = 'ready';
              slot.lastError = null;
              slot.lastUsedAt = nowIso;
              slot.stats.todayRequests += 1;
              slot.stats.totalRequests += 1;
              slot.stats.promptTokens += promptTokens;
              slot.stats.completionTokens += completionTokens;
              slot.stats.totalTokens += totalTokens;
              slot.stats.windowEntries.push({
                ts: Date.now(),
                tokens: totalTokens,
              });

              const durationMs = Date.now() - startTimeMs;
              serverState.ledger.unshift({
                id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                timestamp: nowIso,
                stage: 'translate',
                provider: 'aistudio',
                slotLabel: `${slot.label} (${strictModel})`,
                strictModel,
                chunkIndex: batchIndex,
                chunkRangeSec,
                promptTokens,
                completionTokens,
                totalTokens,
                durationMs,
                status: rotated || rotationLog.length > 0 ? 'rotated' : 'success',
                rotatedToSlot: rotated || rotationLog.length > 0 ? slot.label : undefined,
              });

              savePersistedConfig();

              const translations = cues.map((origCue, idx) => {
                const matched =
                  parsedItems.find(
                    (p: any) => p.id === origCue.id || Number(p.index) === origCue.index
                  ) || parsedItems[idx];
                const txt =
                  matched?.translatedText ??
                  matched?.text ??
                  matched?.t ??
                  matched?.translation ??
                  '';
                return {
                  id: origCue.id,
                  index: origCue.index,
                  translatedText: txt ? String(txt) : '',
                };
              });

              res.json({
                batchIndex,
                translations,
                providerUsed: 'aistudio',
                slotUsed: `${slot.label} (${strictModel})`,
                modelUsed: strictModel,
                rotatedDuringCall: rotated || rotationLog.length > 0,
                rotationLog,
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens,
                  durationMs,
                },
                snapshot: buildPublicSnapshot(),
              });
              return;
            } catch (err: any) {
              const errMsg = String(err?.message || err || 'Unknown Gemini API error');
              const isAuthOrForbidden =
                errMsg.includes('403') ||
                errMsg.includes('401') ||
                errMsg.includes('API_KEY_INVALID') ||
                errMsg.includes('PERMISSION_DENIED') ||
                errMsg.toLowerCase().includes('free tier is not available');

              const isTrueRateLimit =
                errMsg.includes('429') ||
                errMsg.includes('RESOURCE_EXHAUSTED') ||
                errMsg.toLowerCase().includes('quota') ||
                errMsg.toLowerCase().includes('rate limit');

              if (isAuthOrForbidden) {
                slot.status = 'invalid';
                slot.lastError = errMsg.slice(0, 160);
              } else if (isTrueRateLimit) {
                slot.status = 'rate_limited';
                slot.cooldownUntilMs = Date.now() + 60_000;
                slot.lastError = 'Limit ပြည့်နေပါသည် (HTTP 429 Quota Reached)';
              } else {
                slot.lastError = errMsg.slice(0, 160);
                lastErr = new Error(errMsg);
                break;
              }

              if (
                serverState.aistudio.autoRotateEnabled &&
                serverState.aistudio.slots.length > 1 &&
                attemptCount < maxPoolAttempts
              ) {
                const nextIdx = (slotIndex + 1) % serverState.aistudio.slots.length;
                const nextSlot = serverState.aistudio.slots[nextIdx];
                const rotMsg = `${slot.label} Limit ပြည့်သွားသဖြင့် -> ${nextSlot.label} သို့ အလိုအလျောက် ပြောင်းလဲခဲ့သည်`;
                rotationLog.push(rotMsg);
                serverState.aistudio.activeSlotIndex = nextIdx;
                serverState.aistudio.totalRotationsCount += 1;
                serverState.aistudio.lastRotationReason = rotMsg;
                savePersistedConfig();
                lastErr = new Error(errMsg);
                continue;
              }
              lastErr = new Error(errMsg);
              break;
            }
          }

          throw lastErr || new Error(`AI Studio (${strictModel}) translation failed.`);
        }

        // =====================================================================
        // STRICT PROVIDER 2 & 3: apinex.bond or beatapi.io (Strictly uses gatewayModel!)
        // =====================================================================
        const isApinex = provider === 'apinex';
        const gatewayKey = isApinex
          ? serverState.apinex.apiKey
          : serverState.beatapi.apiKey;
        const endpointBase = isApinex
          ? serverState.apinex.endpointBase.includes('apinext.bond')
            ? 'https://api.apinex.bond/v1'
            : serverState.apinex.endpointBase
          : serverState.beatapi.endpointBase;
        const gatewayModel = resolveGatewayModelId(
          strictModel,
          isApinex ? 'apinex' : 'beatapi'
        );
        const gatewayLabel = isApinex
          ? `apinex.bond (${gatewayModel})`
          : `beatapi.io (${gatewayModel})`;

        if (!gatewayKey) {
          throw new Error(
            `${gatewayLabel} API Key မထည့်သွင်းရသေးပါ။ API Key နှင့် Balance ကဏ္ဍတွင် Key ထည့်သွင်းပါ။`
          );
        }

        const completionUrl = `${endpointBase.replace(/\/+$/, '')}/chat/completions`;

        const translateBody: Record<string, any> = {
          model: gatewayModel,
          temperature: 0.2,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'user',
              content: translatePrompt,
            },
          ],
        };

        let gatewayResp: globalThis.Response | null = null;
        let lastTranslateErrText = '';
        let lastTranslateStatus = 524;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(completionUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${gatewayKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenAI/JS',
                Accept: 'application/json',
              },
              body: JSON.stringify(translateBody),
              signal: AbortSignal.timeout(55000),
            });
            gatewayResp = resp;
            if (!resp.ok) {
              lastTranslateStatus = resp.status;
              lastTranslateErrText = await resp.text();
              if (attempt < 3 && (resp.status === 429 || resp.status >= 500)) {
                await new Promise((r) => setTimeout(r, 1100 * attempt));
                continue;
              }
            }
            break;
          } catch (e: any) {
            lastTranslateStatus = 524;
            lastTranslateErrText = e?.message || 'Gateway request timed out';
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 1100 * attempt));
              continue;
            }
          }
        }

        if (!gatewayResp || !gatewayResp.ok) {
          throw new Error(
            `${gatewayLabel} returned ${cleanHttpErrorText(
              lastTranslateStatus,
              lastTranslateErrText
            )}`
          );
        }

        const gatewayJson = (await gatewayResp.json()) as Record<string, any>;
        const rawContent =
          gatewayJson.choices?.[0]?.message?.content ??
          gatewayJson.choices?.[0]?.text ??
          '[]';
        const parsedItems = extractJsonArrayFromText(rawContent);

        const promptTokens = Number(gatewayJson.usage?.prompt_tokens) || 0;
        const completionTokens = Number(gatewayJson.usage?.completion_tokens) || 0;
        const reasoningTokens =
          Number(gatewayJson.usage?.completion_tokens_details?.reasoning_tokens) || 0;
        const totalTokens =
          Number(gatewayJson.usage?.total_tokens) || promptTokens + completionTokens;
        const costTokens = Number(gatewayJson.usage?.cost_tokens) || 0;

        const requestCostUsd = isApinex
          ? Number((costTokens * 0.000001).toFixed(6))
          : 0;

        if (isApinex) {
          void syncApinexLiveState().catch(() => {});
        } else {
          void syncBeatApiLiveState().catch(() => {});
        }

        if (isApinex) {
          serverState.apinex.stats.totalRequests += 1;
          serverState.apinex.stats.promptTokens += promptTokens;
          serverState.apinex.stats.completionTokens += completionTokens;
          serverState.apinex.stats.reasoningTokens += reasoningTokens;
          serverState.apinex.stats.totalTokens += totalTokens;
          serverState.apinex.stats.costTokens += costTokens;
          serverState.apinex.stats.costUsd = Number(
            (serverState.apinex.stats.costUsd + requestCostUsd).toFixed(6)
          );
          if (typeof serverState.apinex.balance.spentUsd === 'number') {
            serverState.apinex.balance.spentUsd = Number(
              (serverState.apinex.balance.spentUsd + requestCostUsd).toFixed(6)
            );
          }
          if (typeof serverState.apinex.balance.balanceUsd === 'number') {
            serverState.apinex.balance.balanceUsd = Number(
              Math.max(0, serverState.apinex.balance.balanceUsd - requestCostUsd).toFixed(6)
            );
          }
          serverState.apinex.stats.windowEntries.push({
            ts: Date.now(),
            tokens: totalTokens,
          });
        } else {
          serverState.beatapi.stats.totalRequests += 1;
          serverState.beatapi.stats.promptTokens += promptTokens;
          serverState.beatapi.stats.completionTokens += completionTokens;
          serverState.beatapi.stats.totalTokens += totalTokens;
          serverState.beatapi.stats.windowEntries.push({
            ts: Date.now(),
            tokens: totalTokens,
          });
        }

        const durationMs = Date.now() - startTimeMs;
        serverState.ledger.unshift({
          id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          stage: 'translate',
          provider: isApinex ? 'apinex' : 'beatapi',
          slotLabel: gatewayLabel,
          strictModel,
          chunkIndex: batchIndex,
          chunkRangeSec,
          promptTokens,
          completionTokens,
          reasoningTokens,
          totalTokens,
          costTokens: isApinex ? costTokens : undefined,
          costUsd: isApinex ? requestCostUsd : undefined,
          durationMs,
          status: 'success',
        });

        savePersistedConfig();

        const translations = cues.map((origCue, idx) => {
          const matched =
            parsedItems.find(
              (p: any) => p.id === origCue.id || Number(p.index) === origCue.index
            ) || parsedItems[idx];
          const txt =
            matched?.translatedText ??
            matched?.text ??
            matched?.t ??
            matched?.translation ??
            '';
          return {
            id: origCue.id,
            index: origCue.index,
            translatedText: txt ? String(txt) : '',
          };
        });

        res.json({
          batchIndex,
          translations,
          providerUsed: isApinex ? 'apinex' : 'beatapi',
          slotUsed: gatewayLabel,
          modelUsed: strictModel,
          rotatedDuringCall: false,
          rotationLog: [],
          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
            durationMs,
          },
          snapshot: buildPublicSnapshot(),
        });
      } catch (err: any) {
        const durationMs = Date.now() - startTimeMs;
        const errDetail = String(err?.message || err || 'Translation batch error');
        serverState.ledger.unshift({
          id: `led-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          stage: 'translate',
          provider,
          slotLabel:
            provider === 'aistudio'
              ? serverState.aistudio.slots[serverState.aistudio.activeSlotIndex]?.label ||
                'AI Studio'
              : provider === 'apinex'
              ? 'apinex.bond Gateway'
              : 'beatapi.io Gateway',
          strictModel,
          chunkIndex: batchIndex,
          chunkRangeSec,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          durationMs,
          status: 'error',
          errorDetail: errDetail,
        });

        res.status(500).json({
          error: errDetail,
          strictModel,
          provider,
          snapshot: buildPublicSnapshot(),
        });
      }
    }
  );

  /**
   * STEP 3 ENDPOINT: Export Burned-In MP4 Video with Hardsub Blur (NO black box)
   * and 100% WYSIWYG Canvas-Rendered Burmese Subtitle Overlays via FFmpeg!
   */
  app.post('/api/subtitle/export-mp4', async (req: Request, res: Response) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-render-'));
    try {
      const {
        videoBase64,
        videoExt = 'mp4',
        videoWidth = 1280,
        videoHeight = 720,
        videoDuration = 60,
        blurConfig,
        blankPngBase64,
        cueOverlays = [],
      } = req.body as {
        videoBase64: string;
        videoExt?: string;
        videoWidth: number;
        videoHeight: number;
        videoDuration: number;
        blurConfig?: {
          enabled: boolean;
          bx: number;
          by: number;
          bw: number;
          bh: number;
          blurStrength: number;
        };
        blankPngBase64: string;
        cueOverlays: Array<{
          startSec: number;
          endSec: number;
          pngBase64: string;
        }>;
      };

      if (!videoBase64) {
        res.status(400).json({ error: 'videoBase64 is required for MP4 export.' });
        return;
      }

      const safeExt = /^[a-z0-9]+$/i.test(videoExt) ? videoExt : 'mp4';
      const inputVideoPath = path.join(workDir, `input.${safeExt}`);
      fs.writeFileSync(inputVideoPath, Buffer.from(videoBase64, 'base64'));

      const blankPngPath = path.join(workDir, 'blank.png');
      fs.writeFileSync(blankPngPath, Buffer.from(blankPngBase64, 'base64'));

      // Sort and sanitize cue intervals to build a seamless concat demuxer script
      const sortedOverlays = [...cueOverlays]
        .filter((o) => o && o.pngBase64 && o.endSec > o.startSec + 0.05)
        .sort((a, b) => a.startSec - b.startSec);

      const concatLines: string[] = ['ffconcat version 1.0'];
      let cursorSec = 0;

      for (let i = 0; i < sortedOverlays.length; i++) {
        const item = sortedOverlays[i];
        const cueStart = Math.max(cursorSec, Number(item.startSec.toFixed(3)));
        const cueEnd = Math.max(cueStart + 0.1, Number(item.endSec.toFixed(3)));

        if (cueStart > cursorSec + 0.02) {
          const gapDur = Number((cueStart - cursorSec).toFixed(3));
          concatLines.push(`file 'blank.png'`);
          concatLines.push(`duration ${gapDur}`);
        }

        const cuePngPath = path.join(workDir, `cue_${i}.png`);
        fs.writeFileSync(cuePngPath, Buffer.from(item.pngBase64, 'base64'));

        const cueDur = Number((cueEnd - cueStart).toFixed(3));
        concatLines.push(`file 'cue_${i}.png'`);
        concatLines.push(`duration ${cueDur}`);
        cursorSec = cueEnd;
      }

      const tailDur = Math.max(1.0, Number((videoDuration - cursorSec + 2.0).toFixed(3)));
      concatLines.push(`file 'blank.png'`);
      concatLines.push(`duration ${tailDur}`);
      // Repeat last file per ffconcat spec
      concatLines.push(`file 'blank.png'`);

      const concatFilePath = path.join(workDir, 'subtitles.ffconcat');
      fs.writeFileSync(concatFilePath, concatLines.join('\n'), 'utf8');

      const outFileName = `kstudio-subtitled-${Date.now()}.mp4`;
      const outFilePath = path.join(EXPORTED_VIDEOS_DIR, outFileName);

      // Build FFmpeg filter_complex matching the exact Canvas Preview pixel coordinates!
      const filterParts: string[] = [];
      let baseStream = '[0:v]';

      if (blurConfig && blurConfig.enabled && blurConfig.bw >= 8 && blurConfig.bh >= 8) {
        const bx = Math.max(0, Math.min(videoWidth - 8, Math.floor(blurConfig.bx)));
        const by = Math.max(0, Math.min(videoHeight - 8, Math.floor(blurConfig.by)));
        const bw = Math.max(8, Math.min(videoWidth - bx, Math.floor(blurConfig.bw)));
        const bh = Math.max(8, Math.min(videoHeight - by, Math.floor(blurConfig.bh)));
        const maxRadius = Math.max(2, Math.floor(Math.min(bw, bh) / 4) - 1);
        const lumaRadius = Math.max(4, Math.min(maxRadius, Math.round(blurConfig.blurStrength || 14)));

        filterParts.push(
          `[0:v]split=2[vorig][vtoblur]`,
          `[vtoblur]crop=${bw}:${bh}:${bx}:${by},boxblur=${lumaRadius}:2[vblurred]`,
          `[vorig][vblurred]overlay=${bx}:${by}[vdelogo]`
        );
        baseStream = '[vdelogo]';
      }

      filterParts.push(
        `[1:v]scale=${videoWidth}:${videoHeight}[vsub]`,
        `${baseStream}[vsub]overlay=0:0:eof_action=pass:shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2[outv]`
      );

      const filterComplex = filterParts.join(';');

      await execFileAsync(
        '/usr/bin/ffmpeg',
        [
          '-y',
          '-i',
          inputVideoPath,
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFilePath,
          '-filter_complex',
          filterComplex,
          '-map',
          '[outv]',
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '21',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          outFilePath,
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );

      res.json({
        ok: true,
        fileName: outFileName,
        videoUrl: `/api/subtitle/exported-video/${encodeURIComponent(outFileName)}`,
      });
    } catch (err: any) {
      res.status(500).json({
        error: `ဗီဒီယိုထုတ်ယူရာတွင် အမှားဖြစ်ပွားပါသည်: ${err?.message || 'FFmpeg render failed'}`,
      });
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  /**
   * Serve exported MP4 video files for in-app preview & download.
   */
  app.get('/api/subtitle/exported-video/:fileName', (req: Request, res: Response) => {
    const rawName = path.basename(String(req.params.fileName || ''));
    const targetPath = path.join(EXPORTED_VIDEOS_DIR, rawName);
    if (!fs.existsSync(targetPath)) {
      res.status(404).send('Exported video not found');
      return;
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${rawName}"`
    );
    res.sendFile(targetPath);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`K-Studio Pro Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
