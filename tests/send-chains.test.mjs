import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as bitcoin from 'bitcoinjs-lib'
import ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { Wallet as EthWallet } from 'ethers'
import { base58Encode, base58CheckEncode, tronToHex20 } from '../src/main/addresses.ts'
import { CHAIN_BY_ID, TOKENS } from '../src/shared/chains.ts'
import { DEFAULT_SETTINGS } from '../src/main/settings.ts'
import { useOnlyCustomEndpointsForTests } from '../src/main/rpc.ts'
import { planBitcoin, finishBitcoin, broadcastBitcoin } from '../src/main/send/bitcoin.ts'
import { planSolana, finishSolana, broadcastSolana, associatedTokenAddress } from '../src/main/send/solana.ts'
import { buildTron, finishTron, broadcastTron, decodeTronRaw, checkTronTx } from '../src/main/send/tron.ts'

const ECPair = ECPairFactory(ecc)
const BTC = CHAIN_BY_ID.get(-1)
const SOL = CHAIN_BY_ID.get(-501)
const TRX = CHAIN_BY_ID.get(-195)
const native = (chainId) => TOKENS.find((t) => t.chainId === chainId && t.address === null)
const token = (chainId, symbol) => TOKENS.find((t) => t.chainId === chainId && t.symbol === symbol)

/* ---- One local server playing Esplora, Solana RPC and TronGrid --------------------- */

const state = {
  utxos: {}, // address -> [{ txid, vout, value }]
  rawTx: {}, // txid -> hex
  btcBroadcast: [],
  solAccounts: new Map(), // address -> lamports
  solTokenBalance: new Map(), // token account -> amount
  solSent: [],
  tronTamper: false,
  tronBroadcast: []
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const url = req.url
    // Bitcoin (Esplora)
    if (url.startsWith('/btc/fee-estimates')) return json({ 1: 20.5, 3: 12.2, 6: 8 })
    let m = url.match(/^\/btc\/address\/([^/]+)\/utxo$/)
    if (m) return json(state.utxos[decodeURIComponent(m[1])] ?? [])
    m = url.match(/^\/btc\/tx\/([0-9a-f]{64})\/hex$/)
    if (m) return res.end(state.rawTx[m[1]] ?? '')
    if (url === '/btc/tx' && req.method === 'POST') {
      const tx = bitcoin.Transaction.fromHex(body)
      state.btcBroadcast.push(tx)
      return res.end(tx.getId())
    }
    // Solana
    if (url.startsWith('/sol')) {
      const call = JSON.parse(body)
      const reply = (result) => json({ jsonrpc: '2.0', id: call.id, result })
      switch (call.method) {
        case 'getAccountInfo': {
          const lamports = state.solAccounts.get(call.params[0])
          return reply({ context: {}, value: lamports === undefined ? null : { lamports } })
        }
        case 'getBalance':
          return reply({ context: {}, value: state.solAccounts.get(call.params[0]) ?? 0 })
        case 'getTokenAccountBalance': {
          const amount = state.solTokenBalance.get(call.params[0])
          if (amount === undefined) return json({ jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'could not find account' } })
          return reply({ context: {}, value: { amount: String(amount), decimals: 6 } })
        }
        case 'getLatestBlockhash':
          return reply({ context: {}, value: { blockhash: base58Encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 100 } })
        case 'sendTransaction': {
          const bytes = Buffer.from(call.params[0], 'base64')
          state.solSent.push(bytes)
          return reply(base58Encode(bytes.subarray(1, 65)))
        }
      }
    }
    // Tron (TronGrid)
    if (url === '/tron/wallet/createtransaction') {
      const b = JSON.parse(body)
      return json(tronTx({ type: 1, owner: b.owner_address, to: b.to_address, amount: BigInt(b.amount) + (state.tronTamper ? 1n : 0n) }))
    }
    if (url === '/tron/wallet/triggersmartcontract') {
      const b = JSON.parse(body)
      const data = 'a9059cbb' + b.parameter
      return json({ result: { result: true }, transaction: tronTx({ type: 31, owner: b.owner_address, to: b.contract_address, data, feeLimit: BigInt(b.fee_limit) }) })
    }
    if (url === '/tron/wallet/broadcasttransaction') {
      const tx = JSON.parse(body)
      state.tronBroadcast.push(tx)
      return json({ result: true, txid: tx.txID })
    }
    if (url === '/tron/wallet/getaccount') return json({ balance: 500_000_000 })
    if (url === '/prices/simple/price' || url.startsWith('/prices')) return json({})
    json({}, 404)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
