import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Alert } from './alerts.js';

const execAsync = promisify(exec);

/**
 * Peer-layer health, read from the ciphernode's own log.
 *
 * Why this exists: every on-chain field can look perfect -- Registered, Active,
 * bond intact, tickets intact -- while the node sits with zero connected peers
 * and silently misses every committee it is selected for. The chain cannot see
 * that. The node's log can.
 */

export interface PeerIdMismatch {
  /** The multiaddr that was dialled. */
  multiaddr: string;
  /** Peer id pinned in the address. */
  expected: string;
  /** Peer id the remote end actually presented. */
  got: string;
  /** Loopback mismatches are the node meeting itself and are harmless noise. */
  loopback: boolean;
}

export interface PeerObservation {
  /** Connected peers from the most recent AllPeersDialed line, null if the window had none. */
  connected: number | null;
  /** Peers the node knows about from that same line. */
  total: number | null;
  /** "Failed to trigger bootstrap: No known peers" occurrences. */
  bootstrapEmpty: number;
  /** "No connected peers available" occurrences -- work that could not be done. */
  requestsWithoutPeers: number;
  /** "Peer admitted" occurrences -- evidence the mesh is alive. */
  peersAdmitted: number;
  /** Pinned-identity mismatches, loopback ones flagged separately. */
  mismatches: PeerIdMismatch[];
  /** Lines the parser looked at, useful for "the log window was empty" reporting. */
  linesScanned: number;
}

export type PeerVerdict = 'healthy' | 'degraded' | 'isolated' | 'unknown';

export interface PeerHealth {
  verdict: PeerVerdict;
  /** One line a human can act on. */
  summary: string;
  observation: PeerObservation;
}

const RE_DIALED = /AllPeersDialed\s*\(connected=(\d+),\s*total=(\d+)\)/;
const RE_BOOTSTRAP_EMPTY = /Failed to trigger bootstrap: No known peers/;
const RE_NO_PEERS = /No connected peers available/;
const RE_ADMITTED = /Peer admitted peer_id=/;
const RE_MISMATCH = /Peer ID mismatch at (\S+?):\s*expected (\S+?),\s*got (\S+?)(?:\s|$|—|--)/;

/** A multiaddr pointing at this machine -- the node dialling itself. */
export function isLoopbackMultiaddr(multiaddr: string): boolean {
  return /\/ip4\/127\.0\.0\.1\//.test(multiaddr) || /\/ip6\/::1\//.test(multiaddr);
}

/**
 * Parse a window of ciphernode log lines. Pure: give it strings, get counts.
 * Unknown lines are ignored rather than guessed at.
 */
export function parsePeerLog(lines: string[]): PeerObservation {
  const obs: PeerObservation = {
    connected: null,
    total: null,
    bootstrapEmpty: 0,
    requestsWithoutPeers: 0,
    peersAdmitted: 0,
    mismatches: [],
    linesScanned: lines.length,
  };

  for (const line of lines) {
    const dialed = RE_DIALED.exec(line);
    if (dialed) {
      // Later lines overwrite earlier ones: we want the most recent reading.
      obs.connected = Number(dialed[1]);
      obs.total = Number(dialed[2]);
      continue;
    }
    if (RE_BOOTSTRAP_EMPTY.test(line)) {
      obs.bootstrapEmpty += 1;
      continue;
    }
    if (RE_NO_PEERS.test(line)) {
      obs.requestsWithoutPeers += 1;
      continue;
    }
    if (RE_ADMITTED.test(line)) {
      obs.peersAdmitted += 1;
      continue;
    }
    const mismatch = RE_MISMATCH.exec(line);
    if (mismatch) {
      const [, multiaddr, expected, got] = mismatch;
      if (multiaddr === undefined || expected === undefined || got === undefined) continue;
      obs.mismatches.push({
        multiaddr,
        expected,
        got,
        loopback: isLoopbackMultiaddr(multiaddr),
      });
    }
  }

  return obs;
}

/** Mismatches that matter: a bootstrap or peer address pinned to a stale peer id. */
export function realMismatches(obs: PeerObservation): PeerIdMismatch[] {
  return obs.mismatches.filter((m) => !m.loopback);
}

/**
 * Turn an observation into a verdict. The ordering is deliberate: evidence of
 * work failing for lack of peers outranks a stale connected= reading.
 */
