import type { Address, Hash, PublicClient } from 'viem';
import { erc20Abi, formatUnits } from 'viem';
import { coordinatorAbi } from '../chain/abi/coordinator.js';
import {
  ETHERSCAN_BASE,
  REWARDS_FALLBACK_LOOKBACK,
  REWARDS_START_BLOCK,
  type ChainName,
} from '../chain/addresses.js';
import type { Alert } from './alerts.js';

/**
 * E3 rewards are pull-based. When an E3 completes, the coordinator emits
 * `RewardCredited(e3Id, account, token, amount)` for every committee member,
 * where `account` is the operator's BOND OWNER (not the operator key), and
 * keeps the funds until that bond owner calls `claimReward(e3Id)`. Nothing
 * arrives on its own and there is no deadline in the contract, so an
 * unclaimed reward simply sits there until someone notices.
 *
 * Discovery: eth_getLogs for RewardCredited filtered on the bond owner, then
 * `pendingReward(e3Id, owner)` to tell "still claimable" from "already claimed".
 */

/**
 * Blocks per eth_getLogs call. Free public endpoints cap ranges at around
 * 10k blocks (some count the bound exclusively), so stay just below.
 */
export const REWARD_LOG_SPAN = 9_000n;

/** Backoff between retries of one getLogs chunk (free RPCs rate-limit bursts). */
export const REWARD_LOG_RETRY_DELAYS_MS = [2_000, 6_000];

function shortError(err: unknown): string {
  if (err && typeof err === 'object' && 'shortMessage' in err && typeof err.shortMessage === 'string') {
    const status = 'status' in err && err.status ? ` (HTTP ${String(err.status)})` : '';
    return err.shortMessage + status;
  }
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

/** Cap on remembered alerted e3Ids in watch state, oldest dropped first. */
export const MAX_ALERTED_REWARDS = 500;

export interface RewardCredit {
  e3Id: bigint;
  token: Address;
  amount: bigint;
  blockNumber: bigint;
  txHash: Hash | null;
}

export interface PendingReward {
  e3Id: bigint;
  token: Address;
  symbol: string;
  decimals: number;
  /** Still-claimable amount from pendingReward(e3Id, owner), raw units. */
  pendingRaw: bigint;
  creditedBlock: bigint;
}

/** Where to start scanning: explicit override, else the chain's known start, else a lookback from head. */
export function resolveRewardsFromBlock(chain: ChainName, head: bigint, override?: bigint): bigint {
  if (override !== undefined) return override;
  const known = REWARDS_START_BLOCK[chain];
  if (known !== null) return known;
  return head > REWARDS_FALLBACK_LOOKBACK ? head - REWARDS_FALLBACK_LOOKBACK : 0n;
}

/** Splits [from, to] into inclusive chunks of at most `span` blocks. */
export function blockChunks(from: bigint, to: bigint, span = REWARD_LOG_SPAN): Array<[bigint, bigint]> {
  const chunks: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    chunks.push([start, end]);
  }
  return chunks;
}

/** RewardCredited logs for `owner` in [fromBlock, toBlock], scanned in chunks. */
export async function scanRewardCredits(
  client: PublicClient,
  coordinator: Address,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
  span = REWARD_LOG_SPAN,
  retryDelaysMs: readonly number[] = REWARD_LOG_RETRY_DELAYS_MS,
): Promise<RewardCredit[]> {
  const credits: RewardCredit[] = [];
  for (const [from, to] of blockChunks(fromBlock, toBlock, span)) {
    const fetchChunk = () =>
      client.getContractEvents({
        address: coordinator,
        abi: coordinatorAbi,
        eventName: 'RewardCredited',
        args: { account: owner },
        fromBlock: from,
        toBlock: to,
      });
    let logs: Awaited<ReturnType<typeof fetchChunk>> | undefined;
    for (let attempt = 0; logs === undefined; attempt++) {
      try {
        logs = await fetchChunk();
      } catch (err) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new Error(`eth_getLogs for blocks ${from}-${to} failed: ${shortError(err)}`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    for (const log of logs) {
      // Defensive: at least one free public RPC has been seen returning every
      // log of the contract for a range, ignoring the topic filter. Anything
      // that is not a RewardCredited to this exact owner is dropped here.
      if (log.eventName !== 'RewardCredited') continue;
      const { e3Id, account, token, amount } = log.args;
      if (e3Id === undefined || token === undefined) continue;
      if (account === undefined || account.toLowerCase() !== owner.toLowerCase()) continue;
      credits.push({
        e3Id,
        token,
        amount: amount ?? 0n,
        blockNumber: log.blockNumber ?? to,
        txHash: log.transactionHash ?? null,
      });
    }
  }
  return credits;
}

interface TokenMeta {
  symbol: string;
  decimals: number;
}

async function readTokenMeta(client: PublicClient, token: Address): Promise<TokenMeta> {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol, decimals };
  } catch {
    // A token without symbol()/decimals() still has a balance worth reporting.
    return { symbol: shortAddress(token), decimals: 18 };
  }
}

