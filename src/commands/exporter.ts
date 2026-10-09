import { createServer } from 'node:http';
import { resolveConfig, requireOperator } from '../config.js';
import { CONTRACT_ADDRESSES } from '../chain/addresses.js';
import { createClient } from '../chain/client.js';
import { fetchFullStatus } from '../core/status.js';
import { fetchLatestRelease, getLocalVersion } from '../core/release.js';
import { isNewer } from '../core/semver.js';
import { createMetrics } from '../metrics/registry.js';
import { probePeers } from '../core/peerHealth.js';
import type { Address } from 'viem';
import {
  fetchPendingRewards,
  resolveRewardsFromBlock,
  scanRewardCredits,
  type RewardCredit,
} from '../core/rewards.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ExporterCommandOptions {
  operator?: string;
  port?: string;
  rpcUrl?: string;
  chain?: string;
  releaseCheckInterval?: string;
  /** Read the local ciphernode journal for peer health alongside the chain. */
  local?: boolean;
  bondOwner?: string;
  logsRpcUrl?: string;
  /** Commander sets this to false for --no-rewards. */
  rewards?: boolean;
}

export async function runExporter(options: ExporterCommandOptions): Promise<void> {
  const config = resolveConfig({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    operator: options.operator,
    bondOwner: options.bondOwner,
    logsRpcUrl: options.logsRpcUrl,
    exporterPort: options.port ? Number(options.port) : undefined,
    releaseCheckMinutes: options.releaseCheckInterval ? Number(options.releaseCheckInterval) : undefined,
  });
  const operator = requireOperator(config);
  const addresses = CONTRACT_ADDRESSES[config.chain];
  const client = createClient(config.rpcUrl, config.chain);
  const metrics = createMetrics();
  const logsClient = config.logsRpcUrl === config.rpcUrl ? client : createClient(config.logsRpcUrl, config.chain);

  // In-memory reward tracking: credits seen so far plus the last scanned
  // block, so each refresh is one small eth_getLogs plus a pendingReward
  // read per credited E3 (claimed ones drop out as their pending hits 0).
  let rewardOwner: Address | null = null;
  let rewardScannedBlock: bigint | null = null;
  let rewardCredits: RewardCredit[] = [];

  async function refreshRewards(owner: Address, head: bigint): Promise<void> {
    if (owner !== rewardOwner) {
      rewardOwner = owner;
      rewardScannedBlock = null;
      rewardCredits = [];
    }
    const fromBlock = rewardScannedBlock !== null ? rewardScannedBlock + 1n : resolveRewardsFromBlock(config.chain, head);
    if (fromBlock <= head) {
      rewardCredits.push(...(await scanRewardCredits(logsClient, addresses.coordinator, owner, fromBlock, head)));
      rewardScannedBlock = head;
    }
    const pending = await fetchPendingRewards(client, addresses.coordinator, owner, rewardCredits);
    // Forget credits that are fully claimed so the per-refresh reads stay bounded.
    const stillPending = new Set(pending.map((r) => r.e3Id));
    rewardCredits = rewardCredits.filter((c) => stillPending.has(c.e3Id));
    metrics.updateRewards(pending);
  }

  async function refresh(): Promise<void> {
    try {
      const report = await fetchFullStatus(client, addresses, operator, config.chain);
      metrics.update(report);
      if (options.local) {
        metrics.updatePeers(await probePeers(config.nodeUnit, config.logWindowMinutes));
      }
      const owner = config.bondOwnerAddress ?? report.operator.bondOwner;
      if (options.rewards !== false && owner && owner !== ZERO_ADDRESS) {
        try {
          await refreshRewards(owner, report.chainInfo.blockNumber);
        } catch (err) {
          // Keep the last good reward gauges; a log-scan hiccup is not an RPC outage.
          console.error('[exporter] reward check failed:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      metrics.markRpcDown();
      console.error('[exporter] refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  // Release checks hit the GitHub API, which has tight anonymous rate
  // limits -- refreshed on its own, much slower timer (releaseCheckMinutes),
  // independent of the chain poll interval.
  async function refreshRelease(): Promise<void> {
    try {
      const [latest, local] = await Promise.all([fetchLatestRelease(), getLocalVersion()]);
      metrics.updateRelease({
        latestTag: latest?.tag ?? null,
        localVersion: local,
        updateAvailable: Boolean(latest && local && isNewer(latest.version, local)),
      });
    } catch (err) {
      console.error('[exporter] release check failed:', err instanceof Error ? err.message : err);
    }
  }

  await refresh();
  await refreshRelease();
  // Refresh once per poll interval so /metrics scrapes don't each trigger their own chain calls.
  const interval = setInterval(refresh, config.pollIntervalSeconds * 1000);
  interval.unref();
  const releaseInterval = setInterval(refreshRelease, config.releaseCheckMinutes * 60 * 1000);
  releaseInterval.unref();

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.url === '/metrics') {
      metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': metrics.registry.contentType });
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.exporterPort, () => resolve());
  });

  console.log(
    `[exporter] listening on :${config.exporterPort} (/metrics, /healthz), polling every ${config.pollIntervalSeconds}s`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      clearInterval(interval);
      clearInterval(releaseInterval);
      server.close(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
