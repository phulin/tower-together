# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object (extends `DurableObject<Env>`). One instance per tower. Responsibilities:
  - SQLite-backed persistence via `ctx.storage.sql` (single `tower` table, JSON blob).
  - WebSocket Hibernation API: `ctx.acceptWebSocket(ws)` plus `webSocketMessage`, `webSocketClose`, `webSocketError` class methods.
  - Handles `join_tower` (sends `init_state`, updates presence, starts tick on 0→1 transition), `place_tile`, `remove_tile`, `ping`.
  - 1 Hz tick loop via `setInterval`: increments `simTime`, broadcasts `time_update`, auto-saves every 30 ticks.
  - Stops tick and saves state when last player disconnects.
  - HTTP sub-paths: `POST /init` (initialize new tower), `GET /info` (tower metadata).
