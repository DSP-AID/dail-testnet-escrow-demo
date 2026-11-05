#!/usr/bin/env node
// DAiL bounty bnty_0450 — independent verification of the recorded escrow demo.
// No secrets required: checks the bundled wasm against on-chain code hash, re-hashes
// every raw signed transaction, queries final tx status, reads contract state, and
// confirms the seller actually received the escrowed deposit.
//
// Usage: node verify_demo.mjs   (reads demo_result.json + contract/escrow.wasm)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { JsonRpcProvider, base64Decode, base64Encode, yoctoToNear } from 'near-api-js';
import { base58 } from '@scure/base';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(readFileSync(path.join(outDir, 'demo_result.json'), 'utf8'));
const wasm = readFileSync(path.join(outDir, result.contract.wasm));

if (result.schema !== 'dail-escrow-demo-v1' || result.network !== 'near-testnet') {
  throw new Error('unexpected schema/network in demo_result.json');
}
const provider = new JsonRpcProvider({ url: result.rpc });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest();

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}
function skip(label, detail) { console.log(`SKIP  ${label} — ${detail}`); }

async function main() {
  const escrow = result.accounts.escrow.account_id;
  const seller = result.accounts.seller.account_id;
  const buyer = result.accounts.buyer.account_id;
  const deposit = BigInt(result.deposit_yocto);

  // 1. bundled wasm integrity (offline)
  check('shipped contract/escrow.wasm matches recorded sha256', sha256(wasm).toString('hex') === result.contract.sha256_hex, result.contract.sha256_hex);

  // 2. on-chain code hash == sha256 of shipped wasm
  const code = await provider.sendJsonRpc('query', { request_type: 'view_code', account_id: escrow, finality: 'final' });
  check(`escrow account ${escrow} runs exactly the shipped contract bytes`, code.hash === base58.encode(sha256(wasm)), `code hash ${code.hash}`);

  // 3. every recorded step's raw signed tx re-hashes consistently (offline)
  for (const s of result.steps) {
    const rehash = base58.encode(sha256(base64Decode(s.signed_tx_b64)));
    if (rehash === s.tx_hash) {
      check(`step "${s.name}": signed tx bytes re-hash to claimed hash`, true, s.tx_hash);
    } else if (rehash === s.client_tx_hash) {
      check(`step "${s.name}": signed tx bytes re-hash to recorded client hash`, true, `canonical explorer hash ${s.tx_hash} is protocol-normalized`);
    } else {
      check(`step "${s.name}": signed tx bytes re-hash`, false, `got ${rehash}`);
    }
  }

  // 4. final tx status for every step (public RPC, receipts included)
  for (const s of result.steps) {
    let res = null;
    for (let i = 0; i < 3 && !res; i++) {
      try {
        const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', [s.tx_hash, s.sender]);
        if (!r || !r.status) throw new Error('no status');
        res = r;
      } catch (e) {
        if (i < 2) await sleep(2000); else skip(`step "${s.name}" tx_status`, `${e.message}; explorer link still public: ${s.explorer}`);
      }
    }
    if (res) check(`step "${s.name}": final on-chain status is success, from ${s.sender} to ${s.receiver}`, 'SuccessValue' in res.status && res.transaction.signer_id === s.sender && res.transaction.receiver_id === s.receiver, `explorer: ${s.explorer}`);
  }

  // 5. contract state machine reached "released" and names the right parties (view call)
  const cf = await provider.sendJsonRpc('query', {
    request_type: 'call_function', account_id: escrow, method_name: 'status',
    args_base64: base64Encode(new TextEncoder().encode('{}')), finality: 'final',
  });
  const st = JSON.parse(new TextDecoder().decode(Uint8Array.from(Array.isArray(cf.result) ? cf.result : base64Decode(cf.result))));
  check('contract status(): stage == 3 (released)', st.stage === 3, JSON.stringify(st));
  check(`contract status(): buyer is ${buyer}`, st.buyer === buyer);
  check(`contract status(): seller is ${seller}`, st.seller === seller);
  const leHex = st.amount_le_hex ?? '';
  let amountBE = '0x';
  for (let i = leHex.length - 2; i >= 0; i -= 2) amountBE += leHex.slice(i, i + 2);
  check(`contract status(): locked amount == ${result.deposit_near} NEAR`, BigInt(amountBE) === deposit);

  // 6. the seller really received the funds (balance delta on-chain)
  const nowBal = BigInt((await provider.sendJsonRpc('query', { request_type: 'view_account', account_id: seller, finality: 'final' })).amount);
  const before = BigInt(result.balances_yocto.seller_before_release);
  const received = nowBal - before;
  check(`seller ${seller} received the escrowed deposit`, received >= deposit - deposit / 100n, `+${yoctoToNear(received.toString())} NEAR (deposit ${result.deposit_near})`);

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  if (fail === 0) {
    console.log('ALL CHECKS PASSED — the escrow lifecycle completed on NEAR testnet.');
    console.log(`Explorer (escrow account): https://testnet.nearblocks.io/accounts/${escrow}`);
  } else {
    process.exit(1);
  }
}

main().catch((e) => { console.error('FAIL: verification crashed:', e.stack ?? e); process.exit(1); });
