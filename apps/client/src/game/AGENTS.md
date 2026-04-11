# apps/client/src/game

Phaser 3 game rendering layer.

- **GameScene.ts** — Main Phaser `Scene`. Renders tower grid, entities, elevator cars; exposes `apply*` methods for state updates from `GameScreen`.
- **PhaserGame.tsx** — React wrapper that creates/destroys the `Phaser.Game` instance.
- **gameSceneConstants.ts** — Shared tile dimensions, colors, label maps, zoom bounds.
- **gameScenePlacement.ts** — Placement preview and shift-fill helpers for the selected tool.
- **gameSceneTransport.ts** — Snapshot timing, car interpolation, and queue positioning helpers.
- **clouds.ts** — Drifting cloud sprite pool in the sky band above the tower.
- **transportSelectors.ts** — Transport selectors/counters shared between the React HUD and Phaser scene.
