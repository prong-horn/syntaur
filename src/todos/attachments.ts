// Todo file attachments — stored on disk, keyed by scope + todo id, and computed
// at read time. Deliberately NOT encoded in the markdown metadata token: that keeps
// the checklist parser untouched (no serialize/parse data-loss risk) and lets
// attachments survive any line rewrite.
//
// Layout: <todosDir>/attachments/<scopeId>/<todoId>/<attachmentId>__<sanitizedName>
//
// The <scopeId> segment is REQUIRED. The workspace router shares one todosDir
// (~/.syntaur/todos/) across every workspace checklist, and 4-hex todo ids are only
// unique within a single checklist — so two workspaces can both own `t:abcd`.
// scopeId = workspace name (incl. `_global`) or project slug.

import { mkdir, readdir, stat, rename, rm, unlink, writeFile, cp } from 'node:fs/promises';
import { resolve, basename, dirname, extname } from 'node:path';
import { generateArtifactId } from '../utils/proof-artifact-id.js';

export interface TodoAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

// --- Validation (traversal defense) -----------------------------------------

// scopeId matches the workspace name regex; project slugs satisfy it too.
const SCOPE_RE = /^[a-z0-9_][a-z0-9-]*$/;
const TODO_ID_RE = /^[a-f0-9]{4}$/;
// The shape produced by generateArtifactId(): base36 timestamp + '-' + 4 hex.
const ATTACHMENT_ID_RE = /^[a-z0-9]+-[0-9a-f]{4}$/;

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

function assertScope(scopeId: string): void {
  if (!SCOPE_RE.test(scopeId)) throw new AttachmentValidationError(`Invalid scope id: "${scopeId}"`);
}
function assertTodoId(todoId: string): void {
  if (!TODO_ID_RE.test(todoId)) throw new AttachmentValidationError(`Invalid todo id: "${todoId}"`);
}
function assertAttachmentId(attachmentId: string): void {
  if (!ATTACHMENT_ID_RE.test(attachmentId)) {
    throw new AttachmentValidationError(`Invalid attachment id: "${attachmentId}"`);
  }
}

// --- Mime inference + safe-serving policy ------------------------------------

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  zip: 'application/zip',
};