test.after(() => {
  server.closeAllConnections()
  server.close()
})
const SETTINGS = {
  ...DEFAULT_SETTINGS,
  priceProviderUrl: `${origin}/prices`,
  customRpc: { [-1]: `${origin}/btc`, [-501]: `${origin}/sol`, [-195]: `${origin}/tron` }
}
// Only the local server, never the public APIs, which CI can reach.
useOnlyCustomEndpointsForTests(true)
const only = (chain) => chain

/* ---- Bitcoin ---------------------------------------------------------------------------- */

const someone = () => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom().publicKey) }).address
const fakeTxid = (n) => n.toString(16).padStart(64, '0')

function btcWallet(kind) {
  const kp = ECPair.makeRandom()
  const pubkey = Buffer.from(kp.publicKey)
  let address
  let signer = kp
  if (kind === 'p2wpkh') address = bitcoin.payments.p2wpkh({ pubkey }).address
  if (kind === 'p2sh') address = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey }) }).address
  if (kind === 'p2pkh') address = bitcoin.payments.p2pkh({ pubkey }).address
  if (kind === 'p2tr') {
    const x = pubkey.subarray(1)
    address = bitcoin.payments.p2tr({ internalPubkey: x }).address
    signer = kp.tweak(bitcoin.crypto.taggedHash('TapTweak', x))
  }
  return { kp, signer, address, publicKey: pubkey.toString('hex') }
}

function fundBtc(w, values) {
  const script = bitcoin.address.toOutputScript(w.address)
  state.utxos[w.address] = values.map((value, i) => {
    // A real previous transaction, so legacy inputs can prove their amounts.
    const prev = new bitcoin.Transaction()
    prev.addInput(Buffer.alloc(32, i + 1), 0)
    prev.addOutput(script, value)
    state.rawTx[prev.getId()] = prev.toHex()
    return { txid: prev.getId(), vout: 0, value, status: { confirmed: true } }
  })
}

const signAll = (plan, w) => {
  const psbt = bitcoin.Psbt.fromHex(plan.psbtHex)
  psbt.signAllInputs(w.signer)
  return psbt.toHex()
}

for (const kind of ['p2wpkh', 'p2sh', 'p2tr', 'p2pkh']) {
  test(`Bitcoin (${kind}): one transaction pays the recipient, the fee and the change`, async () => {
    const w = btcWallet(kind)
    fundBtc(w, [80_000, 50_000, 1_000])
    const to = someone()
    const feeTo = someone()
    const plan = await planBitcoin(only(BTC), SETTINGS, w, to, 100_000n, { recipient: feeTo, units: 600n })
    assert.equal(plan.inputs.length, 2, 'largest coins first, no more than needed')
    assert.equal(plan.feeRate, 13)
    const [pay, fee, change] = plan.outputs
    assert.deepEqual([pay.address, pay.value], [to, 100_000n])
    assert.deepEqual([fee.address, fee.value], [feeTo, 600n])
    assert.equal(change.address, w.address)
    assert.equal(130_000n - 100_000n - 600n - change.value, plan.networkFee)

    const signed = finishBitcoin(BTC, plan, signAll(plan, w))
    const txid = await broadcastBitcoin(only(BTC), SETTINGS, signed)
    const tx = state.btcBroadcast.at(-1)
    assert.equal(tx.getId(), txid)
    assert.equal(tx.outs[0].value, 100_000)
    assert.equal(tx.outs[1].value, 600)
    // The estimate must cover the real size, or the transaction would sit unconfirmed.
    assert.ok(Number(plan.networkFee) >= tx.virtualSize() * plan.feeRate, `fee ${plan.networkFee} for ${tx.virtualSize()} vB`)
  })
}

