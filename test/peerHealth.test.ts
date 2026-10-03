import { describe, expect, it } from 'vitest';
import {
  classifyPeerHealth,
  isLoopbackMultiaddr,
  parsePeerLog,
  peerAlerts,
  probePeers,
  readNodeLog,
  realMismatches,
} from '../src/core/peerHealth.js';

/**
 * The fixtures below are real ciphernode log shapes with the peer ids and
 * addresses replaced by placeholders.
 */
const PEER_A = '12D3KooWAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER_B = '12D3KooWBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BOOTSTRAP = `/ip4/203.0.113.10/udp/9501/quic-v1/p2p/${PEER_A}`;
const SELF = `/ip4/127.0.0.1/udp/9091/quic-v1/p2p/${PEER_A}`;

const stamp = 'Oct 03 12:47:25 node interfold[123]: 2026-10-03T10:47:25.215078Z ';

const dialed = (connected: number, total: number) =>
  `${stamp} INFO NetSyncManager: AllPeersDialed (connected=${connected}, total=${total})`;
const bootstrapEmpty = `${stamp} WARN Failed to trigger bootstrap: No known peers.`;
const noPeers = `${stamp} ERROR Operation failed after 3 attempts: Request failed: Request failed: No connected peers available`;
const admitted = `${stamp} INFO Peer admitted peer_id=${PEER_A} peer_agent=interfold-ciphernode/0.18.0 network=mainnet`;
const mismatchAt = (addr: string) =>
  `${stamp} INFO Peer ID mismatch at ${addr}: expected ${PEER_A}, got ${PEER_B} — removing`;

describe('parsePeerLog', () => {
  it('takes the most recent peer count, not the first', () => {
    const obs = parsePeerLog([dialed(0, 1), dialed(3, 4)]);
    expect(obs.connected).toBe(3);
    expect(obs.total).toBe(4);
  });

  it('counts the three failure shapes separately', () => {
    const obs = parsePeerLog([bootstrapEmpty, bootstrapEmpty, noPeers, admitted]);
    expect(obs.bootstrapEmpty).toBe(2);
    expect(obs.requestsWithoutPeers).toBe(1);
    expect(obs.peersAdmitted).toBe(1);
  });

  it('pulls both peer ids and the address out of a mismatch line', () => {
    const [m] = parsePeerLog([mismatchAt(BOOTSTRAP)]).mismatches;
    expect(m.multiaddr).toBe(BOOTSTRAP);
    expect(m.expected).toBe(PEER_A);
    expect(m.got).toBe(PEER_B);
    expect(m.loopback).toBe(false);
  });

  it('ignores unrelated log lines instead of guessing', () => {
    const obs = parsePeerLog([
      `${stamp} INFO evm_interface: Log fetch complete chain_id=1 chunks_fetched=1`,
      `${stamp} INFO Checking for AllPeersDialed...`,
    ]);
    expect(obs.connected).toBeNull();
    expect(obs.mismatches).toEqual([]);
  });
});

describe('loopback mismatches', () => {
  it('recognises the node dialling itself', () => {
    expect(isLoopbackMultiaddr(SELF)).toBe(true);
    expect(isLoopbackMultiaddr(BOOTSTRAP)).toBe(false);
  });

  it('does not treat a self-dial as a real problem', () => {
    const obs = parsePeerLog([mismatchAt(SELF), dialed(2, 2)]);
    expect(obs.mismatches).toHaveLength(1);
    expect(realMismatches(obs)).toHaveLength(0);
    expect(classifyPeerHealth(obs).verdict).toBe('healthy');
  });
});

