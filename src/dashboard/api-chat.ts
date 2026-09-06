/**
 * Assignment-chat REST API.
 *
 * Mounted at `/api` (the routes carry their own `/assignments/...` prefix, the
 * way `api-events.ts` and `api-inbox.ts` do). Every route resolves the
 * assignment through `resolveAssignmentById`, so a project-nested slug and a
 * standalone UUID work identically.
 *
 * The chat STREAM does not live here — items arrive over `/ws` as `chat-item`
 * frames (Decision 3). These routes are history paging, the session summary, and
 * the four writes.
 *
 * Localhost-only, per the existing dashboard convention.
 */

import { Router, raw, type Request, type Response } from 'express';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { ChatSendError, type ChatBroker } from '../chat/broker.js';
import { ParticipantsError } from '../chat/participants.js';
import {
  ChatAttachmentError,
  MAX_CHAT_ATTACHMENT_BYTES,
  writeChatAttachment,
  resolveChatAttachment,
} from '../chat/attachments.js';
import { messageTurnState } from '../chat/message-state.js';
import type { Participants } from '../chat/types.js';

const MAX_MESSAGE_CHARS = 100_000;

export interface ChatRouterDeps {
  broker: ChatBroker;
}

export function createChatRouter(
  projectsDir: string,
  assignmentsDir: string,
  deps: ChatRouterDeps,
): Router {
  const router = Router();
  const { broker } = deps;

  /** Resolve `:id`, or answer 404 and return null. */
  async function resolveOr404(req: Request, res: Response) {
    // Express 5 types `params` values as `string | string[]`; these routes take
    // a single segment.
    const id = String(req.params.id);
    const assignment = await resolveAssignmentById(projectsDir, assignmentsDir, id);
    if (!assignment) {
      res.status(404).json({ error: `No assignment with id ${JSON.stringify(id)}` });
      return null;
    }
    return assignment;
  }

  /** Domain errors carry a status; anything else is a 500. */
  function fail(res: Response, err: unknown): void {
    if (
      err instanceof ChatSendError ||
      err instanceof ParticipantsError ||
      err instanceof ChatAttachmentError
    ) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }

  function headerValue(req: Request, name: string): string | undefined {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  }

  function contentDisposition(filename: string): string {
    const asciiFallback = Array.from(filename, (ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== '\\' ? ch : '_';
    }).join('');
    return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  // --- history -------------------------------------------------------------

  router.get('/assignments/:id/chat/items', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const before = Number(req.query.before);
      const limit = Number(req.query.limit);
      const items = broker.items(assignment, {
        ...(Number.isFinite(before) ? { beforeSeq: before } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      res.json({
        items,
        // `null` means "nothing older" — the SPA stops paging on it.
        oldestSeq: items.length > 0 ? items[0].seqFirst : null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/assignments/:id/chat/session', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const agentId = typeof req.query.agent === 'string' ? req.query.agent : null;
      res.json({ session: await broker.getSession(assignment, agentId) });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- attachments ---------------------------------------------------------

  router.post(
    '/assignments/:id/chat/attachments',
    (req, res, next) => {
      raw({ type: () => true, limit: MAX_CHAT_ATTACHMENT_BYTES })(req, res, (err) => {
        if (err) {
          if ((err as { type?: string }).type === 'entity.too.large') {
            res.status(413).json({ error: `Attachment exceeds ${MAX_CHAT_ATTACHMENT_BYTES} bytes` });
            return;
          }
          next(err);
          return;
        }
        void (async () => {
          try {
            const assignment = await resolveOr404(req, res);
            if (!assignment) return;
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
            const mime = headerValue(req, 'x-attachment-mime');
            if (!mime) {
              res.status(400).json({ error: 'x-attachment-mime is required' });
              return;
            }
            const body = req.body;
            if (!Buffer.isBuffer(body) || body.length === 0) {
              res.status(400).json({ error: 'Empty upload body' });
              return;
            }
            const result = await writeChatAttachment(assignment.assignmentDir, {
              name: filename,
              mime,
              bytes: body,
            });
            res.status(201).json(result);
          } catch (uploadErr) {
            fail(res, uploadErr);
          }
        })();
      });
    },
  );

  router.get('/assignments/:id/chat/attachments/:attachmentId', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const attachmentId = String(req.params.attachmentId);
      const resolved = await resolveChatAttachment(assignment.assignmentDir, attachmentId);
      if (!resolved) {
        res.status(404).json({ error: `Attachment "${attachmentId}" not found` });
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader('Content-Disposition', contentDisposition(resolved.name));
      res.sendFile(resolved.path, (err) => {
        if (err && !res.headersSent) res.status(500).end();
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- writes --------------------------------------------------------------

  router.post('/assignments/:id/chat/messages', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const body = (req.body ?? {}) as { agentId?: string; text?: string };
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      if (body.text.length > MAX_MESSAGE_CHARS) {
        res.status(413).json({ error: `Message is longer than ${MAX_MESSAGE_CHARS} characters` });
        return;
      }
      const { messageId } = await broker.send({
        assignment,
        agentId: body.agentId ?? null,
        text: body.text,
      });
      res.status(202).json({ messageId });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Where one dispatched message stands. Added for the launchd `schedule tick`
   * CLI (Decision 3): a tick running outside the dashboard has no broker, so it
   * polls this instead of a pid. A 404 means the chat has never seen the id,
   * which the scheduler treats as "unknown", not "finished".
   */
  router.get('/assignments/:id/chat/messages/:messageId', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const state = messageTurnState(assignment.id, String(req.params.messageId));
      if (!state) {
        res.status(404).json({ error: 'No such message in this chat' });
        return;
      }
      res.json(state);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Withdraw a QUEUED message. Keyed on the `messageId` minted at queue time —
   * the item id is `${scopeId}:${ordinal}` and is not known to the client until
   * the item exists.
   */
  router.delete('/assignments/:id/chat/messages/:messageId', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const withdrawn = await broker.withdraw(assignment, String(req.params.messageId));
      if (!withdrawn) {
        res.status(409).json({ error: 'That message is not queued — it has already been sent' });
        return;
      }
      res.json({ withdrawn: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/assignments/:id/chat/cancel', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const body = (req.body ?? {}) as { agentId?: string };
      const cancelled = await broker.cancel(assignment, body.agentId ?? null);
      res.json({ cancelled });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/assignments/:id/chat/permissions/:requestId', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const body = (req.body ?? {}) as { optionId?: string; allowAllSession?: boolean };
      if (typeof body.optionId !== 'string' || body.optionId.length === 0) {
        res.status(400).json({ error: 'optionId is required' });
        return;
      }
      if (body.allowAllSession !== undefined && typeof body.allowAllSession !== 'boolean') {
        res.status(400).json({ error: 'allowAllSession must be a boolean when present' });
        return;
      }
      const answered = await broker.answerPermission(
        assignment,
        String(req.params.requestId),
        body.optionId,
        body.allowAllSession === undefined ? undefined : { allowAllSession: body.allowAllSession },
      );
      if (!answered) {
        res.status(409).json({ error: 'That permission request is no longer pending' });
        return;
      }
      res.json({ answered: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/assignments/:id/chat/questions/:requestId', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const body = (req.body ?? {}) as { optionId?: string; text?: string };
      if (
        (typeof body.optionId !== 'string' || body.optionId.length === 0) &&
        (typeof body.text !== 'string' || body.text.trim().length === 0)
      ) {
        res.status(400).json({ error: 'optionId or text is required' });
        return;
      }
      const answered = await broker.answerQuestion(assignment, String(req.params.requestId), {
        ...(body.optionId ? { optionId: body.optionId } : {}),
        ...(body.text ? { text: body.text } : {}),
      });
      if (!answered) {
        res.status(409).json({ error: 'That question is no longer pending' });
        return;
      }
      res.json({ answered: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Rebuild `chat_items` from `chat/events.jsonl` (Decision 2's recovery path). */
  router.post('/assignments/:id/chat/reindex', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      res.json(await broker.reindex(assignment));
    } catch (err) {
      fail(res, err);
    }
  });

  // --- agents --------------------------------------------------------------

  router.get('/chat/agents', async (_req, res) => {
    try {
      const agents = await broker.agentSummaries();
      const { errors } = await broker.listAgents();
      res.json({ agents, errors });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- participants (Decision 1) -------------------------------------------

  router.get('/assignments/:id/chat/participants', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      res.json(await broker.getParticipants(assignment));
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Replace the participant set. The body is the same `{ agents, defaultAgent,
   * hopBudget? }` shape the GET reports; the broker validates it against the
   * definitions on disk and broadcasts `chat-participants`.
   */
  router.put('/assignments/:id/chat/participants', async (req, res) => {
    try {
      const assignment = await resolveOr404(req, res);
      if (!assignment) return;
      const body = (req.body ?? {}) as Partial<Participants>;
      if (!Array.isArray(body.agents)) {
        res.status(400).json({ error: 'agents must be a list of agent ids' });
        return;
      }
      res.json(
        await broker.setParticipants(assignment, {
          agents: body.agents,
          defaultAgent: body.defaultAgent ?? null,
          ...(body.hopBudget === undefined ? {} : { hopBudget: body.hopBudget }),
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
