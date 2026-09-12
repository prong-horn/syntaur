import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  resolveChatAttachment,
  sanitizeAttachmentName,
  writeChatAttachment,
} from '../chat/attachments.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('sanitizeAttachmentName', () => {
  it('keeps a plain filename', () => {
    expect(sanitizeAttachmentName('screenshot.png')).toBe('screenshot.png');
  });

  it('strips path separators and dots', () => {
    expect(sanitizeAttachmentName('../evil/../../name.png')).toBe('name.png');
    expect(sanitizeAttachmentName('foo\\bar.png')).toBe('foo_bar.png');
  });

  it('falls back for empty or dotfile input', () => {
    expect(sanitizeAttachmentName('')).toBe('file');
    expect(sanitizeAttachmentName('.')).toBe('file');
    expect(sanitizeAttachmentName('..')).toBe('file');
  });
});

describe('resolveChatAttachment', () => {
  it('ignores .tmp siblings and serves the real file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-att-'));
    const ticketDir = join(root, 'ticket');
    const att = await writeChatAttachment(ticketDir, {
      name: 'dot.png',
      mime: 'image/png',
      bytes: PNG_1X1,
    });
    const attDir = join(ticketDir, 'chat', 'attachments');
    const realName = `${att.id}__dot.png.png`;
    await writeFile(join(attDir, `${realName}.${randomUUID()}.tmp`), Buffer.from('leftover'));

    const resolved = await resolveChatAttachment(ticketDir, att.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.bytes).toBe(PNG_1X1.length);
    expect(resolved!.mimeType).toBe('image/png');
  });
});
