#!/usr/bin/env node
// DAiL bounty bnty_0450 — end-to-end NEAR testnet escrow demo, agent-to-agent.
//
// Flow: buyer agent hires seller agent -> buyer locks funds in an escrow contract
// (deployed fresh on testnet) -> seller marks work delivered -> buyer releases ->
// contract transfers the locked funds to the seller. Every step is a real testnet
// transaction; hashes + explorer links are written to demo_result.json.
//
// Usage:
//   node run_demo.mjs
//     Buyer = dspaid identity account if its key file is found (default), else the
//     account given by BUYER_ACCOUNT + BUYER_SEED env vars, else a throwaway account
//     created via the testnet faucet helper. The seller and the escrow contract are
//     always created on-chain as funded sub-accounts of the buyer (no faucet calls).
//   DSPAID_KEYPAIR_PATH=<path>  override key file location
//
// Requires Node >= 20 and `npm install`. Testnet only — never touches mainnet.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, createTransaction, actions,
  base64Encode, base64Decode, nearToYocto, yoctoToNear,
} from 'near-api-js';
import { base58 } from '@scure/base';

const RPC = 'https://rpc.testnet.near.org';
const FAUCET = 'https://helper.testnet.near.org/account';
const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';
const WALLET_ACC = 'https://wallet.testnet.near.org/accounts/';
const BOUNTY = 'bnty_0450';

const BUYER_ACCOUNT = 'dspaid-bounty452.testnet';
const DEFAULT_KEYPAIR_PATH = 'C:/Users/Steam/.basedagents/keys/dspaid-keypair.json';

const GAS = 30_000_000_000_000n; // 30 TGas per function call (contract methods are cheap)
const DEPOSIT = BigInt(nearToYocto('0.1')); // escrowed amount: 0.1 testnet NEAR

const provider = new JsonRpcProvider({ url: RPC });
const outDir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest();
const NE = new TextEncoder();
const ND = new TextDecoder();

async function viewAccount(accountId) {
  return provider.sendJsonRpc('query', { request_type: 'view_account', account_id: accountId, finality: 'final' });
}

async function balanceYocto(accountId) {
  for (let i = 0; i < 10; i++) {
    try {
      return BigInt((await viewAccount(accountId)).amount);
    } catch (e) {
      if (i === 9) throw new Error(`account ${accountId} not visible on RPC: ${e.message}`);
      await sleep(2000);
    }
  }
}

async function contractStatus(accountId) {
  const r = await provider.sendJsonRpc('query', {
    request_type: 'call_function', account_id: accountId, method_name: 'status',
    args_base64: base64Encode(NE.encode('{}')), finality: 'final',
  });
  return JSON.parse(ND.decode(Uint8Array.from(Array.isArray(r.result) ? r.result : base64Decode(r.result))));
}

async function sendTx({ signer, publicKey, senderId, receiverId, acts, label }) {
  const accessKey = await provider.viewAccessKey({ accountId: senderId, publicKey: PublicKey.from(publicKey) });
  const { header } = await provider.viewBlock({ finality: 'final' });
  const blockHash = base58.decode(header.hash);
  const tx = createTransaction(senderId, PublicKey.from(publicKey), receiverId, BigInt(accessKey.nonce) + 1n, acts, blockHash);
  const { signedTransaction } = await signer.signTransaction(tx);
  const bytes = signedTransaction.encode();
  const hash = base58.encode(sha256(bytes));
  const res = await provider.sendJsonRpc('broadcast_tx_commit', [base64Encode(bytes)]);
  const okKind = Object.keys(res.status)[0];
  if (okKind !== 'SuccessValue' && okKind !== 'SuccessReceiptId') {
    throw new Error(`${label}: tx failed: ${JSON.stringify(res.status)}`);
  }
  // The node-reported hash is the canonical one (indexers use protocol-normalized
  // bytes; client borsh encoding may differ by a trailing Option field, e.g. priority_fee).
  const canonical = res.transaction?.hash ?? hash;
  return { name: label, sender: senderId, receiver: receiverId, tx_hash: canonical, explorer: EXPLORER_TX + canonical, client_tx_hash: hash, signed_tx_b64: base64Encode(bytes), at: new Date().toISOString() };
}

// On-chain sub-account creation: [createAccount, transfer, ...extra, addFullAccessKey]
// in one batch. Funds the new account with `transferNear` (covers storage staking + gas).
// addKey=false omits addFullAccessKey — used for the escrow contract so it is deployed as a
// genuinely keyless, contract-only account (0 access keys cannot move its balance directly).
async function createSubAccount(parent, role, transferNear, extraActs, label, addKey = true) {
  const keypair = await KeyPair.fromRandom('ed25519');
  const accountId = `d450${role}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${parent.accountId}`;
  const acts = [
    actions.createAccount(),
    actions.transfer(BigInt(nearToYocto(transferNear))),
    ...extraActs,
    ...(addKey ? [actions.addFullAccessKey(keypair.getPublicKey())] : []),
  ];
  const step = await sendTx({ signer: parent.signer, publicKey: parent.publicKey, senderId: parent.accountId, receiverId: accountId, acts, label });
  await balanceYocto(accountId); // wait until the account is queryable
  return { accountId, keypair, signer: new KeyPairSigner(keypair), publicKey: keypair.getPublicKey().toString(), step };
}

