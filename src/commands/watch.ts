import { resolveConfig, requireOperator } from '../config.js';
import { CONTRACT_ADDRESSES } from '../chain/addresses.js';
import { createClient } from '../chain/client.js';
import { fetchFullStatus } from '../core/status.js';
import { loadState, saveState } from '../core/state.js';
import { diffSnapshots, rpcFailureAlert, type Alert, type WatchSnapshot } from '../core/alerts.js';
import { scanEventAlerts } from '../core/events.js';
import { isLocalCheckDue, localProblemAlerts, probeLocal } from '../core/localCheck.js';
import { peerAlerts, probePeers, type PeerVerdict } from '../core/peerHealth.js';
import { fetchLatestRelease, getLocalVersion } from '../core/release.js';
import { checkNewReleaseAlert, checkUpdateAvailableAlert } from '../core/releaseAlerts.js';
import { sendTelegramMessage } from '../notify/telegram.js';

export interface WatchCommandOptions {
  operator?: string;
  interval?: string;
  rpcUrl?: string;
  chain?: string;
  state?: string;
  local?: boolean;
  localCheckInterval?: string;
  once?: boolean;
  releaseCheckInterval?: string;
}

const RPC_FAILURE_THRESHOLD = 3;
const DEFAULT_LOCAL_CHECK_MINUTES = 10;

interface SnapshotFields {
  report: Awaited<ReturnType<typeof fetchFullStatus>>;
  lastScannedBlock: bigint;
  consecutiveRpcFailures: number;
  releaseLatestTag: string | null;
  releaseLastAlertedVersion: string | null;
  releaseLastCheckedAt: string | null;
  localLastCheckedAt?: string | null;
  localLastProblem?: string | null;
  peerVerdict?: PeerVerdict | null;
}

function toSnapshot(fields: SnapshotFields): WatchSnapshot {
  const { report } = fields;
  return {
    registered: report.operator.registered,
    active: report.operator.active,
    bondRaw: report.operator.bondRaw.toString(),
    tickets: report.operator.tickets,
    requestsPaused: report.protocol.requestsPaused,
    e3Total: report.protocol.e3Total,
    lastScannedBlock: fields.lastScannedBlock.toString(),
    consecutiveRpcFailures: fields.consecutiveRpcFailures,
    releaseLatestTag: fields.releaseLatestTag,
    releaseLastAlertedVersion: fields.releaseLastAlertedVersion,
    releaseLastCheckedAt: fields.releaseLastCheckedAt,
    localLastCheckedAt: fields.localLastCheckedAt ?? null,
    localLastProblem: fields.localLastProblem ?? null,
    peerVerdict: fields.peerVerdict ?? null,
  };
}

function formatAlert(a: Alert): string {
  return `[${a.severity.toUpperCase()}] ${a.message}`;
}

async function emit(alerts: Alert[], telegram: { botToken?: string; chatId?: string }): Promise<void> {
  if (alerts.length === 0) return;
  for (const a of alerts) {
    console.log(formatAlert(a));
  }
  if (telegram.botToken && telegram.chatId) {
    const text = alerts.map(formatAlert).join('\n');
    try {
      await sendTelegramMessage({ botToken: telegram.botToken, chatId: telegram.chatId }, text);
    } catch (err) {
      console.error('[watch] failed to send Telegram alert:', err instanceof Error ? err.message : err);
    }
  }
}

interface ReleaseCheckResult {
  alerts: Alert[];
  releaseLatestTag: string | null;
  releaseLastAlertedVersion: string | null;
  releaseLastCheckedAt: string | null;
}

/**
 * Runs the release check if it's due (based on releaseCheckMinutes elapsed
 * since the last check), otherwise carries the previous state forward
 * unchanged. GitHub API failures are swallowed here (logged, not thrown) --
 * a flaky release check should never take down the main chain-watching
 * loop, and it will simply retry on the next due check.
 */