/**
 * Asks the coordinator which of `credits` the owner can still claim. Credits
 * are de-duplicated per e3Id (pendingReward is keyed on e3Id + account).
 * Already-claimed rewards (pending = 0) are dropped.
 */
export async function fetchPendingRewards(
  client: PublicClient,
  coordinator: Address,
  owner: Address,
  credits: RewardCredit[],
): Promise<PendingReward[]> {
  const byId = new Map<string, RewardCredit>();
  for (const c of credits) {
    if (!byId.has(c.e3Id.toString())) byId.set(c.e3Id.toString(), c);
  }

  const metaCache = new Map<string, Promise<TokenMeta>>();
  const meta = (token: Address): Promise<TokenMeta> => {
    const key = token.toLowerCase();
    let p = metaCache.get(key);
    if (!p) {
      p = readTokenMeta(client, token);
      metaCache.set(key, p);
    }
    return p;
  };

  const results = await Promise.all(
    [...byId.values()].map(async (credit): Promise<PendingReward | null> => {
      const pendingRaw = await client.readContract({
        address: coordinator,
        abi: coordinatorAbi,
        functionName: 'pendingReward',
        args: [credit.e3Id, owner],
      });
      if (pendingRaw === 0n) return null;
      const { symbol, decimals } = await meta(credit.token);
      return {
        e3Id: credit.e3Id,
        token: credit.token,
        symbol,
        decimals,
        pendingRaw,
        creditedBlock: credit.blockNumber,
      };
    }),
  );

  return results
    .filter((r): r is PendingReward => r !== null)
    .sort((a, b) => (a.creditedBlock < b.creditedBlock ? -1 : a.creditedBlock > b.creditedBlock ? 1 : 0));
}

/** Human amount with at most `places` decimals, trailing zeros trimmed. */
export function formatTokenAmount(raw: bigint, decimals: number, places = 3): string {
  const full = formatUnits(raw, decimals);
  const [int = '0', frac = ''] = full.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  const intGrouped = BigInt(int).toLocaleString('en-US');
  return cut ? `${intGrouped}.${cut}` : intGrouped;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Etherscan "Write as Proxy" tab of the coordinator, where claimReward lives. */
export function claimUrl(chain: ChainName, coordinator: Address): string {
  return `${ETHERSCAN_BASE[chain]}/address/${coordinator}#writeProxyContract`;
}

export const CLAIM_REMINDER = 'Claim from the BOND OWNER wallet, not the operator key.';

/** Pending amount summed per token symbol, in whole-token units (for metrics/summary). */
export function sumBySymbol(rewards: PendingReward[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rewards) {
    const value = Number(formatUnits(r.pendingRaw, r.decimals));
    out.set(r.symbol, (out.get(r.symbol) ?? 0) + value);
  }
  return out;
}

export function rewardAlertMessage(
  reward: PendingReward,
  owner: Address,
  chain: ChainName,
  coordinator: Address,
): string {
  return (
    `Unclaimed E3 reward: ${formatTokenAmount(reward.pendingRaw, reward.decimals)} ${reward.symbol} ` +
    `credited to bond owner ${shortAddress(owner)} for E3 ${reward.e3Id}. ` +
    `Rewards are pull-based and stay on the contract until claimed: call claimReward(e3Id) at ` +
    `${claimUrl(chain, coordinator)} . ${CLAIM_REMINDER}`
  );
}

/**
 * Pure de-dup step for watch: one alert per e3Id, ever. Returns the alerts to
 * send and the updated list of alerted e3Ids (bounded to MAX_ALERTED_REWARDS).
 */
export function newRewardAlerts(
  pending: PendingReward[],
  alreadyAlerted: readonly string[],
  owner: Address,
  chain: ChainName,
  coordinator: Address,
): { alerts: Alert[]; alerted: string[] } {
  const seen = new Set(alreadyAlerted);
  const alerted = [...alreadyAlerted];
  const alerts: Alert[] = [];
  for (const reward of pending) {
    const id = reward.e3Id.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    alerted.push(id);
    alerts.push({ severity: 'info', message: rewardAlertMessage(reward, owner, chain, coordinator) });
  }
  return { alerts, alerted: alerted.slice(-MAX_ALERTED_REWARDS) };
}
