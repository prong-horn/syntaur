// AgentAdapter contract (research doc §3.2, adapted per plan D2: buildArgv
// stays in the TUI launch tier, transcript stays with the renderers; this
// daemon-side interface is derivation-only).
import type { DeriveInput, DerivedState } from '../types.js';

export interface AgentAdapter {
  id: string;
  /** Pure: full current opinion from inputs — never a delta, never throws
   * by contract (the engine guards anyway, AC4). */
  deriveState(x: DeriveInput): DerivedState;
}
