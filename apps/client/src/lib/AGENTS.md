# apps/client/src/lib

Client utility modules.

- **socket.ts** — `TowerSocket` class. Wraps a native `WebSocket`, owns reconnect/ping timers and listener sets per instance, derives the correct `ws://`/`wss://` URL, and exposes `connect()`, `disconnect()`, `send()`, `reconnect()`, `getStatus()`, `onMessage()`, and `onStatus()` so `App` can own socket lifecycle explicitly instead of relying on module-global state.
- **storage.ts** — localStorage helpers: `savePlayer`, `getPlayer`, `clearPlayer`, `addRecentTower`, `getRecentTowers`, `generateUUID`.