export function mimeForName(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

// Types we are willing to serve inline (rendered in-browser on our own origin).
// Everything else — notably image/svg+xml, text/html, *xml — is forced to download
// so user-supplied active content can never execute in the dashboard's origin.
const SAFE_INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

export function isSafeInlineMime(mime: string): boolean {
  return SAFE_INLINE_MIME.has(mime);
}

// Raster image types safe to render as a thumbnail (NOT svg).
const SAFE_THUMBNAIL_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isSafeThumbnailMime(mime: string): boolean {
  return SAFE_THUMBNAIL_MIME.has(mime);
}

// --- Name sanitization -------------------------------------------------------

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

// --- Paths -------------------------------------------------------------------

export function attachmentsRootDir(todosDir: string): string {
  return resolve(todosDir, 'attachments');
}

export function attachmentDirFor(todosDir: string, scopeId: string, todoId: string): string {
  assertScope(scopeId);
  assertTodoId(todoId);
  return resolve(attachmentsRootDir(todosDir), scopeId, todoId);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// --- Write / read / list -----------------------------------------------------

export async function writeAttachment(
  todosDir: string,
  scopeId: string,
  todoId: string,
  originalName: string,
  bytes: Buffer,
): Promise<TodoAttachment> {
  const dir = attachmentDirFor(todosDir, scopeId, todoId);
  await mkdir(dir, { recursive: true });
  const id = generateArtifactId();
  const filename = sanitizeAttachmentName(originalName);
  await writeFile(resolve(dir, `${id}__${filename}`), bytes);
  // Mime is inferred from the (extension of the) stored name so it stays consistent
  // between the upload response and later list reads. The x-attachment-mime header
  // is informational only.
  return {
    id,
    filename,
    mime: mimeForName(filename),
    size: bytes.length,
    createdAt: new Date().toISOString(),
  };
}

export async function listAttachments(
  todosDir: string,
  scopeId: string,
  todoId: string,
): Promise<TodoAttachment[]> {
  const dir = attachmentDirFor(todosDir, scopeId, todoId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: TodoAttachment[] = [];
  for (const stored of names) {
    const sep = stored.indexOf('__');
    if (sep <= 0) continue;
    const id = stored.slice(0, sep);
    if (!ATTACHMENT_ID_RE.test(id)) continue;
    const filename = stored.slice(sep + 2);
    try {
      const st = await stat(resolve(dir, stored));
      if (!st.isFile()) continue;
      out.push({ id, filename, mime: mimeForName(filename), size: st.size, createdAt: st.mtime.toISOString() });
    } catch {
      // file vanished between readdir and stat; skip
    }
  }
  // Sort by id — the id's base36 timestamp prefix makes this ≈ creation order.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// Scan attachments/<scopeId>/*/ once and return a map of todoId -> attachments,
// for efficient enrichment of a whole todo list.
export async function readScopeAttachments(
  todosDir: string,
  scopeId: string,
): Promise<Record<string, TodoAttachment[]>> {
  assertScope(scopeId);
  const scopeDir = resolve(attachmentsRootDir(todosDir), scopeId);
  let todoIds: string[];
  try {
    todoIds = await readdir(scopeDir);
  } catch {
    return {};
  }
  const result: Record<string, TodoAttachment[]> = {};
  for (const todoId of todoIds) {
    if (!TODO_ID_RE.test(todoId)) continue;
    const list = await listAttachments(todosDir, scopeId, todoId);
    if (list.length) result[todoId] = list;
  }
  return result;
}

export interface ResolvedAttachment {
  path: string;
  filename: string;
  mime: string;
}

export async function resolveAttachmentFile(
  todosDir: string,
  scopeId: string,
  todoId: string,
  attachmentId: string,
): Promise<ResolvedAttachment | null> {
  assertAttachmentId(attachmentId);
  const dir = attachmentDirFor(todosDir, scopeId, todoId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const prefix = `${attachmentId}__`;
  const stored = names.find((n) => n.startsWith(prefix));
  if (!stored) return null;
  const filename = stored.slice(prefix.length);
  return { path: resolve(dir, stored), filename, mime: mimeForName(filename) };
}

// --- Delete ------------------------------------------------------------------

export async function deleteAttachment(
  todosDir: string,
  scopeId: string,
  todoId: string,
  attachmentId: string,
): Promise<boolean> {
  const resolved = await resolveAttachmentFile(todosDir, scopeId, todoId, attachmentId);
  if (!resolved) return false;
  await unlink(resolved.path);
  return true;
}

export async function deleteAllAttachments(
  todosDir: string,
  scopeId: string,
  todoId: string,
): Promise<void> {
  await rm(attachmentDirFor(todosDir, scopeId, todoId), { recursive: true, force: true });
}

// --- Move (cross-scope) ------------------------------------------------------
//
// Split into a pure preflight + the actual rename so the move handler can check
// ALL target conflicts (id, planDir, attachments) BEFORE performing any rename,
// avoiding partial migration.

export async function attachmentMoveConflict(
  srcTodosDir: string,
  srcScopeId: string,
  dstTodosDir: string,
  dstScopeId: string,
  todoId: string,
): Promise<boolean> {
  const src = attachmentDirFor(srcTodosDir, srcScopeId, todoId);
  const dst = attachmentDirFor(dstTodosDir, dstScopeId, todoId);
  return (await dirExists(src)) && (await dirExists(dst));
}

export async function moveAttachments(
  srcTodosDir: string,
  srcScopeId: string,
  dstTodosDir: string,
  dstScopeId: string,
  todoId: string,
): Promise<void> {
  const src = attachmentDirFor(srcTodosDir, srcScopeId, todoId);
  if (!(await dirExists(src))) return; // nothing to migrate
  const dst = attachmentDirFor(dstTodosDir, dstScopeId, todoId);
  await mkdir(dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      // Cross-device: copy then remove the source.
      await cp(src, dst, { recursive: true });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
