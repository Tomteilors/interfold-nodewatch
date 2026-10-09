import { formatFold } from './math.js';

export interface WatchSnapshot {
  registered: boolean;
  active: boolean;
  bondRaw: string; // bigint serialized as decimal string
  tickets: number;
  requestsPaused: boolean;
  e3Total: number;
  lastScannedBlock: string; // bigint serialized as decimal string
  consecutiveRpcFailures: number;
  /**
   * Release-tracking fields. Optional so state.json files written before
   * this feature existed still load fine (see core/state.ts).
   */
  releaseLatestTag?: string | null;
  releaseLastAlertedVersion?: string | null;
  releaseLastCheckedAt?: string | null;
  /** --local: last time `interfold ciphernode status` was run, and the problem it reported (null = healthy). */
  localLastCheckedAt?: string | null;
  localLastProblem?: string | null;
  /** --local: last peer-layer verdict, so the same verdict is not alerted twice. */
  peerVerdict?: 'healthy' | 'degraded' | 'isolated' | 'unknown' | null;
  /** E3 rewards: bond owner the scan below belongs to (a change restarts the scan). */
  rewardsOwner?: string | null;
  /** Last block scanned for RewardCredited, bigint as decimal string. */
  rewardsScannedBlock?: string | null;
  /** e3Ids already alerted as unclaimed, so each reward is announced once. */
  rewardsAlerted?: string[];
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  message: string;
}

function alert(severity: AlertSeverity, message: string): Alert {
  return { severity, message };
}

/**
 * Pure diff between two watch snapshots. No network access -- this is the
 * function under test for "what should watch alert on when X changes".
 */
export function diffSnapshots(prev: WatchSnapshot, curr: WatchSnapshot): Alert[] {
  const alerts: Alert[] = [];

  if (prev.registered !== curr.registered) {
    alerts.push(
      alert(
        curr.registered ? 'info' : 'critical',
        `Registration changed: ${prev.registered} -> ${curr.registered}`,
      ),
    );
  }

  if (prev.active !== curr.active) {
    alerts.push(
      alert(curr.active ? 'info' : 'critical', `Active status changed: ${prev.active} -> ${curr.active}`),
    );
  }

  if (prev.bondRaw !== curr.bondRaw) {
    const prevRaw = BigInt(prev.bondRaw);
    const currRaw = BigInt(curr.bondRaw);
    const severity: AlertSeverity = currRaw < prevRaw ? 'critical' : 'info';
    alerts.push(
      alert(severity, `Ciphernode bond changed: ${formatFold(prevRaw)} -> ${formatFold(currRaw)} FOLD`),
    );
  }

  if (prev.tickets !== curr.tickets) {
    const severity: AlertSeverity = curr.tickets < prev.tickets ? 'warning' : 'info';
    alerts.push(alert(severity, `Ticket balance changed: ${prev.tickets} -> ${curr.tickets} tickets`));
  }

  if (prev.requestsPaused !== curr.requestsPaused) {
    alerts.push(
      alert(
        curr.requestsPaused ? 'warning' : 'info',
        `Protocol requestsPaused flipped: ${prev.requestsPaused} -> ${curr.requestsPaused}`,
      ),
    );
  }

  if (curr.e3Total > prev.e3Total) {
    const newCount = curr.e3Total - prev.e3Total;
    alerts.push(alert('info', `${newCount} new E3 request(s): total now ${curr.e3Total}`));
  }

  return alerts;
}

/** RPC-down alert, raised once the failure streak crosses the threshold, and once more when it recovers. */
export function rpcFailureAlert(
  previousConsecutiveFailures: number,
  currentConsecutiveFailures: number,
  threshold: number,
): Alert | null {
  if (currentConsecutiveFailures >= threshold && previousConsecutiveFailures < threshold) {
    return alert('critical', `RPC unreachable ${currentConsecutiveFailures} times in a row`);
  }
  if (currentConsecutiveFailures === 0 && previousConsecutiveFailures >= threshold) {
    return alert('info', 'RPC connection recovered');
  }
  return null;
}
