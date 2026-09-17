import { it } from 'vitest';
import { runLockCoordChild } from './helpers/lock-coord-child.js';

const op = process.env.LOCK_OP;
it.runIf(Boolean(op))(`lock worker ${op}`, async () => {
  await runLockCoordChild(op!);
});
