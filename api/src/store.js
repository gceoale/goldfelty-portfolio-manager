import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Accounts on disk.
 *
 * A JSON file is the right size for this: the records are tiny, there is no
 * query beyond two lookups, and it can be swapped for a real database the day
 * the numbers justify one. Writes go through a temp file and a rename so a
 * crash cannot truncate the file.
 */
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'accounts.json')
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { accounts: [] }
    this.usernames = new Map(this.data.accounts.map((a) => [a.username, a]))
    this.addresses = new Map(this.data.accounts.map((a) => [a.address.toLowerCase(), a]))
  }

  hasUsername(username) {
    return this.usernames.has(username)
  }

  byAddress(address) {
    return this.addresses.get(address.toLowerCase()) ?? null
  }

  create({ username, email, address }) {
    const account = { id: `gf_${randomUUID()}`, username, email, address, createdAt: new Date().toISOString() }
    this.data.accounts.push(account)
    this.usernames.set(username, account)
    this.addresses.set(address.toLowerCase(), account)
    this.persist()
    return account
  }

  persist() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
