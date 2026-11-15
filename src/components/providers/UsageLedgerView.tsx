import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, DollarSign, RefreshCw, Trash2 } from 'lucide-react';
import { ProviderId, ProvidersSystemSnapshot } from '../../types/studio';

type LedgerEntryItem = ProvidersSystemSnapshot['ledger'][number];

const LEDGER_LOCAL_STORAGE_KEY = 'kstudio_persistent_ledger_v1';

interface UsageLedgerViewProps {
  snapshot: ProvidersSystemSnapshot | null;
  onRefreshSnapshot?: (updated: ProvidersSystemSnapshot) => void;
}

export const UsageLedgerView: React.FC<UsageLedgerViewProps> = ({
  snapshot,
  onRefreshSnapshot,
}) => {
  const [filterProvider, setFilterProvider] = useState<'all' | ProviderId>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [cachedLedger, setCachedLedger] = useState<LedgerEntryItem[]>(() => {
    try {
      const raw = localStorage.getItem(LEDGER_LOCAL_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  // Auto-sync live APInex / BeatAPI balance when opening the Usage Ledger view
  useEffect(() => {
    let cancelled = false;
    fetch('/api/providers/sync-all', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && onRefreshSnapshot) {
          onRefreshSnapshot(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Merge server snapshot ledger with browser-persisted ledger so history is never lost across restarts
  const ledger = useMemo(() => {
    const serverEntries = snapshot?.ledger ?? [];
    const byId = new Map<string, LedgerEntryItem>();
    for (const item of serverEntries) {
      if (item && item.id) byId.set(item.id, item);
    }
    for (const item of cachedLedger) {
      if (item && item.id && !byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    const merged = Array.from(byId.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return merged.slice(0, 500);
  }, [snapshot?.ledger, cachedLedger]);

  useEffect(() => {
    if (ledger.length > 0) {
      try {
        localStorage.setItem(LEDGER_LOCAL_STORAGE_KEY, JSON.stringify(ledger));
      } catch {
        // ignore storage quota
      }
    }
  }, [ledger]);

  const filteredLedger =
    filterProvider === 'all'
      ? ledger
      : ledger.filter((item) => item.provider === filterProvider);

  const totalCalls = filteredLedger.length;
  const totalPromptTokens = filteredLedger.reduce(
    (acc, r) => acc + (r.promptTokens || 0),
    0
  );
  const totalCompletionTokens = filteredLedger.reduce(
    (acc, r) => acc + (r.completionTokens || 0),
    0
  );
  const totalReasoningTokens = filteredLedger.reduce(
    (acc, r) => acc + (r.reasoningTokens || 0),
    0
  );
  const totalCombinedTokens = filteredLedger.reduce(
    (acc, r) => acc + (r.totalTokens || 0),
    0
  );
  const totalCostTokens = filteredLedger.reduce(
    (acc, r) => acc + (r.costTokens || 0),
    0
  );
  const totalLedgerCostUsd = filteredLedger.reduce(
    (acc, r) => acc + (r.costUsd ?? (r.costTokens ? r.costTokens * 0.000001 : 0)),
    0
  );

  const apinex = snapshot?.apinex;
  const apinexBalanceUsd = apinex?.balance?.balanceUsd;
  const apinexSpentUsd = apinex?.balance?.spentUsd;
  const apinexTokensUsed = apinex?.subscription?.tokensUsed;
  const apinexTokensTotal = apinex?.subscription?.tokensTotal;
  const apinexTokensRemaining = apinex?.subscription?.tokensRemaining;

  const handleCopyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleSyncBalance = async () => {
    setIsSyncing(true);
    try {
      const resp = await fetch('/api/providers/sync-all', {
        method: 'POST',
      });
      if (resp.ok && onRefreshSnapshot) {
        const data: ProvidersSystemSnapshot = await resp.json();
        onRefreshSnapshot(data);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCopyFullLedgerSummary = () => {
    const header = [
      `Active Model: ${snapshot?.strictModel ?? 'gemini-3.8-flash'} (${(snapshot?.activeProvider ?? 'apinex').toUpperCase()})`,
      apinexBalanceUsd != null
        ? `APInex Balance: $${apinexBalanceUsd.toFixed(4)} | Key Total Spent: $${(apinexSpentUsd ?? 0).toFixed(4)} | Quota Used: ${(apinexTokensUsed ?? 0).toLocaleString()} / ${(apinexTokensTotal ?? 0).toLocaleString()}`
        : '',
      `Ledger Calls: ${totalCalls} | Prompt: ${totalPromptTokens} | Out: ${totalCompletionTokens} (Reasoning: ${totalReasoningTokens}) | Total Tokens: ${totalCombinedTokens} | Billed Cost Tokens: ${totalCostTokens} | Ledger Cost: $${totalLedgerCostUsd.toFixed(6)}`,
      `--------------------------------------------------------------------------------`,
    ]
      .filter(Boolean)
      .join('\n');

    const lines = filteredLedger.map((e) => {
      const costUsdVal =
        e.costUsd ?? (e.costTokens ? e.costTokens * 0.000001 : 0);
      return `[${new Date(e.timestamp).toLocaleString()}] ${e.provider.toUpperCase()} (${e.strictModel}) | ${e.stage} | ${e.chunkRangeSec} | In: ${e.promptTokens} | Out: ${e.completionTokens}${
        e.reasoningTokens ? ` (Think: ${e.reasoningTokens})` : ''
      } | Total: ${e.totalTokens}${
        e.costTokens ? ` | Billed: ${e.costTokens} cost_tokens ($${costUsdVal.toFixed(6)})` : ''
      } | ${(e.durationMs / 1000).toFixed(1)}s`;
    });
    handleCopyText(
      [header, ...lines].join('\n') || 'No entries',
      'copy-all-ledger'
    );
  };

  const handleClearLedger = async () => {
    setIsClearing(true);
    try {
      setCachedLedger([]);
      try {
        localStorage.removeItem(LEDGER_LOCAL_STORAGE_KEY);
      } catch {
        // ignore
      }
      const resp = await fetch('/api/providers/ledger/clear', {
        method: 'POST',
      });
      if (resp.ok && onRefreshSnapshot) {
        const data: ProvidersSystemSnapshot = await resp.json();
        onRefreshSnapshot(data);
      }
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="p-3.5 sm:p-6 max-w-4xl mx-auto space-y-4">
      {/* Header & Actions */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-base sm:text-lg font-extrabold text-slate-900">
            Token သုံးစွဲမှု နှင့် ကုန်ကျစရိတ် မှတ်တမ်း (Persistent History)
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            လက်ရှိ ရွေးချယ်ထားသော Model:{' '}
            <span className="font-mono font-bold text-indigo-600">
              {snapshot?.strictModel ?? 'gemini-3.8-flash'}
            </span>{' '}
            ({(snapshot?.activeProvider ?? 'aistudio').toUpperCase()}) · 100% ရွေးချယ်ထားသော Model သီးသန့်ဖြင့်သာ အလုပ်လုပ်ပါသည်။
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            {(
              [
                { id: 'all', label: 'အားလုံး' },
                { id: 'aistudio', label: 'AI Studio' },
                { id: 'apinex', label: 'apinex' },
                { id: 'beatapi', label: 'beatapi' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterProvider(tab.id)}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all whitespace-nowrap ${
                  filterProvider === tab.id
                    ? 'bg-white text-indigo-600 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={isSyncing}
            onClick={handleSyncBalance}
            className="h-8 px-3 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-xs font-bold text-indigo-700 flex items-center gap-1.5"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
            />
            <span>Balance Sync</span>
          </button>

          {ledger.length > 0 && (
            <>
              <button
                type="button"
                onClick={handleCopyFullLedgerSummary}
                className="h-8 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 flex items-center gap-1.5"
              >
                {copiedId === 'copy-all-ledger' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">ကူးပြီး</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={isClearing}
                onClick={handleClearLedger}
                className="h-8 px-3 rounded-xl bg-red-50 hover:bg-red-100 text-xs font-bold text-red-600 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>ရှင်းမည်</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Live APInex Account Balance & Quota Strip */}
      {apinex?.configured && (
        <div className="bg-slate-900 text-white rounded-2xl p-4 shadow-2xs grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-[11px] font-semibold text-slate-400">
              APInex လက်ကျန်ငွေ (Balance)
            </div>
            <div className="text-base sm:text-lg font-extrabold font-mono text-emerald-400 mt-0.5">
              {apinexBalanceUsd != null
                ? `$${apinexBalanceUsd.toFixed(4)}`
                : '—'}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-400">
              API Key စုစုပေါင်း သုံးစွဲငွေ (Spent)
            </div>
            <div className="text-base sm:text-lg font-extrabold font-mono text-amber-300 mt-0.5">
              {apinexSpentUsd != null ? `$${apinexSpentUsd.toFixed(4)}` : '—'}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-400">
              APInex Quota သုံးစွဲမှု (Used)
            </div>
            <div className="text-sm sm:text-base font-extrabold font-mono text-sky-300 mt-0.5">
              {apinexTokensUsed != null
                ? `${apinexTokensUsed.toLocaleString()} / ${(
                    apinexTokensTotal ?? 0
                  ).toLocaleString()}`
                : '—'}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-400">
              Quota လက်ကျန် (Remaining)
            </div>
            <div className="text-sm sm:text-base font-extrabold font-mono text-indigo-300 mt-0.5">
              {apinexTokensRemaining != null
                ? apinexTokensRemaining.toLocaleString()
                : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Session & Persistent Ledger Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-slate-500">
            အကြိမ်ရေ (Calls)
          </div>
          <div className="text-lg sm:text-xl font-extrabold font-mono text-slate-900 mt-0.5">
            {totalCalls.toLocaleString()}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-slate-500">
            Input / Out (Reasoning)
          </div>
          <div className="text-sm sm:text-base font-extrabold font-mono text-slate-900 mt-1">
            {totalPromptTokens.toLocaleString()} /{' '}
            {totalCompletionTokens.toLocaleString()}
            {totalReasoningTokens > 0 && (
              <span className="text-[11px] text-amber-600 ml-1">
                ({totalReasoningTokens.toLocaleString()})
              </span>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-slate-500">
            စုစုပေါင်း Tokens (Raw)
          </div>
          <div className="text-lg sm:text-xl font-extrabold font-mono text-indigo-600 mt-0.5">
            {totalCombinedTokens.toLocaleString()}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-emerald-200/90 p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1">
            <DollarSign className="w-3 h-3" />
            <span>မှတ်တမ်းပါ ကုန်ကျငွေ & Billed</span>
          </div>
          <div className="text-base sm:text-lg font-extrabold font-mono text-emerald-600 mt-0.5">
            ${totalLedgerCostUsd.toFixed(5)}
          </div>
          <div className="text-[11px] font-mono text-slate-500">
            Billed: {totalCostTokens.toLocaleString()} cost_tokens
          </div>
        </div>
      </div>

      {/* Persistent History List */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden">
        {filteredLedger.length === 0 ? (
          <div className="p-10 text-center space-y-1">
            <div className="text-sm font-bold text-slate-700">
              Token သုံးစွဲမှု မှတ်တမ်း မရှိသေးပါ (0 Tokens)
            </div>
            <p className="text-xs text-slate-500">
              ဗီဒီယို သို့မဟုတ် အသံဖိုင် စတင် Transcribe လုပ်သည့်အခါ ကုန်ကျသော Token နှင့် ဒေါ်လာတန်ဖိုးအမှန်ကို ဤနေရာတွင် အမြဲတမ်း သိမ်းဆည်းပြသပေးပါမည်။
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredLedger.map((entry) => {
              const entryCostUsd =
                entry.costUsd ??
                (entry.costTokens ? entry.costTokens * 0.000001 : 0);
              return (
                <div
                  key={entry.id}
                  className="p-3.5 hover:bg-slate-50/80 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-400">
                        {new Date(entry.timestamp).toLocaleString([], {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                      <span className="font-bold text-slate-900">
                        {entry.provider.toUpperCase()}
                      </span>
                      <span className="font-mono text-indigo-600 font-bold">
                        {entry.strictModel}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold text-[11px]">
                        {entry.stage === 'transcribe'
                          ? '၁။ Transcribe'
                          : '၂။ ဘာသာပြန်'}
                      </span>
                      <span className="font-mono text-slate-500">
                        {entry.chunkRangeSec}
                      </span>
                    </div>
                    {entry.status === 'error' && entry.errorDetail && (
                      <div className="text-red-600 font-mono text-[11px] break-words">
                        {entry.errorDetail}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 font-mono tabular-nums">
                    <span className="text-slate-600">
                      In: <b>{entry.promptTokens.toLocaleString()}</b> · Out:{' '}
                      <b>{entry.completionTokens.toLocaleString()}</b>
                      {entry.reasoningTokens ? (
                        <span className="text-amber-600">
                          {' '}
                          (Think: {entry.reasoningTokens.toLocaleString()})
                        </span>
                      ) : null}{' '}
                      · Total:{' '}
                      <b className="text-indigo-600">
                        {entry.totalTokens.toLocaleString()}
                      </b>
                    </span>

                    {(entry.costTokens || entryCostUsd > 0) && (
                      <span className="px-2 py-0.5 rounded-lg bg-emerald-50 border border-emerald-200/80 text-emerald-700 font-bold text-[11px]">
                        {entry.costTokens
                          ? `${entry.costTokens.toLocaleString()} billed · `
                          : ''}
                        ${entryCostUsd.toFixed(6)}
                      </span>
                    )}

                    <span className="text-slate-400">
                      {(entry.durationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
