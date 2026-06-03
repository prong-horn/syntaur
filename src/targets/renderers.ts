import type { ProtocolContext, RendererKey } from './types.js';
import {
  renderCursorProtocol,
  renderCursorAssignment,
} from '../templates/cursor-rules.js';
import { renderCodexAgents } from '../templates/codex-agents.js';
import { renderOpenCodeConfig } from '../templates/opencode-config.js';
import { renderHermesSoul } from '../templates/hermes-soul.js';

/**
 * Maps a descriptor's `RendererKey` to the actual render function. Thin wrappers
 * normalize each renderer's param shape to `ProtocolContext` so descriptors only
 * ever name a key (keeping them serializable). The output of each wrapper is
 * byte-identical to calling the underlying renderer directly — the existing
 * cursor/codex/opencode adapters keep producing the same files.
 */
export const RENDERERS: Record<RendererKey, (ctx: ProtocolContext) => string> = {
  codexAgents: (ctx) => renderCodexAgents(ctx),
  cursorProtocol: () => renderCursorProtocol(),
  cursorAssignment: (ctx) => renderCursorAssignment(ctx),
  openCodeConfig: (ctx) => renderOpenCodeConfig({ projectDir: ctx.projectDir }),
  hermesSoul: (ctx) => renderHermesSoul(ctx),
};
