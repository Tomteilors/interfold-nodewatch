import { resolveConfig, requireOperator } from '../config.js';
import { CONTRACT_ADDRESSES } from '../chain/addresses.js';
import { createClient } from '../chain/client.js';
import { fetchFullStatus } from '../core/status.js';
import { formatStatusTable, toJsonSafe } from '../core/format.js';
import { probePeers } from '../core/peerHealth.js';

export interface StatusCommandOptions {
  operator?: string;
  json?: boolean;
  rpcUrl?: string;
  chain?: string;
  /** Also read the local ciphernode journal and report peer-layer health. */
  local?: boolean;
}

export async function runStatus(options: StatusCommandOptions): Promise<void> {
  const config = resolveConfig({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    operator: options.operator,
  });
  const operator = requireOperator(config);
  const addresses = CONTRACT_ADDRESSES[config.chain];
  const client = createClient(config.rpcUrl, config.chain);

  const report = await fetchFullStatus(client, addresses, operator, config.chain);

  const peers = options.local ? await probePeers(config.nodeUnit, config.logWindowMinutes) : null;

  if (options.json) {
    console.log(JSON.stringify({ ...toJsonSafe(report), peers }, null, 2));
    return;
  }

  console.log(formatStatusTable(report));

  if (options.local) {
    console.log('');
    if (!peers) {
      console.log('Local');
      console.log(
        `  Peers                  could not read the journal for unit "${config.nodeUnit}" ` +
          '(set INTERFOLD_UNIT, or run where journalctl is available)',
      );
      return;
    }
    const label: Record<string, string> = {
      healthy: 'OK',
      degraded: 'DEGRADED',
      isolated: 'ISOLATED',
      unknown: 'UNKNOWN',
    };
    console.log('Local');
    console.log(`  Peer layer             ${label[peers.verdict] ?? peers.verdict}`);
    console.log(`  Detail                 ${peers.summary}`);
    console.log(`  Log window             last ${config.logWindowMinutes} min of unit "${config.nodeUnit}"`);
    if (peers.verdict === 'isolated' && report.operator.registered && report.operator.active) {
      console.log('');
      console.log('  The chain says this operator is registered and active. The node says it has');
      console.log('  no usable peers. Committees it is selected for will be missed silently.');
    }
  }
}
