# apps/client/src/game

Phaser 3 game rendering layer.

- **GameScene.ts** — Phaser `Scene` subclass. Renders a 64×80 cell grid at 16 px/cell using three `Graphics` layers (cells, grid lines, hover highlight). Supports camera pan (middle/right mouse drag) and zoom (scroll wheel). Exposes `applyInitState(cells)` and `applyPatch(cells)` for applying server state, and `setOnCellClick(handler)` so `GameScreen` can inject the click dispatcher.
- **PhaserGame.tsx** — React component that creates and destroys the `Phaser.Game` instance. Receives `onCellClick` and `sceneRef` as props; wires the click callback into the scene whenever it changes.
