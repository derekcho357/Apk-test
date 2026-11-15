import { ProviderId, ProvidersSystemSnapshot, StrictModelId } from '../types/studio';

const LOCAL_STORAGE_KEY = 'kstudio_persistent_keys_v1';

export interface LocalSavedKeysBackup {
  activeProvider?: ProviderId;
  strictModel?: StrictModelId;
  aistudioAutoRotate?: boolean;
  aistudioActiveSlotIndex?: number;
  apinexKey?: string;
  beatapiKey?: string;
  aiStudioRuntimeSlots?: Array<{
    label: string;
    key: string;
  }>;
}

export function loadLocalKeysBackup(): LocalSavedKeysBackup {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as LocalSavedKeysBackup;
  } catch {
    return {};
  }
}

export function saveLocalKeysBackup(patch: Partial<LocalSavedKeysBackup>): void {
  try {
    const current = loadLocalKeysBackup();
    const updated: LocalSavedKeysBackup = {
      ...current,
      ...patch,
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
}

export function addLocalAiStudioSlotBackup(label: string, key: string): void {
  const current = loadLocalKeysBackup();
  const list = current.aiStudioRuntimeSlots ?? [];
  if (list.some((s) => s.key === key)) return;
  saveLocalKeysBackup({
    aiStudioRuntimeSlots: [...list, { label: label || `Slot #${list.length + 2}`, key }],
  });
}

export function syncAllLocalAiStudioSlotsBackup(
  slots: Array<{ label: string; rawKey?: string; source?: string }>
): void {
  const runtimeSlots = slots
    .filter((s) => s.rawKey && s.source === 'runtime_slot')
    .map((s) => ({ label: s.label, key: s.rawKey! }));
  saveLocalKeysBackup({ aiStudioRuntimeSlots: runtimeSlots });
}

/**
 * If the backend server restarted in a fresh container and lost its in-memory/disk keys,
 * automatically restore them from browser localStorage so the user never has to re-type keys.
 */
export async function autoRestoreKeysToBackendIfNeeded(
  snapshot: ProvidersSystemSnapshot
): Promise<ProvidersSystemSnapshot | null> {
  const backup = loadLocalKeysBackup();
  let latestSnapshot: ProvidersSystemSnapshot | null = null;

  // 1. Restore apinex.bond key if saved in browser but missing on backend
  if (backup.apinexKey && !snapshot.apinex.configured) {
    try {
      const resp = await fetch('/api/providers/apinex/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: backup.apinexKey,
          syncNow: true,
        }),
      });
      if (resp.ok) {
        latestSnapshot = await resp.json();
      }
    } catch {
      // Ignore network error
    }
  }

  // 2. Restore beatapi.io key if saved in browser but missing on backend
  if (backup.beatapiKey && !snapshot.beatapi.configured) {
    try {
      const resp = await fetch('/api/providers/beatapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: backup.beatapiKey,
          syncNow: true,
        }),
      });
      if (resp.ok) {
        latestSnapshot = await resp.json();
      }
    } catch {
      // Ignore network error
    }
  }

  // 3. Restore additional AI Studio runtime slots if saved in browser
  if (
    backup.aiStudioRuntimeSlots &&
    backup.aiStudioRuntimeSlots.length > 0 &&
    snapshot.aistudio.slots.filter((s) => s.source === 'runtime_slot').length === 0
  ) {
    for (const slot of backup.aiStudioRuntimeSlots) {
      try {
        const resp = await fetch('/api/providers/aistudio/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addSlotKey: slot.key,
            addSlotLabel: slot.label,
          }),
        });
        if (resp.ok) {
          latestSnapshot = await resp.json();
        }
      } catch {
        // Ignore
      }
    }
  }

  // 4. Restore AI Studio autoRotateEnabled & activeSlotIndex if saved
  if (
    typeof backup.aistudioAutoRotate === 'boolean' ||
    typeof backup.aistudioActiveSlotIndex === 'number'
  ) {
    try {
      const resp = await fetch('/api/providers/aistudio/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoRotateEnabled: backup.aistudioAutoRotate,
          activeSlotIndex: backup.aistudioActiveSlotIndex,
        }),
      });
      if (resp.ok) {
        latestSnapshot = await resp.json();
      }
    } catch {
      // Ignore
    }
  }

  // 5. Restore saved activeProvider & strictModel selection so it never resets
  if (
    (backup.activeProvider && backup.activeProvider !== snapshot.activeProvider) ||
    (backup.strictModel && backup.strictModel !== snapshot.strictModel)
  ) {
    try {
      const resp = await fetch('/api/providers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeProvider: backup.activeProvider,
          strictModel: backup.strictModel,
        }),
      });
      if (resp.ok) {
        latestSnapshot = await resp.json();
      }
    } catch {
      // Ignore
    }
  }

  return latestSnapshot;
}
