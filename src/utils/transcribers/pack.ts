import type { TranscriptWord } from './index.js';

export type Phrase = {
  start: number;
  end: number;
  text: string;
  speakerId?: string;
};

const PUNCT_RE = /^[.,?!;:]$/;

// Mirrors ~/video-use/helpers/pack_transcripts.py:format_time — 6-char
// zero-padded width with two decimals (e.g. 1.5 → "001.50").
export function formatTime(seconds: number): string {
  const fixed = seconds.toFixed(2);
  return fixed.length >= 6 ? fixed : '0'.repeat(6 - fixed.length) + fixed;
}

// Port of pack_transcripts.py:group_into_phrases. Break on silence ≥ threshold
// (between consecutive kept tokens, OR via a long-gap 'spacing' entry) OR on
// speaker change. Re-attach trailing punctuation to the preceding word.
// Audio events are wrapped in parens.
export function groupIntoPhrases(
  words: TranscriptWord[],
  silenceThresholdSec = 0.5,
): Phrase[] {
  const phrases: Phrase[] = [];

  let currentWords: TranscriptWord[] = [];
  let currentStart: number | undefined;
  let currentSpeaker: string | undefined;
  let prevEnd: number | undefined;

  function flush(): void {
    if (currentWords.length === 0) return;
    const parts: string[] = [];
    for (const w of currentWords) {
      const t = w.type ?? 'word';
      let raw = (w.text ?? '').trim();
      if (!raw) continue;
      if (t === 'audio_event' && !raw.startsWith('(')) raw = `(${raw})`;
      parts.push(raw);
    }
    if (parts.length === 0) {
      currentWords = [];
      currentStart = undefined;
      currentSpeaker = undefined;
      return;
    }
    let text = parts.join(' ');
    text = text
      .replace(/ ,/g, ',')
      .replace(/ \./g, '.')
      .replace(/ \?/g, '?')
      .replace(/ !/g, '!');
    const last = currentWords[currentWords.length - 1];
    const endTime = last.end ?? last.start ?? currentStart ?? 0;
    phrases.push({
      start: currentStart ?? 0,
      end: endTime,
      text,
      speakerId: currentSpeaker,
    });
    currentWords = [];
    currentStart = undefined;
    currentSpeaker = undefined;
  }

  for (const w of words) {
    const t = w.type ?? 'word';

    if (t === 'spacing') {
      const start = w.start;
      const end = w.end;
      if (typeof start === 'number' && typeof end === 'number') {
        if (end - start >= silenceThresholdSec) flush();
      }
      continue;
    }

    const start = w.start;
    if (typeof start !== 'number') continue;

    const speaker = w.speaker_id;

    if (
      currentSpeaker !== undefined &&
      speaker !== undefined &&
      speaker !== currentSpeaker
    ) {
      flush();
    }

    if (prevEnd !== undefined && start - prevEnd >= silenceThresholdSec) {
      flush();
    }

    if (currentStart === undefined) {
      currentStart = start;
      currentSpeaker = speaker;
    }
    currentWords.push(w);
    prevEnd = w.end ?? start;
  }

  flush();
  return phrases;
}

// Port of pack_transcripts.py:render_markdown. Optional speaker tag: when
// `speakerId` is undefined, the `S<n>` segment is omitted (matches python
// behavior at pack_transcripts.py:150). Strips a leading "speaker_" prefix
// from the id, mirroring the python `spk_str[len("speaker_"):]` slice.
//
// Output: one line per phrase, two-space leading indent for code-block-style
// readability. Trailing newline at end of file.
export function renderMarkdown(phrases: Phrase[]): string {
  const lines: string[] = [];
  for (const p of phrases) {
    const start = formatTime(p.start);
    const end = formatTime(p.end);
    let speakerSegment = '';
    if (p.speakerId !== undefined) {
      const stripped = p.speakerId.startsWith('speaker_')
        ? p.speakerId.slice('speaker_'.length)
        : p.speakerId;
      speakerSegment = ` S${stripped}`;
    }
    lines.push(`  [${start}-${end}]${speakerSegment} ${p.text}`);
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export { PUNCT_RE };
