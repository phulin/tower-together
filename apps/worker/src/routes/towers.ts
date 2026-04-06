import { Hono } from 'hono'

interface Env {
  TOWER_ROOM: DurableObjectNamespace
}

export const towersRouter = new Hono<{ Bindings: Env }>()

function generateTowerId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

// POST /api/towers - create a new tower
towersRouter.post('/towers', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name ?? 'My Tower'
  const towerId = generateTowerId()

  const id = c.env.TOWER_ROOM.idFromName(towerId)
  const stub = c.env.TOWER_ROOM.get(id)

  const initUrl = new URL('http://do/init')
  initUrl.searchParams.set('towerId', towerId)
  initUrl.searchParams.set('name', name)

  const res = await stub.fetch(initUrl.toString(), { method: 'POST' })
  if (!res.ok) {
    const err = await res.json<{ error: string }>()
    return c.json({ error: err.error ?? 'Failed to initialize tower' }, 500)
  }

  return c.json({ towerId, name }, 201)
})

// GET /api/towers/:id - get tower info
towersRouter.get('/towers/:id', async (c) => {
  const towerId = c.req.param('id')

  const id = c.env.TOWER_ROOM.idFromName(towerId)
  const stub = c.env.TOWER_ROOM.get(id)

  const res = await stub.fetch('http://do/info')
  if (!res.ok) {
    const err = await res.json<{ error: string }>()
    return c.json({ error: err.error ?? 'Tower not found' }, res.status as 404 | 500)
  }

  const info = await res.json()
  return c.json(info)
})
