import { Router, type Request, type Response } from 'express';
import {
  writeStatusConfig,
  deleteStatusConfig,
  DEFAULT_DERIVE_CONFIG,
  validateDeriveConfig,
  validateDeriveShape,
  validateFactDeclarations,
  normalizeFactDeclarations,
  type RawFactDeclaration,
  type DeriveConfig,
  type StatusTransition,
} from '../utils/config.js';
import { acceptFactDeclarations, buildDeriveRegistry } from '../utils/fact-registry.js';
import { DEFAULT_COMMAND_TARGETS } from '../lifecycle/state-machine.js';
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

/**
 * The full status-config response shape shared by GET, POST, and DELETE.
 * `derive` always carries a concrete config (defaults when the file declares
 * none) so the client can render the ladder unconditionally; `deriveCustom`
 * tells it whether the file actually customizes the rules. `knownCommands` are
 * the built-in transition command names for the transitions-editor pickers.
 * POST/DELETE include `factDeclarations`/`rawFacts` so the unified save can
 * rehydrate every section without a follow-up GET.
 */
function configResponse(config: Awaited<ReturnType<typeof getStatusConfig>>) {
  return {
    statuses: config.statuses,
    order: config.order,
    // RAW transitions (empty when the user has none) + a custom flag, so the
    // Settings editor can show read-only defaults vs. a customized table. The
    // materialized `config.transitions` (default-filled for runtime guards) is
    // deliberately NOT exposed here — sending it would make the defaults view
    // unreachable and round-trip phantom rows for undefined statuses.
    transitions: config.rawTransitions,
    transitionsCustom: config.transitionsCustom,
    custom: config.custom,
    derive: config.derive ?? DEFAULT_DERIVE_CONFIG,
    deriveCustom: config.derive !== null,
    knownCommands: [...DEFAULT_COMMAND_TARGETS.keys()],
    factDeclarations: config.factDeclarations,
    rawFacts: config.facts ?? [],
  };
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
      res.json(configResponse(config));
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
        derive,
        facts: bodyFacts,
        factRemovalAcks,
        resolutions: rawResolutions,
      } = req.body ?? {};

      // Fetch current config early — needed for both facts-only and full saves.
      const currentConfig = await getStatusConfig();

      // ── Body-presence semantics ──────────────────────────────────────────
      // Every section is optional; an omitted section preserves the current
      // value. This is what kills the historical `transitions: []` wipe without
      // breaking old facts-only clients, and lets a derive-only save round-trip.
      const hasFacts = bodyFacts !== undefined;
      const hasStatuses = statuses !== undefined;
      const hasOrder = order !== undefined;
      const hasTransitions = transitions !== undefined;
      const hasDerive = derive !== undefined;

      if (!hasStatuses && !hasOrder && !hasTransitions && !hasFacts && !hasDerive) {
        res.status(400).json({ error: 'malformed-statuses', message: 'Request body must include at least one of statuses, order, transitions, derive, or facts' });
        return;
      }
      if (hasStatuses && !Array.isArray(statuses)) {
        res.status(400).json({ error: 'malformed-statuses', message: 'statuses must be an array' });
        return;
      }
      if (hasOrder && !Array.isArray(order)) {
        res.status(400).json({ error: 'malformed-statuses', message: 'order must be an array' });
        return;
      }
      if (hasTransitions && !Array.isArray(transitions)) {
        res.status(400).json({ error: 'malformed-transitions', message: 'transitions must be an array' });
        return;
      }

      const effectiveStatuses = hasStatuses ? statuses : currentConfig.statuses;
      const effectiveOrder = hasOrder ? order : currentConfig.order;
      // Preserve the RAW transitions (what's actually in config.md), NOT the
      // materialized default-filled `currentConfig.transitions` — otherwise a
      // statuses-only save would persist the 17 built-in rows (including ones
      // referencing undefined statuses) into a config that had none.
      const effectiveTransitions: StatusTransition[] = hasTransitions
        ? transitions
        : currentConfig.rawTransitions;

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

      // ── Validation BEFORE mutation ───────────────────────────────────────
      // Every payload validation (facts, derive, transitions, fact-references)
      // runs here, before scanAssignmentsByStatus/applyStatusResolutions touch
      // any assignment file. Previously fact validation ran AFTER resolutions
      // were applied, so an invalid-facts save could remap/delete assignments on
      // disk and *then* 400. All checks below read only the request body and
      // currentConfig — no disk writes — so the move is safe.

      // (1) Facts: shape-check → validate → factsToWrite (defaults to current).
      let factsToWrite: RawFactDeclaration[] | null = currentConfig.facts ?? null;
      if (hasFacts) {
        if (!Array.isArray(bodyFacts)) {
          res.status(400).json({ error: 'malformed-facts', message: 'facts must be an array' });
          return;
        }
        const shapedFacts: RawFactDeclaration[] = [];
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
        factsToWrite = shapedFacts;
      }

      // (2) Derive: presence semantics + shape-check + validateDeriveConfig
      // against the INCOMING statuses and a registry built from the INCOMING
      // facts (so a save that adds a fact and a rule referencing it validates).
      let effectiveDerive: DeriveConfig | null = currentConfig.derive ?? null;
      if (hasDerive) {
        if (derive === null) {
          effectiveDerive = null; // reset to built-in defaults
        } else {
          // Deep shape-check FIRST — validateDeriveConfig assumes correct types,
          // so a malformed payload (null rung, numeric when/next, …) would 500
          // and could partial-mutate via serialization after resolutions apply.
          const shapeProblems = validateDeriveShape(derive);
          if (shapeProblems.length > 0) {
            res.status(400).json({ error: 'invalid-derive', problems: shapeProblems });
            return;
          }
          const incomingRegistry = buildDeriveRegistry(
            acceptFactDeclarations(normalizeFactDeclarations(factsToWrite)),
          );
          const problems = validateDeriveConfig(
            derive as DeriveConfig,
            { statuses: effectiveStatuses },
            (when) => validateDeriveCondition(when, incomingRegistry),
          );
          if (problems.length > 0) {
            res.status(400).json({ error: 'invalid-derive', problems });
            return;
          }
          effectiveDerive = derive as DeriveConfig;
        }
      }

      // (3) Transitions: shape-check rows + from/to must be defined statuses.
      if (hasTransitions) {
        for (let i = 0; i < transitions.length; i++) {
          const t = transitions[i] as Record<string, unknown>;
          const ok =
            !!t &&
            typeof t === 'object' &&
            typeof t.from === 'string' &&
            typeof t.command === 'string' &&
            typeof t.to === 'string' &&
            (t.label === undefined || typeof t.label === 'string') &&
            (t.description === undefined || typeof t.description === 'string') &&
            (t.requiresReason === undefined || typeof t.requiresReason === 'boolean');
          if (!ok) {
            res.status(400).json({
              error: 'invalid-transitions',
              problems: [`transitions[${i}] must have string from/command/to (+ optional string label/description, boolean requiresReason)`],
            });
            return;
          }
        }
        const tproblems: string[] = [];
        for (const t of transitions as StatusTransition[]) {
          if (!newIds.has(t.from)) tproblems.push(`transition ${t.from} --${t.command}--> ${t.to}: "${t.from}" is not a defined status`);
          if (!newIds.has(t.to)) tproblems.push(`transition ${t.from} --${t.command}--> ${t.to}: "${t.to}" is not a defined status`);
        }
        if (tproblems.length > 0) {
          res.status(400).json({ error: 'invalid-transitions', problems: tproblems });
          return;
        }
      }

      // (4) Fact-reference check: a removed fact still referenced by a derive
      // rule that REMAINS (in the incoming derive) → 409 unless acked. Evaluated
      // against effectiveDerive so removing a fact AND its rule in one save is
      // clean, while removing the fact but keeping the rule still 409s.
      if (hasFacts) {
        const currentNames = new Set((currentConfig.facts ?? []).map((f) => f.name));
        const incomingNames = new Set((factsToWrite ?? []).map((f) => f.name));
        const removedNames: string[] = [];
        for (const name of currentNames) {
          if (!incomingNames.has(name)) removedNames.push(name);
        }
        const acks = new Set<string>(Array.isArray(factRemovalAcks) ? factRemovalAcks.map((x: unknown) => String(x)) : []);
        const unresolvedRefs: Array<{ factName: string; location: string; when: string }> = [];
        if (effectiveDerive !== null && removedNames.length > 0) {
          const acceptedAll = acceptFactDeclarations(normalizeFactDeclarations(currentConfig.facts));
          const fullRegistry = buildDeriveRegistry(acceptedAll);
          for (const removedName of removedNames) {
            if (acks.has(removedName)) continue;
            const acceptedWithout = acceptedAll.filter((d) => d.name !== removedName);
            const withoutRegistry = buildDeriveRegistry(acceptedWithout);
            for (let i = 0; i < effectiveDerive.phaseLadder.length; i++) {
              const rung = effectiveDerive.phaseLadder[i];
              if (rung.when === '*') continue;
              const before = validateDeriveCondition(rung.when, fullRegistry);
              const after = validateDeriveCondition(rung.when, withoutRegistry);
              if (before === null && after !== null) {
                unresolvedRefs.push({ factName: removedName, location: `phaseLadder[${i}]`, when: rung.when });
              }
            }
            for (let i = 0; i < effectiveDerive.disposition.length; i++) {
              const rule = effectiveDerive.disposition[i];
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
          derive: effectiveDerive,
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
        ...configResponse(config),
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
      res.json(configResponse(config));
    } catch (error) {
      console.error('Error resetting status config:', error);
      res.status(500).json({ error: 'Failed to reset status config' });
    }
  });

  return router;
}
