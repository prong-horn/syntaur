/**
 * Chat image attachments — stored under `<ticket>/chat/attachments/`.
 * Upload is raw bytes (see `POST …/chat/attachments`); the validated
 * `x-attachment-mime` header decides the on-disk extension.
 */

import { mkdir, readdir, readFile, rename, lstat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { chatDir } from './store.js';

export function sanitizeAttachmentName(name: string): string {
  // Drop quotes, backslash, and forward slash (defense for both the stored filename
  // and the eventual Content-Disposition header).
  let n = basename(name || '').replace(/["'\\/]/g, '_');
  // Replace control chars and DEL by code point (avoids embedding control-char
  // literals in the source / a no-control-regex lint).
  n = Array.from(n, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? '_' : ch;
  }).join('');
  n = n.trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.length > 120) {
    const ext = extname(n);
    n = n.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  return n;
}

export class ChatAttachmentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChatAttachmentError';
    this.status = status;
  }
}

export const CHAT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS = 4;

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const ATTACHMENT_ID_RE = /^[0-9a-f-]{36}$/;

export interface ChatAttachmentRecord {
  id: string;
  mimeType: string;
  bytes: number;
  name: string;
}

export interface ResolvedChatAttachment {
  path: string;
  mimeType: string;
  bytes: number;
  name: string;
}

export function chatAttachmentsDir(ticketDir: string): string {
  return resolve(chatDir(ticketDir), 'attachments');
}

export async function writeChatAttachment(
  ticketDir: string,
  input: { name: string; mime: string; bytes: Buffer },
): Promise<ChatAttachmentRecord> {
  if (!CHAT_IMAGE_MIMES.has(input.mime)) {
    throw new ChatAttachmentError(400, `Unsupported mime type: ${input.mime}`);
  }
  const ext = MIME_EXT[input.mime];
  if (!ext) {
    throw new ChatAttachmentError(400, `Unsupported mime type: ${input.mime}`);
  }
  if (!input.bytes.length) {
    throw new ChatAttachmentError(400, 'Empty upload body');
  }

  const dir = chatAttachmentsDir(ticketDir);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const name = sanitizeAttachmentName(input.name);
  const stored = `${id}__${name}.${ext}`;
  const finalPath = resolve(dir, stored);
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, input.bytes);
  await rename(tempPath, finalPath);
  return { id, mimeType: input.mime, bytes: input.bytes.length, name };
}

export async function resolveChatAttachment(
  ticketDir: string,
  id: string,
): Promise<ResolvedChatAttachment | null> {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  const dir = chatAttachmentsDir(ticketDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const prefix = `${id}__`;
  const stored = names.find((n) => n.startsWith(prefix) && !n.endsWith('.tmp'));
  if (!stored) return null;
  const path = resolve(dir, stored);
  try {
    const st = await lstat(path);
    if (!st.isFile()) return null;
    const ext = extname(stored).slice(1).toLowerCase();
    const mimeType = EXT_MIME[ext] ?? 'application/octet-stream';
    const afterPrefix = stored.slice(prefix.length);
    const displayName = basename(afterPrefix, extname(afterPrefix));
    return { path, mimeType, bytes: st.size, name: displayName };
  } catch {
    return null;
  }
}

export async function readChatAttachmentBase64(
  ticketDir: string,
  id: string,
): Promise<{ data: string; mimeType: string; name: string } | null> {
  const resolved = await resolveChatAttachment(ticketDir, id);
  if (!resolved) return null;
  const data = await readFile(resolved.path);
  return { data: data.toString('base64'), mimeType: resolved.mimeType, name: resolved.name };
}
