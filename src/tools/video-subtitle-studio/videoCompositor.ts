import { SubtitleCue } from '../../types/studio';

export interface VideoRenderSettings {
  /** Blur the original hardcoded subtitle region (NO black background box) */
  blurHardsub: boolean;
  /** 'always' blurs the subtitle strip throughout the video; 'active_only' blurs only when a cue is active */
  blurMode: 'always' | 'active_only';
  /** Vertical center of the blur strip as % of video height (e.g. 64 or 84) */
  blurYPercent: number;
  /** Height of the blur strip as % of video height (e.g. 11) */
  blurHeightPercent: number;
  /** Width of the blur strip as % of video width (e.g. 88) */
  blurWidthPercent: number;
  /** Blur intensity (1 to 30) */
  blurStrength: number;
  /** Show dashed guide around the blur/subtitle zone while dragging or adjusting */
  showBlurGuide: boolean;

  /** Which subtitle text to render onto the video */
  overlayMode: 'translated' | 'bilingual' | 'original' | 'off';
  /** Vertical center of the rendered subtitle text as % of video height (e.g. 64 or 84) */
  subYPercent: number;
  /** Font size as % of video height (e.g. 4.3) */
  fontSizePercent: number;
  /** Primary subtitle text color (e.g. '#FFFFFF' or '#FACC15') */
  textColor: string;
  /** Crisp letter outline stroke color (no black background box!) */
  strokeColor: string;
  /** Letter outline stroke thickness in reference 720p pixels (e.g. 4.5) */
  strokeWidth: number;
}

export const DEFAULT_VIDEO_RENDER_SETTINGS: VideoRenderSettings = {
  blurHardsub: true,
  blurMode: 'always',
  blurYPercent: 78,
  blurHeightPercent: 11,
  blurWidthPercent: 88,
  blurStrength: 16,
  showBlurGuide: false,
  overlayMode: 'translated',
  subYPercent: 78,
  fontSizePercent: 4.2,
  textColor: '#FACC15',
  strokeColor: '#000000',
  strokeWidth: 4.5,
};

let scratchBlurCanvas: HTMLCanvasElement | null = null;
let scratchBlurCtx: CanvasRenderingContext2D | null = null;

function getScratchBlurCanvas(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  if (!scratchBlurCanvas) {
    scratchBlurCanvas = document.createElement('canvas');
    scratchBlurCtx = scratchBlurCanvas.getContext('2d');
  }
  return {
    canvas: scratchBlurCanvas,
    ctx: scratchBlurCtx!,
  };
}

/**
 * Computes pixel coordinates (bx, by, bw, bh) of the hardcoded subtitle blur strip
 * guaranteed to be even integers within video bounds (for both Canvas & FFmpeg).
 */
export function computeBlurRectPixels(
  width: number,
  height: number,
  settings: VideoRenderSettings,
  overrideYPercent?: number
): { bx: number; by: number; bw: number; bh: number } {
  const effectiveY =
    typeof overrideYPercent === 'number' ? overrideYPercent : settings.blurYPercent;
  const rawW = Math.round(
    (width * Math.max(10, Math.min(100, settings.blurWidthPercent))) / 100
  );
  const rawH = Math.round(
    (height * Math.max(3, Math.min(40, settings.blurHeightPercent))) / 100
  );
  const bw = Math.max(16, Math.min(width - 4, rawW - (rawW % 2)));
  const bh = Math.max(12, Math.min(height - 4, rawH - (rawH % 2)));

  const centerX = width / 2;
  const centerY = (height * Math.max(5, Math.min(96, effectiveY))) / 100;

  let bx = Math.round(centerX - bw / 2);
  let by = Math.round(centerY - bh / 2);

  bx = Math.max(0, Math.min(width - bw, bx - (bx % 2)));
  by = Math.max(0, Math.min(height - bh, by - (by % 2)));

  return { bx, by, bw, bh };
}

/**
 * Cleans trailing periods (。/.) so subtitles look like professional cinema/drama subtitles
 * and never leave a floating period at the end.
 */
function cleanSubtitleDisplayLine(raw: string): string {
  return raw
    .trim()
    .replace(/[。．]+$/g, '')
    .replace(/\.+$/g, (m) => (m.length >= 3 ? '...' : ''))
    .trim();
}

/**
 * Smart text line wrapper for Burmese, Chinese, and multilingual subtitles.
 * Prevents orphan punctuation (e.g. a lone "。" or "，" on a new line) and splits
 * naturally at clause boundaries when needed.
 */
function wrapSubtitleLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => cleanSubtitleDisplayLine(l))
    .filter(Boolean);
  const finalLines: string[] = [];

  const PUNCT_ONLY_RE = /^[，。！？、；：,.!?;:的和了啦呢吗呀哦喔”’》）\]\u104A\u104B]+$/;

  for (const rawLine of rawLines) {
    if (ctx.measureText(rawLine).width <= maxWidth * 1.04) {
      finalLines.push(rawLine);
      continue;
    }

    // First try splitting at natural clause comma/space if present
    const clauseParts = rawLine
      .split(/(?<=[，,；;！!？?\u104A\u104B])\s*/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (clauseParts.length === 2) {
      const p1 = clauseParts[0].replace(/[，,；;]$/g, '').trim();
      const p2 = cleanSubtitleDisplayLine(clauseParts[1]);
      if (
        p1 &&
        p2 &&
        ctx.measureText(p1).width <= maxWidth * 1.05 &&
        ctx.measureText(p2).width <= maxWidth * 1.05
      ) {
        finalLines.push(p1, p2);
        continue;
      }
    }

    // Token-based wrapping (words for spaced scripts, characters for CJK/Myanmar)
    const hasSpaces = rawLine.includes(' ');
    const tokens = hasSpaces ? rawLine.split(/\s+/) : Array.from(rawLine);
    const joiner = hasSpaces ? ' ' : '';

    const wrapped: string[] = [];
    let current = '';

    for (const token of tokens) {
      const candidate = current ? `${current}${joiner}${token}` : token;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        // Never start a new line with a punctuation mark or single particle
        if (PUNCT_ONLY_RE.test(token)) {
          current = candidate;
        } else {
          wrapped.push(current.replace(/[，,]$|^[,，]/g, '').trim());
          current = token;
        }
      } else {
        current = candidate;
      }
    }
    if (current) {
      wrapped.push(cleanSubtitleDisplayLine(current));
    }

    // Prevent 1-2 character orphan tail lines by merging back into previous line
    if (wrapped.length >= 2) {
      const last = wrapped[wrapped.length - 1];
      if (Array.from(last).length <= 2) {
        wrapped[wrapped.length - 2] = `${wrapped[wrapped.length - 2]}${joiner}${last}`;
        wrapped.pop();
      }
    }

    for (const w of wrapped) {
      if (w) finalLines.push(w);
    }
  }

  return finalLines.slice(0, 3);
}

/**
 * Draws ONLY the crisp outlined subtitle text (with ZERO black background box)
 * onto the given 2D canvas context.
 * Used identically by both the Live Preview Canvas and the FFmpeg PNG overlay generator!
 */
export function drawSubtitleTextOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cue: SubtitleCue | undefined | null,
  settings: VideoRenderSettings
): void {
  if (!cue || settings.overlayMode === 'off') return;

  const orig = cleanSubtitleDisplayLine(cue.originalText || '');
  const trans = cleanSubtitleDisplayLine(cue.translatedText || '');

  let primaryText = '';
  let secondaryText = '';

  if (settings.overlayMode === 'original') {
    primaryText = orig;
  } else if (settings.overlayMode === 'translated') {
    primaryText = trans || orig;
  } else if (settings.overlayMode === 'bilingual') {
    primaryText = trans || orig;
    secondaryText = trans && orig && trans !== orig ? orig : '';
  }

  if (!primaryText) return;

  const isPortrait = height > width * 1.1;
  // Scale font size naturally for both 9:16 vertical and 16:9 horizontal videos
  const effectiveHeightBasis = isPortrait ? width * 1.15 : height;
  const fontPx = Math.max(
    15,
    Math.round(
      (effectiveHeightBasis *
        Math.max(2.2, Math.min(9.0, settings.fontSizePercent))) /
        100
    )
  );
  const secondaryFontPx = Math.max(12, Math.round(fontPx * 0.74));
  const maxWidth = width * 0.9;
  const scaleFactor = effectiveHeightBasis / 720;
  const strokePx = Math.max(2.5, settings.strokeWidth * scaleFactor);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  ctx.font = `700 ${fontPx}px "Padauk", "Pyidaungsu", "Noto Sans Myanmar", "Plus Jakarta Sans", system-ui, sans-serif`;
  const primaryLines = wrapSubtitleLines(ctx, primaryText, maxWidth);

  let secondaryLines: string[] = [];
  if (secondaryText) {
    ctx.font = `600 ${secondaryFontPx}px "Padauk", "Pyidaungsu", "Noto Sans Myanmar", "Plus Jakarta Sans", system-ui, sans-serif`;
    secondaryLines = wrapSubtitleLines(ctx, secondaryText, maxWidth).slice(0, 2);
  }

  const lineHeight = fontPx * 1.28;
  const secLineHeight = secondaryFontPx * 1.24;
  const totalBlockHeight =
    primaryLines.length * lineHeight +
    (secondaryLines.length > 0 ? secondaryLines.length * secLineHeight + 4 : 0);

  const effectiveSubY =
    typeof cue.customYPercent === 'number'
      ? cue.customYPercent
      : settings.subYPercent;
  const centerY = (height * Math.max(8, Math.min(95, effectiveSubY))) / 100;
  let cursorY = centerY - totalBlockHeight / 2 + lineHeight / 2;

  // Draw Primary Subtitle Lines (Crisp Double-Pass Stroke + Fill, NO black box!)
  ctx.font = `700 ${fontPx}px "Padauk", "Pyidaungsu", "Noto Sans Myanmar", "Plus Jakarta Sans", system-ui, sans-serif`;
  for (const line of primaryLines) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
    ctx.shadowBlur = Math.max(3, Math.round(4 * scaleFactor));
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(1, Math.round(1.5 * scaleFactor));

    ctx.strokeStyle = settings.strokeColor || '#000000';
    ctx.lineWidth = strokePx * 1.4;
    ctx.strokeText(line, width / 2, cursorY);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = strokePx;
    ctx.strokeText(line, width / 2, cursorY);

    ctx.fillStyle = settings.textColor || '#FACC15';
    ctx.fillText(line, width / 2, cursorY);

    cursorY += lineHeight;
  }

  // Draw Secondary Line if Bilingual
  if (secondaryLines.length > 0) {
    cursorY += 2;
    ctx.font = `600 ${secondaryFontPx}px "Padauk", "Pyidaungsu", "Noto Sans Myanmar", "Plus Jakarta Sans", system-ui, sans-serif`;
    for (const sLine of secondaryLines) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
      ctx.shadowBlur = 3;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(2, strokePx * 0.85);
      ctx.strokeText(sLine, width / 2, cursorY);

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(sLine, width / 2, cursorY);

      cursorY += secLineHeight;
    }
  }

  ctx.restore();
}

