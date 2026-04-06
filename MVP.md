# Collaborative SimTower-Inspired Game — MVP

## Goal

Ship the **smallest playable multiplayer version** of a browser-based, SimTower-inspired building game where multiple players can edit the same tower in real time.

This MVP is intentionally constrained to prove only the core loop:

* players can log in
* players can join the same tower
* players can place and remove basic structures on a shared grid
* all connected players see updates live
* the **game timer advances only while at least one player is connected**
* the world persists between sessions

This version explicitly avoids extra infrastructure such as Redis, Postgres, or a separate room server fleet.

---

## Product constraints

### Required

* Multiplayer shared tower
* Browser-based client
* Fast-feeling UI
* Simple authoritative backend
* Durable persistence
* Presence-based simulation timer

### Explicitly out of scope for MVP

* Deep economy simulation
* NPC pathfinding
* elevators with detailed routing
* player chat
* permissions/roles beyond basic ownership or open access
* advanced analytics
* admin tools
* background jobs
* offline progress
* Redis
* Postgres
* Kubernetes
* Next.js

---

## Recommended MVP stack

### Frontend

* **React**
* **Vite**
* **TypeScript**
* **Phaser 3** for game rendering

### Backend

* **Cloudflare Workers**
* **Hono** for HTTP routing and lightweight API structure
* **Cloudflare Durable Objects** for authoritative per-tower synchronization and realtime state

### Persistence

* **SQLite-backed Durable Object storage** for each tower/world

### Auth

* **Simple MVP auth**, one of these two choices:

  1. **Guest sessions** with generated player IDs stored in localStorage
  2. **Cloudflare Access or third-party auth later**, but not required for first playable MVP

For the true minimum viable build, use **guest sessions first**.

---

## Why this stack

This stack keeps everything small and fast:

