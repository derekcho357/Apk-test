import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/layout/Header';
import { MobileBottomNav, Sidebar } from './components/layout/Sidebar';
import { ProviderDashboard } from './components/providers/ProviderDashboard';
import { UsageLedgerView } from './components/providers/UsageLedgerView';
import { WorkspaceSectionId } from './config/toolsRegistry';
import { VideoSubtitleStudio } from './tools/video-subtitle-studio/VideoSubtitleStudio';
import {
  ProviderId,
  ProvidersSystemSnapshot,
  StrictModelId,
} from './types/studio';
import {
  autoRestoreKeysToBackendIfNeeded,
  saveLocalKeysBackup,
} from './utils/keyStorage';

export default function App() {
  const [activeSection, setActiveSection] = useState<WorkspaceSectionId>(
    'tool-18plus-subtitle-studio'
  );
  const [snapshot, setSnapshot] = useState<ProvidersSystemSnapshot | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const hasRestoredKeysRef = useRef(false);

  const fetchLiveState = useCallback(async () => {
    try {
      const resp = await fetch('/api/providers/state');
      if (resp.ok) {
        const data: ProvidersSystemSnapshot = await resp.json();
        if (!hasRestoredKeysRef.current) {
          hasRestoredKeysRef.current = true;
          const restored = await autoRestoreKeysToBackendIfNeeded(data);
          setSnapshot(restored ?? data);
        } else {
          setSnapshot(data);
        }
      }
    } catch {
      // Keep last known snapshot on transient network hiccup
    }
  }, []);

  useEffect(() => {
    fetchLiveState();
    const timer = setInterval(fetchLiveState, 4000);
    return () => clearInterval(timer);
  }, [fetchLiveState]);

  const handleSyncAllBalances = async () => {
    setIsSyncing(true);
    try {
      const resp = await fetch('/api/providers/sync-all', {
        method: 'POST',
      });
      if (resp.ok) {
        const data: ProvidersSystemSnapshot = await resp.json();
        setSnapshot(data);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleQuickSwitchModel = async (strictModel: StrictModelId) => {
    saveLocalKeysBackup({ strictModel });
    const resp = await fetch('/api/providers/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strictModel }),
    });
    if (resp.ok) {
      const data: ProvidersSystemSnapshot = await resp.json();
      setSnapshot(data);
    }
  };

  const handleQuickSwitchProvider = async (activeProvider: ProviderId) => {
    saveLocalKeysBackup({ activeProvider });
    const resp = await fetch('/api/providers/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProvider }),
    });
    if (resp.ok) {
      const data: ProvidersSystemSnapshot = await resp.json();
      setSnapshot(data);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F6FB] text-slate-900 flex flex-col">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        snapshot={snapshot}
        onQuickSwitchModel={handleQuickSwitchModel}
        onQuickSwitchProvider={handleQuickSwitchProvider}
        mobileDrawerOpen={mobileDrawerOpen}
        onCloseMobileDrawer={() => setMobileDrawerOpen(false)}
      />

      <Header
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        snapshot={snapshot}
        isSyncing={isSyncing}
        onSyncAllBalances={handleSyncAllBalances}
        onOpenMobileDrawer={() => setMobileDrawerOpen(true)}
      />

      <main className="flex-1 w-full pb-20 md:pb-10">
        <div
          className={
            activeSection === 'tool-18plus-subtitle-studio' ? 'block' : 'hidden'
          }
        >
          <VideoSubtitleStudio
            snapshot={snapshot}
            onRefreshSnapshot={setSnapshot}
            onSwitchModel={handleQuickSwitchModel}
            onSwitchProvider={handleQuickSwitchProvider}
            onOpenGatewaySettings={() => setActiveSection('infra-gateway-manager')}
          />
        </div>

        {activeSection === 'infra-gateway-manager' && (
          <ProviderDashboard
            snapshot={snapshot}
            onRefreshSnapshot={setSnapshot}
          />
        )}

        {activeSection === 'infra-usage-ledger' && (
          <UsageLedgerView
            snapshot={snapshot}
            onRefreshSnapshot={setSnapshot}
          />
        )}
      </main>

      <MobileBottomNav
        activeSection={activeSection}
        onSelectSection={setActiveSection}
      />
    </div>
  );
}
