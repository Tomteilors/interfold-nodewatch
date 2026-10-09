import { describe, it, expect, afterEach } from 'vitest';
import type { Address, PublicClient } from 'viem';
import {
  blockChunks,
  claimUrl,
  fetchPendingRewards,
  formatTokenAmount,
  MAX_ALERTED_REWARDS,
  newRewardAlerts,
  resolveRewardsFromBlock,
  scanRewardCredits,
  sumBySymbol,
  type PendingReward,
  type RewardCredit,
} from '../src/core/rewards.js';
import { DEFAULT_LOGS_RPC_URL, DEFAULT_RPC_URL, resolveConfig } from '../src/config.js';

// Made-up addresses, not real accounts.
const OWNER: Address = '0x1111111111111111111111111111111111111111';
const COORDINATOR: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x3333333333333333333333333333333333333333';
const ODD_TOKEN: Address = '0x4444444444444444444444444444444444444444';

function reward(e3Id: bigint, pendingRaw: bigint, symbol = 'USDS', creditedBlock = 100n): PendingReward {
  return { e3Id, token: TOKEN, symbol, decimals: 18, pendingRaw, creditedBlock };
}

describe('blockChunks', () => {
  it('splits an inclusive range into spans of at most `span` blocks', () => {
    expect(blockChunks(0n, 24n, 10n)).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 24n],
    ]);
  });

  it('handles a single block and an empty range', () => {
    expect(blockChunks(5n, 5n, 10n)).toEqual([[5n, 5n]]);
    expect(blockChunks(6n, 5n, 10n)).toEqual([]);
  });
});

describe('resolveRewardsFromBlock', () => {
  it('prefers an explicit override', () => {
    expect(resolveRewardsFromBlock('mainnet', 30_000_000n, 123n)).toBe(123n);
  });

  it('uses the known mainnet start block', () => {
    expect(resolveRewardsFromBlock('mainnet', 30_000_000n)).toBe(26_000_000n);
  });

  it('falls back to a lookback window where no start is known', () => {
    expect(resolveRewardsFromBlock('sepolia', 1_000_000n)).toBe(800_000n);
    expect(resolveRewardsFromBlock('sepolia', 50n)).toBe(0n);
  });
});

describe('formatTokenAmount', () => {
  it('trims to three decimals and drops trailing zeros', () => {
    expect(formatTokenAmount(18_048_170_000_000_000_000n, 18)).toBe('18.048');
    expect(formatTokenAmount(5n * 10n ** 18n, 18)).toBe('5');
    expect(formatTokenAmount(1_234_500n * 10n ** 15n, 18)).toBe('1,234.5');
  });

  it('keeps tiny amounts visible when asked for full precision', () => {
    expect(formatTokenAmount(1n, 18)).toBe('0');
    expect(formatTokenAmount(1n, 18, 18)).toBe('0.000000000000000001');
  });

  it('respects non-18 decimals', () => {
    expect(formatTokenAmount(2_500_000n, 6)).toBe('2.5');
  });
});

describe('newRewardAlerts', () => {
  it('alerts once per e3Id and remembers it', () => {
    const first = newRewardAlerts([reward(7n, 10n ** 18n)], [], OWNER, 'mainnet', COORDINATOR);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerted).toEqual(['7']);

    const again = newRewardAlerts([reward(7n, 10n ** 18n)], first.alerted, OWNER, 'mainnet', COORDINATOR);
    expect(again.alerts).toHaveLength(0);
    expect(again.alerted).toEqual(['7']);
  });

  it('does not double-alert an e3Id listed twice in one batch', () => {
    const { alerts } = newRewardAlerts([reward(9n, 1n), reward(9n, 1n)], [], OWNER, 'mainnet', COORDINATOR);
    expect(alerts).toHaveLength(1);
  });

  it('says how to claim and from which wallet', () => {
    const { alerts } = newRewardAlerts([reward(42n, 18_048n * 10n ** 15n)], [], OWNER, 'mainnet', COORDINATOR);
    const msg = alerts[0]!.message;
    expect(msg).toContain('18.048 USDS');
    expect(msg).toContain('E3 42');
    expect(msg).toContain('claimReward');
    expect(msg).toContain(`https://etherscan.io/address/${COORDINATOR}#writeProxyContract`);
    expect(msg).toContain('BOND OWNER wallet, not the operator key');
    expect(msg).toContain('0x1111…1111');
  });

  it('bounds the remembered list', () => {
    const old = Array.from({ length: MAX_ALERTED_REWARDS }, (_, i) => String(i));
    const { alerted } = newRewardAlerts([reward(999_999n, 1n)], old, OWNER, 'mainnet', COORDINATOR);
    expect(alerted).toHaveLength(MAX_ALERTED_REWARDS);
    expect(alerted.at(-1)).toBe('999999');
    expect(alerted[0]).toBe('1');
  });
});

describe('claimUrl / sumBySymbol', () => {
  it('points at the sepolia explorer on sepolia', () => {
    expect(claimUrl('sepolia', COORDINATOR)).toBe(
      `https://sepolia.etherscan.io/address/${COORDINATOR}#writeProxyContract`,
    );
  });

  it('sums per token symbol in whole units', () => {
    const sums = sumBySymbol([reward(1n, 10n ** 18n), reward(2n, 5n * 10n ** 17n), reward(3n, 2n * 10n ** 18n, 'DAI')]);
    expect(sums.get('USDS')).toBeCloseTo(1.5);
    expect(sums.get('DAI')).toBe(2);
  });
});

