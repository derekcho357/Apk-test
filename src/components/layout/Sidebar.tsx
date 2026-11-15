import React from 'react';
import {
  Clapperboard,
  ReceiptText,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { WorkspaceSectionId } from '../../config/toolsRegistry';
import {
  ProviderId,
  ProvidersSystemSnapshot,
  STRICT_MODELS,
  StrictModelId,
} from '../../types/studio';

interface SidebarProps {
  activeSection: WorkspaceSectionId;
  onSelectSection: (id: WorkspaceSectionId) => void;
  snapshot: ProvidersSystemSnapshot | null;
  onQuickSwitchModel: (model: StrictModelId) => void;
  onQuickSwitchProvider: (provider: ProviderId) => void;
  mobileDrawerOpen: boolean;
  onCloseMobileDrawer: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  snapshot,
  onQuickSwitchModel,
  onQuickSwitchProvider,
  mobileDrawerOpen,
  onCloseMobileDrawer,
}) => {
  const rawModel = snapshot?.strictModel ?? 'gemini-3.1-pro';
  const currentModel: StrictModelId =
    rawModel === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro' : rawModel;
  const currentProvider = snapshot?.activeProvider ?? 'aistudio';

  const handleSelectNav = (id: WorkspaceSectionId) => {
    onSelectSection(id);
    onCloseMobileDrawer();
  };

  return (
    <>
      {mobileDrawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs"
            onClick={onCloseMobileDrawer}
          />
          <div className="relative z-10 w-[82vw] max-w-[300px] h-full bg-white border-r border-slate-200 flex flex-col justify-between p-4 overflow-y-auto shadow-xl">
            <div className="space-y-5">
              <div className="pb-3.5 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-sm font-extrabold text-slate-900">
                      K-Studio Pro
                    </div>
                    <div className="text-[11px] text-slate-500">
                      AI Transcribe & Subtitles
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCloseMobileDrawer}
                  className="h-8 w-8 rounded-xl bg-slate-100 text-slate-600 hover:text-slate-900 flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <nav className="space-y-1.5">
                {(
                  [
                    {
                      id: 'tool-18plus-subtitle-studio',
                      title: 'စာတန်းထိုး နှင့် Transcribe',
                      sub: 'ဗီဒီယို/အသံ စာသားထုတ်ရန် နှင့် ဘာသာပြန်ရန်',
                      icon: Clapperboard,
                    },
                    {
                      id: 'infra-gateway-manager',
                      title: 'API Key နှင့် Balance',
                      sub: 'Key သိမ်းဆည်းရန် နှင့် လက်ကျန်ငွေစစ်ရန်',
                      icon: SlidersHorizontal,
                    },
                    {
                      id: 'infra-usage-ledger',
                      title: 'Token သုံးစွဲမှု မှတ်တမ်း',
                      sub: 'API ခေါ်ဆိုမှု နှင့် Token စာရင်း',
                      icon: ReceiptText,
                    },
                  ] as const
                ).map((item) => {
                  const isActive = activeSection === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectNav(item.id)}
                      className={`w-full px-3.5 py-3 rounded-xl text-left transition-all flex items-center gap-3 ${
                        isActive
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">
                          {item.title}
                        </div>
                        <div
                          className={`text-[11px] truncate ${
                            isActive ? 'text-indigo-100' : 'text-slate-500'
                          }`}
                        >
                          {item.sub}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="pt-4 border-t border-slate-100 space-y-3">
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold text-slate-500">
                  AI Model ရွေးချယ်ရန်
                </div>
                <div className="space-y-1">
                  {STRICT_MODELS.map((m) => {
                    const selected = currentModel === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onQuickSwitchModel(m.id)}
                        className={`w-full px-3 py-2 rounded-lg text-xs font-mono text-left flex items-center justify-between border ${
                          selected
                            ? 'bg-indigo-50 border-indigo-600 text-indigo-900 font-bold'
                            : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <span className="truncate">{m.id}</span>
                        {selected && (
                          <span className="text-[10px] text-indigo-600 font-sans font-bold">
                            ✓ သုံးနေသည်
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-bold text-slate-500">
                  API Gateway
                </div>
                <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-xl">
                  {(
                    [
                      { id: 'aistudio', label: 'AI Studio' },
                      { id: 'apinex', label: 'apinex' },
                      { id: 'beatapi', label: 'beatapi' },
                    ] as Array<{ id: ProviderId; label: string }>
                  ).map((p) => {
                    const active = currentProvider === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onQuickSwitchProvider(p.id)}
                        className={`py-1.5 px-1.5 rounded-lg text-[11px] font-bold transition-all ${
                          active
                            ? 'bg-white text-indigo-600 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

interface MobileBottomNavProps {
  activeSection: WorkspaceSectionId;
  onSelectSection: (id: WorkspaceSectionId) => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeSection,
  onSelectSection,
}) => {
  const navItems: Array<{
    id: WorkspaceSectionId;
    label: string;
    icon: React.FC<{ className?: string }>;
  }> = [
    {
      id: 'tool-18plus-subtitle-studio',
      label: 'Transcribe & စာတန်းထိုး',
      icon: Clapperboard,
    },
    {
      id: 'infra-gateway-manager',
      label: 'API & Balance',
      icon: SlidersHorizontal,
    },
    {
      id: 'infra-usage-ledger',
      label: 'Token မှတ်တမ်း',
      icon: ReceiptText,
    },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 shadow-lg">
      <div className="grid grid-cols-3 items-center h-15 px-2 max-w-xl mx-auto gap-1.5">
        {navItems.map((item) => {
          const isActive = activeSection === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              className={`h-11 px-2 rounded-xl flex flex-col items-center justify-center transition-all ${
                isActive
                  ? 'bg-indigo-50 text-indigo-600 font-bold'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="text-[11px] leading-tight mt-0.5 whitespace-nowrap truncate max-w-full">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
