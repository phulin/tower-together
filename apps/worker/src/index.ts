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

// WebSocket upgrade endpoint — forward to the Durable Object
app.get('/api/ws/:towerId', async (c) => {
  const towerId = c.req.param('towerId')
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }
  const id = c.env.TOWER_ROOM.idFromName(towerId)
  const stub = c.env.TOWER_ROOM.get(id)
  return stub.fetch(c.req.raw)
})

export default app
export { TowerRoom }
