import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, VaultLockedError, WeakPasswordError } from '../src/main/vault.ts'
import { deriveKey, encryptWithKey, newSalt, WrongPasswordError, CorruptVaultError } from '../src/main/crypto.ts'

const PASSWORD = 'Tr0ubad0ur&Bits'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-vault-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A vault file exactly as version 1 wrote it: a seed phrase under the password. */
async function writeV1Vault(dir, password) {
  const params = { N: 32768, r: 8, p: 1, keyLength: 32 }
  const salt = newSalt()
  const key = await deriveKey(password, salt, params)
  const blob = encryptWithKey(key, JSON.stringify({ mnemonic: 'test test test test test test test test test test test junk', createdAt: 1 }), {
    name: 'scrypt',
    ...params,
    salt: salt.toString('base64')
  })
  writeFileSync(join(dir, 'vault.json'), JSON.stringify(blob))
}

test('creates a vault, locks, and unlocks to the same data key', async (t) => {
  const vault = new Vault(tempDir(t))
  await vault.create(PASSWORD)
  const key = Buffer.from(vault.key())
  assert.equal(key.length, 32)
  vault.lock()
  assert.throws(() => vault.key(), VaultLockedError)
  const result = await vault.unlock(PASSWORD)
  assert.equal(result.migratedFromV1, false)
  assert.ok(vault.key().equals(key))
})

test('locking wipes the key buffer it handed out', async (t) => {
  const vault = new Vault(tempDir(t))
  await vault.create(PASSWORD)
  const handed = vault.key()
  vault.lock()
  assert.ok(handed.every((b) => b === 0), 'the same buffer is zeroed, not just dropped')
})

test('refuses a weak password and a wrong one', async (t) => {
  const vault = new Vault(tempDir(t))
  await assert.rejects(vault.create('password'), WeakPasswordError)
  await vault.create(PASSWORD)
  vault.lock()
  await assert.rejects(vault.unlock('Wr0ng&Password'), WrongPasswordError)
  assert.equal(vault.isLocked, true)
})

test('will not overwrite an existing vault', async (t) => {
  const vault = new Vault(tempDir(t))
  await vault.create(PASSWORD)
  await assert.rejects(vault.create(PASSWORD), /already set up/)
})

test('changing the password keeps the data key', async (t) => {
  const vault = new Vault(tempDir(t))
  await vault.create(PASSWORD)
  const key = Buffer.from(vault.key())
  await vault.changePassword(PASSWORD, 'N3w&Better-Phrase')
  vault.lock()
  await assert.rejects(vault.unlock(PASSWORD), WrongPasswordError)
  await vault.unlock('N3w&Better-Phrase')
  assert.ok(vault.key().equals(key))
})

test('a version 1 vault is kept aside untouched and converted', async (t) => {
  const dir = tempDir(t)
  await writeV1Vault(dir, PASSWORD)
  const original = readFileSync(join(dir, 'vault.json'), 'utf8')

  const vault = new Vault(dir)
  const result = await vault.unlock(PASSWORD)
  assert.equal(result.migratedFromV1, true)
  assert.equal(readFileSync(vault.backupPath, 'utf8'), original, 'the old file, with its phrase, is preserved byte for byte')
  assert.notEqual(readFileSync(vault.path, 'utf8'), original)

  vault.lock()
  const again = await vault.unlock(PASSWORD)
  assert.equal(again.migratedFromV1, false, 'converted once only')
  assert.ok(!readFileSync(vault.path, 'utf8').includes('mnemonic'))
})

test('refuses a vault file whose KDF has been weakened', async (t) => {
  const dir = tempDir(t)
  const vault = new Vault(dir)
  await vault.create(PASSWORD)
  vault.lock()
  const blob = JSON.parse(readFileSync(vault.path, 'utf8'))
  blob.kdf.N = 2
  writeFileSync(vault.path, JSON.stringify(blob))
  await assert.rejects(vault.unlock(PASSWORD), CorruptVaultError)
  assert.ok(existsSync(vault.path))
})

test('verify checks a password without unlocking', async (t) => {
  const vault = new Vault(tempDir(t))
  await vault.create(PASSWORD)
  vault.lock()
  assert.equal(await vault.verify(PASSWORD), true)
  assert.equal(await vault.verify('Wr0ng&Password'), false)
  assert.equal(vault.isLocked, true)
})
