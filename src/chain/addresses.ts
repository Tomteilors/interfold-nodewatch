import type { Address } from 'viem';

export type ChainName = 'mainnet' | 'sepolia';

export interface ContractAddresses {
  /** Interfold coordinator (E3 lifecycle, requests, pricing). */
  coordinator: Address;
  /** BondingRegistry proxy (operator registration, bonds, tickets). */
  bondingRegistry: Address;
  /** FOLD token (ciphernode bond asset). */
  fold: Address;
  /** tFOLD ticket token (underlying = sUSDS). */
  tFold: Address;
  /** sUSDS, the asset underlying tFOLD. */
  sUsds: Address;
}

/**
 * Deployed contract addresses, keyed by chain. Mainnet addresses were
 * cross-checked against packages/interfold-contracts/deployed_contracts.json
 * in github.com/theinterfold/interfold and verified live via eth_call on
 * 2026-09-17. Every getter this tool relies on has a Sourcify "match": "match"
 * verification for the address' current implementation.
 */
export const CONTRACT_ADDRESSES: Record<ChainName, ContractAddresses> = {
  mainnet: {
    coordinator: '0x28cF63B459e6218C69EA97ea7D90541cf648c715',
    bondingRegistry: '0x0ec90465095C21830BEcED07e032809A2Bd2915F',
    fold: '0xe172e9b6cfbeeb5593bdce3f077356fdb33af904',
    tFold: '0xc0b5b49a3949ec4b520ef21bacfe16e3695f3b5d',
    sUsds: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
  },
  // Sourced from packages/interfold-contracts/deployed_contracts.json in
  // github.com/theinterfold/interfold (not independently verified live --
  // this tool defaults to mainnet; pass --chain sepolia / env overrides to
  // confirm these still resolve before relying on them).
  // Sepolia is a testnet: ciphernodeBondToken is unset (address(0), 0
  // decimals) in the BondingRegistry constructor args, so bond-related
  // fields will read as zero there. `fold` has no sepolia equivalent, so it
  // is set to the mock stable used as the fee/bonding asset instead.
  sepolia: {
    coordinator: '0x3E856E24c7a95d0e04d387f847DA6FA9f6F6c20C',
    bondingRegistry: '0x90250Dc48CBe109fFaA02AeAFbFBdbF12D7BD4d4',
    fold: '0xC35B783cA97710be47Fc81D10dADc895EfcD865c', // MockUSDC, stands in for FOLD on testnet
    tFold: '0xfFFFc3BB04aEe950c0ed5DEe3214408f09fff488',
    sUsds: '0xC35B783cA97710be47Fc81D10dADc895EfcD865c',
  },
};

/**
 * First block worth scanning for `RewardCredited` when nothing better is
 * known. On mainnet the earliest credit is in block 26,105,291 (checked
 * 2026-10-09), so starting at 26,000,000 cannot miss one. Sepolia has no
 * known start; there the scan covers the last REWARDS_FALLBACK_LOOKBACK blocks
 * unless `--from-block` says otherwise.
 */
export const REWARDS_START_BLOCK: Record<ChainName, bigint | null> = {
  mainnet: 26_000_000n,
  sepolia: null,
};

export const REWARDS_FALLBACK_LOOKBACK = 200_000n;

export const ETHERSCAN_BASE: Record<ChainName, string> = {
  mainnet: 'https://etherscan.io',
  sepolia: 'https://sepolia.etherscan.io',
};