/** Just enough of a viem PublicClient for the reward helpers. */
function fakeClient(opts: {
  logs?: (from: bigint, to: bigint) => Array<{ eventName?: string; args: Record<string, unknown>; blockNumber: bigint }>;
  pending?: Record<string, bigint>;
  calls?: Array<[bigint, bigint]>;
}): PublicClient {
  return {
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      opts.calls?.push([fromBlock, toBlock]);
      return (opts.logs?.(fromBlock, toBlock) ?? []).map((l) => ({ eventName: 'RewardCredited', ...l, transactionHash: '0xabc' }));
    },
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
      if (functionName === 'pendingReward') return opts.pending?.[String(args?.[0])] ?? 0n;
      if (address === ODD_TOKEN) throw new Error('execution reverted');
      if (functionName === 'symbol') return 'USDS';
      if (functionName === 'decimals') return 18;
      throw new Error(`unexpected call ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe('scanRewardCredits', () => {
  it('walks the range in chunks and maps the event args', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const client = fakeClient({
      calls,
      logs: (from) =>
        from === 10n ? [{ args: { e3Id: 5n, account: OWNER, token: TOKEN, amount: 77n }, blockNumber: 12n }] : [],
    });
    const credits = await scanRewardCredits(client, COORDINATOR, OWNER, 0n, 25n, 10n);
    expect(calls).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(credits).toEqual([{ e3Id: 5n, token: TOKEN, amount: 77n, blockNumber: 12n, txHash: '0xabc' }]);
  });

  it('retries a rate-limited chunk, then gives a short error', async () => {
    let calls = 0;
    const flaky = {
      getContractEvents: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('long html body'), { shortMessage: 'HTTP request failed.', status: 429 });
        return [];
      },
    } as unknown as PublicClient;
    await expect(scanRewardCredits(flaky, COORDINATOR, OWNER, 0n, 5n, 10n, [0])).resolves.toEqual([]);
    expect(calls).toBe(2);

    const down = {
      getContractEvents: async () => {
        throw Object.assign(new Error('long html body'), { shortMessage: 'HTTP request failed.', status: 429 });
      },
    } as unknown as PublicClient;
    await expect(scanRewardCredits(down, COORDINATOR, OWNER, 0n, 5n, 10n, [0])).rejects.toThrow(
      'eth_getLogs for blocks 0-5 failed: HTTP request failed. (HTTP 429)',
    );
  });

  it('drops logs an RPC returned despite the topic filter', async () => {
    const client = fakeClient({
      logs: () => [
        { eventName: 'E3StageChanged', args: { e3Id: 1n, previousStage: 1, newStage: 2 }, blockNumber: 3n },
        { args: { e3Id: 2n, account: '0x5555555555555555555555555555555555555555', token: TOKEN, amount: 1n }, blockNumber: 3n },
        { args: { e3Id: 3n, account: OWNER.toUpperCase().replace('0X', '0x'), token: TOKEN, amount: 9n }, blockNumber: 4n },
      ],
    });
    const credits = await scanRewardCredits(client, COORDINATOR, OWNER, 0n, 5n, 10n);
    expect(credits.map((c) => c.e3Id)).toEqual([3n]);
  });
});

describe('fetchPendingRewards', () => {
  const credit = (e3Id: bigint, token: Address = TOKEN, blockNumber = 1n): RewardCredit => ({
    e3Id,
    token,
    amount: 1n,
    blockNumber,
    txHash: null,
  });

  it('drops claimed rewards and keeps claimable ones in credit order', async () => {
    const client = fakeClient({ pending: { '1': 0n, '2': 3n * 10n ** 18n, '3': 1n } });
    const out = await fetchPendingRewards(client, COORDINATOR, OWNER, [credit(3n, TOKEN, 9n), credit(1n), credit(2n, TOKEN, 5n)]);
    expect(out.map((r) => r.e3Id)).toEqual([2n, 3n]);
    expect(out[0]).toMatchObject({ symbol: 'USDS', decimals: 18, pendingRaw: 3n * 10n ** 18n });
  });

  it('survives a token without symbol()/decimals()', async () => {
    const client = fakeClient({ pending: { '8': 5n } });
    const [r] = await fetchPendingRewards(client, COORDINATOR, OWNER, [credit(8n, ODD_TOKEN)]);
    expect(r).toMatchObject({ symbol: '0x4444…4444', decimals: 18, pendingRaw: 5n });
  });
});

describe('resolveConfig: reward settings', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses a log-capable public RPC for the scan when RPC_URL is the default', () => {
    delete process.env.RPC_URL;
    delete process.env.LOGS_RPC_URL;
    const c = resolveConfig({});
    expect(c.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(c.logsRpcUrl).toBe(DEFAULT_LOGS_RPC_URL);
  });

  it('reuses a custom RPC_URL for logs unless LOGS_RPC_URL is set', () => {
    process.env.RPC_URL = 'https://rpc.example.org';
    delete process.env.LOGS_RPC_URL;
    expect(resolveConfig({}).logsRpcUrl).toBe('https://rpc.example.org');
    process.env.LOGS_RPC_URL = '';
    expect(resolveConfig({}).logsRpcUrl).toBe('https://rpc.example.org');
    process.env.LOGS_RPC_URL = 'https://logs.example.org';
    expect(resolveConfig({}).logsRpcUrl).toBe('https://logs.example.org');
  });

  it('validates the bond owner address', () => {
    expect(resolveConfig({ bondOwner: OWNER }).bondOwnerAddress).toBe(OWNER);
    expect(() => resolveConfig({ bondOwner: '0xnope' })).toThrow(/BOND_OWNER_ADDRESS/);
  });
});
