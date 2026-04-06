# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen. Owns WebSocket lifecycle (`TowerSocket`), tool selection state, simTime/playerCount display, and the Phaser canvas via `PhaserGame`. Dispatches `place_tile`/`remove_tile` commands on cell click.
