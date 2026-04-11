# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object, one per tower. Coordinates WebSocket sessions, sim ticking, and HTTP sub-paths.
- **TowerRoomRepository.ts** — SQLite-backed persistence for tower room snapshots.
- **TowerRoomSessions.ts** — In-memory session registry and broadcast helper for connected sockets.
