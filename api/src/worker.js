import { handleRequest } from './accounts.js'

/**
 * The Cloudflare entry point. Everything it does is wire D1 to the logic in
 * accounts.js, which is where the interesting parts are and where the tests
 * point.
 */

function d1(database) {
  return {
    async findByUsername(username) {
      return database.prepare('SELECT id, username FROM accounts WHERE username = ?').bind(username).first()
    },
    async findByAddress(address) {
      return database.prepare('SELECT id, username FROM accounts WHERE address = ?').bind(address).first()
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
      return await handleRequest(d1(env.DB), request)
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
