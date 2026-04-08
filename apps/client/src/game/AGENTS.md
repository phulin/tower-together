# apps/client/src/game

Phaser 3 game rendering layer.

- **GameScene.ts** — Phaser `Scene` subclass. Renders the tower grid with tall cells (`4 px` wide × `16 px` tall) so facilities display at the intended `4:1` height:width ratio. Uses shared `TILE_WIDTHS` for hover/placement previews, merged floor/lobby row rendering, and multi-cell facility drawing. Supports camera pan (middle/right mouse drag) and zoom (scroll wheel). Exposes `applyInitState(cells)` and `applyPatch(cells)` for applying server state, and `setOnCellClick(handler)` so `GameScreen` can inject the click dispatcher.
- **PhaserGame.tsx** — React component that creates and destroys the `Phaser.Game` instance. Receives `onCellClick` and `sceneRef` as props; wires the click callback into the scene whenever it changes.
