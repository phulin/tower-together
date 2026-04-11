# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen composition root. Owns view state (selected tool, toasts) and renders toolbar, HUD, and subcomponents.
- **useTowerSession.ts** — React hook for the active tower session. Subscribes to `TowerSocket`, manages sim state, and exposes command helpers.
- **gameScreenStyles.ts** — Shared inline style registry used by the extracted game-screen presentation components.
- **gameScreenTypes.ts** — Shared local screen types for toasts, prompts, and inspected-cell payloads.
- **GameToolbar.tsx** — Extracted top toolbar for tower rename, tool selection, cash/day/player display, and leave action.
- **GameDebugPanel.tsx** — Extracted top-right HUD for simulation/debug counters and speed controls.
- **GamePromptModal.tsx** — Extracted modal for server-driven prompt decisions such as bomb/fire events.
- **CellInspectionDialog.tsx** — Extracted inspection dialog for room/elevator metadata plus rent and car-count controls.
- **GameToasts.tsx** — Extracted toast stack renderer for transient info/error messages.
- **GameStatusBar.tsx** — Extracted connection/tower status footer with reconnect action.
