import type { Address, PublicClient } from 'viem';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import { CONTRACT_ADDRESSES, type ContractAddresses } from '../chain/addresses.js';
import { createClient } from '../chain/client.js';
import { bondingRegistryAbi } from '../chain/abi/bondingRegistry.js';
import {
  CLAIM_REMINDER,
  claimUrl,
  fetchPendingRewards,
  formatTokenAmount,
  resolveRewardsFromBlock,
  scanRewardCredits,
  sumBySymbol,
} from '../core/rewards.js';

export interface RewardsCommandOptions {
  bondOwner?: string;
  operator?: string;
  fromBlock?: string;
  json?: boolean;
  rpcUrl?: string;
  logsRpcUrl?: string;
  chain?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Rewards are credited to the bond owner, so that is the address that
 * matters. Explicit --bond-owner / BOND_OWNER_ADDRESS wins; otherwise it is
 * read from bondOwnerOf(operator) so an operator-only config just works.
 */
export async function resolveBondOwner(
  client: PublicClient,
  addresses: ContractAddresses,
  config: ResolvedConfig,
): Promise<Address> {
  if (config.bondOwnerAddress) return config.bondOwnerAddress;
  if (!config.operatorAddress) {
    throw new Error(
      'No address given. Pass --bond-owner 0x... (or BOND_OWNER_ADDRESS), or --operator 0x... (or OPERATOR_ADDRESS) to look the bond owner up.',
    );
  }
  const owner = await client.readContract({
    address: addresses.bondingRegistry,
    abi: bondingRegistryAbi,
    functionName: 'bondOwnerOf',
    args: [config.operatorAddress],
  });
  if (owner === ZERO_ADDRESS) {
    throw new Error(
      `Operator ${config.operatorAddress} has no bond owner on-chain (not registered?). Pass --bond-owner explicitly.`,
    );
  }
  return owner;
}

export async function runRewards(options: RewardsCommandOptions): Promise<void> {
  const config = resolveConfig({
    rpcUrl: options.rpcUrl,
    logsRpcUrl: options.logsRpcUrl,
    chain: options.chain,
    operator: options.operator,
    bondOwner: options.bondOwner,
  });
  const addresses = CONTRACT_ADDRESSES[config.chain];
  const client = createClient(config.rpcUrl, config.chain);
  const logsClient = config.logsRpcUrl === config.rpcUrl ? client : createClient(config.logsRpcUrl, config.chain);

  const owner = await resolveBondOwner(client, addresses, config);
  const head = await logsClient.getBlockNumber();
  const fromBlock = resolveRewardsFromBlock(
    config.chain,
    head,
    options.fromBlock !== undefined ? BigInt(options.fromBlock) : undefined,
  );

  const credits = await scanRewardCredits(logsClient, addresses.coordinator, owner, fromBlock, head);
  const pending = await fetchPendingRewards(client, addresses.coordinator, owner, credits);
  const url = claimUrl(config.chain, addresses.coordinator);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          bondOwner: owner,
          chain: config.chain,
          scannedBlocks: { from: fromBlock.toString(), to: head.toString() },
          creditsFound: new Set(credits.map((c) => c.e3Id.toString())).size,
          claimUrl: url,
          pending: pending.map((r) => ({
            e3Id: r.e3Id.toString(),
            token: r.token,
            symbol: r.symbol,
            decimals: r.decimals,
            amountRaw: r.pendingRaw.toString(),
            amount: formatTokenAmount(r.pendingRaw, r.decimals, r.decimals),
            creditedBlock: r.creditedBlock.toString(),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const distinctCredits = new Set(credits.map((c) => c.e3Id.toString())).size;
  console.log(`Bond owner:   ${owner}`);
  console.log(`Scanned:      blocks ${fromBlock}-${head} on ${config.chain}`);
  console.log(`Credited:     ${distinctCredits} E3 reward(s) ever, ${pending.length} still unclaimed`);

  if (pending.length === 0) {
    console.log('\nNothing to claim.');
    return;
  }

  console.log('');
  for (const r of pending) {
    console.log(`  E3 ${r.e3Id}`);
    console.log(`    ${formatTokenAmount(r.pendingRaw, r.decimals)} ${r.symbol}  (token ${r.token}, credited in block ${r.creditedBlock})`);
  }
  const totals = [...sumBySymbol(pending).entries()].map(([sym, v]) => `${v.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${sym}`);
  console.log(`\nTotal unclaimed: ${totals.join(', ')}`);
  console.log(`\nRewards are pull-based: nothing arrives on its own. To claim, open`);
  console.log(`  ${url}`);
  console.log('connect the wallet, call claimReward(e3Id) once per E3 id above.');
  console.log(CLAIM_REMINDER);
}
