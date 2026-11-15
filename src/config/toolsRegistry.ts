export type WorkspaceSectionId =
  | 'tool-18plus-subtitle-studio'
  | 'infra-gateway-manager'
  | 'infra-usage-ledger';

export interface WorkspaceNavItem {
  id: WorkspaceSectionId;
  code: string;
  title: string;
  myanmarTitle: string;
  category: 'tools' | 'infrastructure';
  description: string;
}

/**
 * Modular Tool & Infrastructure Registry.
 * Designed so new tools can be appended cleanly without modifying existing tool modules.
 */
export const WORKSPACE_NAV_ITEMS: WorkspaceNavItem[] = [
  {
    id: 'tool-18plus-subtitle-studio',
    code: '01',
    title: '18+/21+ Auto Subtitle Studio',
    myanmarTitle: '18+/21+ အော်တို စာတန်းထိုးနှင့် ဘာသာပြန်စက်',
    category: 'tools',
    description: 'End-to-end uncensored audio extraction, transcription, and Burmese/multi-language subtitle pipeline.',
  },
  {
    id: 'infra-gateway-manager',
    code: '02',
    title: 'API Gateways & Dynamic Limits',
    myanmarTitle: 'API Key (၃) နေရာ၊ Balance နှင့် Limit စီမံခန့်ခွဲမှု',
    category: 'infrastructure',
    description: 'AI Studio Auto-Rotation Pool, APInex.bond Live Wallet/Quota, and BeatAPI.io Usage & Concurrency Control.',
  },
  {
    id: 'infra-usage-ledger',
    code: '03',
    title: 'Real-Time Token & Call Ledger',
    myanmarTitle: 'အမှန်တကယ် သုံးစွဲမှု စာရင်းအသေးစိတ် (Zero-Fake Ledger)',
    category: 'infrastructure',
    description: 'Exact token consumption, latency, and auto-rotation audit trail per API request.',
  },
];
