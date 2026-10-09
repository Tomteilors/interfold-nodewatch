import { Registry, Gauge } from 'prom-client';
import type { NodeStatusReport } from '../types.js';
import type { PeerHealth } from '../core/peerHealth.js';
import { realMismatches } from '../core/peerHealth.js';
import { E3_STAGE_NAMES, E3Stage } from '../chain/abi/coordinator.js';
import { sumBySymbol, type PendingReward } from '../core/rewards.js';

export interface ReleaseInfo {
  latestTag: string | null;
  localVersion: string | null;
  updateAvailable: boolean;
}

export interface NodewatchMetrics {
  registry: Registry;
  rpcUp: Gauge<string>;
  update(report: NodeStatusReport): void;
  markRpcDown(): void;
  updateRelease(info: ReleaseInfo): void;
  updatePeers(health: PeerHealth | null): void;
  updateRewards(pending: PendingReward[]): void;
}

export function createMetrics(): NodewatchMetrics {
  const registry = new Registry();

  const operatorRegistered = new Gauge({
    name: 'interfold_operator_registered',
    help: '1 if the configured operator is registered in BondingRegistry, else 0',
    registers: [registry],
  });
  const operatorActive = new Gauge({
    name: 'interfold_operator_active',
    help: '1 if the configured operator is active, else 0',
    registers: [registry],
  });
  const operatorBondFold = new Gauge({
    name: 'interfold_operator_bond_fold',
    help: "Operator's ciphernode bond, in whole FOLD",
    registers: [registry],
  });
  const operatorTickets = new Gauge({
    name: 'interfold_operator_tickets',
    help: "Operator's ticket count",
    registers: [registry],
  });
  const networkTickets = new Gauge({
    name: 'interfold_network_tickets',
    help: 'Total tickets network-wide (tFOLD.totalSupply / ticketPrice)',
    registers: [registry],
  });
  const ticketShare = new Gauge({
    name: 'interfold_ticket_share',
    help: "Operator's share of total network tickets, percent (0-100)",
    registers: [registry],
  });
  const requestsPaused = new Gauge({
    name: 'interfold_requests_paused',
    help: '1 if the coordinator has E3 requests paused, else 0',
    registers: [registry],
  });
  const e3Total = new Gauge({
    name: 'interfold_e3_total',
    help: 'Total E3 requests seen so far',
    registers: [registry],
  });
  const e3ByStage = new Gauge({
    name: 'interfold_e3_by_stage',
    help: 'E3 count by lifecycle stage',
    labelNames: ['stage'],
    registers: [registry],
  });
  const rpcUp = new Gauge({
    name: 'interfold_rpc_up',
    help: '1 if the last RPC call succeeded, else 0',
    registers: [registry],
  });
  const lastBlock = new Gauge({
    name: 'interfold_last_block',
    help: 'Last block number observed',
    registers: [registry],
  });
  const releaseLatestInfo = new Gauge({
    name: 'interfold_release_latest_info',
    help: 'Always 1; the `tag` label carries the latest interfold release tag (Prometheus info-metric pattern)',
    labelNames: ['tag'],
    registers: [registry],
  });
  const localVersionInfo = new Gauge({
    name: 'interfold_local_version_info',
    help: 'Always 1; the `tag` label carries the locally installed interfold version. Absent if no local binary was found',
    labelNames: ['tag'],
    registers: [registry],
  });
  const updateAvailable = new Gauge({
    name: 'interfold_update_available',
    help: '1 if the local interfold binary is behind the latest release, else 0. Always 0 if no local binary was found',
    registers: [registry],
  });

  const peersConnected = new Gauge({
    name: 'interfold_peers_connected',
    help: 'Connected peers from the ciphernode log. -1 when the log gave no reading',
    registers: [registry],
  });
  const peersKnown = new Gauge({
    name: 'interfold_peers_known',
    help: 'Peers the ciphernode knows about. -1 when the log gave no reading',
    registers: [registry],
  });
  const peerIsolated = new Gauge({
    name: 'interfold_peer_isolated',
    help: '1 if the node has no usable peers -- the failure that on-chain status cannot show',
    registers: [registry],
  });
  const peerIdMismatch = new Gauge({
    name: 'interfold_peer_id_mismatch',
    help: 'Non-loopback peer id mismatches in the window: a pinned peer id in a dialled address is stale',
    registers: [registry],
  });
  const peerBootstrapEmpty = new Gauge({
    name: 'interfold_peer_bootstrap_empty',
    help: 'Times bootstrap reported no known peers in the window',
    registers: [registry],
  });

  const rewardsPending = new Gauge({
    name: 'interfold_rewards_pending',
    help: 'Unclaimed E3 rewards credited to the bond owner, in whole token units, by token symbol. Pull-based: claimReward(e3Id) from the bond owner wallet',
    labelNames: ['token'],
    registers: [registry],
  });
  const rewardsPendingCount = new Gauge({
    name: 'interfold_rewards_pending_count',
    help: 'Number of E3 ids with an unclaimed reward for the bond owner',
    registers: [registry],
  });

  function update(report: NodeStatusReport): void {
    operatorRegistered.set(report.operator.registered ? 1 : 0);
    operatorActive.set(report.operator.active ? 1 : 0);
    operatorBondFold.set(report.operator.bondFold);
    operatorTickets.set(report.operator.tickets);
    networkTickets.set(report.network.totalTickets);
    ticketShare.set(report.network.ticketSharePercent);
    requestsPaused.set(report.protocol.requestsPaused ? 1 : 0);
    e3Total.set(report.protocol.e3Total);

    e3ByStage.set({ stage: E3_STAGE_NAMES[E3Stage.Requested] }, report.protocol.e3ByStage.requested);
    e3ByStage.set(
      { stage: E3_STAGE_NAMES[E3Stage.CommitteeFinalized] },
      report.protocol.e3ByStage.committeeFinalized,
    );
    e3ByStage.set({ stage: E3_STAGE_NAMES[E3Stage.KeyPublished] }, report.protocol.e3ByStage.keyPublished);
    e3ByStage.set(
      { stage: E3_STAGE_NAMES[E3Stage.CiphertextReady] },
      report.protocol.e3ByStage.ciphertextReady,
    );
    e3ByStage.set({ stage: E3_STAGE_NAMES[E3Stage.Complete] }, report.protocol.e3ByStage.complete);
    e3ByStage.set({ stage: E3_STAGE_NAMES[E3Stage.Failed] }, report.protocol.e3ByStage.failed);

    rpcUp.set(1);
    lastBlock.set(Number(report.chainInfo.blockNumber));
  }

  function markRpcDown(): void {
    rpcUp.set(0);
  }

  /**
   * Peer-layer gauges. A null health means the log could not be read at all --
   * that is reported as "no reading" (-1) rather than a confident zero, so a
   * missing journal never looks like an isolated node on the dashboard.
   */
  function updatePeers(health: PeerHealth | null): void {
    if (!health) {
      peersConnected.set(-1);
      peersKnown.set(-1);
      peerIsolated.set(0);
      peerIdMismatch.set(0);
      peerBootstrapEmpty.set(0);
      return;
    }
    const { observation } = health;
    peersConnected.set(observation.connected ?? -1);
    peersKnown.set(observation.total ?? -1);
    peerIsolated.set(health.verdict === 'isolated' ? 1 : 0);
    peerIdMismatch.set(realMismatches(observation).length);
    peerBootstrapEmpty.set(observation.bootstrapEmpty);
  }

  function updateRelease(info: ReleaseInfo): void {
    releaseLatestInfo.reset();
    if (info.latestTag) {
      releaseLatestInfo.set({ tag: info.latestTag }, 1);
    }

    localVersionInfo.reset();
    if (info.localVersion) {
      localVersionInfo.set({ tag: info.localVersion }, 1);
    }

    updateAvailable.set(info.updateAvailable ? 1 : 0);
  }

  function updateRewards(pending: PendingReward[]): void {
    rewardsPending.reset();
    for (const [symbol, amount] of sumBySymbol(pending)) {
      rewardsPending.set({ token: symbol }, amount);
    }
    rewardsPendingCount.set(pending.length);
  }

  return { registry, rpcUp, update, markRpcDown, updateRelease, updatePeers, updateRewards };
}