* **React + Vite** gives fast local development and a lightweight frontend build setup. Vite is designed as a fast frontend toolchain and currently targets modern browsers by default. ([vite.dev](https://vite.dev/guide/?utm_source=chatgpt.com))
* **Phaser 3** handles the simulation canvas, camera, tile/grid rendering, and interaction model.
* **Hono** is a good fit on Workers because it is lightweight and built for web-standard runtimes including Cloudflare Workers. ([hono.dev](https://hono.dev/docs/guides/best-practices?utm_source=chatgpt.com))
* **Durable Objects** are specifically intended for stateful coordination, collaborative applications, realtime interactions, and multiplayer-style synchronization. ([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/?utm_source=chatgpt.com))
* **SQLite-backed Durable Objects** are currently the recommended storage backend for new Durable Object classes and provide durable per-object storage with SQL support. ([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/?utm_source=chatgpt.com))

This avoids running:

* a separate websocket cluster
* Redis for presence
* a separate database for world state

---

## MVP architecture

```text
React + Vite + Phaser client
  ├─ Login / guest entry screen
  ├─ Tower selection / create tower
  ├─ Phaser game canvas
  └─ WebSocket connection to Cloudflare Durable Object

Cloudflare Worker + Hono
  ├─ HTTP routes for tower discovery / bootstrap
  ├─ WebSocket upgrade endpoint
  └─ Durable Object lookup by tower ID

Tower Durable Object (1 tower = 1 DO)
  ├─ authoritative tower state
  ├─ connected player sessions
  ├─ simulation timer
  ├─ command validation
  ├─ state broadcast to clients
  └─ durable save to SQLite-backed DO storage
```

### Core principle

**One tower equals one Durable Object instance.**

That Durable Object is the single authority for:

* the shared map/grid
* connected players
* timer state
* build/remove actions
* persistence

This is the cleanest possible synchronization model for the MVP.

---

## MVP gameplay scope

## What players can do

1. Open the game in a browser
2. Enter as a guest
3. Create a tower or join an existing tower by ID
4. Pan and zoom around the tower
5. Select one of a few build tools
6. Place tiles/rooms on the tower grid
7. Remove placed tiles/rooms
8. See other players’ edits in real time
9. Watch the tower’s simulation time advance while anyone is connected

## What the simulation does

For MVP, the simulation should be intentionally minimal.

Include only:

* a global simulation clock
* optional per-room simple state such as:

  * built at time
  * active/inactive
  * simple occupancy count placeholder

Do **not** implement full tenant simulation yet.

The timer is the important proof:

* if any player is connected, `simTime` increments
* if all players disconnect, `simTime` stops
* when someone rejoins later, `simTime` resumes from the saved value

---

## World model

## Grid

Use a simple 2D grid representing floors and horizontal tower width.

Example:

* width: 64 cells
* height: 80 cells

Each cell can be:

* empty
* floor
* room
* elevator shaft placeholder
* stairs placeholder

For the MVP, it is enough to support just:

* `empty`
* `floor`
* `room_basic`

Everything else can come later.

## Building rules

Keep rules simple:

* rooms can only be placed on valid grid cells
* a placement cannot overlap an occupied cell
* removing clears occupied cells

Optional rule for MVP:

* rooms must touch a floor tile

But even that can be deferred if it slows down implementation.

---

## Realtime synchronization model

## Transport

Use **WebSockets** between the browser and the tower Durable Object.

Cloudflare Durable Objects support WebSockets directly, and the hibernation-oriented WebSocket API is the recommended option for many realtime use cases. ([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/best-practices/websockets/?utm_source=chatgpt.com))

## Authority model

The Durable Object is authoritative.

Clients may:

* send placement/removal commands
* render local hover previews
* animate updates

Clients may not:

* decide whether a placement is valid
* advance the timer
* mutate canonical world state directly

## Command flow

### Client -> server

* `join_tower`
* `place_tile`
* `remove_tile`
* `ping`

### Server -> client

* `init_state`
* `state_patch`
* `command_result`
* `presence_update`
* `time_update`

### Example command

```json
{
  "type": "place_tile",
  "payload": {
    "x": 12,
    "y": 40,
    "tileType": "room_basic"
  }
}
```

### Example response

```json
{
  "type": "command_result",
  "accepted": true,
  "patch": {
    "cells": [
      { "x": 12, "y": 40, "tileType": "room_basic" }
    ]
  }
}
```

---

## Timer behavior

This is the only non-negotiable game rule in the MVP.

## Rule

**The game timer advances only while one or more players are connected to the tower Durable Object.**

## Implementation

Each tower Durable Object stores:

* `simTime`
* `isRunning`
* `connectedPlayers`
* `lastSavedAt`
* `worldState`

### On first player connect

* add connection to `connectedPlayers`
* if player count changes from 0 to 1:

  * set `isRunning = true`
  * start or resume the simulation interval

### On additional player connect

* add connection
* send current full state

### On player disconnect

* remove connection
* if player count becomes 0:

  * set `isRunning = false`
  * stop advancing `simTime`
  * persist world state to DO storage

### Tick loop

* run a very simple interval, e.g. once per second
* if `isRunning`, increment `simTime += 1`
* broadcast `time_update`
* periodically persist state

For MVP, a **1 Hz tick** is enough.

---

## Persistence model

## Storage choice

Use **SQLite-backed Durable Object storage**.

Cloudflare currently recommends SQLite-backed Durable Objects for new DO classes, and Durable Objects should persist important state because in-memory state can be lost when objects are evicted or restarted. ([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/?utm_source=chatgpt.com))

## What to store

Persist:

* tower ID
* tower name
* `simTime`
* full grid state
* minimal metadata like created time / updated time

## Save strategy

For MVP, use a simple approach:

* save on every accepted build/remove command
* save when last player disconnects
* optionally save every 30 seconds while running

Because the world is small, writing the whole world blob each time is acceptable for v1.

## Storage format

Store the world as:

* either a single JSON blob
* or a small SQLite table of cells

For MVP, a **single JSON blob** is simplest.

Example:

```ts
interface TowerSave {
  towerId: string
  name: string
  simTime: number
  width: number
  height: number
  cells: Array<{ x: number; y: number; tileType: string }>
  updatedAt: number
}
```

---

## Frontend MVP design

## App structure

### React app routes/screens

* landing screen
* guest login screen
* create or join tower screen
* game screen

### Phaser responsibilities

* render the tower grid
* camera pan/zoom
* hover highlight
* placement preview
* click handling
* visual updates from patches

### React responsibilities

* menus
* selected build tool
* tower ID / session display
* reconnect UI
* top-level app state

## Client state

Keep it very light:

* `playerId`
* `towerId`
* `selectedTool`
* `connectionStatus`
* `simTime`
* local copy of visible tower state

A small local state library like Zustand is optional, but plain React state is enough for MVP.

---

## API surface

Use Hono for small bootstrap endpoints.

### HTTP routes

* `POST /api/towers` → create tower
* `GET /api/towers/:id` → fetch tower metadata for initial load
* `GET /api/health` → health check
* `GET /api/ws/:towerId` → websocket upgrade into tower Durable Object

Hono is a good fit here because the HTTP layer is tiny; the real game logic lives in the Durable Object.

---

## Data structures

## Durable Object in-memory state

```ts
interface TowerRuntimeState {
  towerId: string
  name: string
  simTime: number
  isRunning: boolean
  width: number
  height: number
  cells: Record<string, string>
  sockets: Map<string, WebSocket>
}
```

Where cell keys are simple:

* `"12,40" -> "room_basic"`

This is enough for MVP.

---

## Validation rules

Keep validation minimal:

* coordinates must be inside bounds
* cell must be empty before placement
* cell must exist before removal
* tile type must be recognized

Do not add complex adjacency or economy validation yet unless it is trivial.

---

## Performance strategy

## Frontend

* render only visible grid area if possible
* keep art simple
* use local hover previews instead of round-tripping to server
* avoid DOM-heavy overlays

## Backend

* one authoritative object per tower
* full world state small enough to keep in memory
* send small patches instead of full state after every edit
* save the whole world blob because the world is small

## Why this is fast enough

The MVP does not need high-frequency action-game networking.
A builder with discrete placement commands works well with:

* a small world
* small patch messages
* 1 Hz sim time updates
* immediate command responses

Cloudflare Durable Objects can coordinate multiple realtime clients in one instance and support WebSockets directly. ([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/?utm_source=chatgpt.com))

---

## Known limitations of the MVP

1. **No Redis presence layer**

   * Presence is purely “who currently has an attached socket in the tower DO”.
   * This is acceptable for MVP.

2. **No Postgres**

   * Querying historical analytics and richer account systems will be limited.

3. **Single-object world authority**

   * Good for one tower, but not intended for huge simulations yet.

4. **Whole-world saves**

   * Fine for small towers, not ideal forever.

5. **Guest auth only**

   * Fastest way to prove the core multiplayer loop.

---

## MVP milestone plan

## Milestone 1 — Local single-player prototype

* React + Vite app bootstrapped
* Phaser renders grid
* place/remove tile locally
* local `simTime` display

## Milestone 2 — Authoritative tower Durable Object

* create tower endpoint
* websocket join
* DO stores world state in memory
* client receives full initial state
* place/remove commands validated by DO

## Milestone 3 — Multiplayer synchronization

* two clients see the same edits
* command results and patches broadcast
* connection count tracked in DO

## Milestone 4 — Timer rule

* `simTime` advances only when at least one client is connected
* disconnecting last client pauses time
* reconnect resumes from saved time

## Milestone 5 — Persistence

* tower state stored in SQLite-backed DO storage
* tower reload works after object restart/reconnect

At that point, the MVP is done.

---

## Suggested folder structure

```text
/apps
  /client
    /src
      /components
      /game
      /routes
      /lib
  /worker
    /src
      /index.ts
      /routes
      /durable-objects
        /TowerRoom.ts
      /types
```

---

## Final recommendation

The minimum viable version should be:

* **React + Vite + TypeScript** frontend
* **Phaser** for rendering the tower
* **Hono on Cloudflare Workers** for bootstrap APIs
* **One Cloudflare Durable Object per tower** for authoritative synchronization
* **SQLite-backed Durable Object storage** for persistence
* **Guest login only**
* **1 Hz simulation clock**
* **Only place/remove/basic shared world editing**

That is the smallest architecture that still honestly proves the product idea:
**a persistent collaborative tower where time only moves while someone is present.**
