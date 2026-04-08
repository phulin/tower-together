# Codebase Overview

Monorepo for a browser-based collaborative SimTower-inspired multiplayer game.

## Packages

### `apps/client`
React 18 + Vite + TypeScript + Phaser 3 frontend. Handles guest login, tower lobby, and the game screen with a Phaser-rendered grid canvas. Communicates with the backend via HTTP (tower create/join) and WebSocket (realtime tile edits + sim clock).

### `apps/worker`
Cloudflare Workers backend using Hono for HTTP routing. One Durable Object (`TowerRoom`) per tower acts as the authoritative game server: validates commands, manages the 1 Hz sim clock, broadcasts state patches to all connected WebSocket clients, and persists world state to SQLite-backed DO storage.

The simulation core lives in `apps/worker/src/sim/` (see `sim/AGENTS.md`). It is pure TypeScript with zero I/O or framework dependencies. `TowerRoom` is thin glue that feeds WebSocket commands into `TowerSim` and fans patches back out.
