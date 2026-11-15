import { SubtitleCue } from '../../types/studio';

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

function pad3(n: number): string {
  return String(Math.floor(n)).padStart(3, '0');
}

export function formatTimestampDisplay(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 100);
  if (hrs > 0) {
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad2(ms)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}.${pad2(ms)}`;
}

export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)},${pad3(ms)}`;
}

export function formatVttTimestamp(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad3(ms)}`;
}

export function exportToSrt(
  cues: SubtitleCue[],
  mode: 'translated' | 'bilingual' | 'original'
): string {
  return cues
    .map((cue, idx) => {
      const start = formatSrtTimestamp(cue.startSec);
      const end = formatSrtTimestamp(cue.endSec);
      let body = cue.translatedText || cue.originalText;
      if (mode === 'original') {
        body = cue.originalText;
      } else if (mode === 'bilingual') {
        body = cue.translatedText
          ? `${cue.translatedText}\n${cue.originalText}`
          : cue.originalText;
      }
      return `${idx + 1}\n${start} --> ${end}\n${body}\n`;
    })
    .join('\n');
}

export function exportToVtt(
  cues: SubtitleCue[],
  mode: 'translated' | 'bilingual' | 'original'
): string {
  const blocks = cues.map((cue, idx) => {
    const start = formatVttTimestamp(cue.startSec);
    const end = formatVttTimestamp(cue.endSec);
    let body = cue.translatedText || cue.originalText;
    if (mode === 'original') {
      body = cue.originalText;
    } else if (mode === 'bilingual') {
      body = cue.translatedText
        ? `${cue.translatedText}\n${cue.originalText}`
        : cue.originalText;
    }
    return `${idx + 1}\n${start} --> ${end}\n${body}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

export function exportToPlainText(
  cues: SubtitleCue[],
  mode: 'original' | 'translated' | 'bilingual'
): string {
  return cues
    .map((cue, idx) => {
      const timeRange = `[${formatTimestampDisplay(cue.startSec)} -> ${formatTimestampDisplay(
        cue.endSec
      )}]`;
      const speakerPrefix = cue.speaker ? `${cue.speaker}: ` : '';
      if (mode === 'original') {
        return `${idx + 1}. ${timeRange} ${speakerPrefix}${cue.originalText}`;
      }
      if (mode === 'translated') {
        return `${idx + 1}. ${timeRange} ${speakerPrefix}${
          cue.translatedText || cue.originalText
        }`;
      }
      return `${idx + 1}. ${timeRange} ${speakerPrefix}\n   မူရင်း: ${
        cue.originalText
      }\n   ဘာသာပြန်: ${cue.translatedText || '—'}`;
    })
    .join('\n\n');
}