export function classifyPeerHealth(obs: PeerObservation): PeerHealth {
  const bad = realMismatches(obs);

  if (obs.linesScanned === 0) {
    return {
      verdict: 'unknown',
      summary: 'no ciphernode log lines in the window -- is the unit name right?',
      observation: obs,
    };
  }

  if (obs.requestsWithoutPeers > 0) {
    return {
      verdict: 'isolated',
      summary: `${obs.requestsWithoutPeers} request(s) failed with "no connected peers available"`,
      observation: obs,
    };
  }

  if (obs.connected === 0) {
    const extra = obs.bootstrapEmpty > 0 ? `, bootstrap found no known peers ${obs.bootstrapEmpty}x` : '';
    return {
      verdict: 'isolated',
      summary: `0 connected peers (knows ${obs.total ?? 0})${extra}`,
      observation: obs,
    };
  }

  const firstBad = bad[0];
  if (firstBad) {
    return {
      verdict: 'degraded',
      summary: `peer id mismatch dialling ${firstBad.multiaddr}: expected ${firstBad.expected}, got ${firstBad.got}`,
      observation: obs,
    };
  }

  if (obs.bootstrapEmpty > 0 && obs.connected === null) {
    return {
      verdict: 'degraded',
      summary: `bootstrap reported no known peers ${obs.bootstrapEmpty}x and no peer count was logged`,
      observation: obs,
    };
  }

  if (obs.connected !== null) {
    return {
      verdict: 'healthy',
      summary: `${obs.connected} connected peer(s) of ${obs.total ?? obs.connected} known`,
      observation: obs,
    };
  }

  if (obs.peersAdmitted > 0) {
    return {
      verdict: 'healthy',
      summary: `${obs.peersAdmitted} peer(s) admitted, no peer errors in the window`,
      observation: obs,
    };
  }

  // A settled node logs nothing about peers for long stretches -- counts are
  // written at bootstrap, not on a timer. "No news" is genuinely no news, so
  // say that rather than claiming health the log does not actually show.
  return {
    verdict: 'unknown',
    summary: `no peer errors in ${obs.linesScanned} log line(s); peer counts are only logged at bootstrap`,
    observation: obs,
  };
}

/**
 * Alert rules for the peer layer. Pure, so the interesting cases are testable.
 *
 * The headline rule -- and the reason the whole module exists -- is the first
 * one: on-chain the operator is registered and active, off-chain it is talking
 * to nobody. That combination is invisible to a chain-only monitor.
 */
export function peerAlerts(
  previousVerdict: PeerVerdict | null | undefined,
  current: PeerHealth,
  onChain: { registered: boolean; active: boolean },
): Alert[] {
  if (previousVerdict === current.verdict) return [];

  const liveOnChain = onChain.registered && onChain.active;

  if (current.verdict === 'isolated') {
    const lead = liveOnChain
      ? 'Node is Registered and Active on-chain but network-isolated'
      : 'Node is network-isolated';
    return [{ severity: 'critical', message: `${lead}: ${current.summary}` }];
  }

  if (current.verdict === 'degraded') {
    const bad = realMismatches(current.observation);
    const hint = bad.length
      ? ' -- the peer id pinned in that address is stale; check your configured bootstrap address'
      : '';
    return [{ severity: 'warning', message: `Peer layer degraded: ${current.summary}${hint}` }];
  }

  if (current.verdict === 'healthy' && previousVerdict && previousVerdict !== 'unknown') {
    return [{ severity: 'info', message: `Peer layer recovered: ${current.summary}` }];
  }

  return [];
}

/**
 * Read the last `windowMinutes` of the ciphernode's journal. The command is
 * injectable so tests never shell out.
 */
export async function readNodeLog(
  unit: string,
  windowMinutes: number,
  runner: (cmd: string) => Promise<{ stdout: string }> = (cmd) => execAsync(cmd, { timeout: 30_000 }),
): Promise<string[] | null> {
  const safeUnit = unit.replace(/[^A-Za-z0-9._@-]/g, '');
  if (!safeUnit) return null;
  const cmd = `journalctl -u ${safeUnit} --since "${Math.max(1, Math.floor(windowMinutes))} min ago" --no-pager`;
  try {
    const { stdout } = await runner(cmd);
    return stdout.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return null;
  }
}

/** Read the log and classify in one step. Returns null when the log is unreadable. */
export async function probePeers(
  unit: string,
  windowMinutes: number,
  runner?: (cmd: string) => Promise<{ stdout: string }>,
): Promise<PeerHealth | null> {
  const lines = await readNodeLog(unit, windowMinutes, runner);
  if (lines === null) return null;
  return classifyPeerHealth(parsePeerLog(lines));
}
