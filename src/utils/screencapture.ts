import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScreenshotMode = 'interactive' | 'window' | 'fullscreen';

export interface ScreenshotResult {
  pngPath: string;
  cleanup: () => Promise<void>;
}

function argsFor(mode: ScreenshotMode, pngPath: string): string[] {
  switch (mode) {
    case 'interactive':
      return ['-i', pngPath];
    case 'window':
      return ['-iWo', pngPath];
    case 'fullscreen':
      return ['-x', pngPath];
  }
}

function runScreencapture(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('screencapture', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code ?? -1);
    });
  });
}

export async function captureScreenshot(mode: ScreenshotMode): Promise<ScreenshotResult> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'screencapture is only available on macOS. Use --file <path> to attach an existing image.',
    );
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'syntaur-screenshot-'));
  const pngPath = join(tmpDir, 'shot.png');
  const cleanup = async (): Promise<void> => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    let code: number;
    try {
      code = await runScreencapture(argsFor(mode, pngPath));
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
        throw new Error(
          'screencapture binary not found. Is this macOS with the system utility on PATH?',
        );
      }
      throw err;
    }

    if (code !== 0) {
      throw new Error(`Screenshot canceled or failed (exit ${code}).`);
    }

    let size = 0;
    try {
      size = (await stat(pngPath)).size;
    } catch {
      throw new Error('screencapture exited 0 but produced no image.');
    }
    if (size === 0) {
      throw new Error('screencapture exited 0 but produced no image.');
    }

    return { pngPath, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
