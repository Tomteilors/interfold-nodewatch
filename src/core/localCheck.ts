import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Alert } from './alerts.js';

const execAsync = promisify(exec);

/**
 * Best-effort parser for `interfold ciphernode status` output. The exact
 * format of that command is not documented publicly, so this looks for
 * "Registered" / "Active" followed by a boolean-ish token on the same line
 * and ignores anything else. Returns null fields it could not find.
 */
export function parseLocalStatus(output: string): { registered: boolean | null; active: boolean | null } {
  const registeredMatch = /registered\s*[:=]?\s*(true|false|yes|no)/i.exec(output);
  const activeMatch = /active\s*[:=]?\s*(true|false|yes|no)/i.exec(output);

  const toBool = (token: string | undefined): boolean | null => {
    if (!token) return null;
    return /^(true|yes)$/i.test(token);
  };

  return {
    registered: toBool(registeredMatch?.[1]),
    active: toBool(activeMatch?.[1]),
  };
}

/** Strip ANSI colour codes the interfold CLI prints on errors. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Runs `interfold ciphernode status` and compares it against the on-chain
 * values already fetched for this tick. Returns a one-line problem
 * description, or null when everything agrees.
 */
export async function probeLocal(
  onChainRegistered: boolean,
  onChainActive: boolean,
  bin = 'interfold',
): Promise<string | null> {
  let stdout: string;
  try {
    const result = await execAsync(`${bin} ciphernode status`, { timeout: 60_000 });
    stdout = result.stdout;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = stripAnsi(raw).replace(/\s+/g, ' ').trim();
    const hint = /not found|ENOENT/i.test(msg)
      ? ' (a cron or systemd shell has a minimal PATH -- set INTERFOLD_BIN to the full path)'
      : '';
    return `\`${bin} ciphernode status\` failed: ${msg}${hint}`;
  }

  const local = parseLocalStatus(stdout);
  const problems: string[] = [];
  if (local.registered !== null && local.registered !== onChainRegistered) {
    problems.push(`local Registered=${local.registered} disagrees with chain Registered=${onChainRegistered}`);
  }
  if (local.active !== null && local.active !== onChainActive) {
    problems.push(`local Active=${local.active} disagrees with chain Active=${onChainActive}`);
  }
  return problems.length ? problems.join('; ') : null;
}

/**
 * Pure alert rule for the local check: alert when a problem appears or
 * changes, and once more when it clears. The same problem repeating tick
 * after tick stays silent -- the operator already knows.
 */
export function localProblemAlerts(previousProblem: string | null, currentProblem: string | null): Alert[] {
  if (previousProblem === currentProblem) return [];
  if (currentProblem !== null) {
    return [{ severity: 'critical', message: `--local: ${currentProblem}` }];
  }
  return [{ severity: 'info', message: '--local: `interfold ciphernode status` agrees with the chain again' }];
}

/** Is it time to run the (RPC-hungry) local status command again? */
export function isLocalCheckDue(lastCheckedAt: string | null | undefined, intervalMinutes: number, now = Date.now()): boolean {
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMinutes * 60_000;
}
