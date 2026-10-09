import { EventEmitter } from 'node:events'

import { doorsHandler, type DoorsOptions } from 'kehikot-module-protocol/serve'

/**
 * One request through the protocol's `doorsHandler`, exactly as `vite.config.ts` mounts it — so a
 * test can say which HEADER a write carried, which calling `answer` directly cannot: there the
 * ticket is already an argument and the header's name is never read.
 */
export interface Sent {
  status: number
  headers: Record<string, string>
  text: string
  /** True when the doors handed the request on to Vite rather than answering it. */
  passed: boolean
  json: () => Record<string, unknown>
}

export function through(
  options: DoorsOptions,
  method: string,
  url: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Sent> {
  const handler = doorsHandler(options, async (html) => html)
  const request = Object.assign(new EventEmitter(), { method, url, headers, resume() {} })
  return new Promise<Sent>((resolve) => {
    const chunks: string[] = []
    const sent: Record<string, string> = {}
    const finish = (status: number, passed: boolean) => {
      const text = chunks.join('')
      resolve({ status, headers: sent, text, passed, json: () => JSON.parse(text) as Record<string, unknown> })
    }
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => void (sent[name.toLowerCase()] = value),
      write: (chunk: string) => void chunks.push(String(chunk)),
      end(chunk?: string | Uint8Array) {
        if (chunk !== undefined) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        finish(this.statusCode, false)
      },
    }
    handler(request as never, response, () => finish(0, true))
    queueMicrotask(() => {
      if (body !== undefined) request.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      request.emit('end')
    })
  })
}
