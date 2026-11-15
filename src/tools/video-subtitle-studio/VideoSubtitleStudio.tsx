import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Upload,
  Play,
  Pause,
  CheckCircle2,
  AlertTriangle,
  Download,
  Sparkles,
  Trash2,
  Plus,
  RefreshCw,
  Volume2,
  FileAudio,
  Languages,
  Check,
  Repeat,
  Scissors,
  Merge,
  Copy,
  FileText,
  Subtitles,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCw,
  Eye,
  Film,
  Sliders,
  History,
  Smartphone,
  Monitor,
  Clock,
  Crosshair,
  X,
  ArrowUp,
  ArrowDown,
  Undo2,
  MoveVertical,
} from 'lucide-react';
import {
  ProviderId,
  ProvidersSystemSnapshot,
  StrictModelId,
  SubtitleCue,
  TranscribeChunkResult,
  TranslateBatchResult,
  STRICT_MODELS,
} from '../../types/studio';
import {
  extractAudioChunksFromMediaFile,
  createVideoChunkSheetSampler,
  ExtractedAudioChunk,
  DetectedHardsubBox,
  ExtractionProgressUpdate,
  findFrameSubtitleBandYPercent,
} from './audioExtractor';
import {
  exportToSrt,
  exportToVtt,
  exportToPlainText,
  formatTimestampDisplay,
} from './subtitleFormatter';
import {
  VideoRenderSettings,
  DEFAULT_VIDEO_RENDER_SETTINGS,
  renderCompositedVideoFrame,
  computeBlurRectPixels,
  generateSubtitleOverlayPngBase64,
} from './videoCompositor';

interface VideoSubtitleStudioProps {
  snapshot: ProvidersSystemSnapshot | null;
  onRefreshSnapshot: React.Dispatch<React.SetStateAction<ProvidersSystemSnapshot | null>>;
  onSwitchModel: (strictModel: StrictModelId) => Promise<void>;
  onSwitchProvider?: (activeProvider: ProviderId) => Promise<void>;
  onOpenGatewaySettings: () => void;
}

export interface SavedHistoryProject {
  id: string;
  fileName: string;
  fileSizeMb: string;
  durationSec: number;
  aspectLabel: string;
  savedAtIso: string;
  targetLanguage: string;
  cues: SubtitleCue[];
  renderSettings: VideoRenderSettings;
  totalTokensUsed: number;
}

interface LiveJobProgress {
  active: boolean;
  percent: number;
  stageTitle: string;
  detailText: string;
  startedAtMs: number;
  etaSeconds: number | null;
}

const ACTIVE_DRAFT_STORAGE_KEY = 'kstudio_active_draft_v2';
const PROJECT_HISTORY_STORAGE_KEY = 'kstudio_project_history_v2';

const TARGET_LANGUAGES = [
  { code: 'Burmese (မြန်မာဘာသာ - သဘာဝကျသော စကားပြောဟန်)', label: 'မြန်မာဘာသာ' },
  { code: 'English', label: 'English' },
  { code: 'Thai', label: 'ထိုင်း (TH)' },
  { code: 'Chinese (Simplified)', label: 'တရုတ် (CN)' },
  { code: 'Japanese', label: 'ဂျပန် (JP)' },
  { code: 'Korean', label: 'ကိုရီးယား (KR)' },
];

const TEXT_COLOR_PRESETS = [
  { color: '#FACC15', label: 'ရွှေဝါ' },
  { color: '#FFFFFF', label: 'အဖြူ' },
  { color: '#38BDF8', label: 'အပြာနု' },
  { color: '#4ADE80', label: 'အစိမ်းနု' },
];

type WorkspaceTab = 'all' | 'transcribe' | 'translate' | 'export';
type PreviewAspectMode = 'auto' | '9:16' | '16:9' | 'theater' | 'compact';

