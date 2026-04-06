import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { towersRouter } from './routes/towers'
import { TowerRoom } from './durable-objects/TowerRoom'

interface Env {
  TOWER_ROOM: DurableObjectNamespace
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({ origin: '*' }))
app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.route('/api', towersRouter)

// Export the worker. WebSocket upgrades are intercepted before Hono so that
// the cors() middleware cannot modify the 101 response (it strips the special
// `webSocket` property that Cloudflare uses to hand the socket to the client).
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const url = new URL(request.url)
      const match = url.pathname.match(/^\/api\/ws\/([^/]+)$/)
      if (match) {
        const towerId = match[1]
        const stub = env.TOWER_ROOM.get(env.TOWER_ROOM.idFromName(towerId))
        return stub.fetch(request)
      }
    }
    return app.fetch(request, env, ctx)
  },
}

export { TowerRoom }
