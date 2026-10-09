# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [0.3.0] - 2026-10-09

### Added

- `nodewatch rewards`: lists unclaimed E3 rewards for a bond owner (`--bond-owner`, or `--operator` and
  the owner is read from `bondOwnerOf`): e3Id, amount, token, Etherscan claim link, and a reminder that
  the claim must come from the bond owner wallet, not the operator key. `--json` for scripts.
- `watch` alerts once per E3 when an unclaimed reward is credited to the bond owner, through the same
  stdout/Telegram channel as every other alert. Rewards already unclaimed when `watch` starts are announced
  on the first tick. `--no-rewards` turns it off.
- `exporter` metrics `interfold_rewards_pending{token}` and `interfold_rewards_pending_count`.
- Config: `BOND_OWNER_ADDRESS` / `--bond-owner`, `LOGS_RPC_URL` / `--logs-rpc-url` (the default
  publicnode RPC refuses `eth_getLogs` on older ranges, so the reward scan falls back to a public RPC
  that serves them).
- README section on how E3 rewards work (pull-based, credited to the bond owner) and how to claim them.

### Changed

- A failed `watch` poll no longer drops the `--local` state from `state.json` (it is carried over like
  the rest).

## [0.2.0] and earlier

See the git history.
