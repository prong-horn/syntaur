// Shared attachment endpoints for the workspace and project todo routers.
// Registered into each router via installTodoAttachmentRoutes() so upload / serve /
// delete logic lives in exactly one place. See src/todos/attachments.ts for storage.

import { Router, raw, type Request, type Response } from 'express';
import {
  writeAttachment,
  resolveAttachmentFile,
  deleteAttachment,
  isSafeInlineMime,
  AttachmentValidationError,
} from '../todos/attachments.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

export interface AttachmentRouteScope {
  todosDir: string;
  scopeId: string;
  todoId: string;
}

export interface AttachmentRouteOptions {
  // Resolve the storage scope + target todo id from the request.
  resolveScope: (req: Request) => AttachmentRouteScope;
  // Run `fn` holding the scope's write lock (wsLock / projLock) so attachment
  // mutations cannot race a concurrent todo delete / move / archive.
  withScopeLock: <T>(req: Request, fn: () => Promise<T>) => Promise<T>;
  // True iff a todo with scope.todoId currently exists (reads the checklist).
  todoExists: (scope: AttachmentRouteScope) => Promise<boolean>;
  // Broadcast the right "todos-updated" message for this scope.
  onChange: (req: Request) => void;
}

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function paramStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof AttachmentValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'Attachment operation failed' });
}

// RFC 6266 disposition with an ASCII fallback plus a UTF-8 form. The filename is
// already sanitized at write time; this is belt-and-suspenders against header
// injection (no quotes / backslashes / control chars reach the header).
function contentDisposition(filename: string, inline: boolean): string {
  const disp = inline ? 'inline' : 'attachment';
  const asciiFallback = Array.from(filename, (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== '\\' ? ch : '_';
  }).join('');
  return `${disp}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function installTodoAttachmentRoutes(
  router: Router,
  prefix: string,
  opts: AttachmentRouteOptions,
): void {
  // POST {prefix}/attachments — upload raw bytes (no multer; the client sends
  // application/octet-stream so the global express.json() never intercepts it).
  router.post(
    `${prefix}/attachments`,
    raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      try {
        const rawName = headerValue(req, 'x-attachment-filename');
        let filename = 'file';
        if (rawName) {
          try {
            filename = decodeURIComponent(rawName);
          } catch {
            res.status(400).json({ error: 'Invalid x-attachment-filename header' });
            return;
          }
        }
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'Empty upload body' });
          return;
        }
        const scope = opts.resolveScope(req);
        const result = await opts.withScopeLock(req, async () => {
          if (!(await opts.todoExists(scope))) return null;
          return writeAttachment(scope.todosDir, scope.scopeId, scope.todoId, filename, body);
        });
        if (!result) {
          res.status(404).json({ error: `Todo "${scope.todoId}" not found` });
          return;
        }
        opts.onChange(req);
        res.status(201).json(result);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // GET {prefix}/attachments/:attachmentId — serve the file. The lock is held only
  // through existence + path resolution; the (potentially large) transfer happens
  // after the lock is released so it never blocks writers.
  router.get(`${prefix}/attachments/:attachmentId`, async (req: Request, res: Response) => {
    try {
      const scope = opts.resolveScope(req);
      const attachmentId = paramStr(req.params.attachmentId);
      const resolved = await opts.withScopeLock(req, async () => {
        if (!(await opts.todoExists(scope))) return { notFound: true as const };
        return {
          file: await resolveAttachmentFile(scope.todosDir, scope.scopeId, scope.todoId, attachmentId),
        };
      });
      if ('notFound' in resolved) {
        res.status(404).json({ error: `Todo "${scope.todoId}" not found` });
        return;
      }
      if (!resolved.file) {
        res.status(404).json({ error: `Attachment "${attachmentId}" not found` });
        return;
      }
      const { path, filename, mime } = resolved.file;
      const inline = isSafeInlineMime(mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(filename, inline));
      res.sendFile(path, (err) => {
        if (err && !res.headersSent) res.status(500).end();
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE {prefix}/attachments/:attachmentId
  router.delete(`${prefix}/attachments/:attachmentId`, async (req: Request, res: Response) => {
    try {
      const scope = opts.resolveScope(req);
      const attachmentId = paramStr(req.params.attachmentId);
      const result = await opts.withScopeLock(req, async () => {
        if (!(await opts.todoExists(scope))) return { notFound: true as const };
        return { deleted: await deleteAttachment(scope.todosDir, scope.scopeId, scope.todoId, attachmentId) };
      });
      if ('notFound' in result) {
        res.status(404).json({ error: `Todo "${scope.todoId}" not found` });
        return;
      }
      if (!result.deleted) {
        res.status(404).json({ error: `Attachment "${attachmentId}" not found` });
        return;
      }
      opts.onChange(req);
      res.json({ deleted: attachmentId });
    } catch (err) {
      sendError(res, err);
    }
  });
}
