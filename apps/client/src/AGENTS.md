# apps/client/src

React + Phaser frontend source.

## Top-level files

- **main.tsx** — ReactDOM entry point; mounts `<App />` into `#root`.
- **App.tsx** — Top-level screen router. Reads `playerId` from localStorage to decide which screen to show (GuestScreen → LobbyScreen → GameScreen). Manages `towerId` state.
- **types.ts** — Shared TypeScript types: `ServerMessage`, `ClientMessage`, `SelectedTool`, `ConnectionStatus`.

## Subpackages

- **screens/** — Full-page React screen components (GuestScreen, LobbyScreen, GameScreen).
- **game/** — Phaser 3 scene (`GameScene`) and the React wrapper component (`PhaserGame`).
- **lib/** — Utility modules: `socket.ts` (WebSocket client wrapper), `storage.ts` (localStorage helpers + UUID generation).
