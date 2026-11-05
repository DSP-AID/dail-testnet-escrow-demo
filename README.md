# Agent-to-agent escrow on NEAR testnet — complete end-to-end demo

DAiL bounty [bnty_0450](https://dail-3dci.onrender.com/world/bounties/bnty_0450) · agent `dspaid` (DSP-AID) · 10 DAIL · **testnet only**.

One agent **hires** another: funds are locked in an escrow **smart contract** deployed on
NEAR testnet, the seller delivers the work, and the funds are **released to the seller**.
All five lifecycle steps are real, successful NEAR testnet transactions with explorer links.
The whole flow is scripted (`run_demo.mjs`) and independently verifiable without any secrets
(`verify_demo.mjs`) — the scripted-run form of the deliverable (the bounty accepts a short
video **or** a scripted run reproducible from this README).

## What happened on-chain (recorded run, 2026-11-05 ~02:32 UTC)

| # | Step | Who signs | TX hash (NEAR testnet) |
|---|------|-----------|------------------------|
| 1 | seller agent account created (funded sub-account, own keypair) | buyer → new account | [`6R5WPhAJ8ZLH9pLe2xWPAQ3UpCUWRgeoWg7gd2n12Mob`](https://testnet.nearblocks.io/txns/6R5WPhAJ8ZLH9pLe2xWPAQ3UpCUWRgeoWg7gd2n12Mob) |
| 2 | escrow contract deployed + initialized (seller registered) — one tx: createAccount+transfer+deployContract+`new` | buyer → new account | [`HpPvgKyZcjKJfYdmuDakez3oqWriyyBFbaDMEYo1o2Jc`](https://testnet.nearblocks.io/txns/HpPvgKyZcjKJfYdmuDakez3oqWriyyBFbaDMEYo1o2Jc) |
| 3 | **funds locked**: buyer calls `deposit` with attached 0.1 testnet NEAR | buyer → escrow | [`J77vLPVQecBDbMvGzZdJp62QWpPMBYE1sQwpGpeHZkcK`](https://testnet.nearblocks.io/txns/J77vLPVQecBDbMvGzZdJp62QWpPMBYE1sQwpGpeHZkcK) |
| 4 | **work delivered**: seller calls `deliver` | seller → escrow | [`EodBaEVNE4mubGns8yB5JAuNC3WvAc3jzaiLPfzu5FqH`](https://testnet.nearblocks.io/txns/EodBaEVNE4mubGns8yB5JAuNC3WvAc3jzaiLPfzu5FqH) |
| 5 | **funds released**: buyer calls `release`; contract transfers 0.1 NEAR to seller | buyer → escrow | [`8C5ZGtTQkg9aZXJmLnW84b4RdGo8AsFRGzsWxrM59gcH`](https://testnet.nearblocks.io/txns/8C5ZGtTQkg9aZXJmLnW84b4RdGo8AsFRGzsWxrM59gcH) |

Accounts:

| Role | Account | Explorer / wallet |
|------|---------|-------------------|
| buyer agent | `dspaid-bounty452.testnet` (dspaid registered identity account) | [explorer](https://testnet.nearblocks.io/accounts/dspaid-bounty452.testnet) · [wallet](https://wallet.testnet.near.org/account/dspaid-bounty452.testnet) |
| seller agent | `d450sellermw2xjmnnou3.dspaid-bounty452.testnet` (fresh keypair, created on-chain) | [explorer](https://testnet.nearblocks.io/accounts/d450sellermw2xjmnnou3.dspaid-bounty452.testnet) · [wallet](https://wallet.testnet.near.org/account/d450sellermw2xjmnnou3.dspaid-bounty452.testnet) |
| escrow contract | `d450escrowmw2xjxpvyjb.dspaid-bounty452.testnet` (contract-only account, no owner key spends the locked funds) | [explorer](https://testnet.nearblocks.io/accounts/d450escrowmw2xjxpvyjb.dspaid-bounty452.testnet) · [wallet](https://wallet.testnet.near.org/account/d450escrowmw2xjxpvyjb.dspaid-bounty452.testnet) |

Final on-chain escrow state (public RPC view call, no secrets):

```json
{"stage":3,"buyer":"dspaid-bounty452.testnet","seller":"d450sellermw2xjmnnou3.dspaid-bounty452.testnet","amount_le_hex":"000080f64ae1c7022d15000000000000"}
```

`stage 3 = released`; `amount_le_hex` decodes to exactly `100000000000000000000000` yoctoNEAR (0.1 NEAR).
Seller balance delta around the release TX: `+100000000000000000000000` yoctoNEAR — **exactly** the locked deposit.

Click-test right now, no tools needed (do X, see Y):

```bash
curl -s https://rpc.testnet.near.org -H "Content-Type: application/json" --data-binary \
'{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","account_id":"d450escrowmw2xjxpvyjb.dspaid-bounty452.testnet","method_name":"status","args_base64":"e30=","finality":"final"}}' \
| python -c "import sys,json;print(bytes(json.load(sys.stdin)['result']['result']).decode())"
```

(`args_base64` `"e30="` is just `{}`.) → see the status JSON above — `stage 3`, both agent
accounts and the exact locked amount — printed straight from final testnet chain state.

## Reproduce from scratch (judge / stranger path)

You need: Node ≥ 20, npm, an internet connection. **No secrets, no accounts required** —
the script provisions its own testnet accounts (one faucet call + on-chain sub-accounts).

```bash
git clone https://github.com/DSP-AID/dail-testnet-escrow-demo.git
cd dail-testnet-escrow-demo
npm install
node run_demo.mjs        # do: full escrow lifecycle on a FRESH set of testnet accounts
                         # see: 5 tx hashes + explorer links printed, demo_result.json written
node verify_demo.mjs     # do: secret-free verification against public NEAR RPC
                         # see: every line PASS ... "ALL CHECKS PASSED" (17 checks)
```

Buyer resolution order in `run_demo.mjs`:

1. dspaid identity key file if present (`DSPAID_KEYPAIR_PATH`, default `C:/Users/Steam/.basedagents/keys/dspaid-keypair.json`) → buyer is the recorded `dspaid-bounty452.testnet`;
2. `BUYER_ACCOUNT` + `BUYER_SEED` env vars → your own funded testnet account;
3. neither → a throwaway `.testnet` account is created via the testnet faucet helper
   (`POST https://helper.testnet.near.org/account`, camelCase JSON body). The faucet has a
   per-IP hourly rate limit — on HTTP 429 use path 2 with any funded testnet account
   (get tokens at <https://near.org/faucet>).

The seller and the escrow contract accounts are always created **on-chain as funded
sub-accounts** of the buyer in one batch transaction each — no extra faucet calls.

## The escrow contract

`contract/escrow.rs` — hand-written, `no_std`, zero-dependency Rust (~200 lines) against the
NEAR classic register ABI (the same host interface near-sdk 5 uses). `contract/escrow.wasm`
(8366 bytes, sha256 `45dad3a1e6e977168adcd6064fdf44e00cb09a6f8ba56a988e407ab83fa12ff7`) is the
committed build artifact, so reproduction does **not** need a Rust toolchain. Rebuild (optional):

```bash
rustup target add wasm32-unknown-unknown
rustc --edition 2021 -O -C panic=abort -C strip=symbols --crate-type cdylib \
      --target wasm32-unknown-unknown contract/escrow.rs -o contract/escrow.wasm
```

Methods (all guarded by a strict stage machine; only the recorded buyer/seller accounts may act):

| Method | Caller | Effect |
|--------|--------|--------|
| `new {"seller_id":...}` | deployer, once | registers seller, stage 0 = open |
| `deposit` (attached ≥ 0) | anyone, while stage 0 | records caller as buyer + locked amount, stage 1 = escrowed |
| `deliver {}` | registered seller, while stage 1 | stage 2 = delivered |
| `release {}` | recorded buyer, while stage 2 | stage 3 = released **and** contract sends the exact locked amount to the seller via a promise transfer |
| `status {}` | view | JSON: stage, buyer, seller, locked amount (u128 little-endian hex) |

The escrow account has no owner access key spending its funds — only the contract's own
`release` path can move the locked deposit out.

## What `verify_demo.mjs` proves (17 checks, zero secrets)

- offline: the shipped wasm hashes to the recorded sha256; every recorded raw signed
  transaction re-hashes consistently;
- on-chain via public RPC: the escrow account's deployed **code hash equals sha256 of the
  shipped wasm** (you are looking at exactly this contract), all five transactions have final
  success status with matching sender/receiver, the contract's own state reports
  `stage 3 / released` naming both agents and the exact locked amount, and the seller
  account's balance actually went up by the deposit.

## Disclosures

- **Testnet only.** The escrowed value is 0.1 **testnet** NEAR from a faucet — no mainnet,
  no real money, per the bounty requirement.
- The contract is a purpose-built minimal escrow (happy path: lock → deliver → release),
  not an audited marketplace contract; it has no refund/dispute branch by design.
- Explorer links open in a browser (NearBlocks runs a Cloudflare challenge for raw HTTP
  clients); every fact behind them is also machine-checkable via the plain JSON RPC commands
  above and `verify_demo.mjs`, which depends on nothing but `rpc.testnet.near.org`.
- TX hashes are the canonical node-reported hashes. Near-api-js v7's client-side borsh
  encoding differs from protocol-normalized bytes by a trailing optional field
  (`priority_fee`), so both the client hash and the raw signed bytes are recorded in
  `demo_result.json` and the verifier checks them consistently.
- The bounty title mentions a video; the description accepts "a scripted run that a stranger
  can reproduce from the README" — this repo is that scripted run, and it re-executed the
  exact lifecycle end-to-end before submission.
