import { Command } from 'commander';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { runCommand } from '../errors.js';
import { checkClaudeAttachCommand } from '../tui/claude-agents/capability.js';
import { buildClaudeAttachArgv } from '../tui/claude-agents/attach.js';

const execFileAsync = promisify(execFile);

/**
 * Every `claude` executable reachable on PATH, in resolution order. More than
 * one entry (or a first entry that isn't the expected install) means a
 * wrapper/shim shadows the real binary — the classic reason the cockpit's
 * probe can disagree with a login shell's `claude attach --help`.
 */
export function scanPathForClaude(pathEnv: string | undefined = process.env.PATH): string[] {
  const hits: string[] = [];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      hits.push(candidate);
    } catch {
      /* not here */
    }
  }
  return hits;
}

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

      // 3. The raw probe, exactly as the cockpit runs it.
      console.log('\n3. Raw probe (`claude attach --help`, 15s timeout):');
      try {
        const { stdout, stderr } = await execFileAsync('claude', ['attach', '--help'], { timeout: 15000 });
        console.log(`   exit: 0`);
        console.log(`   stdout: ${JSON.stringify(stdout.slice(0, 100))}`);
        console.log(`   stderr: ${JSON.stringify(stderr.slice(0, 100))}`);
      } catch (err) {
        const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
        console.log(`   exit/err: ${String(e.code ?? e.message)}`);
        console.log(`   stdout: ${JSON.stringify(String(e.stdout ?? '').slice(0, 100))}`);
        console.log(`   stderr: ${JSON.stringify(String(e.stderr ?? '').slice(0, 100))}`);
      }

      // 4. The cockpit's actual verdict (same memoized function it calls).
      const direct = await checkClaudeAttachCommand();
      console.log(`\n4. Cockpit verdict — checkClaudeAttachCommand(): ${direct ? 'DIRECT ATTACH (claude attach <id>)' : 'FALLBACK (Agent View picker)'}`);

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
        console.log(`\n6. Running the exact cockpit attach now: claude ${argv.join(' ')}`);
        console.log('   (this is interactive — detach/exit to return; what renders IS what the cockpit shows)\n');
        await new Promise<void>((resolvePromise) => {
          const child = spawn('claude', argv, { stdio: 'inherit' });
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
