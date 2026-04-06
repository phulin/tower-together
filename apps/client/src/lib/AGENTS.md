# apps/client/src/lib

Client utility modules.

- **socket.ts** — `TowerSocket` class. Wraps a native `WebSocket`, derives the correct `ws://`/`wss://` URL (dev port 5173 → `localhost:8787`), and exposes `send(msg)`, `reconnect()`, and `destroy()`. Invokes `onMessage` and `onStatus` callbacks provided by `GameScreen`.
- **storage.ts** — localStorage helpers: `savePlayer`, `getPlayer`, `clearPlayer`, `addRecentTower`, `getRecentTowers`, `generateUUID`.