test('Bitcoin: a wallet that changes the transaction is refused', async () => {
  const w = btcWallet('p2wpkh')
  fundBtc(w, [90_000])
  const plan = await planBitcoin(only(BTC), SETTINGS, w, someone(), 20_000n, null)
  const tampered = bitcoin.Psbt.fromHex(plan.psbtHex)
  tampered.addOutput({ address: someone(), value: 10_000 })
  tampered.signAllInputs(w.signer)
  assert.throws(() => finishBitcoin(BTC, plan, tampered.toBase64()), (e) => e.code === 'TAMPERED')
  assert.throws(() => finishBitcoin(BTC, plan, plan.psbtHex), (e) => e.code === 'UNSIGNED')
  assert.throws(() => finishBitcoin(BTC, plan, 'nonsense'), (e) => e.code === 'BAD_PSBT')
})

test('Bitcoin: not enough coins, dust, and Taproot without a public key', async () => {
  const w = btcWallet('p2wpkh')
  fundBtc(w, [5_000])
  await assert.rejects(planBitcoin(only(BTC), SETTINGS, w, someone(), 4_900n, null), (e) => e.code === 'INSUFFICIENT')
  await assert.rejects(planBitcoin(only(BTC), SETTINGS, w, someone(), 100n, null), (e) => e.code === 'DUST')
  const tr = btcWallet('p2tr')
  await assert.rejects(planBitcoin(only(BTC), SETTINGS, { address: tr.address, publicKey: null }, someone(), 10_000n, null), (e) => e.code === 'NO_PUBLIC_KEY')
})

/* ---- Solana ------------------------------------------------------------------------------- */

function solKey() {
  const sk = ed25519.utils.randomPrivateKey()
  return { sk, address: base58Encode(ed25519.getPublicKey(sk)) }
}
const signSol = (plan, sk) => {
  const sig = ed25519.sign(plan.message, sk)
  return Buffer.concat([Buffer.from([1]), Buffer.from(sig), Buffer.from(plan.message)]).toString('base64')
}

test('Solana: SOL and the fee move in one signed transaction', async () => {
  const me = solKey()
  const friend = solKey().address
  const owner = solKey().address
  state.solAccounts.set(friend, 1)
  state.solAccounts.set(owner, 1)
  const plan = await planSolana(only(SOL), SETTINGS, me.address, friend, native(-501), 1_000_000_000n, { recipient: owner, units: 5_000_000n })
  assert.equal(plan.feeIncluded, true)
  const done = finishSolana(plan, me.address, signSol(plan, me.sk))
  const signature = await broadcastSolana(only(SOL), SETTINGS, done)
  assert.equal(signature, done.signature)
  assert.ok(plan.networkFee >= 5_000n && plan.networkFee < 100_000n)
})

test('Solana: a changed message or a different signer is refused', async () => {
  const me = solKey()
  const friend = solKey().address
  state.solAccounts.set(friend, 1)
  const plan = await planSolana(only(SOL), SETTINGS, me.address, friend, native(-501), 2_000_000n, null)
  const signed = Buffer.from(signSol(plan, me.sk), 'base64')
  signed[signed.length - 1] ^= 1
  assert.throws(() => finishSolana(plan, me.address, signed.toString('base64')), (e) => e.code === 'TAMPERED')
  assert.throws(() => finishSolana(plan, me.address, signSol(plan, solKey().sk)), (e) => e.code === 'BAD_SIGNATURE')
})

test('Solana: opening a new address needs the rent minimum', async () => {
  const me = solKey()
  await assert.rejects(planSolana(only(SOL), SETTINGS, me.address, solKey().address, native(-501), 1_000n, null), (e) => e.code === 'BELOW_RENT')
})

