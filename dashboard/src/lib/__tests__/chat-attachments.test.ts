import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS,
  acceptImageFile,
  attachmentUploadName,
  extractImagesFromDataTransfer,
  refusalMessage,
  type PendingImage,
} from '../chat-attachments';

function file(name: string, type: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('acceptImageFile', () => {
  const empty: PendingImage[] = [];

  it('accepts a supported image within limits', () => {
    expect(acceptImageFile(file('a.png', 'image/png'), empty)).toEqual({ ok: true });
  });

  it('refuses unsupported mime types', () => {
    const result = acceptImageFile(file('x.svg', 'image/svg+xml'), empty);
    expect(result).toEqual({ ok: false, reason: 'type' });
    expect(refusalMessage('type')).toContain('PNG');
  });

  it('refuses files over 10 MB', () => {
    expect(acceptImageFile(file('big.png', 'image/png', MAX_CHAT_ATTACHMENT_BYTES + 1), empty)).toEqual({
      ok: false,
      reason: 'size',
    });
  });

  it('refuses a fifth image', () => {
    const current = Array.from({ length: MAX_CHAT_ATTACHMENTS }, (_, i) => ({
      key: String(i),
      file: file(`${i}.png`, 'image/png'),
      name: `${i}.png`,
      mimeType: 'image/png',
      bytes: 1,
      previewUrl: `blob:${i}`,
    }));
    expect(acceptImageFile(file('five.png', 'image/png'), current)).toEqual({
      ok: false,
      reason: 'count',
    });
  });

  it('refuses duplicate name and size', () => {
    const current: PendingImage[] = [
      {
        key: '1',
        file: file('dup.png', 'image/png', 42),
        name: 'dup.png',
        mimeType: 'image/png',
        bytes: 42,
        previewUrl: 'blob:1',
      },
    ];
    expect(acceptImageFile(file('dup.png', 'image/png', 42), current)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('extractImagesFromDataTransfer', () => {
  it('returns image files from items', () => {
    const png = file('a.png', 'image/png');
    const text = file('note.txt', 'text/plain');
    const dt = {
      items: [
        { kind: 'file', getAsFile: () => png },
        { kind: 'file', getAsFile: () => text },
        { kind: 'string', getAsFile: () => null },
      ],
    } as unknown as DataTransfer;
    expect(extractImagesFromDataTransfer(dt).map((f) => f.name)).toEqual(['a.png']);
  });
});

describe('attachmentUploadName', () => {
  it('matches the encoded mime extension', () => {
    expect(attachmentUploadName('photo.jpg', 'image/png')).toBe('photo.png');
    expect(attachmentUploadName('shot.webp', 'image/jpeg')).toBe('shot.jpeg');
    expect(attachmentUploadName('anim.gif', 'image/gif')).toBe('anim.gif');
  });
});
