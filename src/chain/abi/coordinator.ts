/**
 * Minimal Interfold coordinator ABI: only what nodewatch reads.
 *
 * Verified against the mainnet proxy (0x28cF...8715) via Sourcify
 * ("match": "match" for the implementation at 0x8AcB...a61bA, resolved from
 * packages/interfold-contracts/deployed_contracts.json in
 * github.com/theinterfold/interfold) and by live eth_call on 2026-09-17.
 *
 * Note: `nexte3Id()` exists in the verified ABI but returned a value that
 * does not look like a plausible E3 counter when called live (it decodes to
 * this contract's own address shifted into the high bits, not a small
 * integer) -- nodewatch does NOT rely on it. Instead it walks `getE3Stage`
 * from id 0 to find the highest requested E3 (see core/e3.ts), which is
 * cheap while the protocol has few E3 requests and was confirmed correct
 * against the live "0 E3s requested yet" state (requestsPaused=true,
 * activeE3Count=0, e3s(0) all-zero, getE3(0) reverts with E3DoesNotExist).
 */
export const coordinatorAbi = [
  {
    name: 'requestsPaused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'activeE3Count',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getE3Stage',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'e3Id', type: 'uint256' }],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'getFailureReason',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'e3Id', type: 'uint256' }],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'getRequester',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'e3Id', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'getE3',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'e3Id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'seed', type: 'uint256' },
          { name: 'committeeSize', type: 'uint8' },
          { name: 'requestBlock', type: 'uint256' },
          { name: 'encryptionSchemeId', type: 'bytes32' },
          { name: 'e3Program', type: 'address' },
          { name: 'paramSet', type: 'uint8' },
          { name: 'customParams', type: 'bytes' },
          { name: 'decryptionVerifier', type: 'address' },
          { name: 'pkVerifier', type: 'address' },
          { name: 'committeePublicKey', type: 'bytes32' },
          { name: 'ciphertextOutput', type: 'bytes32' },
          { name: 'plaintextOutput', type: 'bytes' },
          { name: 'requester', type: 'address' },
          { name: 'ciphertextCommitment', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    name: 'E3DoesNotExist',
    type: 'error',
    inputs: [{ name: 'e3Id', type: 'uint256' }],
  },
  {
    name: 'RequestsPausedSet',
    type: 'event',
    inputs: [{ name: 'paused', type: 'bool', indexed: false }],
  },
  {
    name: 'E3Requested',
    type: 'event',
    inputs: [
      { name: 'e3Id', type: 'uint256', indexed: false },
      {
        name: 'e3',
        type: 'tuple',
        indexed: false,
        components: [
          { name: 'seed', type: 'uint256' },
          { name: 'committeeSize', type: 'uint8' },
          { name: 'requestBlock', type: 'uint256' },
          { name: 'encryptionSchemeId', type: 'bytes32' },
          { name: 'e3Program', type: 'address' },
          { name: 'paramSet', type: 'uint8' },
          { name: 'customParams', type: 'bytes' },
          { name: 'decryptionVerifier', type: 'address' },
          { name: 'pkVerifier', type: 'address' },
          { name: 'committeePublicKey', type: 'bytes32' },
          { name: 'ciphertextOutput', type: 'bytes32' },
          { name: 'plaintextOutput', type: 'bytes' },
          { name: 'requester', type: 'address' },
          { name: 'ciphertextCommitment', type: 'bytes32' },
        ],
      },
      { name: 'cryptoConfigId', type: 'bytes32', indexed: true },
    ],
  },
  {
    name: 'E3StageChanged',
    type: 'event',
    inputs: [
      { name: 'e3Id', type: 'uint256', indexed: true },
      { name: 'previousStage', type: 'uint8', indexed: false },
      { name: 'newStage', type: 'uint8', indexed: false },
    ],
  },
  // E3 rewards are pull-based: when an E3 completes, the coordinator credits
  // each committee member's share to that operator's BOND OWNER and holds it
  // until the bond owner calls claimReward(e3Id). Signatures checked against
  // live mainnet logs/eth_call on 2026-10-09 (topic0 of RewardCredited is
  // 0xdf636f3c..., pendingReward selector is 0x98969e82).
  {
    name: 'pendingReward',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'e3Id', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'RewardCredited',
    type: 'event',
    inputs: [
      { name: 'e3Id', type: 'uint256', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Mirrors `@interfold/sdk`'s `E3Stage` enum (packages/interfold-sdk). Kept
 * as a local copy so this CLI does not have to import the SDK's heavy
 * dependency tree just for two small enums -- see README > "About
 * @interfold/sdk".
 */
export enum E3Stage {
  None = 0,
  Requested = 1,
  CommitteeFinalized = 2,
  KeyPublished = 3,
  CiphertextReady = 4,
  Complete = 5,
  Failed = 6,
}

/** Mirrors `@interfold/sdk`'s `FailureReason` enum. */
export enum FailureReason {
  None = 0,
  CommitteeFormationTimeout = 1,
  InsufficientCommitteeMembers = 2,
  DKGTimeout = 3,
  DKGInvalidShares = 4,
  NoInputsReceived = 5,
  ComputeTimeout = 6,
  ComputeProviderExpired = 7,
  ComputeProviderFailed = 8,
  RequesterCancelled = 9,
  DecryptionTimeout = 10,
  DecryptionInvalidShares = 11,
  VerificationFailed = 12,
}

export const E3_STAGE_NAMES: Record<E3Stage, string> = {
  [E3Stage.None]: 'None',
  [E3Stage.Requested]: 'Requested',
  [E3Stage.CommitteeFinalized]: 'CommitteeFinalized',
  [E3Stage.KeyPublished]: 'KeyPublished',
  [E3Stage.CiphertextReady]: 'CiphertextReady',
  [E3Stage.Complete]: 'Complete',
  [E3Stage.Failed]: 'Failed',
};

export const FAILURE_REASON_NAMES: Record<FailureReason, string> = {
  [FailureReason.None]: 'None',
  [FailureReason.CommitteeFormationTimeout]: 'CommitteeFormationTimeout',
  [FailureReason.InsufficientCommitteeMembers]: 'InsufficientCommitteeMembers',
  [FailureReason.DKGTimeout]: 'DKGTimeout',
  [FailureReason.DKGInvalidShares]: 'DKGInvalidShares',
  [FailureReason.NoInputsReceived]: 'NoInputsReceived',
  [FailureReason.ComputeTimeout]: 'ComputeTimeout',
  [FailureReason.ComputeProviderExpired]: 'ComputeProviderExpired',
  [FailureReason.ComputeProviderFailed]: 'ComputeProviderFailed',
  [FailureReason.RequesterCancelled]: 'RequesterCancelled',
  [FailureReason.DecryptionTimeout]: 'DecryptionTimeout',
  [FailureReason.DecryptionInvalidShares]: 'DecryptionInvalidShares',
  [FailureReason.VerificationFailed]: 'VerificationFailed',
} as const;