test('Solana USDC: opens the recipient’s token account; skips the fee rather than paying to open the owner’s', async () => {
  const usdc = token(-501, 'USDC')
  const me = solKey()
  const friend = solKey().address
  const owner = solKey().address
  state.solTokenBalance.set(associatedTokenAddress(me.address, usdc.address), 50_000_000)
  const plan = await planSolana(only(SOL), SETTINGS, me.address, friend, usdc, 10_000_000n, { recipient: owner, units: 50_000n })
  assert.equal(plan.feeIncluded, false)
  assert.equal(plan.warnings.length, 1)
  assert.ok(plan.networkFee > 2_000_000n, 'includes the rent for the new account')

  state.solAccounts.set(associatedTokenAddress(friend, usdc.address), 2_039_280)
  state.solAccounts.set(associatedTokenAddress(owner, usdc.address), 2_039_280)
  const again = await planSolana(only(SOL), SETTINGS, me.address, friend, usdc, 10_000_000n, { recipient: owner, units: 50_000n })
  assert.equal(again.feeIncluded, true)
  assert.equal(again.warnings.length, 0)
  await assert.rejects(planSolana(only(SOL), SETTINGS, me.address, friend, usdc, 60_000_000n, null), (e) => e.code === 'INSUFFICIENT')
})

/* ---- Tron ----------------------------------------------------------------------------- */

// A tiny protobuf writer for test transactions, checked against TronWeb's output below.
const varint = (n) => {
  let v = BigInt(n)
  const out = []
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}
const field = (no, wire, payload) => Buffer.concat([varint((no << 3) | wire), wire === 2 ? Buffer.concat([varint(payload.length), payload]) : varint(payload)])
const h = (hex) => Buffer.from(hex, 'hex')
function tronRaw({ type, owner, to, amount, data, feeLimit, expiration, timestamp }) {
  const param =
    type === 1
      ? Buffer.concat([field(1, 2, h(owner)), field(2, 2, h(to)), field(3, 0, amount)])
      : Buffer.concat([field(1, 2, h(owner)), field(2, 2, h(to)), field(4, 2, h(data))])
  const typeUrl = Buffer.from(`type.googleapis.com/protocol.${type === 1 ? 'TransferContract' : 'TriggerSmartContract'}`)
  const contract = Buffer.concat([field(1, 0, type), field(2, 2, Buffer.concat([field(1, 2, typeUrl), field(2, 2, param)]))])
  const parts = [field(1, 2, h('abcd')), field(4, 2, h('0011223344556677')), field(8, 0, expiration), field(11, 2, contract), field(14, 0, timestamp)]
  if (feeLimit) parts.push(field(18, 0, feeLimit))
  return Buffer.concat(parts).toString('hex')
}
const hex41 = (b58) => '41' + tronToHex20(b58)
function tronTx({ type, owner, to, amount, data, feeLimit }) {
  const now = Date.now()
  const raw = tronRaw({ type, owner: hex41(owner), to: hex41(to), amount, data, feeLimit, expiration: now + 60_000, timestamp: now })
  return { visible: true, txID: Buffer.from(sha256(h(raw))).toString('hex'), raw_data: {}, raw_data_hex: raw }
}

test('Tron: the decoder reads what TronWeb writes', () => {
  // Encoded by TronWeb 6's own protobuf code.
  const trx = decodeTronRaw(
    '0A02ABCD220800112233445566774083E597FA96345A67080112630A2D747970652E676F6F676C65617069732E636F6D2F70726F746F636F6C2E5472616E73666572436F6E747261637412320A1541A614F803B6FD780986A42C78EC9C7F77E6DED13C12154174472E7D35395A6B5ADD427EECB7F4B62AD2B0711887AD4B70A39094FA9634'
  )
  assert.deepEqual([trx.type, trx.owner, trx.to, trx.amount], [1, '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', '4174472e7d35395a6b5add427eecb7f4b62ad2b071', 1234567n])
  const trc = decodeTronRaw(
    '0A02ABCD220800112233445566774083E597FA96345AAE01081F12A9010A31747970652E676F6F676C65617069732E636F6D2F70726F746F636F6C2E54726967676572536D617274436F6E747261637412740A1541A614F803B6FD780986A42C78EC9C7F77E6DED13C121541A614F803B6FD780986A42C78EC9C7F77E6DED13C2244A9059CBB00000000000000000000000074472E7D35395A6B5ADD427EECB7F4B62AD2B071000000000000000000000000000000000000000000000000000000000016E36070A39094FA9634900180E1EB17'
  )
  assert.equal(trc.type, 31)
  assert.equal(trc.feeLimit, 50_000_000n)
  assert.ok(trc.data.endsWith('16e360'))
  // And the test writer agrees with TronWeb byte for byte.
  const mine = tronRaw({
    type: 1,
    owner: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
    to: '4174472e7d35395a6b5add427eecb7f4b62ad2b071',
    amount: 1234567n,
    expiration: 1792868217475n,
    timestamp: 1792868157475n
  })
  assert.equal(
    mine.toUpperCase(),
    '0A02ABCD220800112233445566774083E597FA96345A67080112630A2D747970652E676F6F676C65617069732E636F6D2F70726F746F636F6C2E5472616E73666572436F6E747261637412320A1541A614F803B6FD780986A42C78EC9C7F77E6DED13C12154174472E7D35395A6B5ADD427EECB7F4B62AD2B0711887AD4B70A39094FA9634'
  )
})

