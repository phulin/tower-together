# Codebase Overview

Monorepo for a browser-based collaborative SimTower-inspired multiplayer game.

## Packages

### `apps/client`
React 18 + Vite + TypeScript + Phaser 3 frontend. Handles guest login, tower lobby, and the game screen with a Phaser-rendered grid canvas. Communicates with the backend via HTTP (tower create/join) and WebSocket (realtime tile edits + sim clock).

### `apps/worker`
Cloudflare Workers backend using Hono for HTTP routing. One Durable Object (`TowerRoom`) per tower acts as the authoritative game server: validates commands, manages the 1 Hz sim clock, broadcasts state patches to all connected WebSocket clients, and persists world state to SQLite-backed DO storage.
