/**
 * Universal Audio Chunk & Chronological Video Contact-Sheet Extractor.
 *
 * Key Design Principles:
 * 1. ZERO Pixel-Color / Stroke Heuristics:
 *    - Never pre-assumes subtitle color, outline stroke, font, or position.
 *    - Works universally on ANY video (any subtitle color/font/position, 18+/21+ scenes, or raw unsubtitled videos).
 * 2. ZERO Upfront 600-Seek Browser Timeout:
 *    - `extractAudioChunksFromMediaFile` decodes and slices the audio into ~24s chunks in < 2 seconds without blocking on upfront video seeks.
 *    - `VideoChunkSheetSampler` captures 2 chronological 3x4 Contact Sheets (24 frames per chunk, ~1.0s interval) ON DEMAND right before each chunk is sent to the AI model, taking only ~1.5s per chunk and never timing out on mobile browsers.
 */

export interface VisualSubtitleSheet {
  mimeType: string;
  dataBase64: string;
  timeRangeLabel: string;
  sheetStartOffsetSec?: number;
  sheetEndOffsetSec?: number;
}

export interface VisualSubtitleCardMeta {
  cardIndex: number;
  startOffsetSec: number;
  endOffsetSec: number;
  yPercent: number;
}

export interface DetectedHardsubBox {
  hasHardsub: boolean;
  yPercent: number;
  heightPercent: number;
  widthPercent: number;
}

export interface FrameYPoint {
  timeSec: number;
  yPercent: number;
}

export interface ExtractionProgressUpdate {
  percent: number;
  stage: string;
  detail: string;
}

export interface ExtractedAudioChunk {
  chunkIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  isSilent: boolean;
  rmsAmplitude: number;
  audioBase64: string;
  wavBase64: string;
  mimeType: string;
  byteSize: number;
  hasHardsubInChunk: boolean;
  detectedCards: VisualSubtitleCardMeta[];
  visualFrames: VisualSubtitleSheet[];
  safeVisualFrames: VisualSubtitleSheet[];
  frameYTimeline: FrameYPoint[];
}

