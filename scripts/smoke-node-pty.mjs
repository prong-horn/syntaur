#!/usr/bin/env node
// Repo-local pre-check for the node-pty native prebuild. Spawns a real PTY
// running `printf` and asserts the bytes round-trip back through node-pty.
//
// This is a FAST pre-check only — run it FIRST so a broken prebuild kills the
// approach cheaply. It is NOT the Phase-A gate: that gate is
// `syntaur pty-host --smoke` invoked through the globally linked binary
// (see plan Task 5 / AC-6).
import { spawn } from 'node-pty';

const MARKER = 'syntaur-pty-roundtrip-ok';

const ptyProc = spawn('/bin/sh', ['-c', `printf %s ${MARKER}`], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let buf = '';

const timeout = setTimeout(() => {
  console.error(`FAIL: timed out waiting for PTY output (got: ${JSON.stringify(buf)})`);
  try {
    ptyProc.kill();
  } catch {
    /* already gone */
  }
  process.exit(1);
}, 5000);

ptyProc.onData((d) => {
  buf += d;
});

ptyProc.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (buf.includes(MARKER)) {
    console.log(`OK: node-pty round-trip verified (child exit ${exitCode}): ${JSON.stringify(buf.trim())}`);
    process.exit(0);
  }
  console.error(`FAIL: expected ${JSON.stringify(MARKER)} in PTY output, got ${JSON.stringify(buf)}`);
  process.exit(1);
});
