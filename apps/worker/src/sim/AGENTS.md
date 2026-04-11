# sim/ — Pure simulation core

No I/O, no Cloudflare dependencies, no Phaser. Fully unit-testable in Node.

## Files

### `index.ts`
`TowerSim` class — public façade. Exposes `create()`, `fromSnapshot()`, `step()`, `submitCommand()`, `saveState()`.

### `snapshot.ts`
Snapshot creation, migration, hydration, and persistence cloning.

### `time.ts`
`TimeState` + `advanceOneTick()`. Tracks day tick, daypart, day counter, calendar phase, star count, total ticks.

### `world.ts`
Grid constants, `PlacedObjectRecord` layout, `GateFlags`, sidecar record types, `CarrierRecord`, `EventState`, and notification/prompt types.

### `entities.ts`
Entity population rebuild, daily refresh, operational scoring, state machines (office/hotel/condo/parking), venue visits, transport state, and entity cleanup on demolition.

### `entertainment.ts`
Cinema and entertainment link state machines — budget seeding, phase advance, attendance payouts.

### `cathedral.ts`
Cathedral guest entities (families 0x24–0x28) — activation, dispatch, return routing, award path.

### `resources.ts`
Compile-time constants: tile widths/costs/types, family mappings, income/expense tables, route delay constants.

### `ledger.ts`
Three-ledger economy: cash balance, population/income/expense ledgers, expense sweep, 3-day rollover.

### `scheduler.ts`
`SimState` bundle and `runCheckpoints()` — fires all 18 checkpoint bodies at correct `day_tick` values.

### `commands.ts`
`handlePlaceTile()` / `handleRemoveTile()` — validation, mutation, sidecar management, global rebuilds.

### `ring-buffer.ts`
Generic fixed-capacity `RingBuffer<T>`. Used by carrier floor queues.

### `carriers.ts`
Carrier/car state machine — floor-slot mapping, multi-car shafts, queue assignment, tick-level car dispatch.

### `events.ts`
Bomb, fire, random-news, and VIP special visitor event systems.

### `routing.ts`
Special-link rebuilds, walkability flags, transfer-group cache, and route candidate selection.