describe('classifyPeerHealth', () => {
  it('calls zero connected peers isolated', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(0, 1), bootstrapEmpty]));
    expect(health.verdict).toBe('isolated');
    expect(health.summary).toContain('0 connected peers');
  });

  it('ranks failed work above a stale peer count', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(5, 5), noPeers]));
    expect(health.verdict).toBe('isolated');
    expect(health.summary).toContain('no connected peers available');
  });

  it('calls a stale pinned peer id degraded, not dead', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(1, 1), mismatchAt(BOOTSTRAP)]));
    expect(health.verdict).toBe('degraded');
    expect(health.summary).toContain('expected');
  });

  it('reports unknown rather than healthy when the window is empty', () => {
    const health = classifyPeerHealth(parsePeerLog([]));
    expect(health.verdict).toBe('unknown');
    expect(health.summary).toContain('unit name');
  });

  it('does not claim health from a quiet window, and says why it is quiet', () => {
    const quiet = classifyPeerHealth(
      parsePeerLog([`${stamp} INFO evm_interface: Log fetch complete chain_id=1 chunks_fetched=1`]),
    );
    expect(quiet.verdict).toBe('unknown');
    expect(quiet.summary).toContain('no peer errors');
    expect(quiet.summary).toContain('only logged at bootstrap');
    expect(peerAlerts('healthy', quiet, { registered: true, active: true })).toEqual([]);
  });

  it('is healthy on a plain connected count', () => {
    expect(classifyPeerHealth(parsePeerLog([dialed(33, 33)])).verdict).toBe('healthy');
  });
});

describe('peerAlerts', () => {
  const live = { registered: true, active: true };

  it('says plainly that the chain looks fine and the network does not', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(0, 1)]));
    const [alert] = peerAlerts('healthy', health, live);
    expect(alert.severity).toBe('critical');
    expect(alert.message).toContain('Registered and Active on-chain but network-isolated');
  });

  it('drops the on-chain half of the sentence when the operator is not live', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(0, 1)]));
    const [alert] = peerAlerts('healthy', health, { registered: true, active: false });
    expect(alert.message).toContain('Node is network-isolated');
    expect(alert.message).not.toContain('Registered and Active');
  });

  it('stays silent while the verdict is unchanged', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(0, 1)]));
    expect(peerAlerts('isolated', health, live)).toEqual([]);
  });

  it('points at the configured bootstrap address on a mismatch', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(1, 1), mismatchAt(BOOTSTRAP)]));
    const [alert] = peerAlerts('healthy', health, live);
    expect(alert.severity).toBe('warning');
    expect(alert.message).toContain('stale');
  });

  it('announces recovery once', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(4, 4)]));
    const [alert] = peerAlerts('isolated', health, live);
    expect(alert.severity).toBe('info');
    expect(peerAlerts('healthy', health, live)).toEqual([]);
  });

  it('does not announce recovery on the very first reading', () => {
    const health = classifyPeerHealth(parsePeerLog([dialed(4, 4)]));
    expect(peerAlerts(null, health, live)).toEqual([]);
    expect(peerAlerts('unknown', health, live)).toEqual([]);
  });
});

describe('readNodeLog', () => {
  it('builds a bounded journalctl command and splits the output', async () => {
    let seen = '';
    const lines = await readNodeLog('interfold', 15, async (cmd) => {
      seen = cmd;
      return { stdout: `${dialed(2, 2)}\n\n${admitted}\n` };
    });
    expect(seen).toBe('journalctl -u interfold --since "15 min ago" --no-pager');
    expect(lines).toHaveLength(2);
  });

  it('refuses to interpolate a hostile unit name', async () => {
    let seen = '';
    await readNodeLog('interfold; rm -rf /', 15, async (cmd) => {
      seen = cmd;
      return { stdout: '' };
    });
    expect(seen).toBe('journalctl -u interfoldrm-rf --since "15 min ago" --no-pager');
    expect(await readNodeLog('   ', 15, async () => ({ stdout: '' }))).toBeNull();
  });

  it('returns null when journalctl is unavailable instead of throwing', async () => {
    const lines = await readNodeLog('interfold', 15, async () => {
      throw new Error('journalctl: command not found');
    });
    expect(lines).toBeNull();
    expect(await probePeers('interfold', 15, async () => {
      throw new Error('nope');
    })).toBeNull();
  });

  it('never asks journalctl for a zero or negative window', async () => {
    let seen = '';
    await readNodeLog('interfold', 0, async (cmd) => {
      seen = cmd;
      return { stdout: '' };
    });
    expect(seen).toContain('"1 min ago"');
  });
});
