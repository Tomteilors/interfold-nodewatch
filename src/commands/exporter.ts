import { createServer } from 'node:http';
import { resolveConfig, requireOperator } from '../config.js';
import { CONTRACT_ADDRESSES } from '../chain/addresses.js';
import { createClient } from '../chain/client.js';
import { fetchFullStatus } from '../core/status.js';
import { fetchLatestRelease, getLocalVersion } from '../core/release.js';
import { isNewer } from '../core/semver.js';
import { createMetrics } from '../metrics/registry.js';
import { probePeers } from '../core/peerHealth.js';

export interface ExporterCommandOptions {
  operator?: string;
  port?: string;
  rpcUrl?: string;
  chain?: string;
  releaseCheckInterval?: string;
  /** Read the local ciphernode journal for peer health alongside the chain. */
  local?: boolean;
}

export async function runExporter(options: ExporterCommandOptions): Promise<void> {
  const config = resolveConfig({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    operator: options.operator,
    exporterPort: options.port ? Number(options.port) : undefined,
    releaseCheckMinutes: options.releaseCheckInterval ? Number(options.releaseCheckInterval) : undefined,
  });
  const operator = requireOperator(config);
  const addresses = CONTRACT_ADDRESSES[config.chain];
  const client = createClient(config.rpcUrl, config.chain);
  const metrics = createMetrics();

  async function refresh(): Promise<void> {
    try {
      const report = await fetchFullStatus(client, addresses, operator, config.chain);
      metrics.update(report);
      if (options.local) {
        metrics.updatePeers(await probePeers(config.nodeUnit, config.logWindowMinutes));
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
