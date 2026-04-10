# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen composition root. Owns local view state such as selected tool, alias-edit form state, and toast queue, receives an app-owned `TowerSocket` instance from `App`, and delegates tower session/socket state to `useTowerSession.ts` while rendering smaller presentational subcomponents for the toolbar, debug HUD, prompts, inspection dialog, toasts, and status bar.
- **useTowerSession.ts** — React hook for the active tower session. Subscribes to the injected `TowerSocket` instance, updates scene snapshots/presentation clock, stores session-facing UI state (cash, sim time, prompts, inspected cell, entities/carriers), and exposes command helpers back to `GameScreen`.
- **gameScreenStyles.ts** — Shared inline style registry used by the extracted game-screen presentation components.
- **gameScreenTypes.ts** — Shared local screen types for toasts, prompts, and inspected-cell payloads.
- **GameToolbar.tsx** — Extracted top toolbar for tower rename, tool selection, cash/day/player display, and leave action.
- **GameDebugPanel.tsx** — Extracted top-right HUD for simulation/debug counters and speed controls.
- **GamePromptModal.tsx** — Extracted modal for server-driven prompt decisions such as bomb/fire events.
- **CellInspectionDialog.tsx** — Extracted inspection dialog for room/elevator metadata plus rent and car-count controls.
- **GameToasts.tsx** — Extracted toast stack renderer for transient info/error messages.
- **GameStatusBar.tsx** — Extracted connection/tower status footer with reconnect action.