// HTTP faucet helper (testnet): creates a top-level <name>.testnet account.
async function createFaucetAccount(role) {
  const keypair = await KeyPair.fromRandom('ed25519');
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const accountId = `${role}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.testnet`;
    try {
      const res = await fetch(FAUCET, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keypair.getPublicKey().toString() }),
      });
      if (res.ok) {
        await balanceYocto(accountId);
        return { accountId, keypair, signer: new KeyPairSigner(keypair), publicKey: keypair.getPublicKey().toString() };
      }
      const text = (await res.text()).slice(0, 200);
      lastErr = new Error(`faucet HTTP ${res.status}: ${text}`);
      if (/exist|taken/i.test(text)) continue; // name collision -> fresh name
      await sleep(3000); // rate limit / transient
    } catch (e) {
      lastErr = e;
      await sleep(3000);
    }
  }
  throw new Error(`faucet account creation failed (${role}): ${lastErr?.message}`);
}

async function resolveBuyer() {
  // 1) dspaid identity keypair file (full-access key on dspaid-bounty452.testnet)
  const keyPath = process.env.DSPAID_KEYPAIR_PATH ?? DEFAULT_KEYPAIR_PATH;
  if (existsSync(keyPath)) {
    const { publicKey, privateKey } = JSON.parse(readFileSync(keyPath, 'utf8'));
    const keypair = KeyPair.fromString(`ed25519:${base58.encode(Buffer.from(privateKey.slice(0, 64), 'hex'))}`);
    if (Buffer.from(keypair.getPublicKey().data).toString('hex') !== publicKey.replace(/^ed25519:/, '')) {
      throw new Error(`keypair file publicKey mismatch: derived ${keypair.getPublicKey()}, file ${publicKey}`);
    }
    const ak = await provider.viewAccessKey({ accountId: BUYER_ACCOUNT, publicKey: PublicKey.from(keypair.getPublicKey()) });
    const isFullAccess = typeof ak.permission === 'string' ? ak.permission === 'FullAccess' : 'FullAccessKey' in ak.permission;
    if (!isFullAccess) throw new Error(`${BUYER_ACCOUNT}: identity key is not full-access (${JSON.stringify(ak.permission)})`);
    return { accountId: BUYER_ACCOUNT, signer: new KeyPairSigner(keypair), publicKey: keypair.getPublicKey().toString(), identity_note: 'dspaid registered agent identity account (full-access key verified on-chain)' };
  }
  // 2) caller-provided funded testnet account
  if (process.env.BUYER_ACCOUNT && process.env.BUYER_SEED) {
    const keypair = KeyPair.fromString(`ed25519:${base58.encode(Buffer.from(process.env.BUYER_SEED.slice(0, 64), 'hex'))}`);
    return { accountId: process.env.BUYER_ACCOUNT, signer: new KeyPairSigner(keypair), publicKey: keypair.getPublicKey().toString(), identity_note: `account from BUYER_ACCOUNT env (${process.env.BUYER_ACCOUNT})` };
  }
  // 3) throwaway faucet account (no secrets at all — the judge path)
  const acc = await createFaucetAccount('dail450buyer');
  return Object.assign(acc, { identity_note: 'throwaway faucet-created buyer (run without any secrets)' });
}

