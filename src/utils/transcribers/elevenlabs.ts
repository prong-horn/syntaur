import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TranscribeFfmpegError,
  TranscribeFfmpegMissingError,
  TranscribeNoAudioError,
  type TranscribeOptions,
  type Transcriber,
  type TranscriptWordsJson,
} from './index.js';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

const NO_AUDIO_MARKERS = [
  "Stream map '0:a:0' matches no streams",
  'does not contain any stream',
  'Output file does not contain any stream',
];

type FfmpegRunResult = { code: number; stderr: string };

function runFfmpeg(args: string[]): Promise<FfmpegRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code: code ?? -1, stderr });
    });
  });
}

export async function extractAudio(videoAbsPath: string, wavOut: string): Promise<void> {
  let result: FfmpegRunResult;
  try {
    result = await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoAbsPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      wavOut,
    ]);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
      throw new TranscribeFfmpegMissingError(
        "ffmpeg not found — install via 'brew install ffmpeg'",
      );
    }
    throw err;
  }

  if (result.code === 0) return;

  if (NO_AUDIO_MARKERS.some((m) => result.stderr.includes(m))) {
    throw new TranscribeNoAudioError();
  }

  const tail = result.stderr.slice(-200).trim();
  throw new TranscribeFfmpegError(`ffmpeg failed (exit ${result.code}): ${tail}`);
}

async function callScribe(
  wavPath: string,
  apiKey: string,
  opts: TranscribeOptions,
): Promise<TranscriptWordsJson> {
  const audio = await readFile(wavPath);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.set('model_id', 'scribe_v1');
  form.set('diarize', 'true');
  form.set('tag_audio_events', 'true');
  form.set('timestamps_granularity', 'word');
  if (opts.language) form.set('language_code', opts.language);

  const resp = await fetch(SCRIBE_URL, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs Scribe HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }

  return (await resp.json()) as TranscriptWordsJson;
}

export const elevenLabsScribe: Transcriber = {
  id: 'elevenlabs-scribe',
  async transcribe(videoAbsPath, opts = {}) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ELEVENLABS_API_KEY is not set. Export it (e.g. `export ELEVENLABS_API_KEY=…`) and re-run. A config-file slot will land later.',
      );
    }

    const tmp = await mkdtemp(join(tmpdir(), 'syntaur-transcribe-'));
    const wav = join(tmp, 'audio.wav');
    try {
      await extractAudio(videoAbsPath, wav);
      return await callScribe(wav, apiKey, opts);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};
