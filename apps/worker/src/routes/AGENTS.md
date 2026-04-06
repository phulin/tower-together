# apps/worker/src/routes

- **towers.ts** — Hono sub-router mounted at `/api`. `POST /towers`: generates an 8-char alphanumeric tower ID, calls `POST /init` on the `TowerRoom` DO, returns `{ towerId, name }`. `GET /towers/:id`: fetches DO info and returns tower metadata.
