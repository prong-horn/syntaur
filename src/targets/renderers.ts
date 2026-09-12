import type { ProtocolContext, RendererKey } from './types.js';
import {
  renderCursorProtocol,
  renderCursorTicket,
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
function toRendererParams(ctx: ProtocolContext) {
  return {
    projectSlug: ctx.projectSlug,
    ticketSlug: ctx.ticketSlug,
    projectDir: ctx.projectDir,
    ticketDir: ctx.ticketDir,
  };
}

export const RENDERERS: Record<RendererKey, (ctx: ProtocolContext) => string> = {
  codexAgents: (ctx) => renderCodexAgents(toRendererParams(ctx)),
  cursorProtocol: () => renderCursorProtocol(),
  cursorTicket: (ctx) => renderCursorTicket(toRendererParams(ctx)),
  openCodeConfig: (ctx) => renderOpenCodeConfig({ projectDir: ctx.projectDir }),
  hermesSoul: (ctx) => renderHermesSoul(toRendererParams(ctx)),
};
