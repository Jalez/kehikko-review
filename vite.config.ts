import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { LEGACY_WELL_KNOWN, WELL_KNOWN, legacyManifest } from 'kehikot-module-protocol'
import { frameAncestors, serves } from 'kehikot-module-protocol/serve'
import { defineConfig, type Plugin } from 'vite'

import { MANIFEST, TICKET, TICKET_HEADER, answer } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { page } from './page/document.ts'

/**
 * Every door, served by the process that serves the page. A module is ONE
 * ORIGIN: the host refuses an `entry` anywhere else, and a store on a second
 * port would make the page's own `/api` calls cross-origin.
 *
 * `/app` is claimed here before Vite's resolver sees it: under Vite dev an
 * extensionless `/app` next to `src/app.tsx` would otherwise answer with
 * compiled JavaScript, which a frame loads happily and runs nothing from.
 */
function doors(): Plugin {
  return {
    name: 'review-doors',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        const method = (request.method ?? 'GET').toUpperCase()

        const send = (status: number, body: unknown) => {
          response.statusCode = status
          if (body === null) return response.end()
          response.setHeader('content-type', 'application/json; charset=utf-8')
          /* A draft and a diff are both things that change under the page, and
             the page re-reads them on purpose. A cached answer would be an
             agent's comment that never appears. */
          response.setHeader('cache-control', 'no-store')
          response.end(JSON.stringify(body, null, 2))
        }

        if (path === WELL_KNOWN) return send(200, MANIFEST)
        /* The same manifest in the spelling a host from before the rename asks
           for, so that host still finds this module. It greets in that
           dialect and the protocol's client answers in it. */
        if (path === LEGACY_WELL_KNOWN) return send(200, legacyManifest(MANIFEST))

        if (path === '/app' || path === '/app/' || path === '/') {
          void server
            .transformIndexHtml(request.url ?? '/app', page(TICKET), request.originalUrl)
            .then((html) => {
              response.statusCode = 200
              response.setHeader('content-type', 'text/html; charset=utf-8')
              /* The ticket is per process; a cached page would have every write refused. */
              response.setHeader('cache-control', 'no-store')
              /* Framed by a host or by nothing. Which hosts: `KEHIKOT_ORIGINS`, the
                 list a host passes to what it starts (then `KEHIKOT_ORIGIN`, then
                 `ROADMAP_ORIGIN`, then every origin a host here serves from). */
              response.setHeader('content-security-policy', frameAncestors())
              response.end(html)
            })
            .catch(next)
          return
        }

        const ours = path === '/healthz' || path === '/mcp' || path.startsWith('/api/')
        if (!ours) return next()

        /* `answer` is async now: reading a change runs a CLI, and sending a
           review runs several. It never throws for anything a caller did —
           refusals are replies — so the `catch` is for a bug, and hands it to
           Vite's error page rather than leaving the request open. */
        void body(request)
          .then((parsed) => answer(method, path, url.searchParams, parsed, readTicket(request.headers[TICKET_HEADER])))
          .then((reply) => {
            if (!reply) return next()
            send(reply.status, reply.body)
          })
          .catch(next)
      })
    },
  }
}

function readTicket(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/** The POST body as a JSON object, or null. Bounded, because anything on this machine can find the port. */
const MAX_BODY_BYTES = 1_000_000

async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if ((request.method ?? 'GET').toUpperCase() !== 'POST') return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const piece = chunk as Buffer
    size += piece.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(piece)
  }
  if (!chunks.length) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * - No `server.cors`: the manifest declares storage, so the page is same-origin
 *   and a permissive CORS header would only let strangers read the ticket —
 *   which here is the ticket that sends a review.
 * - No alias for `kehikot-module-protocol`: resolve it through its exports, as
 *   the host does. The `@` alias points inside this repo, for shadcn.
 * - No `server.port`: `serves()` (first, so it claims before anything else)
 *   decides it from PREFERRED_PORT and keeps the registration true.
 * - No build: the page is generated by the middleware above.
 * - `base: './'`, because a host frames this at whatever address it wrote down.
 */
export default defineConfig({
  base: './',
  plugins: [serves({ id: ID, prefer: PREFERRED_PORT }), doors(), react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
})