async function maybeCheckRelease(
  prev: WatchSnapshot | null,
  releaseCheckMinutes: number,
): Promise<ReleaseCheckResult> {
  const carryForward: ReleaseCheckResult = {
    alerts: [],
    releaseLatestTag: prev?.releaseLatestTag ?? null,
    releaseLastAlertedVersion: prev?.releaseLastAlertedVersion ?? null,
    releaseLastCheckedAt: prev?.releaseLastCheckedAt ?? null,
  };

  const lastCheckedAt = carryForward.releaseLastCheckedAt ? new Date(carryForward.releaseLastCheckedAt) : null;
  const dueNow = !lastCheckedAt || Date.now() - lastCheckedAt.getTime() >= releaseCheckMinutes * 60_000;
  if (!dueNow) return carryForward;

  try {
    const [latest, local] = await Promise.all([fetchLatestRelease(), getLocalVersion()]);
    const nowIso = new Date().toISOString();

    if (!latest) {
      return { ...carryForward, releaseLastCheckedAt: nowIso };
    }

    const alerts: Alert[] = [];
    const newReleaseAlert = checkNewReleaseAlert(carryForward.releaseLatestTag, latest.tag, latest.url);
    if (newReleaseAlert) alerts.push(newReleaseAlert);

    const { alert: updateAlert, nextAlertedVersion } = checkUpdateAvailableAlert(
      local,
      latest.version,
      latest.tag,
      latest.url,
      carryForward.releaseLastAlertedVersion,
    );
    if (updateAlert) alerts.push(updateAlert);

    return {
      alerts,
      releaseLatestTag: latest.tag,
      releaseLastAlertedVersion: nextAlertedVersion,
      releaseLastCheckedAt: nowIso,
    };
  } catch (err) {
    console.error('[watch] release check failed (will retry next interval):', err instanceof Error ? err.message : err);
    // Still stamp the check time so a persistent failure (e.g. rate limit)
    // backs off instead of retrying every single poll tick.
    return { ...carryForward, releaseLastCheckedAt: new Date().toISOString() };
  }
}