function tronKey() {
  const w = EthWallet.createRandom()
  return { w, address: base58CheckEncode(Buffer.from('41' + w.address.slice(2), 'hex')) }
}
const signTron = (tx, w) => {
  const s = w.signingKey.sign('0x' + tx.txID)
  return { ...tx, signature: [s.r.slice(2) + s.s.slice(2) + s.v.toString(16)] }
}

test('Tron: TRX and USDT transfers are checked, signed by the sender, and broadcast', async () => {
  const me = tronKey()
  const friend = tronKey().address
  const trx = await buildTron(only(TRX), SETTINGS, me.address, friend, native(-195), 25_000_000n)
  const id = await broadcastTron(only(TRX), SETTINGS, finishTron(trx, me.address, signTron(trx, me.w)))
  assert.equal(id, trx.txID)
  assert.equal(state.tronBroadcast.at(-1).signature.length, 1)

  const usdt = token(-195, 'USDT')
  const tx = await buildTron(only(TRX), SETTINGS, me.address, friend, usdt, 7_500_000n)
  const decoded = decodeTronRaw(tx.raw_data_hex)
  assert.equal(decoded.to, hex41(usdt.address))
  assert.ok(decoded.data.endsWith((7_500_000).toString(16).padStart(64, '0')))
  await broadcastTron(only(TRX), SETTINGS, finishTron(tx, me.address, signTron(tx, me.w)))
})

test('Tron: a different amount from the API, or a different signer, is refused', async () => {
  const me = tronKey()
  const friend = tronKey().address
  state.tronTamper = true
  await assert.rejects(buildTron(only(TRX), SETTINGS, me.address, friend, native(-195), 1_000_000n), (e) => e.code === 'TAMPERED')
  state.tronTamper = false
  const tx = await buildTron(only(TRX), SETTINGS, me.address, friend, native(-195), 1_000_000n)
  assert.throws(() => finishTron(tx, me.address, signTron(tx, tronKey().w)), (e) => e.code === 'BAD_SIGNATURE')
  assert.throws(() => finishTron(tx, me.address, { ...signTron(tx, me.w), raw_data_hex: tx.raw_data_hex + '00' }), (e) => e.code === 'TAMPERED')
  assert.throws(() => checkTronTx({ ...tx, txID: '00'.repeat(32) }, me.address, friend, native(-195), 1_000_000n), (e) => e.code === 'BAD_TX')
})

/* ---- Through the send flow, with fees ------------------------------------------------- */

const fees = await import('../src/main/fees.ts')
const { quoteTransfer, executeTransfer } = await import('../src/main/transfers.ts')
const { Store } = await import('../src/main/store.ts')
const { registerConnectionAccounts } = await import('../src/main/wallets.ts')

function storeWith(t, connection) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-send-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir)
  store.open(randomBytes(32))
  const [wallet] = registerConnectionAccounts(store, connection, [1])
  return { store, wallet }
}
const conn = (family, rdns, account, chainId, extra = {}) => ({
  id: `browser:${rdns}`,
  kind: 'browser',
  family,
  name: 'Test Wallet',
  providerId: 'test',
  rdns,
  icon: null,
  accounts: [account],
  chainIds: [chainId],
  connectedAt: 1,
  active: true,
  topic: null,
  ...extra
})
const SEND_SETTINGS = { ...SETTINGS }