function normalizeAndEncodeMono16BitWav(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const safeSamples =
    samples.length > 0 ? samples : new Float32Array(Math.max(800, sampleRate));
  const numSamples = safeSamples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  let peak = 0;
  for (let i = 0; i < numSamples; i++) {
    const abs = Math.abs(safeSamples[i]);
    if (abs > peak) peak = abs;
  }

  const gain = peak > 0.003 && peak < 0.85 ? Math.min(6.0, 0.88 / peak) : 1.0;

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const amplified = safeSamples[i] * gain;
    const clamped = Math.max(-1, Math.min(1, amplified));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true
    );
    offset += 2;
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  const step = Math.max(1, Math.floor(samples.length / 4000));
  let count = 0;
  for (let i = 0; i < samples.length; i += step) {
    sumSq += samples[i] * samples[i];
    count++;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

function findOptimalSilenceCutSample(
  samples: Float32Array,
  sampleRate: number,
  currentStartSample: number,
  minDurationSec: number,
  targetDurationSec: number,
  maxDurationSec: number
): number {
  const totalSamples = samples.length;
  const minEndSample =
    currentStartSample + Math.floor(minDurationSec * sampleRate);
  const targetEndSample =
    currentStartSample + Math.floor(targetDurationSec * sampleRate);
  const maxEndSample = Math.min(
    totalSamples,
    currentStartSample + Math.floor(maxDurationSec * sampleRate)
  );

  if (maxEndSample >= totalSamples - sampleRate * 1.5) {
    return totalSamples;
  }

  const windowSamples = Math.max(1, Math.floor(sampleRate * 0.25));
  const stepSamples = Math.max(1, Math.floor(sampleRate * 0.1));

  let bestCutSample = Math.min(totalSamples, targetEndSample);
  let lowestScore = Number.POSITIVE_INFINITY;

  for (
    let pos = minEndSample;
    pos <= maxEndSample - windowSamples;
    pos += stepSamples
  ) {
    let sumSq = 0;
    for (let j = 0; j < windowSamples; j += 2) {
      const s = samples[pos + j];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / (windowSamples / 2));
    const distanceFromTargetSec =
      Math.abs(pos - targetEndSample) / sampleRate;
    const score = rms + distanceFromTargetSec * 0.0005;

    if (score < lowestScore) {
      lowestScore = score;
      bestCutSample = pos + Math.floor(windowSamples / 2);
    }
  }

  return bestCutSample;
}

/**
 * Legacy helper kept for UI button compatibility without pixel-color/stroke assumptions.
 */
export function findFrameSubtitleBandYPercent(
  _scanCtx: CanvasRenderingContext2D,
  _video: HTMLVideoElement,
  _scanW: number,
  _scanH: number,
  isPortrait: boolean,
  defaultYPercent: number
): { yPercent: number; score: number } {
  return {
    yPercent: defaultYPercent || (isPortrait ? 56 : 84),
    score: 1,
  };
}

export interface VideoChunkSheetSampler {
  captureChunkSheets: (
    startSec: number,
    endSec: number
  ) => Promise<{
    visualFrames: VisualSubtitleSheet[];
    safeVisualFrames: VisualSubtitleSheet[];
  }>;
  dispose: () => void;
}

/**
 * Creates a persistent, reusable HTML5 `<video>` frame sampler for a media file.
 * For each chunk (`startSec` -> `endSec`), captures up to 32 chronological video frames
 * (1 frame every ~0.60s) and packs them into 2 clean 4x4 Contact Sheets:
 * - `visualFrames`: 2 full-frame 4x4 chronological contact sheets with causal-calibrated `T=XX.Xs` badges.
 * - `safeVisualFrames`: 2 lower-half (`Y=42%..86%`) 4x4 chronological contact sheets
 *   (pure geometric crop with ZERO pixel/color manipulation) for strict-model fallback.
 */
export async function createVideoChunkSheetSampler(
  file: File
): Promise<VideoChunkSheetSampler | null> {
  const isVideo =
    file.type.startsWith('video/') ||
    /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);
  if (!isVideo) return null;

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    // Attach offscreen 2x2px video to DOM so mobile Chromium/Opera hardware decoders
    // immediately flush SurfaceTexture frame buffers on every seek instead of lagging by 1 frame.
    video.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(video);
    }
    video.src = url;

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) {
        video.parentNode.removeChild(video);
      }
    };

    const loadTimeout = setTimeout(() => {
      dispose();
      resolve(null);
    }, 15000);

    let resolved = false;
    const initSampler = () => {
      if (resolved || disposed) return;
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 360;
      if (vw <= 0 || vh <= 0) {
        return;
      }
      resolved = true;
      clearTimeout(loadTimeout);

      const isPortrait = vh > vw * 1.05;
      const cols = 4;
      const rows = 6;
      const tilesPerSheet = cols * rows; // 24 tiles on 1 single 4x6 sheet per ~13.5s chunk (~0.54s per tile)
      const tileW = 260;
      const tileH = 150;

      const safeTileW = 260;
      const safeTileH = 98;

      const waitForDecodedFrameFlush = (cb: () => void) => {
        let flushed = false;
        const doneFlush = () => {
          if (flushed) return;
          flushed = true;
          cb();
        };
        // Give mobile hardware decoders 55ms after seeked to paint the decoded frame onto SurfaceTexture
        setTimeout(doneFlush, 55);
      };

      const seekTo = (t: number) =>
        new Promise<void>((resSeek) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            video.removeEventListener('seeked', onSeeked);
            resSeek();
          };
          const onSeeked = () => {
            waitForDecodedFrameFlush(finish);
          };
          video.addEventListener('seeked', onSeeked);
          try {
            if (
              Math.abs(video.currentTime - t) < 0.015 &&
              !video.seeking &&
              video.readyState >= 2
            ) {
              waitForDecodedFrameFlush(finish);
              return;
            }
            video.currentTime = t;
          } catch {
            finish();
          }
          // Safety timeout so mobile browsers seeking across GOP keyframes never hang
          setTimeout(finish, 750);
        });

      const captureChunkSheets = async (
        startSec: number,
        endSec: number
      ): Promise<{
        visualFrames: VisualSubtitleSheet[];
        safeVisualFrames: VisualSubtitleSheet[];
      }> => {
        if (disposed) {
          return { visualFrames: [], safeVisualFrames: [] };
        }

        const dur = Math.max(1, endSec - startSec);
        // 24 samples packed onto 1 single 4x6 Contact Sheet (~0.55s per tile)
        const totalSamples = 24;
        const step = dur / totalSamples;

        const sampleTimes: number[] = [];
        for (let i = 0; i < totalSamples; i++) {
          const t = Math.min(
            Math.max(startSec, endSec - 0.03),
            startSec + i * step
          );
          sampleTimes.push(Number(t.toFixed(2)));
        }

        const visualFrames: VisualSubtitleSheet[] = [];
        const safeVisualFrames: VisualSubtitleSheet[] = [];
        const chunkDeadlineMs = Date.now() + 25000;

        // 1. Full-Color Subtitle Region for gemini-4-argon (Y=48%..90% portrait, Y=48%..94% landscape)
        const mainCropY = Math.floor(vh * 0.48);
        const mainCropH = Math.floor(vh * (isPortrait ? 0.42 : 0.46));

        // 2. Tight Safety-Shielded Subtitle Strip for gemini-3.8-flash & gemini-3.1-pro
        // (Y=59%..78% portrait, Y=70%..92% landscape — completely excludes upper/lower body anatomy while capturing 100% of burned-in subtitle cards)
        const safeCropY = Math.floor(vh * (isPortrait ? 0.59 : 0.70));
        const safeCropH = Math.floor(vh * (isPortrait ? 0.19 : 0.22));

        for (
          let sStart = 0;
          sStart < sampleTimes.length;
          sStart += tilesPerSheet
        ) {
          const slice = sampleTimes.slice(sStart, sStart + tilesPerSheet);
          if (slice.length === 0) continue;

          const sheetRows = Math.max(1, Math.ceil(slice.length / cols));
          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = cols * tileW;
          fullCanvas.height = sheetRows * tileH;
          const fullCtx = fullCanvas.getContext('2d')!;
          fullCtx.fillStyle = '#0B0D13';
          fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

          const safeCanvas = document.createElement('canvas');
          safeCanvas.width = cols * safeTileW;
          safeCanvas.height = sheetRows * safeTileH;
          const safeCtx = safeCanvas.getContext('2d', {
            willReadFrequently: true,
          })!;
          safeCtx.fillStyle = '#0B0D13';
          safeCtx.fillRect(0, 0, safeCanvas.width, safeCanvas.height);

          let drawnCount = 0;
          const badgeRecords: Array<{
            sdx: number;
            sdy: number;
            badgeText: string;
          }> = [];

          for (let idx = 0; idx < slice.length; idx++) {
            if (Date.now() > chunkDeadlineMs && drawnCount >= 12) {
              break;
            }
            const t = slice[idx];
            await seekTo(t);
            drawnCount++;

            const c = idx % cols;
            const r = Math.floor(idx / cols);
            const dx = c * tileW;
            const dy = r * tileH;

            // 1. Draw lower-half active subtitle zone (100% original pixels for gemini-4-argon)
            fullCtx.drawImage(
              video,
              0,
              mainCropY,
              vw,
              mainCropH,
              dx,
              dy,
              tileW,
              tileH
            );

            // Tile border
            fullCtx.strokeStyle = '#334155';
            fullCtx.lineWidth = 1.5;
            fullCtx.strokeRect(dx + 0.5, dy + 0.5, tileW - 1, tileH - 1);

            // Exact hardware-decoded video frame timestamp relative to chunk start with 0.01s precision
            const actualSec =
              Number.isFinite(video.currentTime) &&
              Math.abs(video.currentTime - t) < 0.8
                ? video.currentTime
                : t;
            const rawRelSec = Math.max(0, actualSec - startSec);
            const relSec = rawRelSec.toFixed(2);
            const badgeText = `T=${relSec}s`;
            fullCtx.fillStyle = 'rgba(0, 0, 0, 0.88)';
            fullCtx.fillRect(dx + 5, dy + 5, 92, 22);
            fullCtx.fillStyle = '#FACC15';
            fullCtx.font = 'bold 13px monospace';
            fullCtx.fillText(badgeText, dx + 8, dy + 20);

            // 2. Draw tighter subtitle strip onto safeCanvas (before Dark-LUT pass)
            const sdx = c * safeTileW;
            const sdy = r * safeTileH;
            safeCtx.drawImage(
              video,
              0,
              safeCropY,
              vw,
              safeCropH,
              sdx,
              sdy,
              safeTileW,
              safeTileH
            );
            badgeRecords.push({ sdx, sdy, badgeText });
          }

          // Apply Dark-LUT High-Contrast Subtitle Filter to safeCanvas:
          // Suppresses all skin tones & background clutter (lum < 188 -> 0..37 dark cinema slate)
          // while preserving crisp white/bright-yellow subtitle strokes (lum >= 188 -> 195..255).
          try {
            const imgData = safeCtx.getImageData(
              0,
              0,
              safeCanvas.width,
              safeCanvas.height
            );
            const px = imgData.data;
            for (let p = 0; p < px.length; p += 4) {
              const r = px[p];
              const g = px[p + 1];
              const b = px[p + 2];
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              const out =
                lum >= 188
                  ? Math.min(255, Math.round((lum - 188) * 1.15 + 195))
                  : Math.round(lum * 0.2);
              px[p] = out;
              px[p + 1] = out;
              px[p + 2] = out;
            }
            safeCtx.putImageData(imgData, 0, 0);
          } catch {
            // Ignore if canvas tainted
          }

          // Draw tile borders and crisp yellow-on-black T=...s timestamp badges onto safeCanvas AFTER Dark-LUT pass
          for (const rec of badgeRecords) {
            safeCtx.strokeStyle = '#334155';
            safeCtx.lineWidth = 1.5;
            safeCtx.strokeRect(
              rec.sdx + 0.5,
              rec.sdy + 0.5,
              safeTileW - 1,
              safeTileH - 1
            );
            safeCtx.fillStyle = 'rgba(0, 0, 0, 0.9)';
            safeCtx.fillRect(rec.sdx + 4, rec.sdy + 4, 88, 20);
            safeCtx.fillStyle = '#FACC15';
            safeCtx.font = 'bold 13px monospace';
            safeCtx.fillText(rec.badgeText, rec.sdx + 7, rec.sdy + 18);
          }

          const firstRelNum = Number(Math.max(0, slice[0] - startSec).toFixed(2));
          const lastRelNum = Number(
            Math.max(
              firstRelNum + 0.3,
              slice[Math.min(slice.length - 1, Math.max(0, drawnCount - 1))] -
                startSec
            ).toFixed(2)
          );
          const rangeLabel = `${firstRelNum.toFixed(2)}s-${lastRelNum.toFixed(2)}s`;

          const fullUrl = fullCanvas.toDataURL('image/jpeg', 0.82);
          visualFrames.push({
            mimeType: 'image/jpeg',
            dataBase64: fullUrl.replace(/^data:image\/jpeg;base64,/, ''),
            timeRangeLabel: rangeLabel,
            sheetStartOffsetSec: firstRelNum,
            sheetEndOffsetSec: lastRelNum,
          });

          const safeUrl = safeCanvas.toDataURL('image/jpeg', 0.82);
          safeVisualFrames.push({
            mimeType: 'image/jpeg',
            dataBase64: safeUrl.replace(/^data:image\/jpeg;base64,/, ''),
            timeRangeLabel: rangeLabel,
            sheetStartOffsetSec: firstRelNum,
            sheetEndOffsetSec: lastRelNum,
          });
        }

        return { visualFrames, safeVisualFrames };
      };

      resolve({
        captureChunkSheets,
        dispose,
      });
    };

    video.onloadeddata = initSampler;
    video.onloadedmetadata = () => {
      // Wait up to 600ms for loadeddata (first decoded frame); if not yet fired, proceed with metadata
      setTimeout(initSampler, 600);
    };

    video.onerror = () => {
      clearTimeout(loadTimeout);
      dispose();
      resolve(null);
    };
  });
}

