// ABOUTME: Subprocess runner for wrapped CLIs — captures stdout/stderr, applies a timeout, and surfaces non-zero exits as actionable errors.
export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Milliseconds before the child is killed and the call rejects. Default 30s. */
  timeoutMs?: number;
  /** Extra env merged onto process.env. */
  env?: NodeJS.ProcessEnv;
}

export class CliError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    msg?: string,
  ) {
    super(msg ?? `${cmd} exited ${exitCode}: ${stderr.trim() || stdout.trim() || '(no output)'}`);
    this.name = 'CliError';
  }
}

export async function runCli(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Bun.spawn rather than node:child_process: under Bun on macOS the compat layer's 'close'
  // event occasionally never fires for a fast-exiting child, which hangs the call until timeout.
  let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
  try {
    child = Bun.spawn([cmd, ...args], {
      env: { ...process.env, ...opts.env, NO_COLOR: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(cmd, args, null, '', '', `Failed to spawn ${cmd}: ${message}`);
  }

  let killer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliError(cmd, args, null, '', '', `${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const [stdout, stderr, code] = await Promise.race([output, timeout]).finally(() => clearTimeout(killer));
  if (code !== 0) throw new CliError(cmd, args, code, stdout, stderr);
  return { stdout, stderr };
}

/** Parse stdout as JSON, with the raw text in the error if parsing fails. */
export function parseJsonOutput<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    const head = stdout.slice(0, 500);
    throw new Error(`Expected JSON output but got non-JSON: ${head}${stdout.length > 500 ? '…' : ''}`);
  }
}
