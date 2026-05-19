import { detectInstallKind } from '../launch/index.js';

export interface InstallUrlHandlerOptions {
  /**
   * The caller's `import.meta.url`. Threaded through so the subcommand
   * classifies its own install in the same way the startup nudge does
   * — avoids drift between two detection paths.
   */
  scriptUrl: string;
}

/**
 * Thrown when the subcommand refuses to register because the install path
 * isn't durable. Caught by `formatInstallUrlHandlerError` to surface a
 * cleaner message than the generic "Unexpected error".
 */
export class InstallUrlHandlerRefusalError extends Error {
  constructor(public kind: 'npx' | 'unknown') {
    super(
      `Refusing to register the syntaur:// handler from a non-durable install (kind=${kind}). The bundle path would be GC'd or unresolvable. Install durably with: npm i -g syntaur`,
    );
    this.name = 'InstallUrlHandlerRefusalError';
  }
}

export async function installUrlHandlerCommand(
  options: InstallUrlHandlerOptions,
): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log(
      'syntaur install-url-handler: macOS-only. No action needed on this platform.',
    );
    return;
  }

  const kind = detectInstallKind(options.scriptUrl);
  if (kind === 'npx' || kind === 'unknown') {
    throw new InstallUrlHandlerRefusalError(kind);
  }

  // Dynamic import keeps the .mjs registration logic out of the build graph
  // — tsconfig only includes `src/`, so this stays as runtime ESM import.
  // The module's bottom-of-file `main()` is guarded by an
  // `import.meta.url === pathToFileURL(argv[1]).href` check, so importing
  // here does NOT trigger a second silent registration.
  //
  // Cast at the import site because the .mjs lives outside `src/` and has
  // no .d.ts. Keeping the contract typed here is enough for the caller; the
  // .mjs has its own JSDoc.
  // @ts-expect-error -- .mjs is JS-only; types asserted via the cast below.
  const mod = (await import('../../scripts/install-macos-url-handler.mjs')) as {
    registerMacosUrlHandler: (options: {
      throwOnFailure: boolean;
    }) => Promise<{ bundlePath: string }>;
  };
  const { bundlePath } = await mod.registerMacosUrlHandler({
    throwOnFailure: true,
  });

  console.log(`Registered syntaur:// URL handler at ${bundlePath}.`);
  console.log(`Smoke test: open 'syntaur://open?session=test'`);
  console.log(
    '(See ~/Library/Logs/Syntaur/url-handler.log for diagnostics.)',
  );
}

/**
 * Format a known error for the CLI. Returns a structured message; the caller
 * is responsible for printing it and exiting non-zero.
 */
export function formatInstallUrlHandlerError(err: unknown): string {
  if (err instanceof InstallUrlHandlerRefusalError) {
    return err.message;
  }
  return `Could not install URL handler: ${err instanceof Error ? err.message : String(err)}`;
}
