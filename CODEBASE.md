# Codebase Overview

Monorepo for a browser-based collaborative SimTower-inspired multiplayer game.

## Packages

### `apps/client`
React 18 + Vite + TypeScript + Phaser 3 frontend. Handles guest login, tower lobby, and the game screen with a Phaser-rendered grid canvas. Communicates with the backend via HTTP (tower create/join) and WebSocket (realtime tile edits + sim clock).

### `apps/worker`
Cloudflare Workers backend using Hono for HTTP routing. One Durable Object (`TowerRoom`) per tower acts as the authoritative game server. The worker entrypoints stay thin by routing DO RPC through shared service helpers, while `TowerRoom` delegates persistence to a repository and socket fanout to a session manager.

The simulation core lives in `apps/worker/src/sim/` (see `sim/AGENTS.md`). It is pure TypeScript with zero I/O or framework dependencies. Wire messages are translated into sim-level commands before they reach `TowerSim`, snapshot migration/defaulting now lives in the sim package rather than the Durable Object, and the sim package now owns the runtime entity table used for Phase 4 hotel/office/condo/commercial behavior.
