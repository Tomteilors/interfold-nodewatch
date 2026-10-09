#!/usr/bin/env node
import { Command } from 'commander';
import { runStatus } from './commands/status.js';
import { runWatch } from './commands/watch.js';
import { runExporter } from './commands/exporter.js';
import { runE3 } from './commands/e3.js';
import { runVersion } from './commands/version.js';
import { runRewards } from './commands/rewards.js';

const program = new Command();

program
  .name('nodewatch')
  .description('Status, watch, Prometheus exporter and E3 inspector for Interfold ciphernode operators')
  .version('0.3.0');

program
  .command('status')
  .description('Print operator, network and protocol status')
  .option('--operator <address>', 'operator address (defaults to OPERATOR_ADDRESS env)')
  .option('--json', 'print machine-readable JSON instead of a table')
  .option('--rpc-url <url>', 'JSON-RPC HTTP URL (defaults to RPC_URL env)')
  .option('--chain <name>', 'mainnet | sepolia (defaults to CHAIN env)')
  .option('--local', 'also read the ciphernode journal and report peer-layer health')
  .action(async (opts) => {
    await runStatus(opts);
  });

program
  .command('watch')
  .description('Poll the chain and alert on changes (stdout + optional Telegram)')
  .option('--operator <address>', 'operator address (defaults to OPERATOR_ADDRESS env)')
  .option('--interval <seconds>', 'poll interval in seconds (defaults to POLL_INTERVAL env, then 60)')
  .option('--rpc-url <url>', 'JSON-RPC HTTP URL (defaults to RPC_URL env)')
  .option('--bond-owner <address>', 'bond owner to check E3 rewards for (defaults to BOND_OWNER_ADDRESS env, then bondOwnerOf(operator))')
  .option('--logs-rpc-url <url>', 'RPC for the reward eth_getLogs scan (defaults to LOGS_RPC_URL env, then RPC_URL)')
  .option('--no-rewards', 'do not check for unclaimed E3 rewards')
  .option('--chain <name>', 'mainnet | sepolia (defaults to CHAIN env)')
  .option('--state <path>', 'state file path (default ./state.json)')
  .option(
    '--local',
    'also read the ciphernode journal: peer-layer health every tick, plus `interfold ciphernode status` cross-checked against the chain',
  )
  .option(
    '--local-check-interval <minutes>',
    'how often --local runs the status command (it makes several RPC calls; default 10)',
  )
  .option('--once', 'poll a single time and exit (mainly for testing)')
  .option(
    '--release-check-interval <minutes>',
    'how often to check for a new interfold release (defaults to RELEASE_CHECK_MINUTES env, then 60)',
  )
  .action(async (opts) => {
    await runWatch(opts);
  });

program
  .command('exporter')
  .description('Serve Prometheus metrics on /metrics (and /healthz)')
  .option('--operator <address>', 'operator address (defaults to OPERATOR_ADDRESS env)')
  .option('--port <port>', 'HTTP port (defaults to EXPORTER_PORT env, then 9464)')
  .option('--rpc-url <url>', 'JSON-RPC HTTP URL (defaults to RPC_URL env)')
  .option('--bond-owner <address>', 'bond owner to check E3 rewards for (defaults to BOND_OWNER_ADDRESS env, then bondOwnerOf(operator))')
  .option('--logs-rpc-url <url>', 'RPC for the reward eth_getLogs scan (defaults to LOGS_RPC_URL env, then RPC_URL)')
  .option('--no-rewards', 'do not check for unclaimed E3 rewards')
  .option('--chain <name>', 'mainnet | sepolia (defaults to CHAIN env)')
  .option(
    '--release-check-interval <minutes>',
    'how often to check for a new interfold release (defaults to RELEASE_CHECK_MINUTES env, then 60)',
  )
  .option('--local', 'also export peer-layer metrics read from the ciphernode journal')
  .action(async (opts) => {
    await runExporter(opts);
  });

program
  .command('e3 <id>')
  .description('Show details for one E3 request: stage, failure reason, committee, key/output status')
  .option('--rpc-url <url>', 'JSON-RPC HTTP URL (defaults to RPC_URL env)')
  .option('--chain <name>', 'mainnet | sepolia (defaults to CHAIN env)')
  .action(async (id, opts) => {
    await runE3(id, opts);
  });

program
  .command('rewards')
  .description('List unclaimed E3 rewards for a bond owner (rewards are pull-based: claimReward from the bond owner wallet)')
  .option('--bond-owner <address>', 'bond owner address (defaults to BOND_OWNER_ADDRESS env)')
  .option('--operator <address>', 'or: operator address, its bond owner is looked up on-chain (defaults to OPERATOR_ADDRESS env)')
  .option('--from-block <n>', 'first block to scan for RewardCredited (default: first block rewards exist on the chain)')
  .option('--json', 'print machine-readable JSON instead of text')
  .option('--rpc-url <url>', 'JSON-RPC HTTP URL (defaults to RPC_URL env)')
  .option('--logs-rpc-url <url>', 'RPC for the eth_getLogs scan (defaults to LOGS_RPC_URL env, then RPC_URL; see README)')
  .option('--chain <name>', 'mainnet | sepolia (defaults to CHAIN env)')
  .action(async (opts) => {
    await runRewards(opts);
  });

program
  .command('version')
  .description('Compare the latest interfold release on GitHub against the local `interfold` binary, if any')
  .action(async () => {
    await runVersion();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
