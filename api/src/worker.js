import { handleRequest } from './accounts.js'

/**
 * The Cloudflare entry point. Everything it does is wire D1 to the logic in
 * accounts.js, which is where the interesting parts are and where the tests
 * point.
 */

export function d1(database) {
  return {
    async findByUsername(username) {
      return database.prepare('SELECT id, username FROM accounts WHERE username = ?').bind(username).first()
    },
    async findByAddress(address) {
      return database.prepare('SELECT id, username FROM accounts WHERE address = ?').bind(address).first()
    },
    /** Count one request in a rate-limit window and return the new total. */
    async hit(key, window) {
      const row = await database
        .prepare(
          'INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, 1) ' +
            'ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 RETURNING count'
        )
        .bind(key, window)
        .first()
      // Old windows are useless; sweep now and then rather than on every call.
      if (Math.random() < 0.02) {
        // Scoped to this key's kind: hourly and per-minute buckets are numbered differently.
        const kind = key.slice(0, key.indexOf(':') + 1)
        await database
          .prepare("DELETE FROM rate_limits WHERE substr(key, 1, length(?)) = ? AND bucket < ?")
          .bind(kind, kind, window - 2)
          .run()
      }
      return Number(row?.count ?? 0)
    },
    async setToken(accountId, tokenHash) {
      await database
        .prepare(
          'INSERT INTO api_tokens (account_id, token_hash, created_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT (account_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at'
        )
        .bind(accountId, tokenHash, new Date().toISOString())
        .run()
    },
    async findByTokenHash(tokenHash) {
      return database
        .prepare('SELECT a.id, a.username FROM api_tokens t JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?')
        .bind(tokenHash)
        .first()
    },
    async upsertReport(accountId, { value, currency, wallets, reportedAt }) {
      await database
        .prepare(
          'INSERT INTO reports (account_id, value, currency, wallets, reported_at) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT (account_id) DO UPDATE SET value = excluded.value, currency = excluded.currency, ' +
            'wallets = excluded.wallets, reported_at = excluded.reported_at'
        )
        .bind(accountId, value, currency, wallets, reportedAt)
        .run()
    },
    async deleteReport(accountId) {
      await database.prepare('DELETE FROM reports WHERE account_id = ?').bind(accountId).run()
    },
    async stats() {
      const users = await database.prepare('SELECT COUNT(*) AS n FROM accounts').first()
      const week = await database
        .prepare('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?')
        .bind(new Date(Date.now() - 7 * 86400_000).toISOString())
        .first()
      const totals = await database
        .prepare('SELECT currency, COUNT(*) AS users, SUM(value) AS total FROM reports GROUP BY currency ORDER BY total DESC')
        .all()
      const people = await database
        .prepare(
          'SELECT a.username, a.email, a.created_at AS createdAt, r.value, r.currency, r.wallets, r.reported_at AS reportedAt ' +
            'FROM accounts a LEFT JOIN reports r ON r.account_id = a.id ' +
            'ORDER BY r.value IS NULL, r.value DESC, a.created_at DESC LIMIT 500'
        )
        .all()
      return {
        users: Number(users?.n ?? 0),
        newThisWeek: Number(week?.n ?? 0),
        sharing: (totals.results ?? []).reduce((n, r) => n + Number(r.users), 0),
        totals: totals.results ?? [],
        accounts: people.results ?? []
      }
    },
    async insert({ username, email, address }) {
      const id = `gf_${crypto.randomUUID()}`
      await database
        .prepare('INSERT INTO accounts (id, username, email, address, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, email, address, new Date().toISOString())
        .run()
      return { id, username }
    }
  }
}

export default {
  async fetch(request, env) {
    if (!env.DB) {
      return new Response(JSON.stringify({ message: 'Database binding missing.' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
    try {
      return await handleRequest(d1(env.DB), request, Date.now(), { adminToken: env.ADMIN_TOKEN })
    } catch (error) {
      // Never leak internals to the caller; the detail goes to the log tail.
      console.error('unhandled', error)
      return new Response(JSON.stringify({ message: 'Something went wrong.' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
}
