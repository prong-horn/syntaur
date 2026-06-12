import { Router, type Request, type Response } from 'express';
import {
  writeStatusConfig,
  deleteStatusConfig,
  DEFAULT_DERIVE_CONFIG,
  validateFactDeclarations,
  normalizeFactDeclarations,
  type RawFactDeclaration,
} from '../utils/config.js';
import { acceptFactDeclarations, buildDeriveRegistry } from '../utils/fact-registry.js';
import { getStatusConfig, clearStatusConfigCache, installRecordsInvalidation } from './api.js';
import { validateDeriveCondition } from '../lifecycle/derive.js';
import {
  scanAssignmentsByStatus,
  applyStatusResolutions,
  verifyNoDriftedOrphans,
  StatusResolutionError,
  type StatusResolution,
  type AffectedAssignment,
} from '../utils/status-config-resolution.js';

const AFFECTED_SAMPLE_CAP = 50;

export interface AffectedAssignmentSummary {
  display: string;
  projectSlug: string | null;
  assignmentSlug: string;
  status: string;
}

export interface AffectedResponse {
  id: string;
  count: number;
  truncated: boolean;
  assignments: AffectedAssignmentSummary[];
}

function toSummary(a: AffectedAssignment): AffectedAssignmentSummary {
  return {
    display: a.display,
    projectSlug: a.projectSlug,
    assignmentSlug: a.assignmentSlug,
    status: a.status,
  };
}

function buildAffectedResponse(id: string, list: AffectedAssignment[]): AffectedResponse {
  const truncated = list.length > AFFECTED_SAMPLE_CAP;
  return {
    id,
    count: list.length,
    truncated,
    assignments: list.slice(0, AFFECTED_SAMPLE_CAP).map(toSummary),
  };
}

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

interface ParsedResolutions {
  resolutions: StatusResolution[];
  malformed: string | null;
  duplicateIds: string[] | null;
}

function parseResolutions(raw: unknown): ParsedResolutions {
  if (raw === undefined) {
    return { resolutions: [], malformed: null, duplicateIds: null };
  }
  if (!Array.isArray(raw)) {
    return { resolutions: [], malformed: 'resolutions must be an array', duplicateIds: null };
  }
  const out: StatusResolution[] = [];
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r || typeof r !== 'object') {
      return { resolutions: [], malformed: `resolutions[${i}] must be an object`, duplicateIds: null };
    }
    const obj = r as Record<string, unknown>;
    if (!isString(obj.id)) {
      return { resolutions: [], malformed: `resolutions[${i}].id must be a non-empty string`, duplicateIds: null };
    }
    if (obj.mode === 'remap') {
      if (!isString(obj.target)) {
        return { resolutions: [], malformed: `resolutions[${i}].target must be a non-empty string for mode=remap`, duplicateIds: null };
      }
      if (seen.has(obj.id)) dups.add(obj.id);
      seen.add(obj.id);
      out.push({ id: obj.id, mode: 'remap', target: obj.target });
    } else if (obj.mode === 'delete') {
      if (seen.has(obj.id)) dups.add(obj.id);
      seen.add(obj.id);
      out.push({ id: obj.id, mode: 'delete' });
    } else {
      return { resolutions: [], malformed: `resolutions[${i}].mode must be 'remap' or 'delete'`, duplicateIds: null };
    }
  }
  if (dups.size > 0) {
    return { resolutions: [], malformed: null, duplicateIds: [...dups] };
  }
  return { resolutions: out, malformed: null, duplicateIds: null };
}

function mapResolutionErrorToHttp(
  err: StatusResolutionError,
  applied: { remapped: number; deleted: number } | null,
): { status: number; body: Record<string, unknown> } {
  switch (err.code) {
    case 'duplicate-id':
      return { status: 400, body: { error: 'duplicate-resolution-ids', message: err.message } };
    case 'stale-resolution':
      return { status: 400, body: { error: 'stale-resolution', message: err.message } };
    case 'invalid-target':
      return { status: 400, body: { error: 'invalid-remap-target', message: err.message } };
    case 'scan-failed':
      return { status: 500, body: { error: 'scan-failed', cause: err.message } };
    case 'write-failed':
      return { status: 500, body: { error: 'remap-write-failed', cause: err.message } };
    case 'delete-failed':
      return {
        status: 500,
        body: { error: 'delete-failed', cause: err.message, applied: applied ?? undefined },
      };
    case 'drift-detected':
      return {
        status: 409,
        body: {
          error: 'concurrent-edit',
          cause: err.message,
          applied: applied ?? undefined,
        },
      };
  }
}

