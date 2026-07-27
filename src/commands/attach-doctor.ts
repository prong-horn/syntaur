import { Command } from 'commander';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runCommand } from '../errors.js';
import { checkClaudeAttachCommand, resolveClaudeAttachBinary, scanPathForClaude } from '../tui/claude-agents/capability.js';
import { buildClaudeAttachArgv } from '../tui/claude-agents/attach.js';

const execFileAsync = promisify(execFile);

/**
 * Diagnose the cockpit's claude-attach decision from INSIDE syntaur's own
 * process environment — the same PATH/env the TUI uses, which is exactly
 * where it can differ from the user's login shell. Prints each step the
 * cockpit takes and, with a short id, runs the real attach so the user sees
 * precisely what renders.
 */
export const attachDoctorCommand = new Command('attach-doctor')
  .description("Diagnose cockpit attach: probe claude's hidden `attach` command from syntaur's own environment")
  .argument('[short]', 'Optional claude background session short id — runs the exact cockpit attach argv interactively')
  .action(
    runCommand(async (short: string | undefined) => {
      console.log('syntaur attach-doctor — cockpit claude-attach decision, step by step\n');

      // 1. Which claude(s) this PROCESS resolves (shim detection).
      const claudes = scanPathForClaude();
      console.log(`1. claude executables on this process's PATH (resolution order):`);
      if (claudes.length === 0) console.log('   NONE — the cockpit cannot spawn claude at all');
      claudes.forEach((c, i) => console.log(`   ${i === 0 ? '->' : '  '} ${c}${i > 0 ? '  (shadowed)' : ''}`));
      if (claudes.length > 1) console.log('   WARNING: multiple entries — the first one is what the cockpit runs; later ones are shadowed.');

      // 2. Version of the claude the cockpit would spawn.
      try {
        const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 15000 });
        console.log(`\n2. claude --version: ${stdout.trim()}`);
      } catch (err) {
        console.log(`\n2. claude --version FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3. Per-candidate probe — a shim can answer differently than the real
      // binary, so every candidate is probed the way the resolver does.
      console.log('\n3. Per-candidate probe (`<candidate> attach --help`, 15s timeout):');
      for (const candidate of claudes) {
        try {
          const { stdout, stderr } = await execFileAsync(candidate, ['attach', '--help'], { timeout: 15000 });
          const ok = /^\s*Usage: claude attach\b/m.test(`${stdout}\n${stderr}`);
          console.log(`   ${ok ? 'ATTACH OK ' : 'NO ATTACH '} ${candidate}`);
          console.log(`              stdout: ${JSON.stringify(stdout.slice(0, 80))}`);
        } catch (err) {
          const e = err as { code?: unknown; stdout?: unknown; message?: string };
          const cap = String(e.stdout ?? '');
          const ok = /^\s*Usage: claude attach\b/m.test(cap);
          console.log(`   ${ok ? 'ATTACH OK ' : 'PROBE ERR '} ${candidate} (${String(e.code ?? e.message)})`);
        }
      }

      // 4. The cockpit's actual verdict + the binary it will spawn.
      const direct = await checkClaudeAttachCommand();
      const resolved = await resolveClaudeAttachBinary();
      console.log(`\n4. Cockpit verdict — ${direct ? `DIRECT ATTACH via ${resolved}` : 'FALLBACK (Agent View picker) — no candidate supports attach'}`);

      // 5. Live background sessions the ids come from.
      try {
        const { stdout } = await execFileAsync('claude', ['agents', '--json'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
        const rows = JSON.parse(stdout) as Array<{ id?: string; kind?: string; state?: string; name?: string }>;
        const bg = rows.filter((r) => r.kind === 'background');
        console.log(`\n5. claude agents --json: ${rows.length} sessions, ${bg.length} background (attachable):`);
        bg.slice(0, 8).forEach((r) => console.log(`   ${r.id}  state=${r.state ?? '?'}  ${r.name ?? ''}`));
      } catch (err) {
        console.log(`\n5. claude agents --json FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 6. Optionally run the exact attach the cockpit would run.
      if (short) {
        const argv = buildClaudeAttachArgv(short);
        const bin = resolved ?? 'claude';
        console.log(`\n6. Running the exact cockpit attach now: ${bin} ${argv.join(' ')}`);
        console.log('   (this is interactive — detach/exit to return; what renders IS what the cockpit shows)\n');
        await new Promise<void>((resolvePromise) => {
          const child = spawn(bin, argv, { stdio: 'inherit' });
          child.on('exit', (code) => {
            console.log(`\n   attach child exited with code ${code}`);
            resolvePromise();
          });
          child.on('error', (err) => {
            console.log(`\n   attach child spawn error: ${err.message}`);
            resolvePromise();
          });
        });
      } else {
        console.log('\n6. (pass a background short id from step 5 to run the exact cockpit attach interactively)');
      }
    }),
  );
