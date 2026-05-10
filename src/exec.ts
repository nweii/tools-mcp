// ABOUTME: Subprocess runner for wrapped CLIs — captures stdout/stderr, applies a timeout, and surfaces non-zero exits as actionable errors.
import { spawn } from 'child_process';

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

export function runCli(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliError(cmd, args, null, stdout, stderr, `${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killer);
      reject(new CliError(cmd, args, null, stdout, stderr, `Failed to spawn ${cmd}: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CliError(cmd, args, code, stdout, stderr));
    });
  });
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
