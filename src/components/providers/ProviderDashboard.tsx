import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  AIStudioSlotState,
  ProviderId,
  ProvidersSystemSnapshot,
  STRICT_MODELS,
  StrictModelId,
} from '../../types/studio';
import {
  addLocalAiStudioSlotBackup,
  saveLocalKeysBackup,
  syncAllLocalAiStudioSlotsBackup,
} from '../../utils/keyStorage';

interface ProviderDashboardProps {
  snapshot: ProvidersSystemSnapshot | null;
  onRefreshSnapshot: (updated: ProvidersSystemSnapshot) => void;
}

export const ProviderDashboard: React.FC<ProviderDashboardProps> = ({
  snapshot,
  onRefreshSnapshot,
}) => {
  // Add New AI Studio Key State
  const [newSlotLabel, setNewSlotLabel] = useState('');
  const [newSlotCredential, setNewSlotCredential] = useState('');

  // Inline Edit State for AI Studio Slots
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [editSlotLabel, setEditSlotLabel] = useState('');
  const [editSlotKey, setEditSlotKey] = useState('');
  const [editSlotRpm, setEditSlotRpm] = useState<number>(15);
  const [editSlotRpd, setEditSlotRpd] = useState<number>(1500);

  // Reveal / Mask Key Toggle State
  const [revealedKeyIds, setRevealedKeyIds] = useState<Record<string, boolean>>({});

  // apinex.bond State
  const [apinexEditing, setApinexEditing] = useState(false);
  const [apinexTokenInput, setApinexTokenInput] = useState('');
  const [apinexEndpointInput, setApinexEndpointInput] = useState(
    'https://api.apinex.bond/v1'
  );
  const [apinexBusy, setApinexBusy] = useState(false);

  // beatapi.io State
  const [beatEditing, setBeatEditing] = useState(false);
  const [beatTokenInput, setBeatTokenInput] = useState('');
  const [beatEndpointInput, setBeatEndpointInput] = useState(
    'https://api.beatapi.io/v1'
  );
  const [beatBusy, setBeatBusy] = useState(false);

  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const showTempFeedback = (msg: string) => {
    setStatusFeedback(msg);
    setTimeout(() => {
      setStatusFeedback((prev) => (prev === msg ? null : prev));
    }, 3500);
  };

  const toggleRevealKey = (id: string) => {
    setRevealedKeyIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopyText = async (text: string, id: string, label?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      if (label) {
        showTempFeedback(`${label} ကို Copy ကူးပြီးပါပြီ`);
      }
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleSelectModelOrProvider = async (
    nextProvider?: ProviderId,
    nextModel?: StrictModelId
  ) => {
    const resp = await fetch('/api/providers/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProvider: nextProvider,
        strictModel: nextModel,
      }),
    });
    if (resp.ok) {
      const data: ProvidersSystemSnapshot = await resp.json();
      onRefreshSnapshot(data);
      saveLocalKeysBackup({
        activeProvider: data.activeProvider,
        strictModel: data.strictModel,
      });
      showTempFeedback(
        `ရွေးချယ်ပြီးပါပြီ — ${data.activeProvider.toUpperCase()} (${data.strictModel})`
      );
    }
  };

  const handleAiStudioAction = async (
    payload: Record<string, unknown>,
    feedbackMsg?: string
  ) => {
    const resp = await fetch('/api/providers/aistudio/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data: ProvidersSystemSnapshot = await resp.json();
      onRefreshSnapshot(data);
      saveLocalKeysBackup({
        aistudioAutoRotate: data.aistudio.autoRotateEnabled,
        aistudioActiveSlotIndex: data.aistudio.activeSlotIndex,
      });
      syncAllLocalAiStudioSlotsBackup(data.aistudio.slots);
      showTempFeedback(feedbackMsg || 'AI Studio Key စနစ် သိမ်းဆည်းပြီးပါပြီ');
    }
  };

  const handleAddAiStudioSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedKey = newSlotCredential.trim();
    if (!trimmedKey) return;
    const label =
      newSlotLabel.trim() ||
      `AI Studio Key #${(snapshot?.aistudio.slots.length ?? 0) + 1}`;
    addLocalAiStudioSlotBackup(label, trimmedKey);
    await handleAiStudioAction(
      {
        addSlotKey: trimmedKey,
        addSlotLabel: label,
      },
      `${label} ကို ထည့်သွင်းပြီး လက်ရှိသုံးမည့် Key အဖြစ် ရွေးချယ်လိုက်ပါပြီ`
    );
    setNewSlotCredential('');
    setNewSlotLabel('');
  };

  const startEditingSlot = (slot: AIStudioSlotState) => {
    setEditingSlotId(slot.slotId);
    setEditSlotLabel(slot.label);
    setEditSlotKey(slot.rawKey || '');
    setEditSlotRpm(slot.limits.rpmLimit || 15);
    setEditSlotRpd(slot.limits.rpdLimit || 1500);
  };

  const saveEditedSlot = async (slotId: string) => {
    await handleAiStudioAction(
      {
        updateSlotId: slotId,
        updateLabel: editSlotLabel.trim() || undefined,
        updateApiKey: editSlotKey.trim() || undefined,
        updateLimits: {
          rpmLimit: Math.max(1, Number(editSlotRpm) || 15),
          rpdLimit: Math.max(1, Number(editSlotRpd) || 1500),
        },
      },
      'Key အချက်အလက်နှင့် Limit များကို ပြင်ဆင်သိမ်းဆည်းပြီးပါပြီ'
    );
    setEditingSlotId(null);
  };

  const handleSaveApinex = async (syncOnly = false) => {
    setApinexBusy(true);
    try {
      const trimmedKey = syncOnly ? '' : apinexTokenInput.trim();
      const trimmedBase = apinexEndpointInput.trim();
      if (trimmedKey) {
        saveLocalKeysBackup({ apinexKey: trimmedKey });
      }
      const resp = await fetch('/api/providers/apinex/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: trimmedKey || undefined,
          endpointBase: trimmedBase || undefined,
          syncNow: true,
        }),
      });
      if (resp.ok) {
        const data: ProvidersSystemSnapshot = await resp.json();
        onRefreshSnapshot(data);
        setApinexTokenInput('');
        setApinexEditing(false);
        showTempFeedback(
          syncOnly
            ? 'apinex.bond လက်ကျန် Balance စစ်ဆေးပြီးပါပြီ'
            : 'apinex.bond Key သိမ်းဆည်းပြီး ချိတ်ဆက်ပြီးပါပြီ'
        );
      }
    } finally {
      setApinexBusy(false);
    }
  };

  const handleSaveBeatApi = async (syncOnly = false) => {
    setBeatBusy(true);
    try {
      const trimmedKey = syncOnly ? '' : beatTokenInput.trim();
      const trimmedBase = beatEndpointInput.trim();
      if (trimmedKey) {
        saveLocalKeysBackup({ beatapiKey: trimmedKey });
      }
      const resp = await fetch('/api/providers/beatapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: trimmedKey || undefined,
          endpointBase: trimmedBase || undefined,
          syncNow: true,
        }),
      });
      if (resp.ok) {
        const data: ProvidersSystemSnapshot = await resp.json();
        onRefreshSnapshot(data);
        setBeatTokenInput('');
        setBeatEditing(false);
        showTempFeedback(
          syncOnly
            ? 'beatapi.io လက်ကျန် Balance စစ်ဆေးပြီးပါပြီ'
            : 'beatapi.io Key သိမ်းဆည်းပြီး ချိတ်ဆက်ပြီးပါပြီ'
        );
      }
    } finally {
      setBeatBusy(false);
    }
  };

  const activeProvider = snapshot?.activeProvider ?? 'aistudio';
  const rawStrictModel = snapshot?.strictModel ?? 'gemini-3.1-pro';
  const strictModel: StrictModelId =
    rawStrictModel === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro' : rawStrictModel;
  const autoRotateEnabled = snapshot?.aistudio.autoRotateEnabled ?? true;
  const activeSlotIdx = snapshot?.aistudio.activeSlotIndex ?? 0;
  const aiStudioSlots = snapshot?.aistudio.slots ?? [];

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">
      {statusFeedback && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-800 flex items-center justify-between gap-2 shadow-2xs">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="truncate">{statusFeedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusFeedback(null)}
            className="h-6 w-6 rounded-lg text-emerald-700 hover:bg-emerald-100 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* =====================================================================
          1. AI MODEL SELECTION STRIP (Strict Model Lock + 18+/21+ Uncensored)
          ===================================================================== */}
      <section className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-2xs space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm sm:text-base font-extrabold text-slate-900">
                AI Model ရွေးချယ်မှု (Strict Model Lock)
              </h2>
              <span className="px-2.5 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-mono font-bold">
                လက်ရှိ: {strictModel}
              </span>
              <span className="px-2.5 py-0.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
                18+/21+ Uncensored OCR+ASR
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Auto-Fallback လုံးဝမလုပ်ပါ — သင်ရွေးချယ်ထားသော Model ({strictModel}) နှင့် Gateway ({activeProvider.toUpperCase()}) ကိုသာ 100% တိုက်ရိုက် အသုံးပြုပါသည်။
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {STRICT_MODELS.map((m) => {
            const isSelected = strictModel === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => handleSelectModelOrProvider(undefined, m.id)}
                className={`p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between gap-2 cursor-pointer ${
                  isSelected
                    ? 'bg-indigo-50/70 border-indigo-600 ring-2 ring-indigo-600/15'
                    : 'bg-slate-50/60 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono font-bold text-slate-900 truncate">
                    {m.id}
                  </span>
                  <span
                    className={`h-6 px-2.5 rounded-lg text-[10px] font-bold flex items-center justify-center shrink-0 ${
                      isSelected
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white border border-slate-200 text-slate-600'
                    }`}
                  >
                    {isSelected ? '✓ သုံးနေသည်' : 'ရွေးမည်'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 leading-relaxed">
                  {m.myanmarNote}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          2. GOOGLE AI STUDIO (Native Audio & Multi-Key Pool with Manual Select & Limit-Only Auto-Rotation)
          ===================================================================== */}
      <section className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-2xs space-y-4">
        {/* Header Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <KeyRound className="w-4 h-4 text-indigo-600 shrink-0" />
              <h2 className="text-sm sm:text-base font-extrabold text-slate-900">
                1. Google AI Studio (Native Audio & Free Tier)
              </h2>
              <span className="px-2.5 py-0.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
                Key ({aiStudioSlots.length}) ခု အသင့်ရှိသည်
              </span>
            </div>
            <p className="text-xs text-slate-500">
              ကြိုက်နှစ်သက်ရာ Key ကို ကိုယ်တိုင်ရွေးသုံးနိုင်ပြီး၊ ထို Key အမှန်တကယ် Limit ပြည့်မှသာ နောက် Key တစ်ခုသို့ အလိုအလျောက် ပြောင်းပေးပါသည်။
            </p>
          </div>

          <button
            type="button"
            onClick={() => handleSelectModelOrProvider('aistudio', undefined)}
            className={`h-10 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 flex items-center justify-center gap-1.5 whitespace-nowrap ${
              activeProvider === 'aistudio'
                ? 'bg-indigo-600 text-white shadow-2xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
            }`}
          >
            {activeProvider === 'aistudio' ? '✓ လက်ရှိ သုံးနေသည်' : 'AI Studio သုံးမည်'}
          </button>
        </div>

        {/* Auto-Rotation Mode Segmented Bar (Strict Limit-Only Rotation vs Single Key Lock) */}
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-indigo-600 shrink-0" />
              <span>Key ပြောင်းလဲမှု စနစ် (Key Rotation Mode):</span>
            </span>
            {snapshot?.aistudio.totalRotationsCount ? (
              <span className="text-[11px] font-mono text-indigo-600 font-semibold">
                ပြောင်းလဲခဲ့မှု: {snapshot.aistudio.totalRotationsCount} ကြိမ်
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() =>
                handleAiStudioAction(
                  { autoRotateEnabled: true },
                  'Limit ပြည့်မှသာ အလိုအလျောက် Key ပြောင်းသည့်စနစ် ဖွင့်လိုက်ပါပြီ'
                )
              }
              className={`h-9 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                autoRotateEnabled
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              ✓ Limit အမှန်တကယ်ပြည့်မှသာ အလိုအလျောက်ပြောင်းမည် (Auto-Rotate)
            </button>

            <button
              type="button"
              onClick={() =>
                handleAiStudioAction(
                  { autoRotateEnabled: false },
                  'ရွေးထားသော Key တစ်ခုတည်းကိုသာ အသေသုံးမည့်စနစ် ပြောင်းလိုက်ပါပြီ'
                )
              }
              className={`h-9 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                !autoRotateEnabled
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              ရွေးထားသော Key တစ်ခုတည်းသာ သီးသန့်သုံးမည် (Manual Lock)
            </button>
          </div>
        </div>

        {/* Add New AI Studio Key Form (100% Equal-Height Grid — Zero Vertical Squashing!) */}
        <form
          onSubmit={handleAddAiStudioSlot}
          className="p-3 rounded-xl bg-slate-50/80 border border-slate-200/90 space-y-2"
        >
          <div className="text-xs font-bold text-slate-700">
            AI Studio API Key အသစ် ထပ်ပေါင်းထည့်ရန်:
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
            <div className="sm:col-span-4">
              <input
                type="text"
                placeholder="Key အမည် (ဥပမာ Key #2)"
                value={newSlotLabel}
                onChange={(e) => setNewSlotLabel(e.target.value)}
                className="w-full h-10 px-3.5 rounded-xl bg-white border border-slate-200 text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-indigo-600"
              />
            </div>
            <div className="sm:col-span-5">
              <input
                type="text"
                placeholder="AIza... (AI Studio API Key အသစ်ထည့်ရန်)"
                value={newSlotCredential}
                onChange={(e) => setNewSlotCredential(e.target.value)}
                className="w-full h-10 px-3.5 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-indigo-600"
              />
            </div>
            <div className="sm:col-span-3">
              <button
                type="submit"
                className="w-full h-10 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shadow-2xs"
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span>Key ထည့်မည်</span>
              </button>
            </div>
          </div>
        </form>

        {/* AI Studio Key Pool List (Symmetrical Cards with Select, Copy, Edit, Reset/Delete) */}
        <div className="space-y-2.5">
          {aiStudioSlots.map((slot, idx) => {
            const isCurrentActive = activeSlotIdx === idx;
            const isEditingThis = editingSlotId === slot.slotId;
            const isRevealed = Boolean(revealedKeyIds[slot.slotId]);
            const displayKey =
              isRevealed && slot.rawKey ? slot.rawKey : slot.maskedIdentifier;

            return (
              <div
                key={slot.slotId}
                className={`p-3.5 rounded-xl border transition-all space-y-2.5 overflow-hidden ${
                  isCurrentActive
                    ? 'bg-indigo-50/40 border-indigo-400 ring-2 ring-indigo-500/10'
                    : 'bg-white border-slate-200/90 hover:border-slate-300'
                }`}
              >
                {/* Row 1: Key Title + Status Badges + Key String + Usage Metrics */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs sm:text-sm font-extrabold text-slate-900 truncate">
                        {slot.label}
                      </span>
                      {isCurrentActive && (
                        <span className="px-2 py-0.5 rounded-md bg-indigo-600 text-white text-[10px] font-bold whitespace-nowrap">
                          လက်ရှိ ရွေးထားသော Key
                        </span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-bold whitespace-nowrap ${
                          slot.status === 'ready'
                            ? 'bg-emerald-100 text-emerald-800'
                            : slot.status === 'invalid'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {slot.status === 'ready'
                          ? 'READY (အသင့်)'
                          : slot.status === 'invalid'
                          ? 'KEY မှားနေသည်'
                          : 'LIMIT ပြည့်နေသည်'}
                      </span>
                    </div>

                    {/* Key String + Eye Reveal Button */}
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-600">
                      <span className="truncate bg-slate-100 px-2 py-0.5 rounded border border-slate-200/80">
                        {displayKey}
                      </span>
                      {slot.rawKey && (
                        <button
                          type="button"
                          onClick={() => toggleRevealKey(slot.slotId)}
                          className="h-6 px-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center gap-1 text-[10px] font-sans font-semibold cursor-pointer shrink-0"
                          title={isRevealed ? 'Key ဖျောက်မည်' : 'Key အပြည့်ကြည့်မည်'}
                        >
                          {isRevealed ? (
                            <>
                              <EyeOff className="w-3 h-3" />
                              <span>ဖျောက်</span>
                            </>
                          ) : (
                            <>
                              <Eye className="w-3 h-3" />
                              <span>ကြည့်မည်</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Live Usage Counters */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums shrink-0">
                    <span className="px-2 py-1 rounded-lg bg-slate-100 border border-slate-200/80 text-slate-700 font-semibold">
                      RPM: {slot.liveUsage.currentRpm}/{slot.limits.rpmLimit}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-slate-100 border border-slate-200/80 text-slate-700 font-semibold">
                      Today: {slot.liveUsage.todayRequests}/{slot.limits.rpdLimit}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-indigo-50 border border-indigo-200/80 text-indigo-700 font-bold">
                      Tokens: {slot.liveUsage.totalTokens.toLocaleString()}
                    </span>
                  </div>
                </div>

                {slot.lastError && (
                  <div className="px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 font-mono truncate">
                    မှတ်ချက်: {slot.lastError}
                  </div>
                )}

                {/* Row 2: Strictly Equal-Size 4-Column Action Bar (Select, Copy, Edit, Reset/Delete) */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      handleAiStudioAction(
                        { selectSlotId: slot.slotId },
                        `${slot.label} ကို လက်ရှိသုံးမည့် Key အဖြစ် ရွေးချယ်လိုက်ပါပြီ`
                      )
                    }
                    className={`h-8 px-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1 border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap ${
                      isCurrentActive
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-2xs'
                        : 'bg-slate-50 hover:bg-indigo-50 border-slate-200 hover:border-indigo-300 text-slate-800 hover:text-indigo-700'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {isCurrentActive ? 'လက်ရှိသုံးနေသည်' : 'ဤ Key ကိုသုံးမည်'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        slot.rawKey || slot.maskedIdentifier,
                        `copy_${slot.slotId}`,
                        slot.label
                      )
                    }
                    className="h-8 px-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                  >
                    {copiedId === `copy_${slot.slotId}` ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span className="truncate text-emerald-700 font-bold">
                          Copy ကူးပြီး
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">Copy Key</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      isEditingThis
                        ? setEditingSlotId(null)
                        : startEditingSlot(slot)
                    }
                    className={`h-8 px-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 border cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap ${
                      isEditingThis
                        ? 'bg-amber-500 border-amber-500 text-slate-950 font-bold'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700'
                    }`}
                  >
                    <Edit3 className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {isEditingThis ? 'ပိတ်မည်' : 'ပြင်မည် (Edit)'}
                    </span>
                  </button>

                  {aiStudioSlots.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleAiStudioAction(
                          { removeSlotId: slot.slotId },
                          `${slot.label} ကို ဖျက်လိုက်ပါပြီ`
                        )
                      }
                      className="h-8 px-2.5 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">ဖျက်မည်</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        handleAiStudioAction(
                          { clearCooldownSlotId: slot.slotId },
                          `${slot.label} ကို Reset ပြန်လုပ်ပြီးပါပြီ`
                        )
                      }
                      className="h-8 px-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Reset Key</span>
                    </button>
                  )}
                </div>

                {/* Expandable Inline Edit Drawer for AI Studio Slot */}
                {isEditingThis && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2.5 pt-2.5">
                    <div className="text-xs font-bold text-slate-800">
                      Key အမည်၊ API Key နှင့် Limit ပြင်ဆင်ရန် ({slot.label}):
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                      <div className="sm:col-span-4 space-y-1">
                        <label className="text-[11px] font-semibold text-slate-600 block">
                          Key အမည် (Label)
                        </label>
                        <input
                          type="text"
                          value={editSlotLabel}
                          onChange={(e) => setEditSlotLabel(e.target.value)}
                          className="w-full h-9 px-3 rounded-lg bg-white border border-slate-200 text-xs font-medium text-slate-900 focus:outline-none focus:border-indigo-600"
                        />
                      </div>

                      <div className="sm:col-span-8 space-y-1">
                        <label className="text-[11px] font-semibold text-slate-600 block">
                          API Key (AIza...)
                        </label>
                        <input
                          type="text"
                          value={editSlotKey}
                          onChange={(e) => setEditSlotKey(e.target.value)}
                          placeholder="AIza..."
                          className="w-full h-9 px-3 rounded-lg bg-white border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:border-indigo-600"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-slate-600 block">
                          RPM Limit (၁ မိနစ်)
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={editSlotRpm}
                          onChange={(e) => setEditSlotRpm(Number(e.target.value))}
                          className="w-full h-9 px-3 rounded-lg bg-white border border-slate-200 text-xs font-mono font-bold text-slate-900"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-slate-600 block">
                          RPD Limit (၁ ရက်)
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={editSlotRpd}
                          onChange={(e) => setEditSlotRpd(Number(e.target.value))}
                          className="w-full h-9 px-3 rounded-lg bg-white border border-slate-200 text-xs font-mono font-bold text-slate-900"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => saveEditedSlot(slot.slotId)}
                        className="h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Check className="w-3.5 h-3.5 shrink-0" />
                        <span>သိမ်းဆည်းမည်</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setEditingSlotId(null)}
                        className="h-9 px-3 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <X className="w-3.5 h-3.5 shrink-0" />
                        <span>မလုပ်တော့ပါ</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          3. EXTERNAL GATEWAYS: apinex.bond & beatapi.io (With Full Copy, Edit, Eye Toggle & Sync)
          ===================================================================== */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 2. apinex.bond Card */}
        <section className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-2xs space-y-3.5 flex flex-col justify-between">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="min-w-0">
                <h3 className="text-sm sm:text-base font-extrabold text-slate-900 font-mono">
                  2. apinex.bond
                </h3>
                <p className="text-[11px] text-slate-500 truncate">
                  Endpoint: {snapshot?.apinex.endpointBase || 'https://api.apinex.bond/v1'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleSelectModelOrProvider('apinex', undefined)}
                className={`h-9 px-3.5 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 whitespace-nowrap ${
                  activeProvider === 'apinex'
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                }`}
              >
                {activeProvider === 'apinex' ? '✓ လက်ရှိ သုံးနေသည်' : 'apinex သုံးမည်'}
              </button>
            </div>

            {/* Saved Key Bar with Reveal + Copy + Edit + Sync */}
            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-500 font-semibold shrink-0">လက်ရှိ Key:</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-slate-800 font-semibold truncate">
                    {snapshot?.apinex.configured
                      ? revealedKeyIds['apinex'] && snapshot.apinex.rawKey
                        ? snapshot.apinex.rawKey
                        : snapshot.apinex.maskedIdentifier
                      : 'Key မထည့်ရသေးပါ'}
                  </span>
                  {snapshot?.apinex.rawKey && (
                    <button
                      type="button"
                      onClick={() => toggleRevealKey('apinex')}
                      className="h-6 px-1.5 rounded bg-white border border-slate-200 text-slate-600 text-[10px] font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      {revealedKeyIds['apinex'] ? (
                        <EyeOff className="w-3 h-3" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* 3-Column Equal Action Buttons for apinex.bond */}
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  disabled={!snapshot?.apinex.configured}
                  onClick={() =>
                    handleCopyText(
                      snapshot?.apinex.rawKey || snapshot?.apinex.maskedIdentifier || '',
                      'copy_apinex',
                      'apinex.bond API Key'
                    )
                  }
                  className="h-8 px-2 rounded-lg bg-white hover:bg-slate-100 disabled:opacity-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {copiedId === 'copy_apinex' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span className="truncate text-emerald-700 font-bold">ကူးပြီး</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Copy Key</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!apinexEditing) {
                      setApinexTokenInput(snapshot?.apinex.rawKey || '');
                      setApinexEndpointInput(
                        snapshot?.apinex.endpointBase || 'https://api.apinex.bond/v1'
                      );
                    }
                    setApinexEditing(!apinexEditing);
                  }}
                  className={`h-8 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 border cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap ${
                    apinexEditing
                      ? 'bg-amber-500 border-amber-500 text-slate-950 font-bold'
                      : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-700'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {apinexEditing ? 'ပိတ်မည်' : 'ပြင်မည် (Edit)'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={apinexBusy}
                  onClick={() => handleSaveApinex(true)}
                  className="h-8 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 shrink-0 ${apinexBusy ? 'animate-spin' : ''}`}
                  />
                  <span className="truncate">Sync စစ်မည်</span>
                </button>
              </div>
            </div>

            {/* Balance & Spent Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[11px] text-slate-500 font-medium">
                  လက်ကျန် Balance
                </div>
                <div className="text-base font-extrabold font-mono text-emerald-600 mt-0.5">
                  {snapshot?.apinex.balance.balanceUsd !== null &&
                  snapshot?.apinex.balance.balanceUsd !== undefined
                    ? `$${snapshot.apinex.balance.balanceUsd.toFixed(4)}`
                    : '—'}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[11px] text-slate-500 font-medium">
                  သုံးစွဲပြီး (Spent)
                </div>
                <div className="text-base font-extrabold font-mono text-slate-800 mt-0.5">
                  {snapshot?.apinex.balance.spentUsd !== null &&
                  snapshot?.apinex.balance.spentUsd !== undefined
                    ? `$${snapshot.apinex.balance.spentUsd.toFixed(4)}`
                    : '—'}
                </div>
              </div>
            </div>

            {/* Edit or New Key Input Form (Equal Height h-10 Grid) */}
            {(apinexEditing || !snapshot?.apinex.configured) && (
              <div className="p-3 rounded-xl bg-indigo-50/40 border border-indigo-200/80 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  apinex.bond API Key နှင့် Endpoint ပြင်ဆင်ရန်:
                </div>
                <input
                  type="text"
                  placeholder="sk-... (apinex.bond API Key ထည့်ပါ)"
                  value={apinexTokenInput}
                  onChange={(e) => setApinexTokenInput(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:border-indigo-600"
                />
                <input
                  type="text"
                  placeholder="https://api.apinex.bond/v1"
                  value={apinexEndpointInput}
                  onChange={(e) => setApinexEndpointInput(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-700 focus:outline-none focus:border-indigo-600"
                />
                <button
                  type="button"
                  disabled={apinexBusy}
                  onClick={() => handleSaveApinex(false)}
                  className="w-full h-10 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Check className="w-4 h-4 shrink-0" />
                  <span>Key သိမ်းဆည်းပြီး Balance ချိတ်ဆက်မည်</span>
                </button>
              </div>
            )}
          </div>
        </section>

        {/* 3. beatapi.io Card */}
        <section className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-2xs space-y-3.5 flex flex-col justify-between">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="min-w-0">
                <h3 className="text-sm sm:text-base font-extrabold text-slate-900 font-mono">
                  3. beatapi.io
                </h3>
                <p className="text-[11px] text-slate-500 truncate">
                  Endpoint: {snapshot?.beatapi.endpointBase || 'https://api.beatapi.io/v1'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleSelectModelOrProvider('beatapi', undefined)}
                className={`h-9 px-3.5 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 whitespace-nowrap ${
                  activeProvider === 'beatapi'
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                }`}
              >
                {activeProvider === 'beatapi' ? '✓ လက်ရှိ သုံးနေသည်' : 'beatapi သုံးမည်'}
              </button>
            </div>

            {/* Saved Key Bar with Reveal + Copy + Edit + Sync */}
            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-500 font-semibold shrink-0">လက်ရှိ Key:</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-slate-800 font-semibold truncate">
                    {snapshot?.beatapi.configured
                      ? revealedKeyIds['beatapi'] && snapshot.beatapi.rawKey
                        ? snapshot.beatapi.rawKey
                        : snapshot.beatapi.maskedIdentifier
                      : 'Key မထည့်ရသေးပါ'}
                  </span>
                  {snapshot?.beatapi.rawKey && (
                    <button
                      type="button"
                      onClick={() => toggleRevealKey('beatapi')}
                      className="h-6 px-1.5 rounded bg-white border border-slate-200 text-slate-600 text-[10px] font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      {revealedKeyIds['beatapi'] ? (
                        <EyeOff className="w-3 h-3" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* 3-Column Equal Action Buttons for beatapi.io */}
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  disabled={!snapshot?.beatapi.configured}
                  onClick={() =>
                    handleCopyText(
                      snapshot?.beatapi.rawKey || snapshot?.beatapi.maskedIdentifier || '',
                      'copy_beatapi',
                      'beatapi.io API Key'
                    )
                  }
                  className="h-8 px-2 rounded-lg bg-white hover:bg-slate-100 disabled:opacity-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {copiedId === 'copy_beatapi' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span className="truncate text-emerald-700 font-bold">ကူးပြီး</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Copy Key</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!beatEditing) {
                      setBeatTokenInput(snapshot?.beatapi.rawKey || '');
                      setBeatEndpointInput(
                        snapshot?.beatapi.endpointBase || 'https://api.beatapi.io/v1'
                      );
                    }
                    setBeatEditing(!beatEditing);
                  }}
                  className={`h-8 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 border cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap ${
                    beatEditing
                      ? 'bg-amber-500 border-amber-500 text-slate-950 font-bold'
                      : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-700'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {beatEditing ? 'ပိတ်မည်' : 'ပြင်မည် (Edit)'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={beatBusy}
                  onClick={() => handleSaveBeatApi(true)}
                  className="h-8 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 shrink-0 ${beatBusy ? 'animate-spin' : ''}`}
                  />
                  <span className="truncate">Sync စစ်မည်</span>
                </button>
              </div>
            </div>

            {/* Balance & Used Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[11px] text-slate-500 font-medium">
                  လက်ကျန် Balance
                </div>
                <div className="text-base font-extrabold font-mono text-emerald-600 mt-0.5">
                  {snapshot?.beatapi.usageReport.creditBalanceUsd !== null &&
                  snapshot?.beatapi.usageReport.creditBalanceUsd !== undefined
                    ? `$${snapshot.beatapi.usageReport.creditBalanceUsd.toFixed(4)}`
                    : '—'}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[11px] text-slate-500 font-medium">
                  သုံးစွဲပြီး (Used)
                </div>
                <div className="text-base font-extrabold font-mono text-slate-800 mt-0.5">
                  {snapshot?.beatapi.usageReport.creditsSettledUsd !== null &&
                  snapshot?.beatapi.usageReport.creditsSettledUsd !== undefined
                    ? `$${snapshot.beatapi.usageReport.creditsSettledUsd.toFixed(4)}`
                    : '—'}
                </div>
              </div>
            </div>

            {/* Edit or New Key Input Form (Equal Height h-10 Grid) */}
            {(beatEditing || !snapshot?.beatapi.configured) && (
              <div className="p-3 rounded-xl bg-indigo-50/40 border border-indigo-200/80 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  beatapi.io API Key နှင့် Endpoint ပြင်ဆင်ရန်:
                </div>
                <input
                  type="text"
                  placeholder="sk-... (beatapi.io API Key ထည့်ပါ)"
                  value={beatTokenInput}
                  onChange={(e) => setBeatTokenInput(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:border-indigo-600"
                />
                <input
                  type="text"
                  placeholder="https://api.beatapi.io/v1"
                  value={beatEndpointInput}
                  onChange={(e) => setBeatEndpointInput(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-700 focus:outline-none focus:border-indigo-600"
                />
                <button
                  type="button"
                  disabled={beatBusy}
                  onClick={() => handleSaveBeatApi(false)}
                  className="w-full h-10 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Check className="w-4 h-4 shrink-0" />
                  <span>Key သိမ်းဆည်းပြီး Balance ချိတ်ဆက်မည်</span>
                </button>
              </div>
            )}

            {snapshot?.beatapi.lastError && (
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-700 font-mono flex items-center justify-between gap-2">
                <span className="truncate">{snapshot.beatapi.lastError}</span>
                <button
                  type="button"
                  onClick={() =>
                    handleCopyText(snapshot.beatapi.lastError || '', 'beat-err')
                  }
                  className="h-6 px-2 rounded bg-white border border-rose-200 text-rose-800 font-bold shrink-0 flex items-center gap-1 cursor-pointer"
                >
                  {copiedId === 'beat-err' ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>Copy</span>
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