export async function runWatch(options: WatchCommandOptions): Promise<void> {
  const config = resolveConfig({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    operator: options.operator,
    pollIntervalSeconds: options.interval ? Number(options.interval) : undefined,
    releaseCheckMinutes: options.releaseCheckInterval ? Number(options.releaseCheckInterval) : undefined,
  });
  const operator = requireOperator(config);
  const localCheckMinutes = options.localCheckInterval ? Number(options.localCheckInterval) : DEFAULT_LOCAL_CHECK_MINUTES;
  const addresses = CONTRACT_ADDRESSES[config.chain];
  const client = createClient(config.rpcUrl, config.chain);
  const statePath = options.state ?? 'state.json';

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(
    `[watch] polling every ${config.pollIntervalSeconds}s for ${operator} on ${config.chain} (release checks every ${config.releaseCheckMinutes}min). Ctrl+C to stop.`,
  );

  while (running) {
    const prev = await loadState(statePath);

    try {
      const report = await fetchFullStatus(client, addresses, operator, config.chain);
      const currentBlock = report.chainInfo.blockNumber;
      const alerts: Alert[] = [];
      // Only advances past prev.lastScannedBlock if the event scan below
      // actually succeeds, so a transient failure gets retried next tick
      // instead of silently skipping that block range.
      let scannedThroughBlock = currentBlock;

      if (prev) {
        const curr = toSnapshot({
          report,
          lastScannedBlock: currentBlock,
          consecutiveRpcFailures: 0,
          releaseLatestTag: prev.releaseLatestTag ?? null,
          releaseLastAlertedVersion: prev.releaseLastAlertedVersion ?? null,
          releaseLastCheckedAt: prev.releaseLastCheckedAt ?? null,
        });
        alerts.push(...diffSnapshots(prev, curr));

        // Event log scanning is best-effort: public multi-backend RPCs can
        // briefly disagree on the chain head (one backend serves a block
        // number that another hasn't indexed logs for yet), which makes
        // eth_getLogs reject an otherwise-valid range. That's a transient
        // hiccup, not a real outage, so it must not count towards the
        // consecutive-RPC-failure alert or block this tick's other alerts
        // and state save.
        const fromBlock = BigInt(prev.lastScannedBlock) + 1n;
        if (fromBlock <= currentBlock) {
          try {
            alerts.push(...(await scanEventAlerts(client, addresses, operator, fromBlock, currentBlock)));
          } catch (err) {
            console.error(
              '[watch] event log scan failed (will retry next tick):',
              err instanceof Error ? err.message : err,
            );
            scannedThroughBlock = BigInt(prev.lastScannedBlock);
          }
        }

        const recovered = rpcFailureAlert(prev.consecutiveRpcFailures, 0, RPC_FAILURE_THRESHOLD);
        if (recovered) alerts.push(recovered);
      }

      let localLastCheckedAt = prev?.localLastCheckedAt ?? null;
      let localLastProblem = prev?.localLastProblem ?? null;
      if (options.local && isLocalCheckDue(localLastCheckedAt, localCheckMinutes)) {
        const problem = await probeLocal(report.operator.registered, report.operator.active, config.nodeBin);
        alerts.push(...localProblemAlerts(localLastProblem, problem));
        localLastProblem = problem;
        localLastCheckedAt = new Date().toISOString();
      }

      // Peer health runs every tick: an isolated node is the failure the chain
      // cannot show you, and it is cheap to read from the local journal.
      let peerVerdict = prev?.peerVerdict ?? null;
      if (options.local) {
        const health = await probePeers(config.nodeUnit, config.logWindowMinutes);
        if (health) {
          alerts.push(
            ...peerAlerts(peerVerdict, health, {
              registered: report.operator.registered,
              active: report.operator.active,
            }),
          );
          peerVerdict = health.verdict;
        }
      }

      const releaseCheck = await maybeCheckRelease(prev, config.releaseCheckMinutes);
      alerts.push(...releaseCheck.alerts);

      await emit(alerts, { botToken: config.telegramBotToken, chatId: config.telegramChatId });
      await saveState(
        statePath,
        toSnapshot({
          report,
          lastScannedBlock: scannedThroughBlock,
          consecutiveRpcFailures: 0,
          releaseLatestTag: releaseCheck.releaseLatestTag,
          releaseLastAlertedVersion: releaseCheck.releaseLastAlertedVersion,
          releaseLastCheckedAt: releaseCheck.releaseLastCheckedAt,
          localLastCheckedAt,
          localLastProblem,
          peerVerdict,
        }),
      );
    } catch (err) {
      const previousFailures = prev?.consecutiveRpcFailures ?? 0;
      const currentFailures = previousFailures + 1;
      console.error('[watch] poll failed:', err instanceof Error ? err.message : err);

      const failAlert = rpcFailureAlert(previousFailures, currentFailures, RPC_FAILURE_THRESHOLD);
      if (failAlert) {
        await emit([failAlert], { botToken: config.telegramBotToken, chatId: config.telegramChatId });
      }

      await saveState(statePath, {
        registered: prev?.registered ?? false,
        active: prev?.active ?? false,
        bondRaw: prev?.bondRaw ?? '0',
        tickets: prev?.tickets ?? 0,
        requestsPaused: prev?.requestsPaused ?? false,
        e3Total: prev?.e3Total ?? 0,
        lastScannedBlock: prev?.lastScannedBlock ?? '0',
        consecutiveRpcFailures: currentFailures,
        releaseLatestTag: prev?.releaseLatestTag ?? null,
        releaseLastAlertedVersion: prev?.releaseLastAlertedVersion ?? null,
        releaseLastCheckedAt: prev?.releaseLastCheckedAt ?? null,
      });
    }

    if (options.once) break;
    await sleep(config.pollIntervalSeconds * 1000, () => running);
  }
}

function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (!stillRunning() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(500, ms));
    };
    tick();
  });
}
