# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object (extends `DurableObject<Env>`). One instance per tower. Responsibilities:
  - SQLite-backed persistence via `ctx.storage.sql` (single `tower` table, JSON blob).
  - WebSocket Hibernation API: `ctx.acceptWebSocket(ws)` plus `webSocketMessage`, `webSocketClose`, `webSocketError` class methods.
  - Handles `join_tower` (sends `init_state` with cash, updates presence, starts tick on 0→1 transition), `place_tile` (multi-tile, cost deduction), `remove_tile` (anchor resolution for multi-tile objects), `ping`.
  - Multi-tile support: `cells` stores the tile type in every occupied cell; `cellToAnchor` maps extension cell keys to their anchor key. Placement validates all footprint cells are empty and funds are sufficient.
  - 1 Hz tick loop: increments `simTime`, broadcasts `time_update`. Every `TICKS_PER_DAY` (24) ticks, counts hotel anchor cells and broadcasts `economy_update` with new cash. Auto-saves every 30 ticks.
  - Stops tick and saves state when last player disconnects.
  - HTTP sub-paths: `POST /init` (initialize new tower), `GET /info` (tower metadata).
