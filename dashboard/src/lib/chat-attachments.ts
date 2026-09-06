/**
 * Browser-side helpers for chat image attachments. Pure validation and
 * DataTransfer parsing are unit-tested; downscaleImage needs canvas/Image.
 */

export const MAX_CHAT_ATTACHMENTS = 4;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface PendingImage {
  key: string;
  file: File;
  name: string;
  mimeType: string;
  bytes: number;
  previewUrl: string;
  width?: number;
  height?: number;
}

export type AcceptImageReason = 'type' | 'size' | 'count' | 'duplicate';

export function acceptImageFile(
  file: File,
  current: readonly PendingImage[],
): { ok: true } | { ok: false; reason: AcceptImageReason } {
  if (!ALLOWED_MIMES.has(file.type)) return { ok: false, reason: 'type' };
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) return { ok: false, reason: 'size' };
  if (current.length >= MAX_CHAT_ATTACHMENTS) return { ok: false, reason: 'count' };
  if (current.some((p) => p.name === file.name && p.bytes === file.size)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true };
}

export function refusalMessage(reason: AcceptImageReason): string {
  switch (reason) {
    case 'type':
      return 'Only PNG, JPEG, GIF and WebP images are accepted';
    case 'size':
      return 'Images must be 10 MB or smaller';
    case 'count':
      return 'At most four images per message';
    case 'duplicate':
      return 'That image is already attached';
  }
}

export function extractImagesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file || !ALLOWED_MIMES.has(file.type)) continue;
    out.push(file);
  }
  return out;
}

export async function downscaleImage(
  file: File,
  maxEdge = 2048,
): Promise<{ blob: Blob; width: number; height: number; mimeType: string }> {
  if (file.type === 'image/gif') {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return { blob: file, mimeType: file.type, ...size };
  }
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const scale = maxEdge / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const mimeType =
    file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp'
      ? file.type
      : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), mimeType);
  });
  const encodedMime = blob.type || mimeType;
  return { blob, width, height, mimeType: encodedMime };
}

export function chatAttachmentUrl(assignmentId: string, attachmentId: string): string {
  return `/api/assignments/${encodeURIComponent(assignmentId)}/chat/attachments/${encodeURIComponent(attachmentId)}`;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Pick an upload filename whose extension matches the encoded mime. */
export function attachmentUploadName(displayName: string, mimeType: string): string {
  const ext = MIME_EXT[mimeType] ?? 'png';
  const dot = displayName.lastIndexOf('.');
  const base = dot > 0 ? displayName.slice(0, dot) : displayName;
  return `${base}.${ext}`;
}