function formatElapsedSec(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const VideoSubtitleStudio: React.FC<VideoSubtitleStudioProps> = ({
  snapshot,
  onRefreshSnapshot,
  onSwitchModel,
  onSwitchProvider,
}) => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [lastFileName, setLastFileName] = useState<string>('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ w: number; h: number }>({
    w: 1280,
    h: 720,
  });
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [previewAspectMode, setPreviewAspectMode] = useState<PreviewAspectMode>('auto');

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('all');
  const [scriptViewMode, setScriptViewMode] = useState<'cards' | 'paragraph'>('cards');
  const [expandedTimingCueId, setExpandedTimingCueId] = useState<string | null>(null);

  const [targetLanguage, setTargetLanguage] = useState<string>(TARGET_LANGUAGES[0].code);
  const [contextHint, setContextHint] = useState<string>('');
  const [showContextBox, setShowContextBox] = useState<boolean>(false);

  // WYSIWYG Canvas Render Settings (Hardsub Blur + Outlined Burmese Subtitle without Black Box)
  const [renderSettings, setRenderSettings] = useState<VideoRenderSettings>(
    DEFAULT_VIDEO_RENDER_SETTINGS
  );
  const [, setDetectedHardsub] = useState<DetectedHardsubBox | null>(null);
  const [showVisualControls, setShowVisualControls] = useState<boolean>(false);
  const [positionScope, setPositionScope] = useState<'all' | 'current'>('all');

  // Auto-follow is OFF by default so checking/editing subtitles never yanks the scroll position!
  const [autoFollowPlayback, setAutoFollowPlayback] = useState<boolean>(false);
  const [loopActiveCue, setLoopActiveCue] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Stage 1, 2, 3 State + Detailed Real-Time Progress Dashboard
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [, setChunksTotal] = useState<number>(0);
  const [, setChunksCompleted] = useState<number>(0);

  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [, setTranslateBatchesTotal] = useState<number>(0);
  const [, setTranslateBatchesCompleted] = useState<number>(0);

  const [isExportingVideo, setIsExportingVideo] = useState<boolean>(false);
  const [exportedMp4Url, setExportedMp4Url] = useState<string | null>(null);

  const [jobProgress, setJobProgress] = useState<LiveJobProgress>({
    active: false,
    percent: 0,
    stageTitle: '',
    detailText: '',
    startedAtMs: 0,
    etaSeconds: null,
  });
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [sessionTokensUsed, setSessionTokensUsed] = useState<number>(0);

  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [undoCueStack, setUndoCueStack] = useState<SubtitleCue[][]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [, setStatusLog] = useState<string[]>([]);

  // Persistent History Drawer State
  const [historyItems, setHistoryItems] = useState<SavedHistoryProject[]>([]);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<boolean>(false);
  const cueListContainerRef = useRef<HTMLDivElement | null>(null);
  const cueRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const guideTimeoutRef = useRef<number | null>(null);

  const dragStateRef = useRef<{
    isDown: boolean;
    startY: number;
    startSubY: number;
    moved: boolean;
  }>({
    isDown: false,
    startY: 0,
    startSubY: 56,
    moved: false,
  });

  const pushUndoSnapshot = useCallback((currentCues: SubtitleCue[]) => {
    setUndoCueStack((prev) => [...prev.slice(-12), currentCues]);
  }, []);

  const handleUndoCueChange = () => {
    setUndoCueStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setCues(last);
      return prev.slice(0, -1);
    });
  };

  // 1. Load saved draft & project history on mount so work is NEVER lost
  useEffect(() => {
    try {
      const rawHistory = localStorage.getItem(PROJECT_HISTORY_STORAGE_KEY);
      if (rawHistory) {
        const parsed = JSON.parse(rawHistory);
        if (Array.isArray(parsed)) {
          setHistoryItems(parsed);
        }
      }
    } catch {
      // ignore storage errors
    }

    try {
      const rawDraft = localStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);
      if (rawDraft) {
        const draft = JSON.parse(rawDraft);
        if (draft && Array.isArray(draft.cues) && draft.cues.length > 0) {
          setCues(draft.cues);
          if (draft.renderSettings) {
            const savedSubY = draft.renderSettings.subYPercent ?? 56;
            // If an old draft had subYPercent stuck at 83% (from the 黄果短剧 watermark), reset to 56%
            const sanitizedY = savedSubY >= 80 && savedSubY <= 86 ? 56 : savedSubY;
            setRenderSettings({
              ...DEFAULT_VIDEO_RENDER_SETTINGS,
              ...draft.renderSettings,
              subYPercent: sanitizedY,
              blurYPercent: sanitizedY,
            });
          }
          if (draft.targetLanguage) setTargetLanguage(draft.targetLanguage);
          if (draft.contextHint) setContextHint(draft.contextHint);
          if (draft.lastFileName) setLastFileName(draft.lastFileName);
          if (draft.videoDuration) setVideoDuration(draft.videoDuration);
          if (draft.sessionTokensUsed) setSessionTokensUsed(draft.sessionTokensUsed);
        }
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  // 2. Auto-save active draft whenever cues or settings change
  useEffect(() => {
    if (cues.length === 0) return;
    try {
      const payload = {
        lastFileName: videoFile?.name || lastFileName || 'Untitled_Video',
        videoDuration,
        targetLanguage,
        contextHint,
        renderSettings,
        cues,
        sessionTokensUsed,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore quota errors
    }
  }, [
    cues,
    renderSettings,
    targetLanguage,
    contextHint,
    videoFile,
    lastFileName,
    videoDuration,
    sessionTokensUsed,
  ]);

  const saveProjectToHistory = useCallback(
    (
      projectCues: SubtitleCue[],
      tokensUsed: number,
      customSettings?: VideoRenderSettings
    ) => {
      if (!projectCues || projectCues.length === 0) return;
      const fName = videoFile?.name || lastFileName || 'Video_Project.mp4';
      const fSizeMb = videoFile
        ? `${(videoFile.size / (1024 * 1024)).toFixed(1)} MB`
        : 'Saved';
      const isVert = videoNaturalSize.h > videoNaturalSize.w;
      const entry: SavedHistoryProject = {
        id: `proj_${fName}_${Date.now()}`,
        fileName: fName,
        fileSizeMb: fSizeMb,
        durationSec: videoDuration || projectCues[projectCues.length - 1]?.endSec || 0,
        aspectLabel: isVert ? '9:16 ဒေါင်လိုက်' : '16:9 အလျားလိုက်',
        savedAtIso: new Date().toISOString(),
        targetLanguage,
        cues: projectCues,
        renderSettings: customSettings || renderSettings,
        totalTokensUsed: tokensUsed,
      };

      setHistoryItems((prev) => {
        const filtered = prev.filter((item) => item.fileName !== fName);
        const updated = [entry, ...filtered].slice(0, 25);
        try {
          localStorage.setItem(PROJECT_HISTORY_STORAGE_KEY, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [videoFile, lastFileName, videoNaturalSize, videoDuration, targetLanguage, renderSettings]
  );

  useEffect(() => {
    if (!jobProgress.active || !jobProgress.startedAtMs) {
      return;
    }
    const updateClock = () => {
      const sec = Math.max(0, Math.floor((Date.now() - jobProgress.startedAtMs) / 1000));
      setElapsedSeconds(sec);
    };
    updateClock();
    const interval = window.setInterval(updateClock, 500);
    return () => window.clearInterval(interval);
  }, [jobProgress.active, jobProgress.startedAtMs]);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  const activeCue = useMemo(() => {
    return cues.find(
      (c) => currentTime >= c.startSec && currentTime <= c.endSec + 0.1
    );
  }, [cues, currentTime]);

  const isAudioOnlyFile = useMemo(() => {
    if (!videoFile) return false;
    return (
      videoFile.type.startsWith('audio/') ||
      /\.(mp3|m4a|wav|ogg|opus|aac|flac)$/i.test(videoFile.name)
    );
  }, [videoFile]);

  const isPortraitVideo = useMemo(() => {
    return videoNaturalSize.h > videoNaturalSize.w * 1.05;
  }, [videoNaturalSize]);

  const effectiveAspectMode = useMemo(() => {
    if (previewAspectMode === 'auto') {
      return isPortraitVideo ? '9:16' : '16:9';
    }
    return previewAspectMode;
  }, [previewAspectMode, isPortraitVideo]);

  const drawCurrentPreviewFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = previewCanvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderCompositedVideoFrame(ctx, video, activeCue, renderSettings, false);
  }, [activeCue, renderSettings]);

  useEffect(() => {
    drawCurrentPreviewFrame();
    if (!isPlaying) return;

    let rafId = 0;
    const tick = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
      drawCurrentPreviewFrame();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, drawCurrentPreviewFrame]);

  useEffect(() => {
    if (!loopActiveCue || !activeCue || !videoRef.current) return;
    if (currentTime >= activeCue.endSec - 0.05) {
      videoRef.current.currentTime = activeCue.startSec;
      videoRef.current.play().catch(() => {});
    }
  }, [currentTime, loopActiveCue, activeCue]);

  const scrollToActiveCueInList = useCallback(
    (cueId?: string) => {
      const targetId = cueId || activeCue?.id;
      if (!targetId) return;
      const container = cueListContainerRef.current;
      const rowEl = cueRowRefs.current[targetId];
      if (!container || !rowEl) return;

      const containerRect = container.getBoundingClientRect();
      const rowRect = rowEl.getBoundingClientRect();
      const offsetInside = rowRect.top - containerRect.top + container.scrollTop;
      const targetScrollTop = Math.max(0, offsetInside - container.clientHeight / 3);
      container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    },
    [activeCue?.id]
  );

  useEffect(() => {
    if (!autoFollowPlayback || !activeCue || !isPlaying) return;
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')
    ) {
      return;
    }
    scrollToActiveCueInList(activeCue.id);
  }, [activeCue?.id, autoFollowPlayback, isPlaying, scrollToActiveCueInList]);

  const updateRenderSetting = <K extends keyof VideoRenderSettings>(
    key: K,
    value: VideoRenderSettings[K],
    flashGuide = false
  ) => {
    setRenderSettings((prev) => ({
      ...prev,
      [key]: value,
      showBlurGuide: flashGuide ? true : prev.showBlurGuide,
    }));
    if (flashGuide) {
      if (guideTimeoutRef.current) window.clearTimeout(guideTimeoutRef.current);
      guideTimeoutRef.current = window.setTimeout(() => {
        setRenderSettings((prev) => ({ ...prev, showBlurGuide: false }));
      }, 1400);
    }
  };

  const adjustVerticalPosition = useCallback(
    (newYPercent: number, targetCueId?: string) => {
      const clamped = Math.max(12, Math.min(95, Math.round(newYPercent)));
      const effectiveTargetId =
        targetCueId || (positionScope === 'current' ? activeCue?.id : undefined);

      if (effectiveTargetId) {
        setCues((prev) =>
          prev.map((c) =>
            c.id === effectiveTargetId ? { ...c, customYPercent: clamped } : c
          )
        );
      } else {
        setRenderSettings((prev) => ({
          ...prev,
          blurYPercent: clamped,
          subYPercent: clamped,
          showBlurGuide: true,
        }));
        // Also clear per-cue overrides when user chooses "Move All" so all cues move together cleanly
        setCues((prev) => prev.map((c) => ({ ...c, customYPercent: undefined })));
      }

      if (guideTimeoutRef.current) window.clearTimeout(guideTimeoutRef.current);
      guideTimeoutRef.current = window.setTimeout(() => {
        setRenderSettings((prev) => ({ ...prev, showBlurGuide: false }));
      }, 1400);
    },
    [positionScope, activeCue?.id]
  );

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const currentEffectiveY =
      typeof activeCue?.customYPercent === 'number'
        ? activeCue.customYPercent
        : renderSettings.subYPercent;

    dragStateRef.current = {
      isDown: true,
      startY: e.clientY,
      startSubY: currentEffectiveY,
      moved: false,
    };
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStateRef.current.isDown) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const deltaPx = e.clientY - dragStateRef.current.startY;
    if (Math.abs(deltaPx) > 5) {
      dragStateRef.current.moved = true;
    }
    if (!dragStateRef.current.moved) return;

    const rect = canvas.getBoundingClientRect();
    const deltaPercent = (deltaPx / Math.max(100, rect.height)) * 100;
    const nextY = Math.max(
      12,
      Math.min(95, Math.round(dragStateRef.current.startSubY + deltaPercent))
    );
    adjustVerticalPosition(nextY);
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStateRef.current.isDown) return;
    const wasMoved = dragStateRef.current.moved;
    dragStateRef.current.isDown = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!wasMoved) {
      togglePlayPause();
    }
  };

  // Auto-detect hardcoded subtitle position on the current video frame (strictly ignores Y > 74% watermark in 9:16!)
  const detectCurrentFrameHardsubPosition = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const scanW = 320;
    const scanH = 320;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = scanW;
    tempCanvas.height = scanH;
    const ctx = tempCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const defaultY = isPortraitVideo ? 56 : 84;
    const detected = findFrameSubtitleBandYPercent(
      ctx,
      video,
      scanW,
      scanH,
      isPortraitVideo,
      defaultY
    );
    const detectedY = detected.yPercent;

    if (positionScope === 'current' && activeCue) {
      setCues((prev) =>
        prev.map((c) =>
          c.id === activeCue.id ? { ...c, customYPercent: detectedY } : c
        )
      );
    } else {
      setRenderSettings((prev) => ({
        ...prev,
        blurHardsub: true,
        blurYPercent: detectedY,
        subYPercent: detectedY,
        showBlurGuide: true,
      }));
      setCues((prev) => prev.map((c) => ({ ...c, customYPercent: undefined })));
    }

    setDetectedHardsub({
      hasHardsub: true,
      yPercent: detectedY,
      heightPercent: renderSettings.blurHeightPercent,
      widthPercent: renderSettings.blurWidthPercent,
    });

    if (guideTimeoutRef.current) window.clearTimeout(guideTimeoutRef.current);
    guideTimeoutRef.current = window.setTimeout(() => {
      setRenderSettings((prev) => ({ ...prev, showBlurGuide: false }));
    }, 1800);
  }, [
    isPortraitVideo,
    positionScope,
    activeCue,
    renderSettings.blurHeightPercent,
    renderSettings.blurWidthPercent,
  ]);

  const copyText = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    if (cues.length > 0) {
      saveProjectToHistory(cues, sessionTokensUsed);
    }

    const url = URL.createObjectURL(file);
    setVideoFile(file);
    setLastFileName(file.name);
    setVideoUrl(url);
    setCues([]);
    setUndoCueStack([]);
    setSessionTokensUsed(0);
    setDetectedHardsub(null);
    setExportedMp4Url(null);
    setErrorBanner(null);
    setStatusLog([
      `ဖိုင်အသစ် ရွေးချယ်ပြီးပါပြီ: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`,
    ]);
  };

  const restoreProjectFromHistory = (project: SavedHistoryProject) => {
    setCues(project.cues);
    setRenderSettings({
      ...DEFAULT_VIDEO_RENDER_SETTINGS,
      ...project.renderSettings,
    });
    setTargetLanguage(project.targetLanguage);
    setLastFileName(project.fileName);
    setSessionTokensUsed(project.totalTokensUsed || 0);
    setShowHistoryDrawer(false);
  };

  const deleteHistoryProject = (id: string) => {
    setHistoryItems((prev) => {
      const next = prev.filter((item) => item.id !== id);
      try {
        localStorage.setItem(PROJECT_HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleStrictModelSwitch = async (modelId: StrictModelId) => {
    try {
      await onSwitchModel(modelId);
    } catch {
      // ignore
    }
  };

  const handleProviderSwitch = async (providerId: ProviderId) => {
    if (!onSwitchProvider) return;
    try {
      await onSwitchProvider(providerId);
    } catch {
      // ignore
    }
  };

  const seekToTime = (sec: number, autoPlay = false) => {
    if (!videoRef.current) return;
    const safeSec = Math.max(0, sec);
    videoRef.current.currentTime = safeSec;
    setCurrentTime(safeSec);
    if (autoPlay) {
      videoRef.current.play().catch(() => {});
    } else {
      setTimeout(drawCurrentPreviewFrame, 40);
    }
  };

  const togglePlayPause = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  };

  // ============================================================================
  // 1-CLICK SMART CLEANUP & AUTO-SPLIT FOR MERGED SHORT-DRAMA SUBTITLES
  // Splits on BOTH punctuation AND spaces (e.g. "把裤子也脱了 小穴给我看" -> 2 cues,
  // and joins vocatives like "妈 把衣服脱了可以吗" -> "妈把衣服脱了可以吗")
  // ============================================================================
  const autoCleanAndSplitMergedCues = useCallback(() => {
    if (cues.length === 0) return;
    pushUndoSnapshot(cues);

    const nextCues: SubtitleCue[] = [];
    for (const cue of cues) {
      const cleanedOrig = (cue.originalText || '')
        .replace(/[。．]+$/g, '')
        .replace(/^([\u4e00-\u9fff]{1,2})[\s，,]+([\u4e00-\u9fff0-9]{2,})$/g, '$1$2')
        .trim();
      const cleanedTrans = (cue.translatedText || '')
        .replace(/[。．]+$/g, '')
        .trim();

      const isPureCjkLine =
        /[\u4e00-\u9fff]/.test(cleanedOrig) && !/[A-Za-z]{2,}/.test(cleanedOrig);

      const rawParts = (
        isPureCjkLine
          ? cleanedOrig.split(/[，,；;。！？!?\s]+/)
          : cleanedOrig.split(/[；;。！？!?]+/)
      )
        .map((s) => s.trim())
        .filter(Boolean);

      const cjkParts: string[] = [];
      for (let i = 0; i < rawParts.length; i++) {
        const cur = rawParts[i];
        if (
          isPureCjkLine &&
          i === 0 &&
          Array.from(cur).length <= 2 &&
          /[\u4e00-\u9fff]/.test(cur) &&
          rawParts.length >= 2
        ) {
          rawParts[i + 1] = `${cur}${rawParts[i + 1]}`;
        } else {
          cjkParts.push(cur);
        }
      }

      const transParts = cleanedTrans
        ? cleanedTrans
            .split(/[၊။，,]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      // Also sanitize any cue customYPercent that was stuck at 83% watermark
      const safeCustomY =
        typeof cue.customYPercent === 'number' &&
        cue.customYPercent >= 80 &&
        cue.customYPercent <= 86 &&
        isPortraitVideo
          ? undefined
          : cue.customYPercent;

      const shouldSplit =
        isPureCjkLine &&
        cjkParts.length >= 2 &&
        cjkParts.every((p) => Array.from(p).length >= 3) &&
        cue.endSec - cue.startSec >= 1.0;

      if (shouldSplit) {
        const totalChars = Math.max(
          1,
          cjkParts.reduce((acc, p) => acc + Array.from(p).length, 0)
        );
        const totalDur = cue.endSec - cue.startSec;
        let cursor = cue.startSec;

        cjkParts.forEach((part, idx) => {
          const ratio = Array.from(part).length / totalChars;
          const partEnd =
            idx === cjkParts.length - 1
              ? cue.endSec
              : Number(
                  Math.min(
                    cue.endSec - 0.15,
                    cursor + Math.max(0.45, totalDur * ratio)
                  ).toFixed(2)
                );
          nextCues.push({
            ...cue,
            id: `${cue.id}_sp_${idx}_${Date.now()}`,
            startSec: Number(cursor.toFixed(2)),
            endSec: partEnd,
            originalText: part,
            customYPercent: safeCustomY,
            translatedText:
              transParts.length === cjkParts.length
                ? transParts[idx]
                : idx === 0
                ? cleanedTrans
                : '',
          });
          cursor = partEnd;
        });
      } else {
        nextCues.push({
          ...cue,
          originalText: isPureCjkLine ? cjkParts[0] || cleanedOrig : cleanedOrig,
          translatedText: cleanedTrans,
          customYPercent: safeCustomY,
        });
      }
    }

    const reindexed = nextCues
      .sort((a, b) => a.startSec - b.startSec)
      .map((c, i) => ({ ...c, index: i + 1 }));
    setCues(reindexed);
  }, [cues, pushUndoSnapshot, isPortraitVideo]);

  // ============================================================================
  // STEP 1: DUAL VISION (HARDSUB OCR) + ACOUSTIC AUDIO TRANSCRIPTION
  // ============================================================================
  const startStep1Transcription = async () => {
    if (!videoFile) {
      setErrorBanner('ကျေးဇူးပြု၍ ဗီဒီယို သို့မဟုတ် အသံဖိုင် အရင်ရွေးချယ်ပါ။');
      return;
    }

    const startTimeMs = Date.now();
    abortRef.current = false;
    setErrorBanner(null);
    setIsExtracting(true);
    setCues([]);
    setSessionTokensUsed(0);
    updateRenderSetting('overlayMode', 'original');
    setWorkspaceTab('all');

    const rawModel = snapshot?.strictModel || 'gemini-3.1-pro';
    const activeModel =
      rawModel === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro' : rawModel;
    const activeProv = snapshot?.activeProvider || 'aistudio';

    setJobProgress({
      active: true,
      percent: 2,
      stageTitle: `အဆင့် ၁/၂ — ဗီဒီယို စာတန်းထိုးနေရာ နှင့် အသံလှိုင်းများ စစ်ဆေးနေသည် (${activeModel})`,
      detailText: 'မူရင်း ဗီဒီယို/အသံဖိုင်ကို စတင်ဖတ်ရှုနေသည်...',
      startedAtMs: startTimeMs,
      etaSeconds: null,
    });

    let chunks: ExtractedAudioChunk[] = [];
    let autoBox: DetectedHardsubBox = {
      hasHardsub: false,
      yPercent: isPortraitVideo ? 56 : 84,
      heightPercent: 11,
      widthPercent: 90,
    };

    try {
      const extracted = await extractAudioChunksFromMediaFile(
        videoFile,
        (update: ExtractionProgressUpdate) => {
          const scaledPercent = Math.max(2, Math.min(28, Math.round(update.percent * 0.28)));
          const elapsedSec = (Date.now() - startTimeMs) / 1000;
          const estimatedTotalSec =
            scaledPercent > 4 ? (elapsedSec / scaledPercent) * 100 : null;
          const eta =
            estimatedTotalSec !== null
              ? Math.max(2, Math.round(estimatedTotalSec - elapsedSec))
              : null;

          setJobProgress({
            active: true,
            percent: scaledPercent,
            stageTitle: update.stage,
            detailText: update.detail,
            startedAtMs: startTimeMs,
            etaSeconds: eta,
          });
        },
        activeProv
      );
      chunks = extracted.chunks;
      autoBox = extracted.detectedHardsubBox;
    } catch (err: any) {
      setIsExtracting(false);
      setJobProgress((prev) => ({ ...prev, active: false }));
      setErrorBanner(err?.message || 'အသံထုတ်ယူရာတွင် အမှားဖြစ်ပွားခဲ့ပါသည်။');
      return;
    }

    let updatedSettings = renderSettings;
    if (autoBox && autoBox.hasHardsub) {
      setDetectedHardsub(autoBox);
      updatedSettings = {
        ...renderSettings,
        blurHardsub: true,
        blurYPercent: autoBox.yPercent,
        subYPercent: autoBox.yPercent,
        blurHeightPercent: autoBox.heightPercent,
        blurWidthPercent: autoBox.widthPercent,
      };
      setRenderSettings(updatedSettings);
    } else {
      setDetectedHardsub(null);
      updatedSettings = {
        ...renderSettings,
        blurHardsub: false,
      };
      setRenderSettings(updatedSettings);
    }

    setIsExtracting(false);
    setChunksTotal(chunks.length);
    setChunksCompleted(0);
    setIsTranscribing(true);

    let accumulatedCues: SubtitleCue[] = [];
    let runningTokens = 0;
    const chunkProcessingStartMs = Date.now();
    const transcriptionJobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const needsClientSheetSampler = chunks.some(
      (c) => c.visualFrames.length === 0 && c.safeVisualFrames.length === 0
    );
    const sheetSampler = needsClientSheetSampler
      ? await createVideoChunkSheetSampler(videoFile)
      : null;

    // Serialize HTML5 <video> seeking if client fallback is used, while allowing 4 parallel AI macro-sheet workers!
    let captureChain = Promise.resolve();
    const captureSheetsSerial = (chunk: ExtractedAudioChunk) => {
      if (chunk.visualFrames.length > 0 || chunk.safeVisualFrames.length > 0) {
        return Promise.resolve({
          visualFrames: chunk.visualFrames,
          safeVisualFrames: chunk.safeVisualFrames,
        });
      }
      const next = captureChain.then(async () => {
        if (abortRef.current || !sheetSampler) {
          return {
            visualFrames: chunk.visualFrames,
            safeVisualFrames: chunk.safeVisualFrames,
          };
        }
        return sheetSampler.captureChunkSheets(chunk.startSec, chunk.endSec);
      });
      captureChain = next.then(
        () => {},
        () => {}
      );
      return next;
    };

    const chunkCuesMap = new Map<number, SubtitleCue[]>();
    let completedCount = 0;
    let nextChunkIdx = 0;
    let fatalChunkError: string | null = null;

    const rebuildOrderedCues = (): SubtitleCue[] => {
      const orderedRaw: SubtitleCue[] = [];
      const sortedIndices = Array.from(chunkCuesMap.keys()).sort((a, b) => a - b);
      for (const cIdx of sortedIndices) {
        const list = chunkCuesMap.get(cIdx) || [];
        orderedRaw.push(...list);
      }
      orderedRaw.sort((a, b) => a.startSec - b.startSec);

      const normalizeCrossChunkKey = (txt: string) =>
        (txt || '')
          .replace(/[\s,，.。!！?？:：;；~～—\-'"“”‘’()（）\[\]【】「」『』*＊]/g, '')
          .toLowerCase();

      const dedupedAcrossChunks: SubtitleCue[] = [];
      for (const item of orderedRaw) {
        const normItem = normalizeCrossChunkKey(item.originalText);
        const prev = dedupedAcrossChunks[dedupedAcrossChunks.length - 1];
        if (prev && normItem) {
          const normPrev = normalizeCrossChunkKey(prev.originalText);
          const gapSec = item.startSec - prev.endSec;
          const isCrossChunk = prev.chunkIndex !== item.chunkIndex;
          if (
            (normPrev === normItem && gapSec <= 1.1) ||
            (isCrossChunk &&
              normPrev.length >= 3 &&
              normItem.length >= 3 &&
              Math.abs(normPrev.length - normItem.length) <= 2 &&
              (normPrev.includes(normItem) || normItem.includes(normPrev)) &&
              gapSec <= 0.65)
          ) {
            prev.endSec = Number(Math.max(prev.endSec, item.endSec).toFixed(2));
            if (item.originalText.length > prev.originalText.length) {
              prev.originalText = item.originalText;
            }
            continue;
          }
          if (prev.endSec > item.startSec) {
            prev.endSec = Number(
              Math.max(prev.startSec + 0.35, item.startSec - 0.04).toFixed(2)
            );
          }
        }
        dedupedAcrossChunks.push({ ...item });
      }

      return dedupedAcrossChunks.map((cue, idx) => ({
        ...cue,
        index: idx + 1,
      }));
    };

    const processSingleChunk = async (i: number) => {
      if (abortRef.current || fatalChunkError) return;
      const chunk = chunks[i];

      const captured = await captureSheetsSerial(chunk);
      if (abortRef.current || fatalChunkError) return;

      const chunkVisualFrames = captured.visualFrames;
      const chunkSafeVisualFrames = captured.safeVisualFrames;
      const hasSheetFrames =
        chunkVisualFrames.length > 0 || chunkSafeVisualFrames.length > 0;

      const basePercent =
        28 + Math.round((completedCount / Math.max(1, chunks.length)) * 70);
      const avgMsPerChunk =
        completedCount > 0
          ? (Date.now() - chunkProcessingStartMs) / completedCount
          : 7000;
      const etaSec = Math.max(
        2,
        Math.round(((chunks.length - completedCount) * avgMsPerChunk) / 1000)
      );

      setJobProgress({
        active: true,
        percent: basePercent,
        stageTitle: `အဆင့် ၂/၂ — AI Transcribe (${activeModel}) · အပိုင်း ${i + 1}/${chunks.length}`,
        detailText: `အပိုင်း (${i + 1}/${chunks.length}) [${formatTimestampDisplay(
          chunk.startSec
        )} → ${formatTimestampDisplay(
          chunk.endSec
        )}] ကို ${activeModel} (${activeProv.toUpperCase()}) ဖြင့် 100% ကွက်တိ Transcribe လုပ်နေသည်`,
        startedAtMs: startTimeMs,
        etaSeconds: etaSec,
      });

      const isArgon = activeModel === 'gemini-4-argon';
      // Send only the model-specific contact sheet to minimize upload bandwidth and enforce model separation
      const outboundVisualFrames = isArgon ? chunkVisualFrames : [];
      const outboundSafeFrames = isArgon
        ? chunkSafeVisualFrames
        : chunkSafeVisualFrames.length > 0
        ? chunkSafeVisualFrames
        : chunkVisualFrames;

      const res = await fetch('/api/subtitle/transcribe-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: transcriptionJobId,
          chunkIndex: chunk.chunkIndex,
          chunkStartSec: chunk.startSec,
          chunkDurationSec: chunk.durationSec,
          startSec: chunk.startSec,
          endSec: chunk.endSec,
          // Omit bulky audio WAV payload when visual contact sheets are present
          audioBase64: hasSheetFrames ? '' : chunk.audioBase64,
          mimeType: chunk.mimeType,
          sourceLanguage: 'Auto-Detect',
          hasHardsubInChunk: hasSheetFrames || chunk.hasHardsubInChunk,
          detectedCards: chunk.detectedCards,
          visualFrames: outboundVisualFrames,
          safeVisualFrames: outboundSafeFrames,
          contextHint,
          strictModelOverride: activeModel,
          providerOverride: activeProv,
          previousContextCues: [],
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.snapshot) onRefreshSnapshot(data.snapshot);
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const result = data as TranscribeChunkResult;
      if (result.snapshot) {
        onRefreshSnapshot(result.snapshot);
      }

      runningTokens += result.usage?.totalTokens || 0;
      setSessionTokensUsed(runningTokens);

      const timeline = chunk.frameYTimeline || [];
      const cuesWithSceneY = result.cues.map((cue) => {
        if (timeline.length === 0) return cue;
        const matchingPoints = timeline.filter(
          (pt) => pt.timeSec >= cue.startSec - 0.6 && pt.timeSec <= cue.endSec + 0.6
        );
        if (matchingPoints.length > 0) {
          const sortedY = matchingPoints.map((p) => p.yPercent).sort((a, b) => a - b);
          const medianY = sortedY[Math.floor(sortedY.length / 2)];
          return { ...cue, customYPercent: medianY };
        }
        return cue;
      });

      chunkCuesMap.set(chunk.chunkIndex, cuesWithSceneY);
      completedCount += 1;
      accumulatedCues = rebuildOrderedCues();

      setCues(accumulatedCues);
      setChunksCompleted(completedCount);

      const donePercent =
        28 + Math.round((completedCount / Math.max(1, chunks.length)) * 72);
      const avgMs = (Date.now() - chunkProcessingStartMs) / completedCount;
      const nextEta =
        completedCount < chunks.length
          ? Math.max(1, Math.round(((chunks.length - completedCount) * avgMs) / 1000))
          : 0;

      setJobProgress({
        active: true,
        percent: Math.min(100, donePercent),
        stageTitle: `အဆင့် ၂/၂ — အပိုင်း (${completedCount}/${chunks.length}) ပြီးစီးပါပြီ (${result.modelUsed})`,
        detailText: `စာကြောင်း (${accumulatedCues.length}) ကြောင်း ရရှိထားပါသည် · စုစုပေါင်း ${runningTokens.toLocaleString()} tokens`,
        startedAtMs: startTimeMs,
        etaSeconds: nextEta,
      });
    };

    try {
      // Run up to 4 macro-sheet chunks in parallel so all 4 sheets finish in ~15-28 seconds
      const workerCount = Math.min(4, Math.max(1, chunks.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIdx < chunks.length && !abortRef.current && !fatalChunkError) {
          const targetIdx = nextChunkIdx++;
          try {
            await processSingleChunk(targetIdx);
          } catch (err: any) {
            fatalChunkError = `အပိုင်း #${targetIdx + 1} Transcribe အမှား: ${
              err?.message || 'မသိသော အမှား'
            }`;
            setErrorBanner(fatalChunkError);
            break;
          }
        }
      });
      await Promise.all(workers);
    } finally {
      sheetSampler?.dispose();
    }

    setIsTranscribing(false);
    setJobProgress((prev) => ({
      ...prev,
      active: false,
      percent: 100,
      etaSeconds: 0,
    }));

    if (accumulatedCues.length > 0) {
      saveProjectToHistory(accumulatedCues, runningTokens, updatedSettings);
    }
  };

  /**
   * Smart Burmese Reading-Time Duration Sync:
   * When a short original subtitle card (e.g. 0.8s) is translated into Burmese,
   * smoothly extends `endSec` into any available silent gap before `nextCue.startSec - 0.06s`
   * so the viewer can comfortably finish reading the Burmese subtitle before it disappears,
   * while NEVER overlapping the next subtitle card!
   */
  const syncBurmeseReadingDurations = useCallback(
    (inputCues: SubtitleCue[]): SubtitleCue[] => {
      const sorted = [...inputCues].sort((a, b) => a.startSec - b.startSec);
      return sorted.map((cue, idx) => {
        const trans = (cue.translatedText || '').trim();
        if (!trans) return cue;
        const charCount = trans.length;
        const idealReadDur = Math.min(4.2, Math.max(1.35, charCount * 0.056));
        const currentDur = cue.endSec - cue.startSec;
        if (currentDur >= idealReadDur) return cue;

        const nextCue = sorted[idx + 1];
        const maxAllowedEnd = nextCue
          ? Math.max(cue.endSec, Number((nextCue.startSec - 0.06).toFixed(2)))
          : Math.min(
              videoDuration > 0 ? videoDuration : cue.endSec + 1.5,
              Number((cue.endSec + 1.5).toFixed(2))
            );

        const syncedEnd = Number(
          Math.max(
            cue.endSec,
            Math.min(maxAllowedEnd, cue.startSec + idealReadDur)
          ).toFixed(2)
        );
        return {
          ...cue,
          endSec: syncedEnd,
        };
      });
    },
    [videoDuration]
  );

  // ============================================================================
  // STEP 2: TRANSLATE VERIFIED TRANSCRIPT INTO BURMESE / TARGET LANGUAGE
  // ============================================================================
  const startStep2Translation = async () => {
    if (cues.length === 0) {
      setErrorBanner('ဘာသာပြန်ရန် မူရင်း Transcribe စာကြောင်းများ မရှိသေးပါ။ အဆင့် (၁) ကို အရင်လုပ်ဆောင်ပါ။');
      return;
    }

    const startTimeMs = Date.now();
    abortRef.current = false;
    setErrorBanner(null);
    setIsTranslating(true);
    setWorkspaceTab('all');

    const rawModel = snapshot?.strictModel || 'gemini-3.1-pro';
    const activeModel =
      rawModel === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro' : rawModel;
    const activeProv = snapshot?.activeProvider || 'aistudio';

    const BATCH_SIZE = 30;
    const totalBatches = Math.ceil(cues.length / BATCH_SIZE);
    setTranslateBatchesTotal(totalBatches);
    setTranslateBatchesCompleted(0);

    setJobProgress({
      active: true,
      percent: 5,
      stageTitle: `အဆင့် (၂) — မြန်မာဘာသာပြန်နေသည် (${activeModel})`,
      detailText: `စာကြောင်း (${cues.length}) ကြောင်းကို သဘာဝကျသော စကားပြောဟန်ဖြင့် ဘာသာပြန်နေသည်...`,
      startedAtMs: startTimeMs,
      etaSeconds: totalBatches * 4,
    });

    setCues((prev) =>
      prev.map((c) => ({ ...c, translationStatus: 'translating' }))
    );

    let runningCues = [...cues];
    let runningTokens = sessionTokensUsed;

    for (let b = 0; b < totalBatches; b++) {
      if (abortRef.current) {
        break;
      }

      const slice = runningCues.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const startPercent = Math.max(8, Math.round((b / Math.max(1, totalBatches)) * 100));
      const avgMs = b > 0 ? (Date.now() - startTimeMs) / b : 4000;
      const etaSec = Math.max(1, Math.round(((totalBatches - b) * avgMs) / 1000));

      setJobProgress({
        active: true,
        percent: startPercent,
        stageTitle: `အဆင့် (၂) — ဘာသာပြန်နေသည် (${activeModel} · အပိုင်း ${b + 1}/${totalBatches})`,
        detailText: `စာကြောင်း #${slice[0]?.index || 1} မှ #${
          slice[slice.length - 1]?.index || slice.length
        } အထိ မြန်မာဘာသာပြန်နေသည်...`,
        startedAtMs: startTimeMs,
        etaSeconds: etaSec,
      });

      try {
        const res = await fetch('/api/subtitle/translate-cues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batchIndex: b,
            targetLanguage,
            contextHint,
            strictModelOverride: activeModel,
            providerOverride: activeProv,
            cues: slice.map((c) => ({
              id: c.id,
              index: c.index,
              startSec: c.startSec,
              endSec: c.endSec,
              speaker: c.speaker,
              originalText: c.originalText,
            })),
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          if (data.snapshot) onRefreshSnapshot(data.snapshot);
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        const result = data as TranslateBatchResult;
        if (result.snapshot) {
          onRefreshSnapshot(result.snapshot);
        }

        runningTokens += result.usage?.totalTokens || 0;
        setSessionTokensUsed(runningTokens);

        const transMap = new Map<string, string>();
        for (const item of result.translations) {
          if (item.id) transMap.set(item.id, item.translatedText);
          transMap.set(`idx_${item.index}`, item.translatedText);
        }

        runningCues = syncBurmeseReadingDurations(
          runningCues.map((cue) => {
            const matched =
              transMap.get(cue.id) ?? transMap.get(`idx_${cue.index}`);
            if (matched !== undefined) {
              return {
                ...cue,
                translatedText: matched,
                translationStatus: 'translated',
                translatedByModel: result.modelUsed,
              };
            }
            return cue;
          })
        );

        setCues(runningCues);
        setTranslateBatchesCompleted(b + 1);
        updateRenderSetting('overlayMode', 'translated');

        const donePercent = Math.round(((b + 1) / Math.max(1, totalBatches)) * 100);
        setJobProgress({
          active: true,
          percent: donePercent,
          stageTitle: `အဆင့် (၂) — ဘာသာပြန် အပိုင်း (${b + 1}/${totalBatches}) ပြီးစီး (${result.modelUsed})`,
          detailText: `စာကြောင်း (${runningCues.filter((c) => c.translatedText).length}/${
            runningCues.length
          }) ကြောင်း မြန်မာဘာသာပြန်ပြီးပါပြီ`,
          startedAtMs: startTimeMs,
          etaSeconds:
            b + 1 < totalBatches
              ? Math.max(1, Math.round(((totalBatches - (b + 1)) * avgMs) / 1000))
              : 0,
        });
      } catch (err: any) {
        setErrorBanner(
          `ဘာသာပြန် အပိုင်း #${b + 1} အမှား: ${err?.message || 'မသိသော အမှား'}`
        );
        break;
      }
    }

    setIsTranslating(false);
    setJobProgress((prev) => ({ ...prev, active: false, percent: 100, etaSeconds: 0 }));
    saveProjectToHistory(runningCues, runningTokens, {
      ...renderSettings,
      overlayMode: 'translated',
    });
  };

  // ============================================================================
  // STEP 3: EXPORT BURNED-IN MP4 VIDEO (100% WYSIWYG MATCH WITH PREVIEW CANVAS)
  // ============================================================================
  const handleExportBurnedInMp4 = async () => {
    if (!videoFile || isAudioOnlyFile) {
      setErrorBanner('ဗီဒီယိုဖိုင် ရွေးချယ်ထားမှသာ စာတန်းထိုးသွင်းပြီး MP4 ဗီဒီယို ထုတ်ယူနိုင်ပါမည်။');
      return;
    }
    if (cues.length === 0) {
      setErrorBanner('ဗီဒီယိုထဲသို့ စာတန်းထိုးသွင်းရန် စာကြောင်းများ မရှိသေးပါ။');
      return;
    }

    const startTimeMs = Date.now();
    setErrorBanner(null);
    setIsExportingVideo(true);
    setExportedMp4Url(null);

    try {
      const vw = videoNaturalSize.w || 1280;
      const vh = videoNaturalSize.h || 720;

      setJobProgress({
        active: true,
        percent: 15,
        stageTitle: 'အဆင့် (၃) — Preview အတိုင်း မြန်မာစာတန်းထိုး ဖရိမ်များ တည်ဆောက်နေသည်',
        detailText: `စာကြောင်း (${cues.length}) ကြောင်းအတွက် ကြည်လင်သော စာတန်းထိုးဖရိမ်များ ဆွဲနေသည်...`,
        startedAtMs: startTimeMs,
        etaSeconds: 12,
      });

      const blankPngBase64 = generateSubtitleOverlayPngBase64(
        vw,
        vh,
        null,
        renderSettings
      );

      const cueOverlays = cues.map((cue) => ({
        startSec: cue.startSec,
        endSec: cue.endSec,
        pngBase64: generateSubtitleOverlayPngBase64(
          vw,
          vh,
          cue,
          renderSettings
        ),
      }));

      setJobProgress({
        active: true,
        percent: 48,
        stageTitle: 'အဆင့် (၃) — မူရင်းစာတန်း ဝါးဖျောက်ခြင်း နှင့် မြန်မာစာတန်းထိုး MP4 ပေါင်းစပ်နေသည်',
        detailText: 'FFmpeg Video Engine ဖြင့် Preview အတိုင်း 100% တူညီသော MP4 ဗီဒီယို ထုတ်ယူနေသည်...',
        startedAtMs: startTimeMs,
        etaSeconds: 8,
      });

      const arrayBuffer = await videoFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(slice));
      }
      const videoBase64 = btoa(binary);

      const { bx, by, bw, bh } = computeBlurRectPixels(vw, vh, renderSettings);
      const extMatch = /\.([a-z0-9]+)$/i.exec(videoFile.name);
      const videoExt = extMatch ? extMatch[1].toLowerCase() : 'mp4';

      const res = await fetch('/api/subtitle/export-mp4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoBase64,
          videoExt,
          videoWidth: vw,
          videoHeight: vh,
          videoDuration: Math.max(1, videoDuration || 60),
          blurConfig: {
            enabled: renderSettings.blurHardsub,
            bx,
            by,
            bw,
            bh,
            blurStrength: renderSettings.blurStrength,
          },
          blankPngBase64,
          cueOverlays,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setExportedMp4Url(data.videoUrl);

      const a = document.createElement('a');
      const baseName = videoFile.name.replace(/\.[^/.]+$/, '');
      a.href = data.videoUrl;
      a.download = `${baseName}_subtitled.mp4`;
      a.click();
    } catch (err: any) {
      setErrorBanner(
        err?.message || 'MP4 ဗီဒီယို ထုတ်ယူရာတွင် အမှားဖြစ်ပွားခဲ့ပါသည်။'
      );
    } finally {
      setIsExportingVideo(false);
      setJobProgress((prev) => ({ ...prev, active: false, percent: 100, etaSeconds: 0 }));
    }
  };

  // ============================================================================
  // SUBTITLE CUE EDITING, TIMING SHIFT, SPLIT, MERGE, INSERT & DELETE HANDLERS
  // ============================================================================
  const handleCueChange = (
    id: string,
    field: keyof SubtitleCue,
    value: string | number | boolean | undefined
  ) => {
    setCues((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
  };

  const nudgeCueTiming = (
    id: string,
    field: 'startSec' | 'endSec' | 'both',
    deltaSec: number
  ) => {
    setCues((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (field === 'both') {
          const nextStart = Math.max(0, Number((c.startSec + deltaSec).toFixed(2)));
          const dur = Math.max(0.3, c.endSec - c.startSec);
          const nextEnd = Number((nextStart + dur).toFixed(2));
          seekToTime(nextStart, false);
          return { ...c, startSec: nextStart, endSec: nextEnd };
        }
        const nextVal = Math.max(0, Number((c[field] + deltaSec).toFixed(2)));
        if (field === 'startSec') {
          const safeEnd = Math.max(nextVal + 0.2, c.endSec);
          seekToTime(nextVal, false);
          return { ...c, startSec: nextVal, endSec: safeEnd };
        } else {
          const safeEnd = Math.max(c.startSec + 0.2, nextVal);
          return { ...c, endSec: safeEnd };
        }
      })
    );
  };

  const splitCueSmart = (id: string) => {
    pushUndoSnapshot(cues);
    setCues((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      const midSec = Number(((target.startSec + target.endSec) / 2).toFixed(2));
      if (midSec <= target.startSec + 0.15) return prev;

      const rawOrig = target.originalText.trim();
      let firstOrig = rawOrig;
      let secondOrig = '';

      const commaMatch = /^(.+?)[，,；;。！？!?]+(.+)$/.exec(rawOrig);
      if (commaMatch && commaMatch[1].trim() && commaMatch[2].trim()) {
        firstOrig = commaMatch[1].trim();
        secondOrig = commaMatch[2].trim().replace(/[。．]+$/g, '');
      } else if (rawOrig.includes(' ')) {
        const words = rawOrig.split(/\s+/);
        const half = Math.ceil(words.length / 2);
        firstOrig = words.slice(0, half).join(' ');
        secondOrig = words.slice(half).join(' ');
      } else {
        const chars = Array.from(rawOrig);
        const half = Math.ceil(chars.length / 2);
        firstOrig = chars.slice(0, half).join('');
        secondOrig = chars.slice(half).join('');
      }

      const rawTrans = (target.translatedText || '').trim();
      let firstTrans = rawTrans;
      let secondTrans = '';
      if (rawTrans) {
        const transParts = rawTrans
          .split(/[၊။，,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (transParts.length >= 2) {
          const halfT = Math.ceil(transParts.length / 2);
          firstTrans = transParts.slice(0, halfT).join(' ');
          secondTrans = transParts.slice(halfT).join(' ');
        }
      }

      const firstCue: SubtitleCue = {
        ...target,
        endSec: midSec,
        originalText: firstOrig,
        translatedText: firstTrans,
      };
      const secondCue: SubtitleCue = {
        ...target,
        id: `cue_split_${Date.now()}`,
        startSec: midSec,
        originalText: secondOrig || firstOrig,
        translatedText: secondTrans,
      };

      const next = [...prev];
      next.splice(idx, 1, firstCue, secondCue);
      return next.map((c, i) => ({ ...c, index: i + 1 }));
    });
  };

  const mergeWithNextCue = (id: string) => {
    pushUndoSnapshot(cues);
    setCues((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1 || idx >= prev.length - 1) return prev;
      const current = prev[idx];
      const nextCue = prev[idx + 1];

      const merged: SubtitleCue = {
        ...current,
        endSec: nextCue.endSec,
        originalText: `${current.originalText} ${nextCue.originalText}`.trim(),
        translatedText: `${current.translatedText || ''} ${
          nextCue.translatedText || ''
        }`.trim(),
      };

      const copy = [...prev];
      copy.splice(idx, 2, merged);
      return copy.map((c, i) => ({ ...c, index: i + 1 }));
    });
  };

  const deleteCue = (id: string) => {
    pushUndoSnapshot(cues);
    setCues((prev) =>
      prev
        .filter((c) => c.id !== id)
        .map((c, idx) => ({ ...c, index: idx + 1 }))
    );
  };

  const insertCueAfter = (afterCue?: SubtitleCue) => {
    pushUndoSnapshot(cues);
    const start = afterCue
      ? Number(afterCue.endSec.toFixed(2))
      : Number(currentTime.toFixed(2));
    const end = Number((start + 2.2).toFixed(2));
    const newCue: SubtitleCue = {
      id: `cue_manual_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      index: cues.length + 1,
      startSec: start,
      endSec: end,
      speaker: 'Speaker 1',
      originalText: '',
      translatedText: '',
      verified: true,
      translationStatus: 'untranslated',
    };
    const next = [...cues, newCue]
      .sort((a, b) => a.startSec - b.startSec)
      .map((c, idx) => ({ ...c, index: idx + 1 }));
    setCues(next);
  };

  const downloadFile = (
    content: string,
    ext: string,
    mime = 'text/plain;charset=utf-8'
  ) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = videoFile
      ? videoFile.name.replace(/\.[^/.]+$/, '')
      : lastFileName
      ? lastFileName.replace(/\.[^/.]+$/, '')
      : 'subtitles';
    a.href = url;
    a.download = `${baseName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const translatedCount = useMemo(
    () =>
      cues.filter((c) => c.translatedText && c.translatedText.trim().length > 0)
        .length,
    [cues]
  );

  const fullOriginalTranscriptText = useMemo(
    () => cues.map((c) => c.originalText).join('\n'),
    [cues]
  );

  const fullTranslatedText = useMemo(
    () =>
      cues
        .map((c) => c.translatedText || c.originalText)
        .filter(Boolean)
        .join('\n'),
    [cues]
  );

  const currentDisplayedYPercent =
    typeof activeCue?.customYPercent === 'number'
      ? activeCue.customYPercent
      : renderSettings.subYPercent;

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3.5 space-y-4">
      {/* ============================================================================
          TOP STUDIO COMMAND PANEL (100% Symmetrical, Uniform Height, Zero Overflow)
          ============================================================================ */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-3.5 sm:p-4 shadow-2xs space-y-3">
        {/* Row 1: File Upload + History + Note + Strict Provider & Model Lock Controls */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          {/* Left: File Button + Active File Badge + History + Note */}
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="col-span-2 sm:col-span-1 h-9 px-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 shrink-0" />
              <span>{videoFile ? 'ဖိုင်အသစ် လဲမည်' : 'ဗီဒီယို / အသံဖိုင် ရွေးမည်'}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*"
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
            />

            <button
              type="button"
              onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                showHistoryDrawer
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
              }`}
            >
              <History className="w-3.5 h-3.5 shrink-0" />
              <span>မှတ်တမ်း ({historyItems.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setShowContextBox(!showContextBox)}
              className={`h-9 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                showContextBox || contextHint
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              မှတ်ချက်ထည့်ရန်
            </button>

            {(videoFile || lastFileName) && (
              <div className="col-span-2 sm:col-span-1 h-9 px-3 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 font-medium flex items-center gap-2 min-w-0 max-w-full sm:max-w-[220px]">
                <FileAudio className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                <span className="truncate">{videoFile?.name || lastFileName}</span>
                {sessionTokensUsed > 0 && (
                  <span className="text-[11px] font-mono tabular-nums text-indigo-600 font-bold shrink-0">
                    · {sessionTokensUsed.toLocaleString()} tok
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right: Strict Gateway Switcher + Strict Model Switcher (Uniform 3-Col Segmented Bars) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex items-center gap-2">
            {/* Active Gateway Selector */}
            <div className="grid grid-cols-3 bg-slate-100 p-1 rounded-xl border border-slate-200">
              {(
                [
                  { id: 'aistudio', label: 'AI Studio' },
                  { id: 'apinex', label: 'apinex' },
                  { id: 'beatapi', label: 'beatapi' },
                ] as Array<{ id: ProviderId; label: string }>
              ).map((p) => {
                const isProvActive = (snapshot?.activeProvider ?? 'aistudio') === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleProviderSwitch(p.id)}
                    className={`h-7 px-2.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer whitespace-nowrap text-center ${
                      isProvActive
                        ? 'bg-indigo-600 text-white shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Strict Model Lock Selector */}
            <div className="grid grid-cols-3 bg-slate-100 p-1 rounded-xl border border-slate-200">
              {STRICT_MODELS.map((m) => {
                const currentNormalized =
                  snapshot?.strictModel === 'gemini-3.1-pro-preview'
                    ? 'gemini-3.1-pro'
                    : snapshot?.strictModel ?? 'gemini-3.1-pro';
                const active = currentNormalized === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleStrictModelSwitch(m.id)}
                    className={`h-7 px-2.5 rounded-lg text-[11px] font-mono font-bold transition-all cursor-pointer whitespace-nowrap text-center ${
                      active
                        ? 'bg-white text-indigo-600 shadow-2xs border border-slate-200/80'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {m.id === 'gemini-4-argon'
                      ? '4-Argon'
                      : m.id === 'gemini-3.8-flash'
                      ? '3.8-Flash'
                      : '3.1-Pro'}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Collapsible Project History Drawer */}
        {showHistoryDrawer && (
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-600" />
                <span className="text-xs font-bold text-slate-900">
                  သိမ်းဆည်းထားသော စာတန်းထိုး မှတ်တမ်းများ (Project History)
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowHistoryDrawer(false)}
                className="h-7 w-7 rounded-lg text-slate-500 hover:bg-slate-200 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {historyItems.length === 0 ? (
              <p className="text-xs text-slate-500 py-3 text-center">
                သိမ်းဆည်းထားသော မှတ်တမ်း မရှိသေးပါ။ Transcribe သို့မဟုတ် Translate လုပ်ပြီးတိုင်း အလိုအလျောက် သိမ်းဆည်းပေးပါမည်။
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                {historyItems.map((item) => {
                  const transCount = item.cues.filter(
                    (c) => c.translatedText && c.translatedText.trim().length > 0
                  ).length;
                  return (
                    <div
                      key={item.id}
                      className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="text-xs font-bold text-slate-900 truncate">
                          {item.fileName}
                        </div>
                        <p className="text-[11px] text-slate-500 tabular-nums">
                          စာကြောင်း {item.cues.length} · ဘာသာပြန် {transCount} · {item.aspectLabel}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => restoreProjectFromHistory(item)}
                          className="h-8 px-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer whitespace-nowrap"
                        >
                          ပြန်ဖွင့်မည်
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadFile(
                              exportToSrt(
                                item.cues,
                                transCount > 0 ? 'translated' : 'original'
                              ),
                              `${item.fileName.replace(/\.[^/.]+$/, '')}.srt`
                            )
                          }
                          className="h-8 px-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[11px] font-semibold cursor-pointer whitespace-nowrap"
                        >
                          .SRT
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteHistoryProject(item.id)}
                          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {showContextBox && (
          <div>
            <input
              type="text"
              value={contextHint}
              onChange={(e) => setContextHint(e.target.value)}
              placeholder="ဇာတ်ကောင်အမည်များ သို့မဟုတ် အကြောင်းအရာ အတိုချုပ် (မထည့်လည်းရပါသည်)..."
              className="w-full h-9 bg-slate-50 border border-slate-200 rounded-xl px-3.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 focus:bg-white"
            />
          </div>
        )}

        {/* Row 2: 3 Primary Step Pipeline Buttons (Strictly Equal Height & Symmetrical Grid) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            type="button"
            onClick={startStep1Transcription}
            disabled={!videoFile || isExtracting || isTranscribing || isTranslating || isExportingVideo}
            className="h-10 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-100 disabled:text-slate-400 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {isExtracting || isTranscribing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">
                  ၁။ Transcribe လုပ်နေသည် ({jobProgress.percent}%)
                </span>
              </>
            ) : (
              <>
                <Eye className="w-4 h-4 shrink-0" />
                <span className="truncate">၁။ မူရင်းစာတန်း/အသံ Transcribe လုပ်မည်</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={startStep2Translation}
            disabled={cues.length === 0 || isExtracting || isTranscribing || isTranslating || isExportingVideo}
            className="h-10 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-100 disabled:text-slate-400 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {isTranslating ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">
                  ၂။ ဘာသာပြန်နေသည် ({jobProgress.percent}%)
                </span>
              </>
            ) : (
              <>
                <Languages className="w-4 h-4 shrink-0" />
                <span className="truncate">၂။ မြန်မာဘာသာပြန်မည် (Translate)</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleExportBurnedInMp4}
            disabled={
              !videoFile ||
              isAudioOnlyFile ||
              cues.length === 0 ||
              isExtracting ||
              isTranscribing ||
              isTranslating ||
              isExportingVideo
            }
            className="h-10 px-3.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-slate-100 disabled:text-slate-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {isExportingVideo ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">
                  ၃။ MP4 ထုတ်နေသည် ({jobProgress.percent}%)
                </span>
              </>
            ) : (
              <>
                <Film className="w-4 h-4 shrink-0" />
                <span className="truncate">၃။ စာတန်းထိုးသွင်းပြီး MP4 ထုတ်မည်</span>
              </>
            )}
          </button>
        </div>

        {/* ============================================================================
            REAL-TIME PROGRESS DASHBOARD (Zero Mobile Overflow, Full Readable Text)
            ============================================================================ */}
        {(jobProgress.active || isExtracting || isTranscribing || isTranslating || isExportingVideo) && (
          <div className="p-3.5 rounded-2xl bg-slate-900 text-white border border-slate-800 space-y-3 overflow-hidden">
            <div className="flex items-start justify-between gap-2.5">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <span className="px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 font-mono tabular-nums font-extrabold text-xs sm:text-sm shrink-0">
                  {jobProgress.percent}%
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-xs sm:text-sm font-bold text-white leading-snug break-words">
                    {jobProgress.stageTitle || 'လုပ်ဆောင်နေသည်...'}
                  </p>
                  <p className="text-[11px] text-slate-300 leading-relaxed break-words">
                    {jobProgress.detailText}
                  </p>
                </div>
              </div>

              {(isTranscribing || isTranslating) && (
                <button
                  type="button"
                  onClick={() => {
                    abortRef.current = true;
                  }}
                  className="h-8 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shrink-0 cursor-pointer whitespace-nowrap"
                >
                  ရပ်မည်
                </button>
              )}
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-400 via-emerald-400 to-indigo-400 rounded-full transition-all duration-300"
                style={{ width: `${Math.max(4, Math.min(100, jobProgress.percent))}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono tabular-nums">
              <div className="px-2.5 py-1.5 rounded-lg bg-slate-800/90 text-slate-200 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="truncate">ကြာချိန်: {formatElapsedSec(elapsedSeconds)}</span>
              </div>
              <div className="px-2.5 py-1.5 rounded-lg bg-slate-800/90 text-emerald-300 flex items-center justify-end">
                <span className="truncate">
                  {jobProgress.etaSeconds !== null && jobProgress.etaSeconds > 0
                    ? `ခန့်မှန်းကျန်ချိန်: ~${jobProgress.etaSeconds}s`
                    : 'လုပ်ဆောင်နေသည်...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Copyable Error Banner */}
        {errorBanner && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start justify-between gap-2 text-xs text-rose-800">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span className="leading-relaxed break-words">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => copyText(errorBanner, 'err')}
              className="h-7 px-2.5 rounded-lg bg-white border border-rose-200 text-rose-700 text-[11px] font-medium shrink-0 flex items-center gap-1 cursor-pointer"
            >
              {copiedKey === 'err' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span>Copy</span>
            </button>
          </div>
        )}
      </div>

      {/* ============================================================================
          MAIN SPLIT WORKSPACE:
          Left: 9:16 & 16:9 Interactive WYSIWYG Video Preview (Supports Touch Drag!)
          Right: Complete Unified Subtitle & Script Editor (Edit, Timing, Move, Delete)
          ============================================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN: INTERACTIVE VIDEO PREVIEW & POSITION CONTROLS */}
        {videoUrl && (
          <div
            className={`${
              effectiveAspectMode === 'theater' ? 'lg:col-span-12' : 'lg:col-span-5'
            } lg:sticky lg:top-16 z-20 space-y-3`}
          >
            <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
              {/* Top Aspect Ratio & View Mode Bar (Uniform 4-Column Grid) */}
              {!isAudioOnlyFile && (
                <div className="p-2 bg-slate-900 text-white grid grid-cols-4 gap-1.5 border-b border-slate-800">
                  <button
                    type="button"
                    onClick={() => setPreviewAspectMode('auto')}
                    className={`h-8 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center cursor-pointer transition-colors whitespace-nowrap ${
                      previewAspectMode === 'auto'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    Auto ({isPortraitVideo ? '9:16' : '16:9'})
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewAspectMode('9:16')}
                    className={`h-8 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors whitespace-nowrap ${
                      previewAspectMode === '9:16'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5 shrink-0" />
                    <span>9:16</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewAspectMode('16:9')}
                    className={`h-8 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors whitespace-nowrap ${
                      previewAspectMode === '16:9'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Monitor className="w-3.5 h-3.5 shrink-0" />
                    <span>16:9</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewAspectMode(
                        previewAspectMode === 'theater' ? 'auto' : 'theater'
                      )
                    }
                    className={`h-8 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors whitespace-nowrap ${
                      previewAspectMode === 'theater'
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {previewAspectMode === 'theater' ? (
                      <>
                        <Minimize2 className="w-3.5 h-3.5 shrink-0" />
                        <span>ပုံမှန်</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3.5 h-3.5 shrink-0" />
                        <span>အကြီးချဲ့</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* WYSIWYG Master Video + Transparent Overlay Canvas Stage (Touch/Mouse Drag moves subtitle Y%!) */}
              <div className="relative bg-slate-950 flex items-center justify-center p-1.5 select-none">
                {isAudioOnlyFile && (
                  <div className="flex items-center gap-3 text-white px-4 py-6">
                    <Volume2 className="w-6 h-6 text-indigo-400" />
                    <span className="text-xs font-medium">
                      အသံဖိုင် ဖွင့်ထားသည် ({videoFile?.name})
                    </span>
                  </div>
                )}

                <div
                  className={
                    isAudioOnlyFile
                      ? 'hidden'
                      : `relative flex items-center justify-center overflow-hidden rounded-xl bg-black transition-all ${
                          effectiveAspectMode === 'compact'
                            ? 'h-14 w-full'
                            : effectiveAspectMode === '9:16'
                            ? 'aspect-[9/16] max-h-[390px] sm:max-h-[460px] w-auto mx-auto shadow-lg border border-slate-800'
                            : effectiveAspectMode === 'theater'
                            ? isPortraitVideo
                              ? 'aspect-[9/16] max-h-[620px] w-auto mx-auto shadow-xl'
                              : 'aspect-video max-h-[520px] w-full'
                            : 'aspect-video max-h-[250px] sm:max-h-[310px] lg:max-h-[330px] w-full'
                        }`
                  }
                >
                  {/* Native Hardware-Decoded Video Layer (Always visible, never display:none for video!) */}
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    preload="auto"
                    playsInline
                    className="w-full h-full object-contain block pointer-events-none select-none"
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      const vw = v.videoWidth || 1280;
                      const vh = v.videoHeight || 720;
                      setVideoDuration(v.duration || 0);
                      setVideoNaturalSize({ w: vw, h: vh });
                      if (vh > vw * 1.08 && renderSettings.subYPercent > 72 && cues.length === 0) {
                        setRenderSettings((prev) => ({
                          ...prev,
                          blurYPercent: 56,
                          subYPercent: 56,
                        }));
                      }
                      setTimeout(drawCurrentPreviewFrame, 50);
                    }}
                    onLoadedData={() => {
                      drawCurrentPreviewFrame();
                    }}
                    onTimeUpdate={(e) => {
                      setCurrentTime(e.currentTarget.currentTime);
                      drawCurrentPreviewFrame();
                    }}
                    onSeeked={() => drawCurrentPreviewFrame()}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  />

                  {/* Crisp Transparent Subtitle Overlay Canvas (Cleared on every frame — zero ghosting!) */}
                  <canvas
                    ref={previewCanvasRef}
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
                    className={`absolute inset-0 z-10 w-full h-full object-contain cursor-grab active:cursor-grabbing touch-none ${
                      effectiveAspectMode === 'compact' ? 'opacity-25' : ''
                    }`}
                    title="နှိပ်လျှင် Play/Pause · အပေါ်/အောက် ဖိဆွဲလျှင် စာတန်းနေရာ ရွှေ့နိုင်သည်"
                  />
                </div>

                {effectiveAspectMode !== 'compact' && !isAudioOnlyFile && (
                  <div className="absolute top-3 left-3 z-20 px-2 py-0.5 rounded-md bg-black/75 text-amber-300 text-[10px] font-medium border border-white/15 pointer-events-none flex items-center gap-1">
                    <MoveVertical className="w-3 h-3" />
                    <span>ပုံပေါ်ဖိဆွဲ၍ စာတန်းရွှေ့နိုင်သည် (Y: {currentDisplayedYPercent}%)</span>
                  </div>
                )}
              </div>

              {/* Transport & Direct Position Quick-Bar (100% Uniform Grid Alignment) */}
              <div className="p-3 space-y-2.5 bg-white">
                {/* Timeline Scrubber */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono tabular-nums text-slate-600 w-12 shrink-0">
                    {formatTimestampDisplay(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, videoDuration)}
                    step={0.05}
                    value={currentTime}
                    onChange={(e) => seekToTime(Number(e.target.value), false)}
                    className="flex-1 accent-indigo-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                  />
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 w-12 text-right shrink-0">
                    {formatTimestampDisplay(videoDuration)}
                  </span>
                </div>

                {/* DIRECT 1-TAP SUBTITLE & BLUR POSITION MOVER BAR (Symmetrical 4-Col Grid) */}
                {!isAudioOnlyFile && (
                  <div className="p-2 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2">
                    <div className="grid grid-cols-4 gap-1.5">
                      <button
                        type="button"
                        onClick={() => adjustVerticalPosition(currentDisplayedYPercent - 2)}
                        className="h-8 px-2 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-800 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <ArrowUp className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                        <span>အပေါ်ရွှေ့</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => adjustVerticalPosition(currentDisplayedYPercent + 2)}
                        className="h-8 px-2 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-800 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <ArrowDown className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                        <span>အောက်ရွှေ့</span>
                      </button>

                      <button
                        type="button"
                        onClick={detectCurrentFrameHardsubPosition}
                        className="h-8 px-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <Crosshair className="w-3.5 h-3.5 shrink-0" />
                        <span>ကွက်တိချိန်</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowVisualControls(!showVisualControls)}
                        className={`h-8 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 border cursor-pointer whitespace-nowrap ${
                          showVisualControls
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <Sliders className="w-3.5 h-3.5 shrink-0" />
                        <span>စတိုင်ညှိ</span>
                      </button>
                    </div>

                    {/* Position Scope Segmented Toggle (Zero Text Collision on Any Device!) */}
                    <div className="grid grid-cols-2 gap-1.5 bg-slate-200/70 p-1 rounded-xl">
                      <button
                        type="button"
                        onClick={() => setPositionScope('all')}
                        className={`h-8 px-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                          positionScope === 'all'
                            ? 'bg-white text-indigo-700 shadow-2xs border border-slate-200/80'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        အားလုံး တစ်ပြိုင်တည်းရွှေ့
                      </button>
                      <button
                        type="button"
                        onClick={() => setPositionScope('current')}
                        className={`h-8 px-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                          positionScope === 'current'
                            ? 'bg-white text-indigo-700 shadow-2xs border border-slate-200/80'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        လက်ရှိစာကြောင်းသာ ရွှေ့
                      </button>
                    </div>
                  </div>
                )}

                {/* Playback Transport Controls (Symmetrical 4-Col Grid) */}
                <div className="grid grid-cols-4 gap-1.5">
                  <button
                    type="button"
                    onClick={togglePlayPause}
                    className="h-9 px-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="w-3.5 h-3.5 shrink-0" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 shrink-0" />
                        <span>Play</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekToTime(currentTime - 2, false)}
                    className="h-9 px-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-mono font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3 shrink-0" />
                    <span>-2s</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => seekToTime(currentTime + 2, false)}
                    className="h-9 px-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-mono font-semibold flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <RotateCw className="w-3 h-3 shrink-0" />
                    <span>+2s</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setLoopActiveCue(!loopActiveCue)}
                    className={`h-9 px-2 rounded-xl text-xs font-medium flex items-center justify-center gap-1 border cursor-pointer whitespace-nowrap ${
                      loopActiveCue
                        ? 'bg-amber-50 border-amber-300 text-amber-800 font-semibold'
                        : 'bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    <Repeat className="w-3 h-3 shrink-0" />
                    <span>Loop</span>
                  </button>
                </div>

                {/* Overlay Mode Quick Switcher (Symmetrical 4-Col Grid) */}
                {!isAudioOnlyFile && (
                  <div className="grid grid-cols-4 gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                    {(
                      [
                        { id: 'translated', label: 'ဘာသာပြန်' },
                        { id: 'bilingual', label: 'နှစ်ဘာသာ' },
                        { id: 'original', label: 'မူရင်း' },
                        { id: 'off', label: 'ပိတ်မည်' },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => updateRenderSetting('overlayMode', m.id)}
                        className={`h-7 px-2 rounded-lg text-[11px] font-semibold cursor-pointer whitespace-nowrap text-center ${
                          renderSettings.overlayMode === m.id
                            ? 'bg-white text-indigo-600 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* HARDSUB BLUR & SUBTITLE APPEARANCE PANEL (Expandable) */}
                {!isAudioOnlyFile && showVisualControls && (
                  <div className="pt-2.5 border-t border-slate-200 space-y-3 text-xs">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 font-semibold text-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={renderSettings.blurHardsub}
                          onChange={(e) =>
                            updateRenderSetting('blurHardsub', e.target.checked, true)
                          }
                          className="w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
                        />
                        <span>မူရင်းစာတန်းကို ဝါးဖျောက်မည် (Background အမဲ မထည့်ပါ)</span>
                      </label>

                      <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200">
                        <button
                          type="button"
                          onClick={() => updateRenderSetting('blurMode', 'always', true)}
                          className={`h-8 px-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                            renderSettings.blurMode === 'always'
                              ? 'bg-white text-indigo-700 shadow-2xs border border-slate-200/80'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          အမြဲတမ်း ဝါးမည်
                        </button>
                        <button
                          type="button"
                          onClick={() => updateRenderSetting('blurMode', 'active_only', true)}
                          className={`h-8 px-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                            renderSettings.blurMode === 'active_only'
                              ? 'bg-white text-indigo-700 shadow-2xs border border-slate-200/80'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          စာတန်းပေါ်ချိန်သာ ဝါးမည်
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
                      <div>
                        <div className="flex justify-between text-[11px] text-slate-600 mb-0.5">
                          <span>အပေါ်/အောက် (Y%)</span>
                          <span className="font-mono tabular-nums font-bold">
                            {currentDisplayedYPercent}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={15}
                          max={95}
                          value={currentDisplayedYPercent}
                          onChange={(e) =>
                            adjustVerticalPosition(Number(e.target.value))
                          }
                          className="w-full accent-indigo-600 h-1.5 cursor-pointer"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-[11px] text-slate-600 mb-0.5">
                          <span>စာလုံး အရွယ်အစား</span>
                          <span className="font-mono tabular-nums font-bold">
                            {renderSettings.fontSizePercent.toFixed(1)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={2.6}
                          max={7.5}
                          step={0.2}
                          value={renderSettings.fontSizePercent}
                          onChange={(e) =>
                            updateRenderSetting(
                              'fontSizePercent',
                              Number(e.target.value)
                            )
                          }
                          className="w-full accent-indigo-600 h-1.5 cursor-pointer"
                        />
                      </div>

                      {renderSettings.blurHardsub && (
                        <>
                          <div>
                            <div className="flex justify-between text-[11px] text-slate-600 mb-0.5">
                              <span>ဝါးမည့်အမြင့် (Height)</span>
                              <span className="font-mono tabular-nums font-bold">
                                {renderSettings.blurHeightPercent}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={5}
                              max={26}
                              value={renderSettings.blurHeightPercent}
                              onChange={(e) =>
                                updateRenderSetting(
                                  'blurHeightPercent',
                                  Number(e.target.value),
                                  true
                                )
                              }
                              className="w-full accent-indigo-600 h-1.5 cursor-pointer"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-[11px] text-slate-600 mb-0.5">
                              <span>ဝါးမည့်အကျယ် (Width)</span>
                              <span className="font-mono tabular-nums font-bold">
                                {renderSettings.blurWidthPercent}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={30}
                              max={100}
                              value={renderSettings.blurWidthPercent}
                              onChange={(e) =>
                                updateRenderSetting(
                                  'blurWidthPercent',
                                  Number(e.target.value),
                                  true
                                )
                              }
                              className="w-full accent-indigo-600 h-1.5 cursor-pointer"
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-600 font-medium shrink-0">
                        စာတန်းအရောင်:
                      </span>
                      <div className="grid grid-cols-4 gap-1.5 flex-1 max-w-[260px]">
                        {TEXT_COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.color}
                            type="button"
                            onClick={() =>
                              updateRenderSetting('textColor', preset.color)
                            }
                            className={`h-7 px-2 rounded-lg text-[11px] font-semibold border cursor-pointer whitespace-nowrap ${
                              renderSettings.textColor === preset.color
                                ? 'border-indigo-600 bg-indigo-50 text-indigo-800'
                                : 'border-slate-200 bg-white text-slate-600'
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* EXPORTED MP4 VIDEO RESULT PLAYER & DOWNLOAD CARD */}
            {exportedMp4Url && (
              <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-3.5 shadow-2xs space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-emerald-900 font-bold text-xs min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="truncate">ထွက်လာသော MP4 ဗီဒီယို (Preview အတိုင်း 100%)</span>
                  </div>
                  <a
                    href={exportedMp4Url}
                    download={
                      videoFile
                        ? `${videoFile.name.replace(/\.[^/.]+$/, '')}_subtitled.mp4`
                        : 'subtitled_video.mp4'
                    }
                    className="h-8 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>MP4 ဒေါင်းမည်</span>
                  </a>
                </div>
                <video
                  src={exportedMp4Url}
                  controls
                  playsInline
                  className={`w-full rounded-xl bg-black ${
                    isPortraitVideo ? 'max-h-[380px] object-contain' : 'max-h-[240px]'
                  }`}
                />
              </div>
            )}
          </div>
        )}

        {/* ============================================================================
            RIGHT COLUMN: COMPLETE UNIFIED SUBTITLE & TRANSCRIPT STUDIO
            (Inline Edit, Timing Shift, Position Move, Split, Merge, Delete on EVERY Card!)
            ============================================================================ */}
        <div
          className={`${
            videoUrl && effectiveAspectMode !== 'theater'
              ? 'lg:col-span-7'
              : 'lg:col-span-12'
          } bg-white border border-slate-200/90 rounded-2xl shadow-2xs overflow-hidden min-w-0`}
        >
          {/* Segmented Workspace Mode Switcher (Uniform 2x2 on Mobile, 4-Col on Desktop) */}
          <div className="p-2 bg-slate-100/90 border-b border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <button
              type="button"
              onClick={() => setWorkspaceTab('all')}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap ${
                workspaceTab === 'all'
                  ? 'bg-white text-indigo-600 shadow-2xs border border-slate-200/90'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <Subtitles className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">အားလုံး စစ်ရန် ({cues.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setWorkspaceTab('transcribe')}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap ${
                workspaceTab === 'transcribe'
                  ? 'bg-white text-indigo-600 shadow-2xs border border-slate-200/90'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">မူရင်းစာသား ({cues.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setWorkspaceTab('translate')}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap ${
                workspaceTab === 'translate'
                  ? 'bg-white text-emerald-700 shadow-2xs border border-slate-200/90'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <Languages className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                ဘာသာပြန် ({translatedCount}/{cues.length})
              </span>
            </button>

            <button
              type="button"
              onClick={() => setWorkspaceTab('export')}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap ${
                workspaceTab === 'export'
                  ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/90'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">SRT / MP4 ထုတ်ရန်</span>
            </button>
          </div>

          {/* ==========================================================================
              EXPORT & DOWNLOAD VIEW
              ========================================================================== */}
          {workspaceTab === 'export' ? (
            <div className="p-4 space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-slate-900">
                  စာတန်းထိုးဖိုင်များ (.SRT / .VTT / .TXT) နှင့် MP4 ဗီဒီယို ထုတ်ယူရန်
                </h3>
                <p className="text-xs text-slate-500">
                  စာကြောင်း စုစုပေါင်း ({cues.length}) ကြောင်း · မြန်မာဘာသာပြန်ပြီး ({translatedCount}) ကြောင်း
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {!isAudioOnlyFile && (
                  <button
                    type="button"
                    onClick={handleExportBurnedInMp4}
                    disabled={isExportingVideo || cues.length === 0}
                    className="sm:col-span-2 h-11 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-slate-100 disabled:text-slate-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Film className="w-4 h-4 shrink-0" />
                    <span className="truncate">
                      {isExportingVideo
                        ? 'MP4 ဗီဒီယို ထုတ်နေသည်...'
                        : 'Preview အတိုင်း မြန်မာစာတန်းထိုးသွင်းပြီး MP4 ဗီဒီယို ဒေါင်းလုဒ်ဆွဲမည်'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(
                      exportToSrt(
                        cues,
                        translatedCount > 0 ? 'translated' : 'original'
                      ),
                      'translated.srt'
                    )
                  }
                  disabled={cues.length === 0}
                  className="h-10 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-100 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>မြန်မာဘာသာပြန် .SRT ဒေါင်းမည်</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(exportToSrt(cues, 'original'), 'original.srt')
                  }
                  disabled={cues.length === 0}
                  className="h-10 px-3.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>မူရင်းဘာသာ .SRT ဒေါင်းမည်</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(exportToVtt(cues, 'bilingual'), 'bilingual.vtt')
                  }
                  disabled={cues.length === 0}
                  className="h-10 px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>နှစ်ဘာသာ .VTT ဒေါင်းမည်</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(exportToPlainText(cues, 'bilingual'), 'script.txt')
                  }
                  disabled={cues.length === 0}
                  className="h-10 px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>စာသားသီးသန့် .TXT ဒေါင်းမည်</span>
                </button>
              </div>
            </div>
          ) : (
            /* ==========================================================================
               UNIFIED INTERACTIVE SUBTITLE EDITOR (ALL / TRANSCRIBE / TRANSLATE)
               ========================================================================== */
            <div className="p-3.5 sm:p-4 space-y-3">
              {/* Top Editor Toolbar: 100% Symmetrical 3-Column Equal-Size Grid (Zero Collision!) */}
              <div className="space-y-2 pb-3 border-b border-slate-100">
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setScriptViewMode('cards')}
                    className={`h-9 px-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                      scriptViewMode === 'cards'
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-2xs'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    စာကြောင်းလိုက်
                  </button>

                  <button
                    type="button"
                    onClick={() => setScriptViewMode('paragraph')}
                    className={`h-9 px-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                      scriptViewMode === 'paragraph'
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-2xs'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    စာပိုဒ်အပြည့်
                  </button>

                  <button
                    type="button"
                    onClick={() => setAutoFollowPlayback(!autoFollowPlayback)}
                    className={`h-9 px-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                      autoFollowPlayback
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Scroll: {autoFollowPlayback ? 'ဖွင့်' : 'ပိတ်'}
                  </button>
                </div>

                {/* Action Row: Auto-Split + Add New + Undo + Copy All (Uniform 2x2 / 4-Col Grid) */}
                {cues.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      onClick={autoCleanAndSplitMergedCues}
                      className="h-8 px-2.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                      title="ပူးနေသော စာကြောင်းရှည်များကို အလိုအလျောက် ခွဲထုတ်ပြီး အစက် (。) များကို ရှင်းလင်းမည်"
                    >
                      <Scissors className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">စာကြောင်းရှည်ခွဲမည်</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => insertCueAfter(activeCue)}
                      className="h-8 px-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">စာကြောင်းသစ်ထည့်</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        copyText(
                          workspaceTab === 'translate'
                            ? fullTranslatedText
                            : fullOriginalTranscriptText,
                          'copy_all'
                        )
                      }
                      className="h-8 px-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {copiedKey === 'copy_all' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span className="truncate">Copy ကူးပြီး</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">အားလုံး Copy</span>
                        </>
                      )}
                    </button>

                    {undoCueStack.length > 0 ? (
                      <button
                        type="button"
                        onClick={handleUndoCueChange}
                        className="h-8 px-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        <Undo2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">ပြန်ယူ (Undo)</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => activeCue && scrollToActiveCueInList(activeCue.id)}
                        disabled={!activeCue}
                        className="h-8 px-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        <span className="truncate">
                          {activeCue ? `လက်ရှိ (#${activeCue.index}) သို့` : 'လက်ရှိစာကြောင်း'}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Target Language Segmented Selector (NO <select> dropdown arrow! Clean 3x2 / 6-Col Grid) */}
              {(workspaceTab === 'all' || workspaceTab === 'translate') && cues.length > 0 && (
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                    {TARGET_LANGUAGES.map((lang) => {
                      const isSelected = targetLanguage === lang.code;
                      return (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => setTargetLanguage(lang.code)}
                          className={`h-8 px-2 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-center ${
                            isSelected
                              ? 'bg-emerald-600 border-emerald-600 text-white shadow-2xs'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {lang.label}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={startStep2Translation}
                    disabled={isTranslating}
                    className="h-9 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer w-full whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    <span>အားလုံး ဘာသာပြန်မည်</span>
                  </button>
                </div>
              )}

              {/* Empty State */}
              {cues.length === 0 ? (
                <div className="py-12 px-4 text-center space-y-3 bg-slate-50/70 rounded-2xl border border-dashed border-slate-200">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mx-auto text-indigo-600">
                    <Eye className="w-5 h-5" />
                  </div>
                  <div className="space-y-1 max-w-md mx-auto">
                    <h3 className="text-sm font-bold text-slate-900">
                      စာတန်းထိုး စာကြောင်းများ မရှိသေးပါ
                    </h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      အပေါ်မှ <strong>ဗီဒီယို / အသံဖိုင် ရွေးမည်</strong> ကိုနှိပ်ပြီး{' '}
                      <strong>၁။ မူရင်းစာတန်း/အသံ Transcribe လုပ်မည်</strong> ကို နှိပ်ပါ။
                    </p>
                  </div>
                </div>
              ) : scriptViewMode === 'paragraph' ? (
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 leading-relaxed text-sm sm:text-base text-slate-900 space-y-2 max-h-[68vh] overflow-y-auto">
                  <p className="text-xs text-slate-500 mb-2 font-medium">
                    စာကြောင်းတစ်ခုခုကို နှိပ်ပါက ထိုစာကြောင်းပြောသည့် ဗီဒီယိုနေရာသို့ တိုက်ရိုက်ပြသပေးပါမည် —
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {cues.map((cue) => {
                      const isCurrent = activeCue?.id === cue.id;
                      const displayTxt =
                        workspaceTab === 'translate'
                          ? cue.translatedText || cue.originalText
                          : cue.originalText;
                      return (
                        <span
                          key={cue.id}
                          onClick={() => seekToTime(cue.startSec, true)}
                          className={`inline-flex items-baseline gap-1 px-2 py-1 rounded-lg cursor-pointer transition-colors ${
                            isCurrent
                              ? 'bg-indigo-600 text-white font-semibold'
                              : 'hover:bg-indigo-50 text-slate-800'
                          }`}
                        >
                          <span
                            className={`text-[10px] font-mono tabular-nums ${
                              isCurrent ? 'text-indigo-200' : 'text-slate-400'
                            }`}
                          >
                            [{formatTimestampDisplay(cue.startSec)}]
                          </span>
                          <span>{displayTxt}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* ======================================================================
                   COMPLETE INTERACTIVE SUBTITLE CUE CARDS
                   (Uniform Buttons, Single-Line Labels, Full Timing/Position/Delete)
                   ====================================================================== */
                <div
                  ref={cueListContainerRef}
                  className="space-y-2.5 max-h-[70vh] overflow-y-auto pr-1"
                >
                  {cues.map((cue, idx) => {
                    const isCurrent = activeCue?.id === cue.id;
                    const isTimingOpen = expandedTimingCueId === cue.id;
                    const cueY =
                      typeof cue.customYPercent === 'number'
                        ? cue.customYPercent
                        : renderSettings.subYPercent;

                    return (
                      <div
                        key={cue.id}
                        ref={(el) => {
                          cueRowRefs.current[cue.id] = el;
                        }}
                        className={`p-3 rounded-xl border transition-colors space-y-2 overflow-hidden ${
                          isCurrent
                            ? 'bg-indigo-50/50 border-indigo-400 ring-2 ring-indigo-500/15'
                            : 'bg-white border-slate-200/90 hover:border-slate-300'
                        }`}
                      >
                        {/* ROW 1: Play Timestamp + Quick Timing Shift (Strictly Contained, Zero Overflow!) */}
                        <div className="flex items-center justify-between gap-1.5 min-w-0">
                          <button
                            type="button"
                            onClick={() => seekToTime(cue.startSec, true)}
                            className={`h-8 px-2.5 rounded-lg text-xs font-mono tabular-nums font-bold flex items-center gap-1.5 cursor-pointer transition-colors min-w-0 flex-1 sm:flex-initial overflow-hidden ${
                              isCurrent
                                ? 'bg-indigo-600 text-white'
                                : 'bg-slate-100 hover:bg-indigo-100 text-slate-800 hover:text-indigo-700'
                            }`}
                            title="ဤစာကြောင်းနေရာသို့ ဗီဒီယိုဖွင့်ကြည့်မည်"
                          >
                            <Play className="w-3 h-3 fill-current shrink-0" />
                            <span className="truncate">
                              #{cue.index} · {formatTimestampDisplay(cue.startSec)} →{' '}
                              {formatTimestampDisplay(cue.endSec)}
                            </span>
                          </button>

                          <div className="grid grid-cols-2 gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200 shrink-0">
                            <button
                              type="button"
                              onClick={() => nudgeCueTiming(cue.id, 'both', -0.15)}
                              className="h-7 px-2 rounded-md text-[11px] font-mono tabular-nums font-semibold text-slate-700 hover:bg-white cursor-pointer whitespace-nowrap text-center"
                            >
                              -0.15s
                            </button>
                            <button
                              type="button"
                              onClick={() => nudgeCueTiming(cue.id, 'both', 0.15)}
                              className="h-7 px-2 rounded-md text-[11px] font-mono tabular-nums font-semibold text-slate-700 hover:bg-white cursor-pointer whitespace-nowrap text-center"
                            >
                              +0.15s
                            </button>
                          </div>
                        </div>

                        {/* ROW 2: 4 Strictly Equal-Width Action Buttons (grid-cols-4, h-8) */}
                        <div className="grid grid-cols-4 gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedTimingCueId(isTimingOpen ? null : cue.id)
                            }
                            className={`h-8 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 border cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap ${
                              isTimingOpen
                                ? 'bg-indigo-600 border-indigo-600 text-white'
                                : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700'
                            }`}
                          >
                            <Clock className="w-3 h-3 shrink-0" />
                            <span className="truncate">အချိန်/နေရာ</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => splitCueSmart(cue.id)}
                            className="h-8 px-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                            title="စာကြောင်း နှစ်ပိုင်းခွဲမည်"
                          >
                            <Scissors className="w-3 h-3 shrink-0" />
                            <span className="truncate">ခွဲမည်</span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              copyText(
                                cue.translatedText || cue.originalText,
                                `cue_${cue.id}`
                              )
                            }
                            className="h-8 px-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                            title="Copy စာသား"
                          >
                            {copiedKey === `cue_${cue.id}` ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                                <span className="truncate">ကူးပြီး</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3 shrink-0" />
                                <span className="truncate">Copy</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => deleteCue(cue.id)}
                            className="h-8 px-2 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                            title="ဤစာကြောင်းကို ဖျက်မည်"
                          >
                            <Trash2 className="w-3 h-3 shrink-0" />
                            <span className="truncate">ဖျက်မည်</span>
                          </button>
                        </div>

                        {/* EXPANDABLE PRECISION TIMING & VERTICAL POSITION BAR */}
                        {isTimingOpen && (
                          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2 text-xs">
                            {idx < cues.length - 1 && (
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => mergeWithNextCue(cue.id)}
                                  className="h-7 px-2.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                >
                                  <Merge className="w-3 h-3 shrink-0" />
                                  <span>အောက်စာကြောင်းနှင့် ပေါင်းမည် (Merge)</span>
                                </button>
                              </div>
                            )}
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-[11px] text-slate-600 font-semibold">
                                <span>စချိန် (Start Sec)</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleCueChange(
                                      cue.id,
                                      'startSec',
                                      Number(currentTime.toFixed(2))
                                    )
                                  }
                                  className="text-indigo-600 hover:underline font-bold cursor-pointer"
                                >
                                  လက်ရှိဗီဒီယိုချိန်ယူ
                                </button>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    nudgeCueTiming(cue.id, 'startSec', -0.1)
                                  }
                                  className="h-8 px-2 rounded-lg bg-white border border-slate-200 font-mono text-[11px] font-semibold cursor-pointer"
                                >
                                  -0.1s
                                </button>
                                <input
                                  type="number"
                                  step={0.1}
                                  min={0}
                                  value={cue.startSec}
                                  onChange={(e) =>
                                    handleCueChange(
                                      cue.id,
                                      'startSec',
                                      Math.max(0, Number(e.target.value))
                                    )
                                  }
                                  className="h-8 w-full bg-white border border-slate-200 rounded-lg px-2 text-center font-mono tabular-nums font-bold text-slate-900"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    nudgeCueTiming(cue.id, 'startSec', 0.1)
                                  }
                                  className="h-8 px-2 rounded-lg bg-white border border-slate-200 font-mono text-[11px] font-semibold cursor-pointer"
                                >
                                  +0.1s
                                </button>
                              </div>
                            </div>

                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-[11px] text-slate-600 font-semibold">
                                <span>ဆုံးချိန် (End Sec)</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleCueChange(
                                      cue.id,
                                      'endSec',
                                      Number(Math.max(cue.startSec + 0.3, currentTime).toFixed(2))
                                    )
                                  }
                                  className="text-indigo-600 hover:underline font-bold cursor-pointer"
                                >
                                  လက်ရှိဗီဒီယိုချိန်ယူ
                                </button>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => nudgeCueTiming(cue.id, 'endSec', -0.1)}
                                  className="h-8 px-2 rounded-lg bg-white border border-slate-200 font-mono text-[11px] font-semibold cursor-pointer"
                                >
                                  -0.1s
                                </button>
                                <input
                                  type="number"
                                  step={0.1}
                                  min={0.2}
                                  value={cue.endSec}
                                  onChange={(e) =>
                                    handleCueChange(
                                      cue.id,
                                      'endSec',
                                      Math.max(cue.startSec + 0.2, Number(e.target.value))
                                    )
                                  }
                                  className="h-8 w-full bg-white border border-slate-200 rounded-lg px-2 text-center font-mono tabular-nums font-bold text-slate-900"
                                />
                                <button
                                  type="button"
                                  onClick={() => nudgeCueTiming(cue.id, 'endSec', 0.1)}
                                  className="h-8 px-2 rounded-lg bg-white border border-slate-200 font-mono text-[11px] font-semibold cursor-pointer"
                                >
                                  +0.1s
                                </button>
                              </div>
                            </div>

                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-[11px] text-slate-600 font-semibold">
                                <span>စာတန်းနေရာ (Y: {cueY}%)</span>
                                {typeof cue.customYPercent === 'number' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCueChange(cue.id, 'customYPercent', undefined)
                                    }
                                    className="text-slate-500 hover:underline text-[10px] cursor-pointer"
                                  >
                                    မူလအတိုင်းပြန်ထား
                                  </button>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    seekToTime(cue.startSec + 0.05, false);
                                    adjustVerticalPosition(cueY - 3, cue.id);
                                  }}
                                  className="h-8 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                  <span>အပေါ်</span>
                                </button>
                                <input
                                  type="range"
                                  min={15}
                                  max={94}
                                  value={cueY}
                                  onChange={(e) => {
                                    seekToTime(cue.startSec + 0.05, false);
                                    adjustVerticalPosition(
                                      Number(e.target.value),
                                      cue.id
                                    );
                                  }}
                                  className="flex-1 accent-indigo-600 h-1.5 cursor-pointer"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    seekToTime(cue.startSec + 0.05, false);
                                    adjustVerticalPosition(cueY + 3, cue.id);
                                  }}
                                  className="h-8 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                >
                                  <ArrowDown className="w-3 h-3" />
                                  <span>အောက်</span>
                                </button>
                              </div>
                            </div>
                            </div>
                          </div>
                        )}

                        {/* DIRECT INLINE EDITABLE ORIGINAL TEXT (Single-line w-16 label!) */}
                        {(workspaceTab === 'all' || workspaceTab === 'transcribe') && (
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[11px] font-bold text-slate-500 w-16 shrink-0 whitespace-nowrap">
                              မူရင်း:
                            </span>
                            <input
                              type="text"
                              value={cue.originalText}
                              onFocus={() => seekToTime(cue.startSec + 0.05, false)}
                              onChange={(e) =>
                                handleCueChange(cue.id, 'originalText', e.target.value)
                              }
                              placeholder="မူရင်း စာတန်းထိုး စာသား ရေးထည့်ပါ..."
                              className="flex-1 min-w-0 h-9 bg-slate-50/80 focus:bg-white border border-slate-200 focus:border-indigo-500 rounded-xl px-3 text-sm font-medium text-slate-900 focus:outline-none transition-colors"
                            />
                          </div>
                        )}

                        {/* DIRECT INLINE EDITABLE BURMESE TRANSLATED TEXT (Single-line w-16 label!) */}
                        {(workspaceTab === 'all' || workspaceTab === 'translate') && (
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[11px] font-bold text-emerald-700 w-16 shrink-0 whitespace-nowrap">
                              ဘာသာပြန်:
                            </span>
                            <input
                              type="text"
                              value={cue.translatedText}
                              onFocus={() => seekToTime(cue.startSec + 0.05, false)}
                              onChange={(e) =>
                                handleCueChange(cue.id, 'translatedText', e.target.value)
                              }
                              placeholder="မြန်မာဘာသာပြန် စာသား ရေးထည့်ပါ (သို့) အပေါ်မှ ဘာသာပြန်မည် နှိပ်ပါ..."
                              className="flex-1 min-w-0 h-9 bg-emerald-50/40 focus:bg-white border border-emerald-200/90 focus:border-emerald-500 rounded-xl px-3 text-sm font-semibold text-slate-900 focus:outline-none transition-colors"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
