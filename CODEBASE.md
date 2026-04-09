# Codebase Overview

Monorepo for a browser-based collaborative SimTower-inspired multiplayer game.

## Packages

### `apps/client`
React 18 + Vite + TypeScript + Phaser 3 frontend. Handles guest login, tower lobby, and the game screen with a Phaser-rendered grid canvas. Communicates with the backend via HTTP (tower create/join) and WebSocket (realtime tile edits + sim clock).

### `apps/worker`
Cloudflare Workers backend using Hono for HTTP routing. One Durable Object (`TowerRoom`) per tower acts as the authoritative game server. The worker entrypoints stay thin by routing DO RPC through shared service helpers, while `TowerRoom` delegates persistence to a repository and socket fanout to a session manager.

The simulation core lives in `apps/worker/src/sim/` (see `sim/AGENTS.md`). It is pure TypeScript with zero I/O or framework dependencies. Wire messages are translated into sim-level commands before they reach `TowerSim`, snapshot migration/defaulting now lives in the sim package rather than the Durable Object, and the sim package now owns the runtime entity table used for Phase 4 hotel/office/condo/commercial behavior plus the evolving spec-driven elevator/carrier runtime, including the recovered split between raw stairs/escalator special-link segments and derived lobby/sky-lobby transfer records, explicit transfer-concourse routing, mode-aware elevator overlays (`standard` / `express` / `service`) with single-mode shaft enforcement, shared carrier served-floor logic between routing and queueing, carrier-side operating expenses, multi-car shaft state, in-car active route slots, immediate arrival dispatch back into entity family handlers, and same-floor route success handling where the binary would treat transport as an immediate arrival.
