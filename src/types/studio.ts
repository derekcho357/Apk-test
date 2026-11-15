export type StrictModelId =
  | 'gemini-4-argon'
  | 'gemini-3.8-flash'
  | 'gemini-3.1-pro'
  | 'gemini-3.1-pro-preview';

export type ProviderId = 'aistudio' | 'apinex' | 'beatapi';

export interface StrictModelSpec {
  id: StrictModelId;
  label: string;
  myanmarTitle: string;
  myanmarNote: string;
  myanmarRoleDetail: string;
}

export const STRICT_MODELS: StrictModelSpec[] = [
  {
    id: 'gemini-3.1-pro',
    label: 'gemini-3.1-pro (Gemini 3.1 Pro)',
    myanmarTitle: 'Gemini 3.1 Pro — အတိကျဆုံး စာတန်းထိုး နှင့် ဒိုင်ယာလော့ခ် အထူးပြု',
    myanmarNote:
      'ဗီဒီယိုထဲရှိ မူရင်းစာတန်းထိုး (Hardsub OCR) နှင့် 18+/21+ ဒိုင်ယာလော့ခ်များကို 100% အတိကျဆုံး ဖတ်ရှုဘာသာပြန်ပေးသည့် Pro Model ဖြစ်သည်။',
    myanmarRoleDetail:
      'Strict Lock: ရွေးချယ်ထားပါက gemini-3.1-pro တစ်ခုတည်းကိုသာ သီးသန့်ခေါ်ဆိုပြီး အခြား Model သို့ လုံးဝပြောင်းလဲမည်မဟုတ်ပါ။',
  },
  {
    id: 'gemini-4-argon',
    label: 'gemini-4-argon (Gemini 4 Argon)',
    myanmarTitle: 'Gemini 4 Argon — အမြင့်ဆုံး အရည်အသွေး (Flagship)',
    myanmarNote:
      '18+/21+ စကားပြော၊ ဗန်းစကား၊ ခံစားချက်နှင့် ဇာတ်လမ်းအသွားအလာကို အတိကျဆုံးနှင့် သဘာဝအကျဆုံး မြန်မာဘာသာပြန်ပေးသည့် အမြင့်ဆုံး Model ဖြစ်သည်။',
    myanmarRoleDetail:
      'Strict Lock: ရွေးချယ်ထားပါက gemini-4-argon တစ်ခုတည်းကိုသာ သီးသန့်ခေါ်ဆိုပြီး အခြား Model သို့ လုံးဝပြောင်းလဲမည်မဟုတ်ပါ။',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'gemini-3.8-flash (Gemini 3.8 Flash)',
    myanmarTitle: 'Gemini 3.8 Flash — အမြန်ဆုံးနှင့် Token အသက်သာဆုံး',
    myanmarNote:
      'အသံဖမ်းယူခြင်း (Transcribe) နှင့် စာတန်းထိုးအများအပြားကို အချိန်တိုအတွင်း Token အသက်သာဆုံးဖြင့် လျင်မြန်စွာ ဘာသာပြန်ပေးသည့် High-Speed Model ဖြစ်သည်။',
    myanmarRoleDetail:
      'Strict Lock: ရွေးချယ်ထားပါက gemini-3.8-flash တစ်ခုတည်းကိုသာ သီးသန့်ခေါ်ဆိုပြီး အခြား Model သို့ လုံးဝပြောင်းလဲမည်မဟုတ်ပါ။',
  },
];

export interface AIStudioSlotState {
  slotId: string;
  label: string;
  rawKey?: string;
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
  liveUsage: {
    currentRpm: number;
    currentTpm: number;
    todayRequests: number;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ApinexGatewayState {
  configured: boolean;
  rawKey?: string | null;
  maskedIdentifier: string | null;
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
    tokensUsed?: number | null;
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
  liveUsage: {
    currentRpm: number;
    currentTpm: number;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
    costTokens?: number;
    costUsd?: number;
  };
}

export interface BeatApiGatewayState {
  configured: boolean;
  rawKey?: string | null;
  maskedIdentifier: string | null;
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
  liveUsage: {
    currentRpm: number;
    currentTpm: number;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface UsageLedgerEntry {
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

export interface ProvidersSystemSnapshot {
  serverTime: string;
  activeProvider: ProviderId;
  strictModel: StrictModelId;
  aistudio: {
    autoRotateEnabled: boolean;
    activeSlotIndex: number;
    totalRotationsCount: number;
    lastRotationReason: string | null;
    slots: AIStudioSlotState[];
  };
  apinex: ApinexGatewayState;
  beatapi: BeatApiGatewayState;
  ledger: UsageLedgerEntry[];
}

export interface SubtitleCue {
  id: string;
  index: number;
  chunkIndex?: number;
  startSec: number;
  endSec: number;
  speaker: string;
  detectedLanguage?: string;
  originalText: string;
  translatedText: string;
  toneNote?: string;
  verified?: boolean;
  translationStatus?: 'untranslated' | 'translating' | 'translated' | 'error';
  translatedByModel?: StrictModelId;
  customYPercent?: number;
}

export interface TranscribeChunkResult {
  chunkIndex: number;
  cues: SubtitleCue[];
  providerUsed: ProviderId;
  slotUsed: string;
  modelUsed: StrictModelId;
  rotatedDuringCall: boolean;
  rotationLog: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
  snapshot: ProvidersSystemSnapshot;
}

export interface TranslateBatchResult {
  batchIndex: number;
  translations: Array<{
    id: string;
    index: number;
    translatedText: string;
  }>;
  providerUsed: ProviderId;
  slotUsed: string;
  modelUsed: StrictModelId;
  rotatedDuringCall: boolean;
  rotationLog: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
  snapshot: ProvidersSystemSnapshot;
}
