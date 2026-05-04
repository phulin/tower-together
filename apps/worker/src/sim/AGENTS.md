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

### `recycling.ts`
Recycling-center checkpoint state: daily duty-tier reset, adequacy calculation, and upper/lower slice unit-status updates.

### `entertainment.ts`
Cinema and entertainment link state machines — budget seeding, phase advance, attendance payouts.

### `cathedral.ts`
Cathedral guest sims (families 0x24–0x28) — activation, dispatch, return routing, award path.

### `progression.ts`
Per-tick star-advancement check (`tryAdvanceStarCount`) plus `addToPopulationBucket` helper — tier-from-ledger uses `world.currentPopulation` (binary g_primary_family_ledger_total). Fired at the top of `carrierTick`, mirroring binary FUN_1098_03ab.

### `resources.ts`
Compile-time constants: tile widths/costs/types, family mappings including metro stack rows, binary-aligned build-menu star requirements, income/expense tables, route delay constants.

### `ledger.ts`
Three-ledger economy: cash balance, population/income/expense ledgers, expense sweep, 3-day rollover.

### `scheduler.ts`
Re-export shim: `SimState` bundle, `runCheckpoints()`, and `runSimulationDayScheduler()` now live in `tick/day-scheduler.ts`.

### `commands.ts`
`handlePlaceTile()` / `handleRemoveTile()` — validation (including star-tier build unlocks and the singleton three-row metro stack), mutation, sidecar management, global rebuilds. Also: elevator config commands — `handleSetElevatorDwellDelay`, `handleSetElevatorWaitingCarResponse`, `handleSetElevatorHomeFloor`, `handleToggleElevatorFloorStop` — and `handleSetCinemaMoviePool` (cycles cinema selector within classic/new pool, charges $150k/$300k, resets `linkAgeCounter`).

### `ring-buffer.ts`
Legacy generic `RingBuffer<T>`. Kept for backwards compat with old snapshot payloads; carrier floor queues now use `queue/route-record.RouteRequestRing` (fixed size 40, wraps silently on 41st enqueue).

### `carriers.ts`
Carrier module hub — constructors (`makeCarrier`/`makeCarrierCar`), world-level lifecycle (`rebuildCarrierList`, `initCarrierState`, `flushCarriersEndOfDay`), the `tickAllCarriers` back-compat wrapper, and re-exports of the per-car state machine (`carriers/*.ts`) and queue ops (`queue/*.ts`). `enqueueCarrierRoute` / `evictCarrierRoute` are aliases over the queue's `enqueueRequestIntoRouteQueue` / `cancelRuntimeRouteRequest`. Phase 7: `tickAllCarriers` no longer takes `onArrival`/`onBoarding` callbacks — arrival and boarding dispatch run inline inside the queue module.

### `events.ts`
Bomb, fire, random-news, and metro-driven VIP special visitor event systems.

### `sim.test.ts`
Broad unit coverage for simulation commands, family behaviors, routing, carriers, and event/economy edge cases.

### `carriers.test.ts`
Regression coverage for carrier lifecycle quirks that are easier to pin with small unit tests than full trace fixtures.

### `commands.test.ts`
Unit tests for `handlePlaceTile` placement rules, including elevator shaft spacing and metro stack behavior.

### `trace.test.ts`
Fixture-driven parity suite that builds towers from JSON specs and checks scalar fields, sim populations, sim states, RNG deltas, carriers, and cash against reference JSONL traces.

### `determinism.test.ts`
Hydration/idempotence and server-vs-client lockstep determinism checks over fixture-built towers, including mixed entertainment fixtures.

## Subpackages

### `sims/`
Runtime sims facade, split facility helpers, shared state/constants, population helpers, scoring, trip counters, parking, and family-specific state machines.

### `tick/`
Per-tick orchestration split out to mirror the binary call graph. Files: `service-idle-tasks.ts` (1268:01a6), `day-scheduler.ts` (1208:0196), `carrier-tick.ts` (1098:03ab).

### `carriers/`
Per-car state machine (binary segment 1098) split one-function-per-file. Covers `advance`, `position`, `target`, `motion`, `depart`, `assign`, `arrival`, `pending`, `slot`, plus derived-state sync helpers in `sync.ts`.

### `queue/`
Route queue subsystem (binary segment 1218) split one-function-per-file. Covers enqueue/dequeue, arrival dispatch, queue-drain + boarding, cancel, slot ops, encoded-target decode, and `resolveSimRouteBetweenFloors`. Hosts `RouteRequestRing` (fixed size 40 with silent head-overwrite on 41st enqueue).

### `reachability/`
Reachability rebuild + mask/span tests (binary segment 11b8) split one-function-per-file.

### `route-scoring/`
Route candidate scorers and `selectBestRouteCandidate` (binary segment 11b8) split one-function-per-file, plus parity-based per-stop delay table.

### `families/`
Per-family sim state handlers (binary segment 1228, §3.5) with binary-aligned `refresh_*` / `dispatch_*` / `gate_*` entry points. Phase 5a re-exports existing `sims/*.ts` implementations and adds TODO stubs for handlers not yet ported. Subpackage `state-tables/` documents the binary CS-relative jump tables.

### `sim-refresh/`
Hosts `refreshRuntimeEntitiesForTickStride` (1228:0d64). Phase 5a re-exports from `sims`; Phase 5b moves implementation here.

### `sim-access/`
Binary-aligned sim selectors (1228:681d..688c etc.) and state-code bit helpers (0x20 waiting, 0x40 in-transit). Phase 5a declares the names; Phase 5b wires them to replace the `sim.route` discriminated union.

### `stress/`
Per-sim stress accessors (binary segment 11e0): `advanceSimTripCounters`, `rebaseSimElapsedFromClock`, `addDelayToCurrentSim`, `accumulateElapsedDelayIntoCurrentSim`, `reduceElapsedForLobbyBoarding`. One file per binary function. Phase 8 extraction from `sims/trip-counters.ts` and `queue/process-travel.ts`.

### `daily/`
Once-per-day sweeps fired from specific day-tick checkpoints. Hosts `dispatchActiveRequestsByFamily` (1190:0977), wired into the 0x9c4 checkpoint.

### `fixtures/`
JSON build specs and generated JSONL binary reference traces used by `trace.test.ts`.
