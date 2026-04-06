# Collaborative SimTower (1993-inspired) — Comprehensive Design Document

## 1. Executive summary

This document proposes a **browser-first, multiplayer tower-building simulation** inspired by *SimTower*, built with **Phaser.js** on the client and an **authoritative real-time backend** for shared simulation, persistence, and presence-aware time progression.

The primary product goal is to make the game feel **immediate and responsive** even with multiple concurrent players editing the same tower, while keeping infrastructure and code paths simple enough to ship quickly.

### Key product constraint

**Game time advances only when at least one player is logged in to that tower/world.**

That requirement strongly influences the architecture:

* The simulation must run on the server, not the client.
* Presence must be tracked reliably and quickly.
* World time must be pausable/resumable with durable timestamps.
* Reconnects and multiple players joining/leaving cannot corrupt simulation state.

### Recommended stack at a glance

**Frontend**

* **Phaser 3.90** for rendering and game loop in the browser. ([docs.phaser.io](https://docs.phaser.io/api-documentation/api-documentation?utm_source=chatgpt.com))
* **React + Next.js** shell around Phaser for auth flows, menus, dashboards, admin tools, and deployment ergonomics; Phaser maintains the actual gameplay canvas. Phaser provides an official Phaser + Next.js template. ([phaser.io](https://phaser.io/news/2024/03/official-phaser-3-and-nextjs-template?utm_source=chatgpt.com))
* **TypeScript** everywhere.

**Realtime gameplay**

* **Node.js + Colyseus** authoritative multiplayer server for room-based state sync, presence, and matchmaking. Colyseus is specifically designed for authoritative real-time game servers with built-in room abstractions and state synchronization. ([docs.colyseus.io](https://docs.colyseus.io/?utm_source=chatgpt.com))

**Persistent backend**

* **PostgreSQL** as the source of truth for accounts, worlds, buildings, economy snapshots, tasks, and event history.
* **Supabase** for managed Postgres, Auth, Storage, Realtime integrations, database functions, and operational speed. Supabase provides Postgres, Auth, Realtime, Edge Functions, and Row Level Security in one platform. ([supabase.com](https://supabase.com/docs?utm_source=chatgpt.com))

**Low-latency coordination**

* **Redis** for presence heartbeats, world-locking, timer coordination, hot caches, rate limits, and short-lived distributed coordination. Redis sorted sets and TTLs are useful for time-ordered presence/session tracking and expiring liveness keys. ([redis.io](https://redis.io/docs/latest/develop/data-types/sorted-sets/?utm_source=chatgpt.com))

**Infra / deployment**

* **Vercel** or similar for the Next.js web app.
* **Fly.io**, **Railway**, or **Kubernetes** for Colyseus game servers.
* Managed **Redis** (Upstash/Elasticache/Redis Cloud).
* Managed **Supabase** project for Postgres/Auth/Storage.
* **Cloudflare** in front for CDN, static assets, caching, and DDoS protection.

This is the fastest stack to ship while still supporting real multiplayer simulation with good performance.

---

## 2. Product goals and non-goals

## Goals

1. **Multiplayer first**

   * Multiple players can co-build and co-manage the same tower in real time.
   * Every player sees changes quickly and consistently.

2. **Fast UI and backend**

   * Low input-to-visual latency for build placement and camera movement.
   * Small, efficient realtime payloads.
   * Minimal server round trips for common actions.

3. **Persistent worlds**

   * A tower persists across sessions.
   * Simulation state is durable even if servers restart.

4. **Presence-aware simulation**

   * World simulation only progresses while at least one player is online in that world.
   * On rejoin, the system resumes from paused state safely.

5. **Operational simplicity**

   * Keep the first version understandable and maintainable.
   * Use managed services where they reduce ops burden.

## Non-goals for v1

1. Exact reproduction of original SimTower mechanics.
2. Deterministic lockstep networking.
3. Massive shared worlds with hundreds of simultaneous players in one tower.
4. Fully offline-first support.
5. Cross-shard economic simulation.

---

## 3. High-level game design assumptions

Because you said precise mechanics are not the priority yet, this design assumes:

* The game world is a **grid-based vertical tower**.
* Players place rooms/services/transit/infrastructure onto a shared grid.
* The simulation includes periodic updates: people movement, room occupancy, jobs, power/service checks, finances, happiness, queues, and events.
* Many actions are **discrete commands** rather than continuous action gameplay.
* The most important multiplayer property is **authoritative consistency** with a smooth local UI.

That means we can optimize for:

* Command-based networking.
* Region- and entity-based delta synchronization.
* Predictive local feedback where safe.
* Server-side simulation ticks.

---

## 4. Recommended architecture

## 4.1 Overall architecture

```text
Browser Client (Next.js + React + Phaser)
  ├─ Auth/UI shell (React)
  ├─ Game renderer/input (Phaser)
  ├─ REST/HTTP for meta actions
  └─ WebSocket to authoritative game room

Realtime Game Layer (Node.js + Colyseus)
  ├─ Tower room instances
  ├─ Presence tracking
  ├─ Authoritative simulation tick
  ├─ Command validation/execution
  ├─ Delta broadcast to clients
  └─ Snapshot/event write-behind

Persistence Layer
  ├─ Postgres (durable source of truth)
  ├─ Redis (hot ephemeral state)
  └─ Object storage (assets, saves, replays, logs if needed)

Backend Services
  ├─ Auth (Supabase Auth)
  ├─ HTTP API / Edge functions / server actions
  ├─ Admin / analytics pipeline
  └─ Background workers
```

## 4.2 Why this architecture

A collaborative builder-sim needs **two kinds of backend behavior**:

1. **Realtime authoritative simulation**

   * validate player actions
   * resolve conflicts
   * maintain a consistent world
   * broadcast updates immediately

2. **Durable data and product backend**

   * accounts, saves, permissions, analytics, asset metadata, billing/admin

Trying to do both entirely in a generic database-backed web stack produces slow, awkward gameplay. Trying to do everything only in a game server makes product features painful. The split architecture gives the best of both.

---

## 5. Frontend design

## 5.1 Frontend stack

### Recommended

* **Next.js (App Router)**
* **React**
* **TypeScript**
* **Phaser 3.90** embedded inside a React-managed page/app shell. Phaser is a browser-focused HTML5 game framework using Canvas/WebGL. ([docs.phaser.io](https://docs.phaser.io/api-documentation/api-documentation?utm_source=chatgpt.com))
* **Zustand** for lightweight client state outside the Phaser scene
* **TanStack Query** for meta API data fetching/caching
* **Tailwind CSS** for UI shell styling
* **WebSocket client** via Colyseus JS SDK

### Why not pure Phaser-only UI?

Pure Phaser is possible, but React/Next.js dramatically speeds up:

* auth and account pages
* world selection screens
* admin tools
* social/invite UI
* settings
* analytics instrumentation
* SEO/landing pages

Use React for app chrome and Phaser for the actual game canvas.

## 5.2 Client architecture

Split the client into four layers:

### A. App shell

Responsible for:

* authentication
* world list / lobby
* profile/settings
* route transitions
* error boundaries
* patch notes/admin pages

### B. Game runtime shell

Responsible for:

* bootstrapping Phaser
* joining/leaving room
* loading assets
* syncing selected world metadata
* reconnect flow

### C. Phaser scene layer

Responsible for:

* world rendering
* grid overlays
* camera controls
* hover/highlight
* selection boxes
* animation and feedback
* visual entity presentation

### D. Network/state adapter

Responsible for:

* translating WebSocket messages into client-side stores
* command submission
* optimistic UX for safe actions
* reconciliation from authoritative updates

## 5.3 Rendering model

Use **tile/grid-based rendering** with strong culling and chunking.

### Recommended strategies

* Represent the tower as **floor chunks** or **rectangular sectors**.
* Render only visible chunks.
* Use layered containers:

  * background
  * structure/walls
  * rooms
  * transit/elevators/stairs
  * units/occupants
  * overlays (selection, service heatmaps)
  * effects/UI labels
* Pre-bake static chunk textures when possible.
* Keep dynamic agents on separate lightweight layers.

### Why this is fast

A builder sim is typically bottlenecked more by:

* too many display objects
* excessive scene re-layout
* over-broadcasting state

than by raw physics. Minimize live objects and redraw work.

## 5.4 Input and responsiveness

For a fast feel:

* Camera pan/zoom is fully local.
* Hover previews are fully local.
* Build placement preview is local.
* Actual placement is sent as a server command.
* The client may show “pending placement” immediately, then confirm or roll back on server response.

Safe optimistic actions:

* selection
* camera movement
* hover
* tool changes
* blueprint ghost placement

Server-confirmed actions:

* build/demolish
* room upgrades
* economy-impacting actions
* anything with resource costs or permissions

## 5.5 UI performance rules

1. Never rerender the full scene when one room changes.
2. Use chunk-level invalidation.
3. Use texture atlases.
4. Avoid per-entity React components inside the game canvas.
5. Keep the Phaser scene authoritative for visual state; React manages menus and panels.
6. Reduce floating DOM overlays inside gameplay.
7. Batch network-driven visual updates per frame.

---

## 6. Multiplayer networking design

## 6.1 Why Colyseus

Colyseus is a strong fit because it provides:

* **authoritative room-based multiplayer**
* **automatic state synchronization**
* **matchmaking/room lifecycle**
* **Node.js friendliness**
* easy integration with browser clients and game engines. ([docs.colyseus.io](https://docs.colyseus.io/?utm_source=chatgpt.com))

This maps directly to a model where:

* each tower is a **room**
* clients join that room
* the room owns simulation state and the tick loop

## 6.2 Authoritative model

The server is the source of truth for:

* tower structure
* economy
* simulation time
* permissions
* room occupancy / service state
* queued jobs
* NPC state (if included)
* conflict resolution

Clients are responsible for:

* rendering
* local input
* short-lived optimistic visuals
* interpolation/animation

## 6.3 Room topology

### Recommended

* **One tower = one authoritative room instance**

This is the simplest model and matches the pause/resume requirement well.

If a tower becomes too large later:

* keep one logical tower authority
* split internal simulation into subsystems or sectors
* but maintain a single externally visible room/session

## 6.4 Networking protocol

### Client → server commands

Examples:

* `build_place`
* `build_cancel`
* `demolish`
* `set_policy`
* `assign_zone`
* `rename_tower`
* `change_priority`
* `pause_overlay_toggle` (local only, not necessarily authoritative)

### Server → client messages

Examples:

* `state_patch`
* `command_result`
* `presence_update`
* `time_state_update`
* `economy_update`
* `notification`
* `conflict_rejected`

## 6.5 Delta sync strategy

Do **not** broadcast the full world every tick.

Instead broadcast:

* only changed entities/tiles/chunks
* only at a defined network send frequency (for example 5–10 Hz for most sim state)
* immediate important responses for build commands

Use categories of updates:

1. **Critical immediate**

   * build accepted/rejected
   * object removed
   * player joined/left
   * pause/resume transition

2. **Frequent state deltas**

   * room stats changes
   * occupancy changes
   * queue lengths
   * power/service statuses

3. **Low frequency aggregates**

   * finances
   * daily summary stats
   * heatmaps

## 6.6 Conflict resolution

Multiple players may try to edit the same area.

Recommended rule set:

* Server validates every command against the latest tower state.
* First valid command wins.
* Subsequent conflicting commands receive rejection plus refreshed state.
* Optional soft locks for UI friendliness:

  * when a player starts dragging a placement area, broadcast a temporary “editing region” hint
  * do not make it authoritative initially; it is only a collaboration aid

This avoids central locking complexity while preserving consistency.

---

## 7. Presence-aware time progression

This is the most important special requirement.

## 7.1 Core rule

**A tower’s simulation clock advances if and only if at least one authenticated player is currently present in that tower.**

## 7.2 Desired semantics

* If zero players are present, the world is paused.
* If one or more players are present, the world runs.
* If all players disconnect, the world pauses immediately or after a very small grace period.
* When a player rejoins, the world resumes from the same saved state and simulation time.
* No “offline progress” occurs.

## 7.3 Recommended implementation

Each tower maintains:

* `simulation_time` — current in-world simulation timestamp/counter
* `is_running` — boolean
* `last_resume_at_real` — wall-clock timestamp when simulation last resumed
* `last_pause_at_real` — wall-clock timestamp when simulation last paused
* `online_player_count`
* `tick_accumulator_ms`

### On player join

1. Authenticate player.
2. Add presence heartbeat in Redis.
3. Increment `online_player_count` for the tower room.
4. If count transitions from `0 -> 1`:

   * mark `is_running = true`
   * set `last_resume_at_real = now`
   * resume simulation loop
   * persist transition event asynchronously

### On player leave / disconnect

1. Remove connection from room memory.
2. Expire or delete heartbeat.
3. Recompute active presence count.
4. If count transitions from `1 -> 0`:

   * flush final pending simulation updates
   * set `is_running = false`
   * set `last_pause_at_real = now`
   * persist snapshot/checkpoint
   * stop advancing simulation

## 7.4 Why Redis matters here

Socket disconnects are not enough by themselves because browsers crash, mobile tabs sleep, and network partitions happen.

Use Redis for:

* per-connection heartbeat keys with TTL
* optional per-tower sorted set of live sessions
* fast presence count checks
* crash recovery if a room process dies

Redis TTLs let inactive connections age out automatically. Sorted sets are useful when you want ordered or time-scored membership. ([redis.io](https://redis.io/docs/latest/develop/data-types/sorted-sets/?utm_source=chatgpt.com))

## 7.5 Grace period recommendation

Use a **10–20 second disconnect grace window**.

Why:

* avoids pause/resume thrash during brief reconnects
* reduces noisy persistence events
* feels better for players refreshing or switching tabs

Semantics:

* if a player disconnects, keep them “soft present” for a short TTL
* if they reconnect in time, no pause occurs
* if TTL expires and no players remain, pause the world

## 7.6 Tick model

Use a fixed simulation tick on the server, such as:

* **4–10 simulation ticks per second** for builder sim logic
* separate from render framerate

Recommended initial approach:

* simulation tick: **5 Hz**
* broadcast tick: **5 Hz** for standard state deltas
* immediate messages for command acknowledgements

A tower sim usually does not need shooter-grade 30–60 Hz authoritative updates.

## 7.7 Persistence model for pause/resume

When pausing:

* write a snapshot/checkpoint of the tower state
* record the exact `simulation_time`
* record `is_running = false`

When resuming:

* load the latest checkpoint into memory if the room is cold
* resume ticking from the stored `simulation_time`
* do not advance based on real elapsed wall-clock time during offline period

That ensures “no one logged in” means literally “no progress happened.”

---

## 8. Backend and data architecture

## 8.1 Backend split

Use three backend layers:

### Layer A: Realtime game server

**Node.js + Colyseus**

Responsibilities:

* room lifecycle
* simulation tick
* command validation
* state diffs
* presence integration
* write-behind snapshots/events

### Layer B: Durable data/API backend

**Supabase Postgres + Auth + Functions**

Responsibilities:

* users, identities, sessions
* tower metadata
* persistent saves
* invites/permissions
* admin actions
* analytics/event storage
* asset/storage metadata

### Layer C: Hot coordination/cache

**Redis**

Responsibilities:

* presence heartbeats
* distributed locks / leader election if needed
* rate limiting
* ephemeral room metadata
* event fan-out/caches

## 8.2 Why Postgres

Postgres is the right long-term source of truth because a collaborative sim has strongly relational data:

* users
* towers
* memberships
* permissions
* build actions
* snapshots
* economy summaries
* event logs
* achievements
* moderation/admin tables

Also, simulation snapshots and append-only event logs are easy to store/query.

## 8.3 Why Supabase specifically

Supabase accelerates delivery because it bundles:

* managed Postgres
* authentication
* storage
* realtime capabilities
* database functions
* security policies. ([supabase.com](https://supabase.com/docs?utm_source=chatgpt.com))

For a game startup or fast-moving prototype, this removes a large amount of boilerplate.

## 8.4 Recommended persistence strategy

Use **hybrid snapshot + event log**.

### Store in Postgres

1. **Canonical tower metadata**
2. **Periodic tower snapshots**
3. **Important action/event log**
4. **Economy/stat summaries**
5. **Membership/permissions**

### Do not rely on Postgres alone for per-tick state mutation

The game server should keep the active world in memory and write periodically.

### Why hybrid is best

* Snapshots make recovery fast.
* Event logs help debugging, replay, audits, analytics, and potentially future rollback.
* You avoid writing every tiny simulation mutation to SQL in real time.

---

## 9. Data model

Below is a practical initial schema.

## 9.1 Core tables

### `users`

* `id` (uuid, PK)
* `display_name`
* `created_at`
* `last_seen_at`
* auth handled by Supabase Auth user identity mapping

### `towers`

* `id` (uuid, PK)
* `name`
* `owner_user_id`
* `created_at`
* `updated_at`
* `version`
* `status` (`active`, `archived`, etc.)
* `current_snapshot_id` (nullable)
* `simulation_time` (bigint or numeric tick counter)
* `is_running` (bool)
* `last_paused_at`
* `last_resumed_at`

### `tower_members`

* `tower_id`
* `user_id`
* `role` (`owner`, `editor`, `viewer`)
* `joined_at`
* composite PK `(tower_id, user_id)`

### `tower_snapshots`

* `id` (uuid)
* `tower_id`
* `created_at`
* `simulation_time`
* `snapshot_format_version`
* `world_blob` (jsonb or compressed binary/blob reference)
* `checksum`
* `reason` (`autosave`, `pause`, `manual`, `migration`)

### `tower_events`

* `id` (bigserial or uuid)
* `tower_id`
* `simulation_time`
* `created_at`
* `actor_user_id` (nullable for system)
* `event_type`
* `payload` (jsonb)
* indexed by `(tower_id, created_at)` and `(tower_id, simulation_time)`

### `tower_finance_snapshots`

* `id`
* `tower_id`
* `simulation_time`
* `cash`
* `income`
* `expenses`
* `occupancy_rate`
* `summary` (jsonb)

### `tower_presence_sessions`

Optional durable audit table:

* `id`
* `tower_id`
* `user_id`
* `joined_at`
* `left_at`
* `disconnect_reason`

## 9.2 In-memory world representation

Inside the room server, keep a compact authoritative state object:

```ts
interface TowerRoomState {
  towerId: string;
  simTime: number;          // integer tick count
  isRunning: boolean;
  tickRate: number;         // e.g. 5
  dimensions: { floors: number; width: number };
  gridChunks: Map<string, ChunkState>;
  rooms: Map<string, RoomState>;
  transit: Map<string, TransitState>;
  agents: Map<string, AgentState>;
  economy: EconomyState;
  jobs: JobQueueState;
  players: Map<string, ConnectedPlayerState>;
  dirtyChunks: Set<string>;
  dirtyEntities: Set<string>;
}
```

The exact entity model can change later; the principle is more important:

* chunks for structure
* maps for dynamic entities
* dirty sets for efficient broadcasting and persistence

## 9.3 Snapshot format

Recommended:

* store authoritative snapshots as **compressed JSON** initially for speed of development
* optionally move to binary format later if world size grows

For v1:

* use JSON schema versioning
* gzip or zstd compression
* checksum each snapshot

This keeps migrations understandable.

---

## 10. Simulation model

## 10.1 Simulation loop

Run the authoritative simulation only on the game server.

Pseudo-flow:

1. On each fixed tick:

   * if `isRunning == false`, skip
   * advance `simTime += 1`
   * process queued commands
   * update systems in deterministic order
   * mark dirty state
   * periodically broadcast deltas
   * periodically persist snapshot/event summaries

## 10.2 System ordering

Recommended system order per tick:

1. ingest player commands
2. validate structural dependencies
3. update resource/service networks
4. update room operational statuses
5. update transit/elevator scheduling
6. update agents/resident/visitor behaviors
7. update economy/revenue/costs
8. emit notifications/events
9. mark dirty chunks/entities
10. publish deltas

## 10.3 Determinism

Full cross-platform deterministic lockstep is unnecessary.

Instead, target **server-side consistency**:

* only the server mutates canonical state
* clients never simulate authoritative outcomes independently
* the server may use seeded randomness internally if needed for reproducibility/debugging

That is much easier and sufficient here.

---

## 11. API design

## 11.1 HTTP/meta API responsibilities

Use HTTP for non-realtime product functions:

* create tower
* list towers
* invite members
* get profile/settings
* fetch history summaries
* manage saves/admin tools
* patch metadata

These can live in:

* Next.js server actions / route handlers, or
* Supabase Edge Functions, or
* a small dedicated API service

## 11.2 WebSocket responsibilities

Use WebSocket/Colyseus for gameplay:

* join tower room
* presence
* build commands
* command acks
* state deltas
* notifications

## 11.3 Example client command contract

```json
{
  "type": "build_place",
  "clientCommandId": "uuid",
  "payload": {
    "tool": "residential_room",
    "x": 12,
    "y": 44,
    "width": 3,
    "height": 1,
    "rotation": 0
  }
}
```

Response:

```json
{
  "type": "command_result",
  "clientCommandId": "uuid",
  "accepted": true,
  "serverVersion": 1842,
  "affectedChunks": ["4:1"]
}
```

Or rejection:

```json
{
  "type": "command_result",
  "clientCommandId": "uuid",
  "accepted": false,
  "reason": "tile_occupied",
  "serverVersion": 1843
}
```

---

## 12. Performance strategy

Because you prioritized speed in UI and backend, this section is central.

## 12.1 Performance principles

1. **Keep active worlds in memory on the game server.**
2. **Use WebSockets for gameplay, not request/response.**
3. **Send deltas, not full snapshots.**
4. **Use Postgres for durability, not for every simulation mutation.**
5. **Use Redis only for ephemeral hot state.**
6. **Chunk rendering and state updates.**
7. **Avoid giant JSON payloads.**
8. **Separate simulation tick rate from render rate.**

## 12.2 UI speed techniques

* Camera movement is local.
* Preload spritesheets/atlases.
* Use chunked tilemaps or custom chunk renderers.
* Pool frequently created display objects.
* Animate only what matters on screen.
* Keep overlay text minimal.
* Avoid recomputing pathfinding/heatmaps client-side unless purely visual.

## 12.3 Backend speed techniques

* Hold room state entirely in RAM while active.
* Use dirty flags for changed chunks/entities.
* Batch writes to Postgres.
* Coalesce multiple small updates into a single delta packet per broadcast frame.
* Use binary or compact serialization later if needed.
* Use Redis TTL heartbeats instead of frequent SQL writes for presence.

## 12.4 Broadcast strategy

Example:

* Sim tick: 5 Hz
* Broadcast state deltas: 5 Hz
* Economy summaries: 1 Hz
* Presence summaries: on change only
* Notifications: immediate

## 12.5 Persistence cadence

Recommended initial persistence cadence:

* autosave snapshot every **30–60 seconds** while running
* force snapshot on **pause**, **server shutdown**, and **major migrations**
* append important player/system events continuously or in small batches

## 12.6 Serialization options

### v1

* JSON patches / structured deltas
* compressed snapshot blobs

### v2 if needed

* msgpack / protobuf / custom binary payloads

Start with JSON because it is faster for team iteration. Optimize only once payload profiling proves the need.

---

## 13. Scalability strategy

## 13.1 Scale model

This game is more likely to scale by **number of towers** than by huge player counts in one tower.

Therefore optimize for:

* many room instances
* low memory per inactive tower
* efficient warm start from snapshot
* low-cost idle state (paused towers consume almost nothing)

## 13.2 Horizontal scaling

### Web app

Scale statelessly behind CDN/load balancer.

### Game servers

Run multiple Colyseus instances.

Routing rule:

* tower ID maps to an active room instance
* if no active room exists, create one on some server and load snapshot
* when last player leaves and grace period ends, persist and unload room from memory

### Redis role

Redis can help coordinate:

* which process owns which active tower
* active room registry
* presence heartbeat checks
* transient distributed locks

## 13.3 Cold vs warm towers

### Warm tower

* in memory on a game server
* players present or recently disconnected
* fastest interaction

### Cold tower

* no one online
* latest snapshot persisted
* no simulation running
* zero or near-zero compute cost

This model aligns perfectly with your “time only advances if anyone is logged in” rule.

---

## 14. Security and trust model

## 14.1 Never trust the client

The client may suggest:

* building positions
* tool usage
* actions

But the server must validate:

* permissions
* costs
* placement legality
* dependencies
* cooldowns / limits
* world version compatibility

## 14.2 Auth

Use **Supabase Auth** for:

* email/password
* magic link
* OAuth if desired

Supabase Auth integrates with JWT-based authorization and RLS. ([supabase.com](https://supabase.com/auth?utm_source=chatgpt.com))

The realtime game server should verify the auth token on room join.

## 14.3 Authorization

Use both:

* DB-level role/membership checks for meta APIs
* in-room permission checks for live commands

Roles:

* owner
* editor
* viewer

Future:

* limited editor scopes
* guest collaborator sessions

## 14.4 Anti-abuse

Use Redis-backed rate limits for:

* login/join spam
* command floods
* chat or notification spam if included later

Log suspicious command rejection patterns.

---

## 15. Reliability and recovery

## 15.1 Failure scenarios to handle

1. Browser tab closes unexpectedly
2. Mobile browser sleeps
3. WebSocket disconnects and reconnects
4. Game server process dies
5. Redis temporary outage
6. Postgres temporary outage
7. Deployment restarts

## 15.2 Recovery plan

### Client reconnect

* reconnect to the same tower room
* re-authenticate
* receive latest tower snapshot + version + delta backlog if used
* re-enter presence count

### Game server crash

* new room instance loads the latest durable tower snapshot from Postgres
* simulation resumes only if players reconnect/presence exists
* optional replay of recent event log after snapshot if you use write-behind

### Redis outage

* fallback to in-process room presence if possible for currently connected users
* degrade gracefully but preserve authoritative simulation
* restore TTL-based presence when Redis returns

### Postgres outage

* active rooms can continue briefly in memory
* queue write-behind events/snapshots in process or durable queue
* if outage is prolonged, stop accepting destructive commands and surface degraded mode

## 15.3 Save safety

Use:

* snapshot checksum
* snapshot format version
* periodic snapshot validation in background
* staged snapshot write then pointer swap (`current_snapshot_id` update)

Never overwrite the only known good save without a fallback snapshot.

---

## 16. Observability

## 16.1 Metrics to track

### Client

* FPS
* scene object count
* asset load times
* network RTT
* command ack latency
* reconnect count

### Game server

* room count
* active players per room
* sim tick duration
* delta payload size
* broadcast frequency
* command validation latency
* pause/resume transitions
* snapshot write time

### Database

* snapshot table growth
* event ingest rate
* slow queries
* auth errors

## 16.2 Logging

Structured logs for:

* room joins/leaves
* pause/resume transitions
* command rejects
* snapshot writes
* room load/unload
* crashes/recovery

## 16.3 Tracing

Use OpenTelemetry or equivalent across:

* web API
* auth join flow
* room load from DB
* snapshot write path

This will matter quickly once multiplayer bugs appear.

---

## 17. Development workflow

## 17.1 Monorepo recommendation

Use a monorepo:

```text
/apps
  /web           # Next.js + React + Phaser host
  /game-server   # Colyseus authoritative server
/packages
  /shared        # shared types, schemas, constants, command contracts
  /sim-core      # pure simulation systems and state definitions
  /ui            # shared React components if needed
  /config        # tsconfig/eslint/prettier/etc
```

## 17.2 Why monorepo

* shared TypeScript types for commands/state
* consistent linting/build tooling
* easy local dev
* fewer integration mismatches

## 17.3 Local development setup

Run locally:

* Next.js web app
* Colyseus server
* local Postgres (or Supabase local)
* local Redis

Use seeded sample towers for testing.

---

## 18. Testing strategy

## 18.1 Simulation tests

Most important automated tests:

* build placement legality
* resource/service dependency calculations
* economy calculations
* pause/resume behavior
* no-offline-progress guarantee
* snapshot load/save fidelity

## 18.2 Multiplayer tests

* concurrent edit conflict tests
* reconnect tests
* duplicate command handling
* unauthorized command rejection
* room migration/load tests

## 18.3 Performance tests

* tower with large room count
* many agents
* 2, 4, 8, 16 concurrent collaborators
* burst build placement actions
* repeated join/leave churn

## 18.4 Client tests

* scene smoke tests
* UI state tests for menus/panels
* network adapter tests

---

## 19. Versioning and migration strategy

## 19.1 Snapshot versioning

Every snapshot should include:

* `snapshot_format_version`
* optional per-entity version markers

When simulation structure changes:

* migrate older snapshots on load, or
* run offline migration scripts

## 19.2 Command protocol versioning

Include a shared protocol version between client and server. Reject incompatible clients gracefully.

## 19.3 Feature flags

Use feature flags for:

* new simulation systems
* new room types/build tools
* economy tweaks
* experimental UI overlays

---

## 20. Delivery plan

## 20.1 Phase 1 — Playable collaborative foundation

Ship first:

* auth
* create/join tower
* Phaser camera + chunked grid renderer
* authoritative room server
* build/demolish commands
* shared real-time editing
* pause/resume on player presence
* snapshots and reload

Ignore at first:

* fancy NPC behavior
* deep economy
* admin polish

## 20.2 Phase 2 — Core sim loop

Add:

* basic occupancy/jobs/services
* economic summary model
* notifications
* better overlays
* reconnect polish
* analytics dashboards

## 20.3 Phase 3 — Social and scale polish

Add:

* invites/roles
* edit region hints
* replay/history tools
* moderation/admin
* binary delta optimization if needed

---

## 21. Concrete recommendation

If the goal is to move fast **without painting yourself into a corner**, I recommend the following exact stack.

### Frontend

* **Next.js + React + TypeScript**
* **Phaser 3.90** embedded for gameplay rendering. ([docs.phaser.io](https://docs.phaser.io/api-documentation/api-documentation?utm_source=chatgpt.com))
* **Zustand** for lightweight app/game UI state
* **TanStack Query** for HTTP/meta data
* **Tailwind CSS** for shell UI

### Multiplayer server

* **Node.js + TypeScript**
* **Colyseus** for authoritative rooms, syncing, and WebSocket gameplay. ([docs.colyseus.io](https://docs.colyseus.io/?utm_source=chatgpt.com))

### Persistent backend

* **Supabase Postgres** as durable source of truth. ([supabase.com](https://supabase.com/docs?utm_source=chatgpt.com))
* **Supabase Auth** for login/session handling. ([supabase.com](https://supabase.com/auth?utm_source=chatgpt.com))
* **Supabase Storage** for large assets/backups if needed.
* **Supabase Edge Functions** or Next.js route handlers for metadata/admin APIs. Supabase Edge Functions are globally distributed TypeScript functions. ([supabase.com](https://supabase.com/docs/guides/functions?utm_source=chatgpt.com))

### Low-latency ephemeral data

* **Redis** for presence heartbeats, TTL expiry, hot room registry, and rate limits. TTL and sorted-set primitives are useful here. ([redis.io](https://redis.io/docs/latest/develop/data-types/sorted-sets/?utm_source=chatgpt.com))

### Hosting

* **Vercel** for the web app
* **Fly.io** or **Railway** for game servers initially; Kubernetes later only if scale demands it
* Managed **Redis**
* Managed **Supabase**
* **Cloudflare CDN** for assets

### Why this exact combo

It is the best balance of:

* fast iteration
* low-latency multiplayer
* durable persistence
* manageable ops burden
* clear path to scale

---

## 22. Explicit recommendation on the timer rule

Implement the game clock as a **server-owned fixed tick counter** stored per tower.

Do not:

* advance time on clients
* infer progress from wall-clock time after everyone leaves
* rely solely on DB timestamps

Do:

* advance `simTime` only while room presence count > 0
* determine active presence with WebSocket room membership backed by Redis heartbeats and TTL grace
* persist snapshots on pause and regular intervals

That gives you exact control over the rule you care about most.

---

## 23. Final verdict

For a collaborative SimTower-like game where UI speed and backend speed both matter, the strongest v1 architecture is:

* **Phaser.js** for the actual simulation UI/rendering
* **React/Next.js** around it for app/product shell
* **Colyseus** as the authoritative real-time multiplayer game server
* **Supabase Postgres/Auth** for durable backend and rapid product development
* **Redis** for presence, timer coordination, and hot ephemeral state

This is faster and safer than trying to force all multiplayer logic into a generic backend database, and much more product-friendly than building the entire stack as a custom game backend from scratch.

If you want, the next best follow-up is turning this into a **formal engineering RFC** with sections like API contracts, table DDL, room lifecycle pseudocode, and an MVP milestone plan.
