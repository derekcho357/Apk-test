import React from 'react';
import { Menu, RefreshCw, Sparkles } from 'lucide-react';
import { WorkspaceSectionId } from '../../config/toolsRegistry';
import { ProvidersSystemSnapshot } from '../../types/studio';

interface HeaderProps {
  activeSection: WorkspaceSectionId;
  onSelectSection: (id: WorkspaceSectionId) => void;
  snapshot: ProvidersSystemSnapshot | null;
  isSyncing: boolean;
  onSyncAllBalances: () => void;
  onOpenMobileDrawer: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeSection,
  onSelectSection,
  snapshot,
  isSyncing,
  onSyncAllBalances,
  onOpenMobileDrawer,
}) => {
  const apinexBal = snapshot?.apinex.balance.balanceUsd;

  return (
    <header className="sticky top-0 z-30 h-14 px-3.5 sm:px-6 bg-white/95 backdrop-blur-md border-b border-slate-200/90 flex items-center justify-between gap-3 shrink-0 shadow-2xs">
      {/* Left: Brand + Mobile Drawer Trigger */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={onOpenMobileDrawer}
          aria-label="Open navigation menu"
          className="md:hidden h-9 w-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 transition-colors"
        >
          <Menu className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => onSelectSection('tool-18plus-subtitle-studio')}
          className="flex items-center gap-2.5 text-left shrink-0"
        >
          <span className="h-8 w-8 rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center justify-center shadow-xs">
            <Sparkles className="w-4 h-4" />
          </span>
          <div>
            <span className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 block leading-none">
              K-Studio
            </span>
            <span className="text-[10px] font-medium text-slate-500 block mt-0.5">
              Transcribe & Subtitle Workspace
            </span>
          </div>
        </button>
      </div>

      {/* Center: Segmented Pill Navigation */}
      <nav className="hidden md:flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200/80">
        {(
          [
            {
              id: 'tool-18plus-subtitle-studio',
              label: 'စာတန်းထိုး နှင့် Transcribe',
            },
            {
              id: 'infra-gateway-manager',
              label: 'API Key နှင့် Balance',
            },
            {
              id: 'infra-usage-ledger',
              label: 'Token မှတ်တမ်း',
            },
          ] as const
        ).map((item) => {
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                active
                  ? 'bg-white text-indigo-600 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Right: Balance Readout + Sync */}
      <div className="flex items-center gap-2 shrink-0">
        {apinexBal !== null && apinexBal !== undefined && (
          <button
            type="button"
            onClick={() => onSelectSection('infra-gateway-manager')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-mono text-emerald-800 hover:bg-emerald-100/70 transition-colors"
          >
            <span className="font-bold tabular-nums">
              ${apinexBal.toFixed(2)}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onSyncAllBalances}
          disabled={isSyncing}
          className="h-9 px-3 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-xl disabled:opacity-50 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 text-slate-600 shrink-0 ${
              isSyncing ? 'animate-spin' : ''
            }`}
          />
          <span className="hidden sm:inline">
            {isSyncing ? 'Syncing...' : 'Sync'}
          </span>
        </button>
      </div>
    </header>
  );
};