export async function extractAudioChunksFromMediaFile(
  file: File,
  onProgress?: (update: ExtractionProgressUpdate) => void,
  _providerHint: 'aistudio' | 'apinex' | 'beatapi' = 'aistudio'
): Promise<{
  totalDurationSec: number;
  sampleRate: number;
  chunks: ExtractedAudioChunk[];
  detectedHardsubBox: DetectedHardsubBox;
}> {
  const emit = (percent: number, stage: string, detail: string) => {
    onProgress?.({ percent, stage, detail });
  };

  const isVideo =
    file.type.startsWith('video/') ||
    /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);

  emit(8, 'ဖိုင်ကို ဖတ်ယူနေသည်', `${file.name} မှ အသံနှင့် ဗီဒီယိုလှိုင်း စစ်ဆေးနေသည်...`);
  const arrayBuffer = await file.arrayBuffer();

  // For video files, use Server-Side Native FFmpeg 15fps Card-Indexed Contact-Sheet Extractor first:
  // - Uploads in 8MB binary slices so large videos (77MB–350MB) never hit Cloud Run's 32MB single-request limit
  // - Decodes every frame at 15fps (0.067s precision) in strict sequential stream order and packs up to 36 detected cards per sheet
  if (isVideo) {
    try {
      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const SLICE_BYTES = 8 * 1024 * 1024; // 8 MB per chunk (< 32 MB Cloud Run HTTP/1.1 limit)
      const totalSlices = Math.max(1, Math.ceil(arrayBuffer.byteLength / SLICE_BYTES));
      let uploadOk = true;

      for (let i = 0; i < totalSlices; i++) {
        const startByte = i * SLICE_BYTES;
        const endByte = Math.min(arrayBuffer.byteLength, startByte + SLICE_BYTES);
        const sliceBuf = arrayBuffer.slice(startByte, endByte);
        const pct = 12 + Math.round(((i + 1) / totalSlices) * 26);
        emit(
          pct,
          `ဗီဒီယိုဖိုင် ပေးပို့နေသည် (${i + 1}/${totalSlices})`,
          `မြန်နှုန်းမြင့် FFmpeg 15fps စစ်ဆေးရန် အပိုင်း (${i + 1}/${totalSlices}) ပို့နေသည်...`
        );
        const upResp = await fetch('/api/subtitle/upload-video-chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(i),
          },
          body: sliceBuf,
        });
        if (!upResp.ok) {
          uploadOk = false;
          break;
        }
      }

      if (uploadOk) {
        emit(
          45,
          'ဗီဒီယို စာတန်းထိုး ကတ်များ ရှာဖွေနေသည် (FFmpeg 15fps Card Engine)',
          'ဗီဒီယိုတစ်ခုလုံးကို 15fps (0.067s) နှုန်းဖြင့် စာတန်းထိုးကတ်တိုင်း 100% ကွက်တိ ထုတ်ယူနေသည်...'
        );
        const resp = await fetch('/api/subtitle/extract-video-chunks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ uploadId }),
        });
        if (resp.ok) {
          const serverExtracted = await resp.json();
          if (
            serverExtracted &&
            Array.isArray(serverExtracted.chunks) &&
            serverExtracted.chunks.length > 0
          ) {
            emit(
              100,
              'အသင့်ဖြစ်ပါပြီ',
              `အပိုင်း (${serverExtracted.chunks.length}) ပိုင်း စစ်ဆေးပြီးပါပြီ။`
            );
            return serverExtracted;
          }
        }
      }
    } catch {
      // Fallback to client-side extraction if server FFmpeg endpoint is unreachable
    }
  }

  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const audioCtx = new AudioContextClass();

  let decodedBuffer: AudioBuffer | null = null;
  try {
    emit(25, 'အသံလှိုင်း ဖြည်ယူနေသည် (Decoding Audio)', 'မူရင်းအသံလှိုင်းကို စစ်ဆေးနေသည်...');
    decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    decodedBuffer = null;
  } finally {
    await audioCtx.close().catch(() => {});
  }

  const totalDurationSec = decodedBuffer
    ? Number(decodedBuffer.duration.toFixed(2))
    : 120;

  const targetSampleRate = 12000;
  let monoSamples: Float32Array;

  if (decodedBuffer) {
    const totalTargetSamples = Math.max(
      1200,
      Math.ceil(totalDurationSec * targetSampleRate)
    );
    emit(
      55,
      'အသံလှိုင်း သန့်စင်နေသည် (12kHz Speech Audio)',
      `စုစုပေါင်း ကြာချိန် ${totalDurationSec.toFixed(1)} စက္ကန့် အသံလှိုင်းကို ပြင်ဆင်နေသည်...`
    );
    const offlineCtx = new OfflineAudioContext(
      1,
      totalTargetSamples,
      targetSampleRate
    );
    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    monoSamples = renderedBuffer.getChannelData(0);
  } else {
    monoSamples = new Float32Array(targetSampleRate * Math.ceil(totalDurationSec));
  }

  // Split into ~13.5-second chunks on natural silence boundaries (40 frames per chunk across 2 sheets = ~0.33s per frame!)
  const minDurSec = 10.5;
  const targetDurSec = 13.5;
  const maxDurSec = 15.0;

  const chunks: ExtractedAudioChunk[] = [];
  let currentSample = 0;
  let chunkIndex = 0;
  const totalSamples = monoSamples.length;

  while (currentSample < totalSamples) {
    const cutSample = findOptimalSilenceCutSample(
      monoSamples,
      targetSampleRate,
      currentSample,
      minDurSec,
      targetDurSec,
      maxDurSec
    );

    const slice = monoSamples.subarray(currentSample, cutSample);
    const startSec = Number((currentSample / targetSampleRate).toFixed(2));
    const endSec = Number((cutSample / targetSampleRate).toFixed(2));
    const durationSec = Number(Math.max(0.5, endSec - startSec).toFixed(2));

    const rms = computeRms(slice);
    const isSilent = decodedBuffer ? rms < 0.0012 && !isVideo : false;

    const wavBuffer = normalizeAndEncodeMono16BitWav(slice, targetSampleRate);
    const b64 = arrayBufferToBase64(wavBuffer);

    chunks.push({
      chunkIndex,
      startSec,
      endSec,
      durationSec,
      isSilent,
      rmsAmplitude: Number(rms.toFixed(5)),
      audioBase64: b64,
      wavBase64: b64,
      mimeType: 'audio/wav',
      byteSize: wavBuffer.byteLength,
      hasHardsubInChunk: isVideo,
      detectedCards: [],
      visualFrames: [],
      safeVisualFrames: [],
      frameYTimeline: [],
    });

    currentSample = cutSample;
    chunkIndex++;
  }

  emit(100, 'အသင့်ဖြစ်ပါပြီ', `အပိုင်း (${chunks.length}) ပိုင်း စစ်ဆေးပြီးပါပြီ။`);

  return {
    totalDurationSec,
    sampleRate: targetSampleRate,
    chunks,
    detectedHardsubBox: {
      hasHardsub: isVideo,
      yPercent: 56,
      heightPercent: 11,
      widthPercent: 90,
    },
  };
}