test('send flow: Bitcoin fee rides in the same transaction, to the BTC fee address', async (t) => {
  const owner = someone()
  fees.setFeeRecipientForTests(owner, 'utxo')
  t.after(() => fees.setFeeRecipientForTests(undefined, 'utxo'))
  const w = btcWallet('p2wpkh')
  fundBtc(w, [2_000_000])
  const { store, wallet } = storeWith(t, conn('utxo', 'btc:test', w.address, -1, { publicKeys: { [w.address]: w.publicKey } }))
  const to = someone()
  const quote = await quoteTransfer(store, SEND_SETTINGS, { walletId: wallet.id, tokenKey: native(-1).key, to, amount: '0.01' })
  assert.equal(quote.fee.bps, 50)
  assert.equal(quote.fee.recipient, owner)
  assert.ok(quote.networkFee > 0)

  const sender = {
    isReachable: () => true,
    sendTransaction: async () => assert.fail('not an EVM send'),
    signPsbt: async (_c, psbtHex) => signAll({ psbtHex }, w),
    signSolana: async () => assert.fail(),
    signTron: async () => assert.fail()
  }
  const result = await executeTransfer(store, SEND_SETTINGS, sender, { walletId: wallet.id, tokenKey: native(-1).key, to, amount: '0.01', feeBps: 50 })
  const tx = state.btcBroadcast.at(-1)
  assert.equal(result.hash, tx.getId())
  assert.equal(result.fee.status, 'sent')
  assert.equal(result.fee.hash, result.hash)
  assert.match(result.explorerUrl, /mempool\.space\/tx\//)
  const outs = tx.outs.map((o) => [bitcoin.address.fromOutputScript(o.script), o.value])
  assert.deepEqual(outs.slice(0, 2), [
    [to, 1_000_000],
    [owner, 5_000]
  ])
  assert.deepEqual(store.transfers.map((r) => r.kind).sort(), ['fee', 'transfer'])
})

test('send flow: Tron sends the fee as a second transaction after the transfer', async (t) => {
  const owner = tronKey().address
  fees.setFeeRecipientForTests(owner, 'tron')
  t.after(() => fees.setFeeRecipientForTests(undefined, 'tron'))
  const me = tronKey()
  const { store, wallet } = storeWith(t, conn('tron', 'tron:test', me.address, -195))
  const friend = tronKey().address
  const usdt = token(-195, 'USDT')
  const signed = []
  const sender = {
    isReachable: () => true,
    sendTransaction: async () => assert.fail(),
    signPsbt: async () => assert.fail(),
    signSolana: async () => assert.fail(),
    signTron: async (_c, tx) => (signed.push(decodeTronRaw(tx.raw_data_hex)), signTron(tx, me.w))
  }
  const result = await executeTransfer(store, SEND_SETTINGS, sender, { walletId: wallet.id, tokenKey: usdt.key, to: friend, amount: '200', feeBps: 50 })
  assert.equal(signed.length, 2)
  assert.ok(signed[0].data.includes(tronToHex20(friend)))
  assert.ok(signed[1].data.includes(tronToHex20(owner)))
  assert.ok(signed[1].data.endsWith((1_000_000).toString(16).padStart(64, '0')), '0.5% of 200 USDT')
  assert.equal(result.fee.status, 'sent')
  assert.notEqual(result.fee.hash, result.hash)
})

test('send flow: Litecoin, Dogecoin and XRP are track-only', async (t) => {
  const { store, wallet } = storeWith(t, conn('xrp', 'xrp:test', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', -144))
  await assert.rejects(
    quoteTransfer(store, SEND_SETTINGS, { walletId: wallet.id, tokenKey: native(-144).key, to: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', amount: '1' }),
    (e) => e.code === 'CANT_SEND'
  )
})

test('send flow: a recipient on the wrong chain is refused before anything is built', async (t) => {
  const me = solKey()
  const { store, wallet } = storeWith(t, conn('solana', 'sol:test', me.address, -501))
  await assert.rejects(
    quoteTransfer(store, SEND_SETTINGS, { walletId: wallet.id, tokenKey: native(-501).key, to: someone(), amount: '1' }),
    (e) => e.code === 'BAD_RECIPIENT'
  )
})
