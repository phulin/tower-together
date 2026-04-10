# apps/client/src

React + Phaser frontend source.

## Top-level files

- **main.tsx** — ReactDOM entry point; mounts `<App />` into `#root`.
- **App.tsx** — Top-level screen router and app-flow controller. Reads stored player identity, owns the singleton `TowerSocket` instance for the current browser tab, centralizes URL slug resolution plus enter/leave tower transitions, and decides whether to show GuestScreen, LobbyScreen, or GameScreen.
- **types.ts** — Client-side wire types plus re-exported simulation constants (`GRID_*`, `UNDERGROUND_*`, `TILE_WIDTHS`, `TILE_COSTS`) sourced from the worker sim modules so placement UI uses the same facility widths and costs as the server. VIP room variants are no longer player-facing tool types.

## Subpackages

- **screens/** — Full-page React screen components (GuestScreen, LobbyScreen, GameScreen).
- **game/** — Phaser 3 scene (`GameScene`) and the React wrapper component (`PhaserGame`).
- **lib/** — Utility modules: `socket.ts` (`TowerSocket` instance class with reconnect logic), `storage.ts` (localStorage helpers + UUID generation).
