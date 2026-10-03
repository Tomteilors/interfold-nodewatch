import type { Address } from 'viem';
import { isAddress } from 'viem';
import type { ChainName } from './chain/addresses.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_RPC_URL = 'https://ethereum-rpc.publicnode.com';
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_EXPORTER_PORT = 9464;
export const DEFAULT_RELEASE_CHECK_MINUTES = 60;
export const DEFAULT_NODE_UNIT = 'interfold';
export const DEFAULT_NODE_BIN = 'interfold';
export const DEFAULT_LOG_WINDOW_MINUTES = 15;

export interface ResolvedConfig {
  rpcUrl: string;
  chain: ChainName;
  operatorAddress: Address | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  pollIntervalSeconds: number;
  exporterPort: number;
  releaseCheckMinutes: number;
  /** systemd unit the ciphernode runs under, read by the peer-health probe. */
  nodeUnit: string;
  /**
   * Path to the `interfold` binary. Needed because a cron or systemd shell has
   * a minimal PATH and will not find it where an interactive login does.
   */
  nodeBin: string;
  /** How far back the peer-health probe reads the node log, in minutes. */
  logWindowMinutes: number;
}

export interface ConfigOverrides {
  rpcUrl?: string;
  chain?: string;
  operator?: string;
  pollIntervalSeconds?: number;
  exporterPort?: number;
  releaseCheckMinutes?: number;
  nodeUnit?: string;
  nodeBin?: string;
  logWindowMinutes?: number;
}

function parseChain(value: string | undefined): ChainName {
  if (value === 'sepolia') return 'sepolia';
  return 'mainnet';
}

/**
 * Minimal .env loader (KEY=value lines, # comments, optional quotes). Values
 * already present in the real environment are never overridden, so a shell
 * export or a systemd Environment= line always wins over the file. No
 * dependency on dotenv on purpose -- this is all the tool needs.
 */
export function loadDotEnv(path = resolve(process.cwd(), '.env'), env: NodeJS.ProcessEnv = process.env): number {
  if (!existsSync(path)) return 0;
  let loaded = 0;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}

/** CLI flags always win over environment variables, which win over .env. */
export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  loadDotEnv();
  const rpcUrl = overrides.rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const chain = parseChain(overrides.chain ?? process.env.CHAIN);

  const rawOperator = overrides.operator ?? process.env.OPERATOR_ADDRESS;
  let operatorAddress: Address | undefined;
  if (rawOperator) {
    if (!isAddress(rawOperator)) {
      throw new Error(`Not a valid address: "${rawOperator}" (--operator or OPERATOR_ADDRESS)`);
    }
    operatorAddress = rawOperator;
  }

  const pollIntervalSeconds =
    overrides.pollIntervalSeconds ??
    (process.env.POLL_INTERVAL ? Number(process.env.POLL_INTERVAL) : undefined) ??
    DEFAULT_POLL_INTERVAL_SECONDS;

  const exporterPort =
    overrides.exporterPort ??
    (process.env.EXPORTER_PORT ? Number(process.env.EXPORTER_PORT) : undefined) ??
    DEFAULT_EXPORTER_PORT;

  const releaseCheckMinutes =
    overrides.releaseCheckMinutes ??
    (process.env.RELEASE_CHECK_MINUTES ? Number(process.env.RELEASE_CHECK_MINUTES) : undefined) ??
    DEFAULT_RELEASE_CHECK_MINUTES;

  const nodeUnit = overrides.nodeUnit ?? process.env.INTERFOLD_UNIT ?? DEFAULT_NODE_UNIT;
  const nodeBin = overrides.nodeBin ?? process.env.INTERFOLD_BIN ?? DEFAULT_NODE_BIN;
  const logWindowMinutes =
    overrides.logWindowMinutes ??
    (process.env.LOG_WINDOW_MINUTES ? Number(process.env.LOG_WINDOW_MINUTES) : undefined) ??
    DEFAULT_LOG_WINDOW_MINUTES;

  return {
    rpcUrl,
    chain,
    operatorAddress,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    pollIntervalSeconds,
    exporterPort,
    releaseCheckMinutes,
    nodeUnit,
    nodeBin,
    logWindowMinutes,
  };
}

export function requireOperator(config: ResolvedConfig): Address {
  if (!config.operatorAddress) {
    throw new Error(
      'No operator address given. Pass --operator 0x... or set OPERATOR_ADDRESS in the environment.',
    );
  }
  return config.operatorAddress;
}
