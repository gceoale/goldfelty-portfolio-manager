import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, VaultLockedError, WeakPasswordError, BASE_PATH } from '../src/main/vault.ts'

const PASSWORD = 'Tr0ubad0ur&Bits'

function freshVault() {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-test-'))
  return { vault: new Vault(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('creating a vault writes an encrypted file and returns recovery material once', async (t) => {
  const { vault, dir, cleanup } = freshVault()
  t.after(cleanup)

  const { recovery, ticket } = await vault.create(PASSWORD)
  assert.equal(recovery.mnemonic.split(' ').length, 24)
  assert.match(recovery.privateKey, /^0x[0-9a-f]{64}$/)
  assert.equal(recovery.derivationPath, `${BASE_PATH}/0`)
  assert.ok(ticket)

  // The seed must not be sitting on disk in the clear.
  const onDisk = readFileSync(join(dir, 'vault.json'), 'utf8')
  assert.ok(!onDisk.includes(recovery.mnemonic))
  assert.ok(!onDisk.includes(recovery.privateKey))
  assert.ok(onDisk.includes('aes-256-gcm'))
})

test('refuses a weak password', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await assert.rejects(() => vault.create('password'), WeakPasswordError)
})

test('the one-time reveal burns after the backup is confirmed', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)

  const { recovery, ticket } = await vault.create(PASSWORD)
  assert.equal(vault.revealOnce(ticket).mnemonic, recovery.mnemonic)

  vault.closeReveal()
  assert.equal(vault.revealIsOpen, false)
  assert.throws(() => vault.revealOnce(ticket), /only be shown while setting up/)
})

test('a forged ticket cannot reveal the seed', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)
  assert.throws(() => vault.revealOnce('deadbeef'), /only be shown while setting up/)
})

test('locks, then unlocks with the right password only', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)

  const { recovery } = await vault.create(PASSWORD)
  vault.lock()
  assert.equal(vault.isLocked, true)
  assert.throws(() => vault.deriveOwner(0), VaultLockedError)

  await assert.rejects(() => vault.unlock('not-the-password-1!'), /Incorrect password/)
  assert.equal(vault.isLocked, true)

  await vault.unlock(PASSWORD)
  assert.equal(vault.isLocked, false)
  assert.equal(vault.ownerAddress(0), recovery.ownerAddress)
})

test('derives a stable, distinct owner key per index', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)

  const addresses = new Set()
  for (let i = 0; i < 60; i++) addresses.add(vault.ownerAddress(i))
  assert.equal(addresses.size, 60, '60 wallets must mean 60 distinct owner keys')
  assert.equal(vault.ownerAddress(17), vault.ownerAddress(17))
})

test('rejects nonsense derivation indices', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)
  assert.throws(() => vault.deriveOwner(-1), /Invalid derivation index/)
  assert.throws(() => vault.deriveOwner(1.5), /Invalid derivation index/)
})

test('restoring the same phrase rebuilds identical addresses', async (t) => {
  const first = freshVault()
  const second = freshVault()
  t.after(first.cleanup)
  t.after(second.cleanup)

  const { recovery } = await first.vault.create(PASSWORD)
  await second.vault.create('An0ther-Password!', recovery.mnemonic)

  for (let i = 0; i < 10; i++) {
    assert.equal(first.vault.ownerAddress(i), second.vault.ownerAddress(i))
  }
})

test('changing the password keeps the same seed', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)

  const { recovery } = await vault.create(PASSWORD)
  await vault.changePassword(PASSWORD, 'A-Wholly-N3w-Password!')
  vault.lock()

  await assert.rejects(() => vault.unlock(PASSWORD), /Incorrect password/)
  await vault.unlock('A-Wholly-N3w-Password!')
  assert.equal(vault.ownerAddress(0), recovery.ownerAddress)
})

test('verify checks a password without unlocking', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)
  vault.lock()

  assert.equal(await vault.verify(PASSWORD), true)
  assert.equal(await vault.verify('nope'), false)
  assert.equal(vault.isLocked, true, 'verify must not unlock as a side effect')
})

test('will not overwrite an existing vault', async (t) => {
  const { vault, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)
  await assert.rejects(() => vault.create('Some0ther-Password!'), /already exists/)
})

test('leaves no temp file behind after writing', async (t) => {
  const { vault, dir, cleanup } = freshVault()
  t.after(cleanup)
  await vault.create(PASSWORD)
  assert.equal(existsSync(join(dir, 'vault.json.tmp')), false)
})
