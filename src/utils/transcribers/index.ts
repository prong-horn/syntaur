import { elevenLabsScribe } from './elevenlabs.js';

export type TranscriptWord = {
  text: string;
  start: number;
  end: number;
  type?: 'word' | 'spacing' | 'audio_event';
  speaker_id?: string;
};

export type TranscriptWordsJson = {
  language_code?: string;
  text?: string;
  words: TranscriptWord[];
};

export type TranscribeOptions = {
  language?: string;
};

export interface Transcriber {
  id: string;
  transcribe(videoAbsPath: string, opts?: TranscribeOptions): Promise<TranscriptWordsJson>;
}

export class TranscribeFfmpegMissingError extends Error {
  constructor(message = 'ffmpeg not found') {
    super(message);
    this.name = 'TranscribeFfmpegMissingError';
  }
}

export class TranscribeNoAudioError extends Error {
  constructor(message = 'video has no audio track') {
    super(message);
    this.name = 'TranscribeNoAudioError';
  }
}

export class TranscribeFfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscribeFfmpegError';
  }
}

const REGISTRY: Record<string, Transcriber> = {
  [elevenLabsScribe.id]: elevenLabsScribe,
};

export function getTranscriber(id: string = 'elevenlabs-scribe'): Transcriber {
  const t = REGISTRY[id];
  if (!t) throw new Error(`unknown transcriber: ${id}`);
  return t;
}
