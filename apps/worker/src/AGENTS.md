# apps/worker/src

Cloudflare Workers backend source.

## Top-level files

- **index.ts** — Main worker entry. Mounts Hono app with CORS, health check (`GET /api/health`), tower HTTP routes, and the WebSocket upgrade handler (`GET /api/ws/:towerId` → forwards request to `TowerRoom` DO).
- **types.ts** — Shared types and game constants: `TowerSave`, `TowerRuntimeState`, `ClientMessage`/`ServerMessage` unions, `TILE_WIDTHS`, `TILE_COSTS`, `HOTEL_DAILY_INCOME`, `VALID_TILE_TYPES`, `TICKS_PER_DAY`, `STARTING_CASH`.

## Subpackages

- **durable-objects/** — `TowerRoom` Durable Object: authoritative per-tower game state, WebSocket handling, sim clock, SQLite persistence.
- **routes/** — Hono sub-router for tower HTTP endpoints (create, get info).