async function main() {
  const status = await provider.sendJsonRpc('status', {});
  if ((status.chain_id ?? '') !== 'testnet') {
    throw new Error(`unexpected chain_id from RPC: ${status.chain_id}`);
  }

  const wasm = readFileSync(path.join(outDir, 'contract', 'escrow.wasm'));
  const wasmSha = sha256(wasm).toString('hex');

  console.log('[1/6] resolving buyer agent...');
  const buyer = await resolveBuyer();
  console.log(`      buyer: ${buyer.accountId}  ${WALLET_ACC}${buyer.accountId}`);
  const balBuyer = await balanceYocto(buyer.accountId);
  if (balBuyer < DEPOSIT * 20n) {
    throw new Error(`buyer ${buyer.accountId} balance too low: ${yoctoToNear(balBuyer.toString())} NEAR (need >= ${(DEPOSIT * 20n).toString()} yocto)`);
  }

  const steps = [];

  // --- seller agent: funded sub-account with its own keypair ---
  console.log('[2/6] creating seller agent on-chain (funded sub-account)...');
  const seller = await createSubAccount(buyer, 'seller', '0.5', [], 'create-seller');
  steps.push(seller.step);
  console.log(`      seller: ${seller.accountId}  ${WALLET_ACC}${seller.accountId}`);

  // --- escrow contract account: sub-account + funding + deploy + init in ONE tx ---
  console.log('[3/6] deploying escrow contract (create sub-account + deploy + init in one tx)...');
  // addKey=false: no FullAccess key on the escrow account — only the contract governs its balance
  const escrow = await createSubAccount(
    buyer, 'escrow', '0.5',
    [actions.deployContract(wasm), actions.functionCall('new', { seller_id: seller.accountId }, GAS, 0n)],
    'deploy+init',
    false,
  );
  steps.push(escrow.step);
  console.log(`      escrow: ${escrow.accountId}  ${WALLET_ACC}${escrow.accountId}`);
  const code = await provider.sendJsonRpc('query', { request_type: 'view_code', account_id: escrow.accountId, finality: 'final' });
  if (code.hash !== base58.encode(sha256(wasm))) {
    throw new Error(`deployed code hash ${code.hash} != sha256 of shipped wasm`);
  }

  // --- buyer locks funds in escrow ---
  console.log('[4/6] buyer deposits 0.1 NEAR into escrow...');
  const depStep = await sendTx({ signer: buyer.signer, publicKey: buyer.publicKey, senderId: buyer.accountId, receiverId: escrow.accountId, acts: [actions.functionCall('deposit', {}, GAS, DEPOSIT)], label: 'deposit' });
  depStep.attached_deposit_yocto = DEPOSIT.toString();
  steps.push(depStep);
  let st = await contractStatus(escrow.accountId);
  if (st.stage !== 1 || st.buyer !== buyer.accountId) throw new Error(`after deposit: unexpected status ${JSON.stringify(st)}`);

  // --- seller delivers the work ---
  console.log('[5/6] seller marks work as delivered...');
  steps.push(await sendTx({ signer: seller.signer, publicKey: seller.publicKey, senderId: seller.accountId, receiverId: escrow.accountId, acts: [actions.functionCall('deliver', {}, GAS, 0n)], label: 'deliver' }));
  st = await contractStatus(escrow.accountId);
  if (st.stage !== 2) throw new Error(`after deliver: unexpected status ${JSON.stringify(st)}`);

  // --- buyer releases the funds to the seller ---
  console.log('[6/6] buyer releases funds to seller...');
  const sellerBefore = await balanceYocto(seller.accountId);
  steps.push(await sendTx({ signer: buyer.signer, publicKey: buyer.publicKey, senderId: buyer.accountId, receiverId: escrow.accountId, acts: [actions.functionCall('release', {}, GAS, 0n)], label: 'release' }));
  for (let i = 0; i < 15; i++) {
    st = await contractStatus(escrow.accountId);
    if (st.stage === 3) break;
    await sleep(2000);
  }
  if (st.stage !== 3) throw new Error(`release not finalized on-chain, status: ${JSON.stringify(st)}`);
  const sellerAfter = await balanceYocto(seller.accountId);
  const delta = sellerAfter - sellerBefore;
  if (delta < DEPOSIT - DEPOSIT / 100n) {
    throw new Error(`seller balance delta ${delta} != deposit ${DEPOSIT}`);
  }

  const result = {
    schema: 'dail-escrow-demo-v1',
    network: 'near-testnet',
    rpc: RPC,
    bounty: BOUNTY,
    recorded_at: new Date().toISOString(),
    explorer_tx_prefix: EXPLORER_TX,
    wallet_account_prefix: WALLET_ACC,
    deposit_yocto: DEPOSIT.toString(),
    deposit_near: yoctoToNear(DEPOSIT.toString()),
    contract: { source: 'contract/escrow.rs', wasm: 'contract/escrow.wasm', sha256_hex: wasmSha, deployed_code_hash_b58: code.hash },
    accounts: {
      buyer: { account_id: buyer.accountId, role: 'buyer agent (hires)', note: buyer.identity_note },
      seller: { account_id: seller.accountId, role: 'seller agent (does the work)' },
      escrow: { account_id: escrow.accountId, role: 'escrow contract (holds funds)' },
    },
    steps,
    status_final: st,
    balances_yocto: { seller_before_release: sellerBefore.toString(), seller_after_release: sellerAfter.toString(), received_delta: delta.toString() },
  };
  const outFile = path.join(outDir, 'demo_result.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log('\n=== ESCROW LIFECYCLE COMPLETE (NEAR testnet) ===');
  for (const s of steps) {
    console.log(`${(s.name + ' ').padEnd(13)} ${s.tx_hash}\n${' '.repeat(13)} ${s.explorer}`);
  }
  console.log(`escrow status : ${JSON.stringify(st)}`);
  console.log(`seller delta  : +${yoctoToNear(delta.toString())} NEAR`);
  console.log(`result file   : ${outFile}`);
  console.log('\nNow verify independently (no secrets): node verify_demo.mjs');
}

main().catch((e) => { console.error('FAIL:', e.stack ?? e); process.exit(1); });