/**
 * Master WYSIWYG Video Frame Compositor.
 * Renders:
 * 1) Video frame
 * 2) Soft natural pixel blur over the hardcoded subtitle zone (NO black box!)
 * 3) Crisp outlined Burmese / Translated subtitle text
 */
export function renderCompositedVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  activeCue: SubtitleCue | undefined | null,
  settings: VideoRenderSettings,
  isExportPass = false
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  if (width <= 0 || height <= 0) return;

  // Always clear the canvas first so previous subtitle text or guide lines NEVER stack or smear!
  ctx.clearRect(0, 0, width, height);

  // During export pass, draw the base video frame onto the export canvas.
  // (In live preview, the native <video> element is visibly rendered directly behind <canvas> for 100% hardware-decoded reliability on mobile browsers.)
  if (isExportPass && video.readyState >= 2) {
    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch {
      // ignore transient decode state
    }
  }

  const effectiveBlurY =
    typeof activeCue?.customYPercent === 'number'
      ? activeCue.customYPercent
      : settings.blurYPercent;

  // 2. Blur hardcoded subtitle region (strictly sampled from visible <video>, never from ctx.canvas!)
  const shouldBlurNow =
    settings.blurHardsub &&
    (settings.blurMode === 'always' || Boolean(activeCue));

  if (shouldBlurNow && video.readyState >= 2 && video.videoWidth > 0) {
    try {
      const { bx, by, bw, bh } = computeBlurRectPixels(
        width,
        height,
        settings,
        effectiveBlurY
      );
      const { canvas: sCanvas, ctx: sCtx } = getScratchBlurCanvas();

      const downFactor = Math.max(
        4,
        Math.min(28, Math.round(settings.blurStrength * 0.95))
      );
      const smallW = Math.max(4, Math.round(bw / downFactor));
      const smallH = Math.max(3, Math.round(bh / downFactor));

      if (sCanvas.width !== smallW || sCanvas.height !== smallH) {
        sCanvas.width = smallW;
        sCanvas.height = smallH;
      }

      sCtx.imageSmoothingEnabled = true;
      sCtx.imageSmoothingQuality = 'high';
      sCtx.clearRect(0, 0, smallW, smallH);
      // Strictly sample from `video` (NEVER from `ctx.canvas`, which would cause feedback smearing!)
      sCtx.drawImage(video, bx, by, bw, bh, 0, 0, smallW, smallH);

      ctx.save();
      ctx.beginPath();
      const radius = Math.min(10, bh / 4);
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(bx, by, bw, bh, radius);
      } else {
        ctx.rect(bx, by, bw, bh);
      }
      ctx.clip();

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sCanvas, 0, 0, smallW, smallH, bx, by, bw, bh);
      ctx.restore();
    } catch {
      // ignore
    }
  }

  // Optional dashed guide when user is actively dragging/adjusting position on Preview
  if (settings.showBlurGuide && !isExportPass) {
    const { bx, by, bw, bh } = computeBlurRectPixels(
      width,
      height,
      settings,
      effectiveBlurY
    );
    ctx.save();
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
    ctx.lineWidth = Math.max(2, Math.round(width / 320));
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
  }

  // 3. Draw crisp outlined subtitle text on top
  drawSubtitleTextOnCanvas(ctx, width, height, activeCue, settings);
}

/**
 * Generates a transparent PNG (base64 without data: prefix) for a single cue
 * at the exact target video resolution so FFmpeg overlays the 100% identical text!
 */
export function generateSubtitleOverlayPngBase64(
  width: number,
  height: number,
  cue: SubtitleCue | null,
  settings: VideoRenderSettings
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  if (cue) {
    drawSubtitleTextOnCanvas(ctx, width, height, cue, settings);
  }
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