export function createStatusConfigRouter(
  projectsDir: string,
  assignmentsDir: string | null,
): Router {
  const router = Router();
  // The POST/DELETE routes rewrite assignment.md status fields (and may remove
  // assignment dirs) via applyStatusResolutions; clear the shared records cache
  // synchronously once each mutation resolves so the client's immediate refetch
  // sees fresh status counts rather than the pre-remap snapshot.
  installRecordsInvalidation(router);

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
        factDeclarations: config.factDeclarations,
        rawFacts: config.facts ?? [],
      });
    } catch (error) {
      console.error('Error getting status config:', error);
      res.status(500).json({ error: 'Failed to get status config' });
    }
  });

  router.get('/affected/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      if (!isString(id)) {
        res.status(400).json({ error: 'malformed-id' });
        return;
      }
      const affected = await scanAssignmentsByStatus(projectsDir, assignmentsDir, [id]);
      const list = affected.get(id) ?? [];
      res.json(buildAffectedResponse(id, list));
    } catch (error) {
      console.error('Error getting affected assignments:', error);
      res.status(500).json({ error: 'Failed to get affected assignments' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const {
        statuses,
        order,
        transitions,
        facts: bodyFacts,
        factRemovalAcks,
        resolutions: rawResolutions,
      } = req.body ?? {};

      // Fetch current config early — needed for both facts-only and full saves.
      const currentConfig = await getStatusConfig();

      // ── Body-presence semantics ──────────────────────────────────────────
      const hasFacts = bodyFacts !== undefined;
      const hasStatuses = statuses !== undefined;
      const hasOrder = order !== undefined;
      const hasTransitions = transitions !== undefined;

      let effectiveStatuses = statuses;
      let effectiveOrder = order;
      let effectiveTransitions = transitions;

      if (hasFacts && !hasStatuses && !hasOrder && !hasTransitions) {
        // Facts-only save: default the status arrays from current config.
        effectiveStatuses = currentConfig.statuses;
        effectiveOrder = currentConfig.order;
        effectiveTransitions = currentConfig.transitions;
      } else if (!Array.isArray(effectiveStatuses) || !Array.isArray(effectiveOrder) || !Array.isArray(effectiveTransitions)) {
        res.status(400).json({ error: 'malformed-statuses', message: 'Request body must include statuses, order, and transitions arrays' });
        return;
      }

      // Validate resolutions shape early.
      const parsed = parseResolutions(rawResolutions);
      if (parsed.malformed) {
        res.status(400).json({ error: 'malformed-resolutions', message: parsed.malformed });
        return;
      }
      if (parsed.duplicateIds) {
        res.status(400).json({ error: 'duplicate-resolution-ids', ids: parsed.duplicateIds });
        return;
      }
      const resolutions = parsed.resolutions;

      // Compute oldIds (from current resolved config) and newIds (from request).
      const oldIds = new Set(currentConfig.statuses.map((s) => s.id));
      const newIds = new Set<string>();
      for (const s of effectiveStatuses) {
        if (s && typeof s === 'object' && isString((s as { id: unknown }).id)) {
          newIds.add((s as { id: string }).id);
        }
      }
      const droppedIds: string[] = [];
      for (const id of oldIds) {
        if (!newIds.has(id)) droppedIds.push(id);
      }

      // Validate every resolution references a dropped id.
      for (const r of resolutions) {
        if (!droppedIds.includes(r.id)) {
          res.status(400).json({ error: 'stale-resolution', id: r.id });
          return;
        }
      }

      // Validate remap targets against oldIds ∩ newIds + target !== id.
      const validTargets = new Set<string>();
      for (const id of newIds) {
        if (oldIds.has(id)) validTargets.add(id);
      }
      for (const r of resolutions) {
        if (r.mode !== 'remap') continue;
        if (r.target === r.id) {
          res.status(400).json({ error: 'invalid-remap-target', reason: 'same-as-source', id: r.id, target: r.target });
          return;
        }
        if (!newIds.has(r.target)) {
          res.status(400).json({ error: 'invalid-remap-target', reason: 'not-in-new-config', id: r.id, target: r.target });
          return;
        }
        if (!oldIds.has(r.target)) {
          res.status(400).json({ error: 'invalid-remap-target', reason: 'not-in-old-config', id: r.id, target: r.target });
          return;
        }
      }

      // Scan affected assignments for every dropped id.
      let affectedMap: Awaited<ReturnType<typeof scanAssignmentsByStatus>>;
      try {
        affectedMap = await scanAssignmentsByStatus(projectsDir, assignmentsDir, droppedIds);
      } catch (err) {
        if (err instanceof StatusResolutionError) {
          const mapped = mapResolutionErrorToHttp(err, null);
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw err;
      }

      // Reject unresolved drops with affected assignments.
      const unresolved: AffectedResponse[] = [];
      const resolvedById = new Set(resolutions.map((r) => r.id));
      for (const id of droppedIds) {
        const list = affectedMap.get(id) ?? [];
        if (list.length > 0 && !resolvedById.has(id)) {
          unresolved.push(buildAffectedResponse(id, list));
        }
      }
      if (unresolved.length > 0) {
        res.status(409).json({ error: 'unresolved-orphans', unresolved });
        return;
      }

      // Step A: apply resolutions (remap → delete).
      let applied: Awaited<ReturnType<typeof applyStatusResolutions>>;
      try {
        applied = await applyStatusResolutions(resolutions, affectedMap, validTargets);
      } catch (err) {
        if (err instanceof StatusResolutionError) {
          const mapped = mapResolutionErrorToHttp(err, null);
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw err;
      }

      // Step A.5: final drift check. Catches the case where an assignment
      // moved from one dropped id to another between scan and apply (the
      // intra-resolution TOCTOU guard misses this). If anything still
      // references a dropped id, abort before config write so the user can
      // retry cleanly.
      try {
        await verifyNoDriftedOrphans(projectsDir, assignmentsDir, droppedIds);
      } catch (err) {
        if (err instanceof StatusResolutionError) {
          const mapped = mapResolutionErrorToHttp(err, {
            remapped: applied.remapped,
            deleted: applied.deleted,
          });
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw err;
      }

      // ── Fact validation + reference check ─────────────────────────────
      let factsToWrite: RawFactDeclaration[] | null = currentConfig.facts ?? null;
      if (hasFacts) {
        // Shape-check + normalize binds undefined → null.
        const shapedFacts: RawFactDeclaration[] = [];
        if (!Array.isArray(bodyFacts)) {
          res.status(400).json({ error: 'malformed-facts', message: 'facts must be an array' });
          return;
        }
        for (let i = 0; i < bodyFacts.length; i++) {
          const row = bodyFacts[i];
          if (!row || typeof row !== 'object') {
            res.status(400).json({ error: 'malformed-facts', message: `facts[${i}] must be an object` });
            return;
          }
          const name = (row as Record<string, unknown>).name;
          const type = (row as Record<string, unknown>).type;
          if (typeof name !== 'string' || typeof type !== 'string') {
            res.status(400).json({ error: 'malformed-facts', message: `facts[${i}] must have name and type strings` });
            return;
          }
          const binds = (row as Record<string, unknown>).binds;
          const normalizedBinds = binds === undefined ? null : binds === null ? null : typeof binds === 'string' ? binds : null;
          shapedFacts.push({ name, type, binds: normalizedBinds });
        }

        const problems = validateFactDeclarations(shapedFacts);
        if (problems.length > 0) {
          res.status(400).json({ error: 'invalid-facts', problems });
          return;
        }

        // Reference check: removed facts still referenced by derive rules?
        const currentNames = new Set((currentConfig.facts ?? []).map((f) => f.name));
        const incomingNames = new Set(shapedFacts.map((f) => f.name));
        const removedNames: string[] = [];
        for (const name of currentNames) {
          if (!incomingNames.has(name)) removedNames.push(name);
        }
        const acks = new Set<string>(Array.isArray(factRemovalAcks) ? factRemovalAcks.map((x: unknown) => String(x)) : []);
        const unresolvedRefs: Array<{ factName: string; location: string; when: string }> = [];
        const deriveConfig = currentConfig.derive ?? null;
        if (deriveConfig !== null && removedNames.length > 0) {
          const acceptedAll = acceptFactDeclarations(normalizeFactDeclarations(currentConfig.facts));
          const fullRegistry = buildDeriveRegistry(acceptedAll);
          for (const removedName of removedNames) {
            if (acks.has(removedName)) continue;
            const acceptedWithout = acceptedAll.filter((d) => d.name !== removedName);
            const withoutRegistry = buildDeriveRegistry(acceptedWithout);
            for (let i = 0; i < deriveConfig.phaseLadder.length; i++) {
              const rung = deriveConfig.phaseLadder[i];
              if (rung.when === '*') continue;
              const before = validateDeriveCondition(rung.when, fullRegistry);
              const after = validateDeriveCondition(rung.when, withoutRegistry);
              if (before === null && after !== null) {
                unresolvedRefs.push({ factName: removedName, location: `phaseLadder[${i}]`, when: rung.when });
              }
            }
            for (let i = 0; i < deriveConfig.disposition.length; i++) {
              const rule = deriveConfig.disposition[i];
              if (rule.when === null) continue;
              const before = validateDeriveCondition(rule.when, fullRegistry);
              const after = validateDeriveCondition(rule.when, withoutRegistry);
              if (before === null && after !== null) {
                unresolvedRefs.push({ factName: removedName, location: `disposition[${i}]`, when: rule.when });
              }
            }
          }
        }
        if (unresolvedRefs.length > 0) {
          res.status(409).json({ error: 'unresolved-fact-references', references: unresolvedRefs });
          return;
        }

        factsToWrite = shapedFacts;
      }

      // Step B: write the new config. If this throws, the resolutions have
      // already landed on disk; per Decision 3 the old config is still in
      // place and no assignment.invalid-status errors exist (every remap
      // target was in oldIds, every delete is gone). Surface the partial-apply
      // 500 to the client so it can refresh and retry.
      try {
        await writeStatusConfig({
          statuses: effectiveStatuses,
          order: effectiveOrder,
          transitions: effectiveTransitions,
          derive: currentConfig.derive ?? null,
          facts: factsToWrite,
        });
      } catch (err) {
        console.error('Error saving status config after applying resolutions:', err);
        res.status(500).json({
          error: 'config-write-failed',
          message: err instanceof Error ? err.message : String(err),
          applied: { remapped: applied.remapped, deleted: applied.deleted },
        });
        return;
      }

      // Step C: cache + return. Use per-resolution counts from `applied.byId`
      // (which already account for TOCTOU skips) rather than scan-time list
      // lengths — otherwise the user sees inflated counts when a concurrent
      // writer moved an assignment out of scope.
      clearStatusConfigCache();
      const config = await getStatusConfig();
      const byId: Record<string, { mode: 'remap' | 'delete'; count: number; target?: string }> = {};
      for (const [id, entry] of applied.byId) {
        byId[id] = entry.target !== undefined
          ? { mode: entry.mode, count: entry.count, target: entry.target }
          : { mode: entry.mode, count: entry.count };
      }
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
        applied: { remapped: applied.remapped, deleted: applied.deleted, byId },
      });
    } catch (error) {
      console.error('Error saving status config:', error);
      res.status(500).json({ error: 'Failed to save status config' });
    }
  });

  router.delete('/', async (_req: Request, res: Response) => {
    try {
      await deleteStatusConfig();
      clearStatusConfigCache();
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error resetting status config:', error);
      res.status(500).json({ error: 'Failed to reset status config' });
    }
  });

  return router;
}
