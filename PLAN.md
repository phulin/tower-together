# Tower Together — SimTower Parity Implementation Plan

## Architecture

### Module Breakdown

The simulation logic is entirely server-authoritative. The client is a thin renderer + input layer. The spec's headless model maps cleanly onto the existing Durable Object pattern.

```
apps/
  worker/src/
    protocol.ts                   # Wire → domain command mapping for websocket payloads
    tower-service.ts              # Shared DO RPC helpers for tower + alias operations
    sim/                        # Pure simulation core — no I/O, no Cloudflare deps
      index.ts                  # TowerSim class: step(), submit_command(), save/load
      snapshot.ts               # Snapshot creation + migration/defaulting for persisted saves
      time.ts                   # day_tick, daypart_index, day_counter, calendar_phase_flag
      world.ts                  # Floors, PlacedObjectRecord, tile adjacency helpers
      entities.ts               # RuntimeEntityTable + all entity record fields
      scheduler.ts              # Checkpoint dispatcher (all 0x000–0x09f6 bodies)
      routing.ts                # Route resolution, scoring, walkability, transfer-group cache
      carriers.ts               # CarrierRecord + CarrierCar state machine
      ledger.ts                 # cash_balance, primary / secondary / tertiary ledgers
      sidecars.ts               # ServiceRequestEntry, CommercialVenueRecord, EntertainmentLinkRecord
      events.ts                 # Fire, bomb, metro-display toggle, and prompt event state machines
      commands.ts               # build, demolish, rent-change, elevator-edit handlers
      resources.ts              # YEN #1000 / #1001 / #1002 tables + tuning constants
      families/
        hotel.ts                # Families 3, 4, 5 (rooms) + 0x0f (vacancy claimant)
        hotel-guest.ts          # Family 0x21
        office.ts               # Family 7
        condo.ts                # Family 9
        commercial.ts           # Families 6, 0x0a, 0x0c (restaurant / fast-food / retail)
        entertainment.ts        # Families 0x12, 0x1d
        evaluation.ts           # Families 0x24–0x28
        parking.ts              # Family 0x18 (passive)
    durable-objects/
      TowerRoom.ts              # Room coordinator: transport/session/tick orchestration
      TowerRoomRepository.ts    # SQLite snapshot persistence
      TowerRoomSessions.ts      # Socket registry + broadcast fanout
      TowerRegistry.ts
    routes/
      towers.ts
    types.ts                    # Wire protocol types (commands, patches, notifications)

  client/src/
    game/
      GameScene.ts              # Phaser scene (orchestrates sub-renderers)
      renderer/
        TileRenderer.ts         # Floor/lobby merged runs, hotel/office/condo rects
        CarrierRenderer.ts      # Elevator shafts, car positions, escalator bands
        OverlayRenderer.ts      # Stairs, entity dots, fire/bomb indicators
      input/
        PlacementHandler.ts     # Hover, shift-fill, click dispatch
        ToolState.ts            # Selected tool + placement validation mirrors
      PhaserGame.tsx
    screens/
      GameScreen.tsx            # Toolbar, stat bar, prompt dialogs
    lib/
      socket.ts
      storage.ts
    types.ts                    # Shared wire types (mirrored from worker)
```

**Key architectural invariants:**
- `sim/` has zero dependencies on Cloudflare, Phaser, or React. It can be unit-tested in Node.
- WebSocket wire messages are translated into domain `SimCommand` values before they enter `sim/`.
- Snapshot normalization and save-format migration live in `sim/snapshot.ts`, not in the Durable Object.
- `TowerRoom.ts` coordinates runtime concerns only: it receives WebSocket messages, dispatches domain commands to `sim.submit_command()`, calls `sim.step()` on a timer, and fans out patches to all sockets via collaborators.
- The client never simulates — it applies server patches and renders.
- `sim/index.ts` exposes exactly the API the spec describes: `step()`, `advance_ticks(n)`, `submit_command(cmd)`, `collect_notifications()`, `save_state()`, `load_state(snap)`.

### Wire Protocol Extension

The current flat `cells` patch model needs extensions for the new sim depth. Add alongside existing messages:

```ts
// Server → Client additions
| { type: "notification"; kind: string; params: Record<string, unknown> }
| { type: "prompt"; id: string; kind: "bomb_ransom" | "fire_rescue" | ...; params: ... }
| { type: "star_upgrade"; newStar: number }
| { type: "object_update"; floor: number; subtype: number; fields: Partial<PlacedObjectRecord> }

// Client → Server additions
| { type: "respond_prompt"; promptId: string; choice: string }
| { type: "demolish_tile"; x: number; y: number }
| { type: "set_rent"; floor: number; subtype: number; variantIndex: number }
| { type: "elevator_edit"; carrierId: number; op: ElevatorEditOp }
```

---

## Phase 1: Correct Foundation (MVP → Early 1-Star Game)

**Goal:** The simulation runs with correct time, correct floor numbering, correct tile types and placement rules. No entity AI yet — income is still placeholder — but the structural skeleton is right.

### 1.1 Grid and Floor Model

- Extend `GRID_HEIGHT` from 110 → 120 (floor indices 0–119; floor 10 = ground lobby; floors 109–119 = top penthouse band for eval entities).
- Update floor label math: `uiLabel = floor_index - 10` (floor 10 → "0", floor 9 → "-1", floor 119 → "109").
- Sky lobby rows: every 15 floors above ground = floor indices 10, 25, 40, 55, 70, 85, 100, 115 → 8 lobby rows. Update validation.
- Move all grid/floor constants into `sim/world.ts` so both server and client reference the same values (client imports from a shared constants file or re-exports from `types.ts`).

### 1.2 Tile Type Audit

Tiles have a **1:4 height:width aspect ratio** — each tile is 4× wider than it is tall in game pixels. Pixel widths in the original game: lobby/floor = 1, elevator = 4, single room = 4, condo = 16, office = 9.

Add all SimTower tile types to both `types.ts` files and the tile registry:

**Column key**: "Entity count" = runtime entity/occupant slots (one per sub-tile). "Tile width" = geometric placement width in game coordinate units as recovered from `FUN_1200_0000` in the binary (see SPEC.md "Object Tile Widths" table). These two columns are independent: entity count drives state-machine loops; tile width drives placement, collision, and render math.

| Family / type | Name | Entity count | Tile width | Notes |
|---|---|---|---|---|
| 3 | Single Room | 1 | 4 | Hotel, income on checkout |
| 4 | Twin Room | 2 | 8 | Hotel |
| 5 | Suite | 3 | 12 | Hotel |
| 6 | Restaurant | 1 | 24 | Commercial venue |
| 7 | Office | 6 | 9 | Activates every 3rd day |
| 9 | Condo | 3 | 16 | One-time sale |
| 0x0a / 12 | Fast Food | 1 | 12 | Commercial venue |
| 0x0c / 10 | Retail Shop | 1 | 16 | Commercial venue |
| 0x12 | Cinema | — | 24 | Entertainment, paired link |
| 0x1d | (other entertainment) | — | 24 | Single link |
| 0x14 | Security Office | — | varies | Passive; enables bomb patrol; stay_phase = duty tier |
| 0x15 | Housekeeping | — | varies | Passive cart; stay_phase = duty tier |
| 0x18 | Parking | — | 4 | Passive; contributes to transfer cache |
| 0x1f / 0x20 / 0x21 | Metro Station Stack | — | 30 | Required for 4→5 star; sets `g_metro_station_floor_index` |
| 0x0e | Security Office | — | varies | Required for 2→3 star; sets `security_office_placed` gate flag |
| 0x28 | Fire Suppressor | — | 28 | Prevents fire events (same width as eval entities) |
| Elevator shaft (0x01) | — | — | 4 | Vertical anchor; multiple per column |
| Lobby/floor (0x00) | — | — | 1 | Drag-placed, fills floor row |

Remove the current `hotel_single/twin/suite` naming shim and align with family codes.

### 1.3 Proper Time Model

Replace the current 24-tick day in `TowerRoom.ts` with the spec's model, implemented in `sim/time.ts`:

```ts
// sim/time.ts
const DAY_TICK_MAX = 0x0a28;  // 2600 ticks per day
const DAY_TICK_INCOME = 0x08fc; // day_counter increments here

interface TimeState {
  day_tick: number;       // 0x000–0x0a27
  daypart_index: number;  // day_tick / 400 → 0..6
  day_counter: number;    // long-running day count
  calendar_phase_flag: number; // (day_counter % 12) % 3 >= 2 ? 1 : 0
  star_count: number;     // 1–6
}

function tick(t: TimeState): TimeState { ... }
function pre_day_4(t: TimeState): boolean { return t.daypart_index < 4; }
```

The Durable Object's `setInterval` fires at 1 Hz real time = 1 sim tick per real second. Scale can be a config parameter later.

### 1.4 New Game Initialization State

Reproduce the exact initial state from `new_game_initializer` at `0x10d8_07f6`:

- `g_cash_balance = 20000` → **$2,000,000** (cash in $100 units)
- `g_cash_balance_cycle_base = 20000`; secondary/tertiary ledger totals = 0
- `g_day_tick = 0x9e5` (= **2533**) — starts mid-day; `daypart_index = 6`. First full day cycle begins on the second sim day.
- `g_day_counter = 0`, `g_calendar_phase_flag = 0`
- `g_star_count = 1` (hard-code; exact write site not recovered)
- `g_metro_station_floor_index = 0xffff` (−1: no metro station)
- `g_eval_entity_index = 0xffff` (−1: no evaluation in progress)
- `g_facility_progress_override = 0`, `g_security_ledger_scale = 0`
- Star gate flags all zeroed: `security_office_placed`, `office_placed`, `office_service_ok`, `security_adequate`, `routes_viable`, `office_service_in_progress`
- `[0xc198..0xc19b] = 0xffffffff` (purpose unresolved, but must be all-ones)
- No pre-placed objects, carriers, or special-link segments. Run `rebuild_transfer_group_cache` and `rebuild_route_reachability_tables` once at end of init.

### 1.5 Resource Tables

Hard-code the spec's known values into `sim/resources.ts`:

- **YEN #1001** payout table (hotels: 30/20/15/5, offices: 150/100/50/20, condos: 2000/1500/1000/400, retail: 200/150/100/40)
- **YEN #1002** expense table (restaurant: 500, fast food: 50, retail: 1000, security: 200, housekeeping: 100, elevator: 200/100, escalator: 100)
- Construction cost table (existing `TILE_COSTS`, extended with new types)
- Carrier expense: local elevator ¥200/unit/3-day, express ¥100/unit, escalator ¥100/unit
- Operational score thresholds by star rating (1–2: 80/150, 3: 80/150, 4+: 80/200)
- Activity score upgrade thresholds (300/1000/5000/10000/15000)

### 1.6 Refactor TowerRoom → TowerSim Wrapper

Extract the current inline sim logic from `TowerRoom.ts` into `sim/index.ts`:

```ts
// sim/index.ts
export class TowerSim {
  step(): Notification[] { ... }
  advance_ticks(n: number): Notification[] { ... }
  submit_command(cmd: Command): CommandResult { ... }
  save_state(): SimSnapshot { ... }
  load_state(snap: SimSnapshot): void { ... }
}
```

`TowerRoom.ts` becomes ~100 lines: accept WebSocket, call `sim.submit_command()`, call `sim.step()` each real-second tick, broadcast resulting patches + notifications.

**End state:** The game runs with correct time, correct tile types, correct floor numbering, basic placeholder income (hotels earn flat rates at checkout time), and proper modular code structure. Existing multiplayer works unchanged.

### Architecture Follow-up Completed (2026-04-08)

- Added `protocol.ts` so transport-level websocket messages are mapped to domain `SimCommand` values before entering `TowerSim`.
- Added `sim/snapshot.ts` so snapshot creation, migration, and defaulting are owned by the simulation package rather than `TowerRoom`.
- Split `TowerRoom` runtime support into `TowerRoomRepository` (SQLite persistence) and `TowerRoomSessions` (connection fanout).
- Added `tower-service.ts` so worker routes and alias endpoints share DO RPC helpers instead of duplicating internal endpoint construction.

---

## Phase 2: Static World + Scheduler Skeleton

**Goal:** All checkpoint bodies fire at the right ticks. PlacedObjectRecord is fully specified. The three-ledger money model is correct. Operating expenses fire. No entity AI yet.

### 2.1 PlacedObjectRecord

18-byte (`0x12`) record with these recovered field offsets (confirmed via `FUN_1200_1847` and `FUN_1200_293e`):

```ts
// sim/world.ts
interface PlacedObjectRecord {
  // +0x00..+0x05: family-specific runtime bytes (e.g. route_mode for routing entities)
  left_tile_index: number;       // +0x06 word: leftmost tile occupied
  right_tile_index: number;      // +0x08 word: rightmost tile occupied
  object_type_code: number;      // +0x0a byte: placement-time type
  stay_phase: number;            // +0x0b byte: per-family lifecycle / stay_phase
  aux_value_or_timer: number;    // +0x0c word: tool-counter rotation index at init; runtime cycle counter
  // +0x0e..+0x11: additional family-specific bytes
  linked_record_index: number;   // +0x12 byte: sidecar slot; init = -1 (no sidecar)
  needs_refresh_flag: number;    // +0x13 byte: dirty bit; init = 1
  pairing_active_flag: number;   // +0x14 byte: init = 1 (first-activation latch)
  pairing_status: number;        // +0x15 byte: 0=bad/refund-eligible, 1=ok, 2=good; init = -1
  variant_index: number;         // +0x16 byte: rent tier 0–3; 4 = no payout; init 1 for families 3/4/5/7/9/10, 4 for drag-placed
  activation_tick_count: number; // +0x17 byte: init = 0, capped at 0x78
}
```

Store floors as a flat array of `PlacedObjectRecord[][]` (floor × subtype). Maintain a parallel `subtype_to_object` reverse map.

### 2.2 Full Checkpoint Dispatcher

Implement all checkpoint bodies in `sim/scheduler.ts`. Initially most body logic is stubs (log the checkpoint, do nothing); flesh them out in later phases. The checkpoint table fires exactly as specified:

```ts
const CHECKPOINTS: Array<[number, (state: SimState) => void]> = [
  [0x000, checkpoint_start_of_day],
  [0x020, checkpoint_housekeeping_reset],
  [0x050, checkpoint_progress_notification],  // fires if facility_progress_override bit set
  [0x078, checkpoint_progress_notification],  // fires if facility_progress_override bit set
  [0x0a0, checkpoint_morning_notification],
  [0x0f0, checkpoint_facility_ledger_rebuild],
  [0x3e8, checkpoint_entertainment_half1],
  [0x4b0, checkpoint_hotel_sale_reset],    // + eval entity midday return dispatch (FUN_1048_0179)
  [0x578, checkpoint_entertainment_half2],
  [0x5dc, checkpoint_entertainment_phase1],
  [0x640, checkpoint_midday],              // security housekeeping reset param=0
  [0x6a4, checkpoint_afternoon_notification],
  [0x708, checkpoint_noop],                // no-op (previously decoded as security update)
  [0x76c, checkpoint_entertainment_phase2],
  [0x7d0, checkpoint_late_facility],       // security housekeeping tier-2 check param=2
  [0x898, checkpoint_type6_advance],
  [0x8fc, checkpoint_day_counter],
  [0x960, checkpoint_noop],               // no-op; fires at tick 2400, between 0x0898 and 0x09c4
  [0x9c4, checkpoint_runtime_refresh],
  [0x9e5, checkpoint_ledger_rollover],
  [0x9f6, checkpoint_end_of_day],
  [0x0a06, checkpoint_security_final],    // security housekeeping final tier check param=5
];
```

Checkpoint notes:
- **0x04b0 step 4**: `FUN_1048_0179` — if `g_eval_entity_index >= 0` (`[0xbc60] >= 0`): sweep floors `0x6d–0x77` for types `0x24–0x28`, clear `object[+0xc]` sidecar to 0 and mark dirty, advance any entity in state `0x03` (arrived) → state `0x05` (return journey). If `game_state_flags bit 2` is set, clear bit 2.
- **0x0640 step 8**: call `update_security_housekeeping_state(0)` — always resets to tier 0 (inadequate): clears `[0xc1a0]`, sets all type-0x14/0x15 `stay_phase = 0`.
- **0x0708**: no simulation state changes (previously mislabeled as security update).
- **0x07d0 step 2**: call `update_security_housekeeping_state(2)` — sets adequate flag and `stay_phase = required_tier` if required tier ≤ 2.
- **0x0a06**: call `update_security_housekeeping_state(5)` — final daily check; sets `[0xc1a0] = 1` if tower security meets ledger-scaled requirement.

### 2.3 Three-Ledger Money Model

```ts
// sim/ledger.ts
interface LedgerState {
  cash_balance: number;          // capped at 99,999,999
  primary_ledger: number[];      // per-family daily rate, indexed by family code
  secondary_ledger: number[];    // income since last 3-day rollover
  tertiary_ledger: number[];     // expenses since last 3-day rollover
  cash_balance_cycle_base: number; // saved at rollover
}
```

Implement `add_cashflow_from_family_resource(family, variant)` using YEN #1001. Implement 3-day rollover at checkpoint `0x09e5`. Implement periodic expense sweep: infrastructure by type (YEN #1002), carrier expenses per unit, parking rate by star tier.

### 2.4 Build / Demolish Command Handlers

Implement `sim/commands.ts`:

- Validate cost, geometry, tile occupancy, special placement rules
- Insert/remove `PlacedObjectRecord` at correct floor/subtype
- Allocate sidecar records (`CommercialVenueRecord`, `ServiceRequestEntry`, `EntertainmentLinkRecord`) on build
- Mark sidecar invalid on demolish (sets `owner_subtype_index = 0xff`)
- Post-build: conservatively rerun all global rebuilds (route reachability, transfer-group cache, path buckets, demand history, facility ledger)
- Post-demolish: same set of rebuilds

**End state:** Money flows correctly. Expenses charge every 3 days. Placing/demolishing objects works with full side-effect chains. Time advances through all checkpoint slots. No entities move yet.

---

## Phase 3: Routing + Carrier System

**Goal:** Elevators and escalators work. Entities can route between floors. The core transport simulation is mechanically correct.

### 3.1 Special-Link Segments and Walkability

```ts
// sim/routing.ts
interface SpecialLinkSegment {  // 64 entries, stride 10 bytes
  active: boolean;
  flags: number;      // bit 0 = express flag; bits 7:1 = half-span
  start_floor: number;
  height_metric: number;
}
```

Implement `is_floor_span_walkable_for_local_route` and `_for_express_route` using `g_floor_walkability_flags`. Rebuild flag array on every carrier placement/demolition.

### 3.2 Transfer-Group Cache

Implement `rebuild_transfer_group_cache`: scan for type-0x18 parking/concourse objects, group by floor, compute `carrier_mask` bitmasks. Trigger on: elevator served-floor toggle, elevator demolition, escalator demolition, elevator extension.

### 3.3 Route Candidate Selection

Full `select_best_route_candidate` with local-mode and express-mode priority order. Exact cost formulas from spec:
- Local special-link: `abs(height_delta) * 8`
- Express special-link: `abs(height_delta) * 8 + 0x280`
- Carrier direct: `abs(height_delta) * 8 + 0x280`
- Carrier transfer: `abs(height_delta) * 8 + 3000`

Hard-code all confirmed route delay values from startup tuning resource (type `0xff05`, id `1000`) in `sim/resources.ts`:

| Constant | Value | Used when |
|---|---|---|
| `DELAY_VESTIGIAL` | `300` | Loaded at `0xe5ee` but never read — vestigial |
| `DELAY_WAITING` | `5` | Carrier floor-slot status == `0x28` (at-capacity/departing) |
| `DELAY_REQUEUE_FAIL` | `0` | `assign_request_to_runtime_route` finds no valid transfer floor |
| `DELAY_ROUTE_FAIL` | `300` | `select_best_route_candidate` returns < 0 (no route) |
| `DELAY_VENUE_UNAVAIL` | `0` | Target commercial venue slot invalid/demolished/no path-seed entry |
| `DELAY_STOP_EVEN` | `16` | Per-stop direct delay for even-parity segments |
| `DELAY_STOP_ODD` | `35` | Per-stop direct delay for odd-parity segments |

### 3.4 CarrierRecord + Car State Machine

```ts
// sim/carriers.ts
interface CarrierRecord {
  carrier_mode: 0 | 1 | 2;  // 0=Express Elevator, 1=Standard Elevator, 2=Service Elevator (from placement dispatcher FUN_1200_082c); route scorer treats 0/1 as "local-mode" and 2 as "express-mode"
  top_served_floor: number;
  bottom_served_floor: number;
  served_floor_flags: number[];  // 14 entries (7 dayparts × 2 calendar phases)
  primary_route_status_by_floor: number[];
  secondary_route_status_by_floor: number[];
  cars: CarrierCar[];
}
interface CarrierCar {
  current_floor: number;
  door_wait_counter: number;
  speed_counter: number;
  assigned_count: number;
  direction_flag: number;
  target_floor: number;
  prev_floor: number;
  departure_flag: number;
  departure_timestamp: number;
  schedule_flag: number;
  waiting_count: number[];
}
```

Implement the full car state machine: Branch 1 (door open), Branch 2 (in transit), Branch 3 (idle at/not-at target). Motion profile, door dwell times, target floor selection, departure decision, out-of-range reset.

### 3.5 Queue Drain + Arrival Dispatch

Implement `process_unit_travel_queue(carrier, car)` and `dispatch_destination_queue_entries(carrier, car, floor)`. The arrival dispatch routes to family-specific handlers (initially stubs that just advance entity state).

### 3.6 Floor-to-Slot Index Mapping

Local elevator: floors 1–10 → slots 0–9; sky lobby floors where `(floor-10) % 15 == 14` → slot `(floor-10)/15 + 10`. Express/escalator: `floor - bottom_served_floor`.

**End state:** Elevators and escalators move correctly. Entities can be routed between floors. The carrier tick runs each sim tick. Route costs are computed correctly. Transfer points work.

---

## Phase 4: Entity AI — Hotels, Offices, Condos, Commercial

**Goal:** Hotel rooms fill and earn checkout income. Offices activate and deactivate. Condos sell and refund. Commercial venues track capacity and visits. Operational scoring works.

### 4.1 RuntimeEntityTable

```ts
// sim/entities.ts
interface EntityRecord {
  floor_anchor: number;
  subtype_index: number;
  base_offset: number;       // sub-tile within multi-tile span
  family_code: number;
  state_code: number;
  selected_floor: number;
  origin_floor: number;
  encoded_route_target: number;
  aux_state: number;
  queue_tick: number;
  accumulated_delay: number;
  aux_counter: number;
  // demand pipeline fields
  word_0xa: number;   // last-sampled day_tick
  word_0xc: number;   // elapsed ticks (low 10 bits) + flags
  word_0xe: number;   // accumulated elapsed total
  byte_0x9: number;   // sample count
}
```

Entities persist across days; `reset_entity_runtime_state` restores idle state at checkpoints `0x09c4` and `0x09e5` without reallocating.

### 4.2 Family 0x0f — Vacancy Claimant

Implements hotel room assignment. Full state machine (states 0–4): spawn on ground floor, find vacant room via demand history log, route to room, call `activate_selected_vacant_unit`. Required for hotel room occupancy.

### 4.3 Families 3, 4, 5 — Hotel Rooms

Full state machine from spec. Key transitions:
- **0x20/0x60**: route to assigned room; check-in via `activate_family_345_unit` (sets `stay_phase = 0/8`, credits ledger +1/+2)
- **0x01/0x41**: rest in room, route to commercial venue
- **0x22/0x62**: at venue, return
- **0x04**: sibling sync wait
- **0x10**: checkout-ready
- **0x05/0x45**: route to lobby; checkout fires `deactivate_family_345_unit_with_income` when `stay_phase & 7 == 0` → credits `add_cashflow_from_family_resource(family, variant)`, sets `g_newspaper_trigger`

Multi-tile checkout sync: family 3 sets stay_phase=1, family 4/5 sets stay_phase=2; each entity in state 0x05 decrements; first gets 1 (no checkout), last gets 0 → checkout.

Gate: hotel room assignment requires `star_count > 2` (3-star minimum for occupied hotel rooms).

### 4.4 Family 0x21 — Hotel Guest

Separate from hotel rooms. Guests wander commercial venues during dayparts 0–3 with 1/36 probability per gate check. Venue selection from bucket 0 (global, not zone-restricted). State machine: 0x01 → 0x41 → 0x22 → 0x62 → 0x01, parks at 0x27 overnight.

### 4.5 Families 6, 0x0a, 0x0c — Commercial Venues

Full `CommercialVenueRecord` with all fields. Daily recompute at checkpoints 0x0f0 and 0x0640:
- Capacity selection: `select_facility_progress_slot()` → capacity_phase_a/b/override
- Type-specific ceilings: restaurant 35/50/25, fast-food 35/50/25, retail 25/30/18
- Copy `today_visit_count` → `yesterday_visit_count`, reset counts
- Seed into path bucket tables for zone-based venue selection

Slot acquire/release with minimum service duration (60 ticks for all three). Daily closure at 0x07d0 / 0x0898: `availability_state = 3`.

### 4.6 Family 7 — Office

6-tile span. Operational scoring via `recompute_object_operational_status` (applies to all support-dependent families):
1. **Per-tile metric**: `0x1000 / entity.byte_0x9` (sample count); returns 0 if count == 0
2. **Span average**: sum across span tiles, divide by span count (office = 6)
3. **Variant modifier** (from `variant_index` at `+0x16`): tier 0 → +30, tier 1 → 0, tier 2 → −30, tier 3 → force score to 0; clamp to ≥ 0
4. **Support search**: `is_nearby_support_missing_for_object` within radius 10 tiles; office accepts families 3/4/5/6/10/12 but rejects another family 7
5. **Support bonus**: if support found on either side → `+60`
6. **Threshold mapping** (loaded by `refresh_operational_status_thresholds_for_star_rating`):
   - Stars 1–3: lower=80, upper=150; Stars 4+: lower=80, upper=200
   - score < lower → `pairing_status = 2` (good); < upper → 1 (ok); ≥ upper → 0 (bad/refund-eligible)
7. **Pairing active flag**: if `object[+0x14]` was 0 and new status is nonzero → set to 1

Activation/deactivation every 3rd day at checkpoint 0x09e5. Income via `add_cashflow_from_family_resource(7, variant)` each activation event + per-arrival.

Entity state machine: route from floor 10 to assigned office floor (states 0x00/0x40), make a commercial venue trip for fast food (states 0x01–0x23), route home (0x05/0x45). Gate by `calendar_phase_flag` and daypart.

**Office service evaluation (gate for 3→4 star):** Checked every 9th day (`day_counter % 9 == 3`) when `star_count == 3`. If an office entity is in state `0x01` with a service assignment:
- Compute `compute_runtime_tile_average()` against threshold `[0xe5ec]`.
- If average exceeds threshold (service too slow): set `[0xc197] = 0`, fire fail notification `0xbbb`.
- If average meets threshold: set `[0xc197] = 1`, fire pass notification `0xbba`.

This `office_service_ok` flag (`[0xc197]`) is required in `FUN_1150_007e` for the 3→4 star gate check.

### 4.7 Family 9 — Condo

3-tile span. One-time sale when entity arrives while `stay_phase >= 0x18`. Income: `add_cashflow_from_family_resource(9, variant)` using YEN #1001 condo row (2000/1500/1000/400).

Refund every 3rd day when `pairing_status == 0` and `stay_phase < 0x18`: calls `deactivate_commercial_tenant_cashflow`, deducts full sale price from cash.

Pairing system: A-rated (pairing_status=2) condos unblock idle neighbor entities via `attempt_pairing_with_floor_neighbor`. The "A brings additional inhabitants" mechanic is purely the neighbor's `pairing_active_flag` being set to 1, unblocking the state 0x20 gate.

Commercial trip alternation: restaurant vs fast-food selection based on `calendar_phase_flag` and `subtype_index % 4`. Support search radius: 30 tiles.

### 4.8 Demand Pipeline

Implement `rebase_entity_elapsed_from_clock` and `advance_entity_demand_counters`. These maintain `byte_0x9` (sample count) and `word_0xe` (accumulated elapsed total). The tile average used by `compute_runtime_tile_average` is `4096 / byte_0x9` — NOT `word_0xe / byte_0x9`. `word_0xe` is maintained by the pipeline but is not read by the scoring functions (its purpose is display-only or unused). 300-tick clamp on `word_0xc` prevents outliers from dominating the running sum.

### 4.9 Demand History + Coverage Propagation

Lobby tile objects (type 0x0b) register `ServiceRequestEntry` records. Vertical anchor objects (type 0x2c = elevator/escalator shafts) suppress adjacent lobby tiles' demand via coverage propagation. `rebuild_demand_history_table` sweeps all ServiceRequestEntries, collects uncovered (active) emitters into the demand log. `pick_random_demand_log_entry` drives hotel room assignment.

**End state:** Hotels fill with guests, earn checkout income. Offices activate/deactivate based on commercial support. Condos sell and refund based on service quality. Commercial venues track capacity through the daily cycle. Elevators route entities correctly.

---

## Phase 5: Entertainment, Evaluation Entities, Events, Star Ratings

**Goal:** Full SimTower feature parity. Star ratings advance. Events fire. The game has a progression arc.

### 5.1 Families 0x12 and 0x1d — Entertainment

16-entry `EntertainmentLinkRecord` table. Two modes:
- **Paired-link** (type 0x22/0x23): two halves (cinema + something). Income is attendance-based: <40 visits → ¥0, 40–79 → ¥20, 80–99 → ¥100, ≥100 → ¥150 per phase.
- **Single-link** (other types): fixed ¥200 per completed phase.

Phase budget driven by `compute_entertainment_income_rate`: age-based (age/3), low selector: 40/40/40/20, high: 60/60/40/20.

Daily phase state machine: Checkpoint 0x3e8 activates forward half → 0x578 activates reverse half → 0x5dc advances forward phase → 0x0640 (midday) completes reverse phase and accrues income.

Entity state machine: state 0x20 (consume phase budget, route to venue) → 0x60 (in transit) → 0x03 (at venue, await phase advance) → 0x05/0x01 (route to reverse floor or commercial venue) → 0x22/0x62 (at commercial venue) → 0x27 (park).

### 5.2 Families 0x24–0x28 — Star Rating Evaluation Entities

40 total entities (5 families × 8 slots each — the "8 slots per eval object" allocation is hardcoded, independent of tile span).

**`g_activity_score` IS `g_primary_family_ledger_total`.** There is no separate activity counter — the same aggregate that drives the cashflow display also drives the tower-tier gate. It is mutated exclusively via `add_to_primary_family_ledger_bucket(family_code, delta)`.

Per-family ledger contributions (all symmetric — same magnitude on deactivation):
- Family 3 (single room): +1 on check-in / −1 on checkout
- Family 4/5 (twin/suite): +2 / −2
- Family 7 (office): +6 / −6
- Family 9 (condo): +3 / −3
- Family 10 (retail): +10 (constant; no decrement path)
- Families 0x12/0x1d (entertainment): full clear-and-rebuild daily at checkpoint 0x0f0
- Families 6/0xc (restaurant/fast-food): +field_0x8 (≥10) on facility-record link

Upgrade thresholds for `g_primary_family_ledger_total`: 300 / 1000 / 5000 / 10000 / 15000.

**Dispatch model**: evaluation entities activate from state `0x20` (set by checkpoint 0x000 step 5 when `star_count > 2`) via the **normal entity-refresh stride**, not a dedicated checkpoint. The earlier probabilistic dispatch window (0x0051–0x00f0) was a misread and does not exist.

`check_evaluation_completion_and_award` counts arrivals (state `0x03`) only when `day_tick < 800`. All 40 must arrive within that window. Route failure → state `0x27` (parked); parked entities do not contribute. Failed runs are discarded; no carry-over to the next day.

At checkpoint `0x04b0`, `FUN_1048_0179` sweeps arrived entities (state `0x03`) and advances them to return state (`0x05`).

Upper tower activation: checkpoint 0x000 step 5 is gated on `g_eval_entity_index >= 0` (set only when `star_count > 2`). It computes the base entity index via `compute_subtype_tile_offset(floor, subtype, base_offset=0)` and forces the 8 consecutive slots to state `0x20`.

### 5.3 Fire Event

Triggers every 84 days (`day_counter % 84 == 83`) at checkpoint 0x0f0, when `star_count > 2`, `pre_day_4()` is true, and no fire suppressor (type 0x28) is placed.

Bidirectional spread from `fire_start_x = floor_right - 32`. Two fronts: left (decrement per `fire_spread_rate` ticks) and right (increment). Each step calls `delete_object_covering_floor_tile` — same teardown as demolish. Adjacent floors activate with a `floor_spread_delay` per floor gap.

At `fire_start_tick + search_interval`: emit helicopter rescue prompt with cost `rescue_cost`. Player accepts → fast-forward to near-extinguished; refuses → continue. Extinguishes at day_tick=2000 or when all boundaries cleared.

### 5.4 Bomb / Terrorist Event

Triggers every 60 days (`day_counter % 60 == 59`) at checkpoint 0x0f0.

Setup: pick random floor + tile, compute ransom by star rating, emit modal ransom prompt. If refused: start timer (`detonation_deadline = 0x4b0`), activate security patrol.

Security guard patrol: deterministic tile sweep from right to left across floors. Hits bomb tile → disarmed. Fails to reach bomb tile before deadline → detonation. Blast: 6-floor tall × 40-tile wide rectangle destroyed via full teardown path.

### 5.5 Metro Station Display Toggle And 4→5 Gate

**`g_metro_station_floor_index` (`[0xbc5c]`)**: stores the floor index of the placed metro station stack (types `0x1f`, `0x20`, `0x21`). Initialized to `0xffff` (−1 signed) on new game. Set to the object's floor index when a metro station is first placed. Saved/restored with tower file.

Gates two behaviors:
1. **Metro-station display toggle**: runs each tick when `day_tick > 0x0f0` and `daypart_index < 4`, only when `[0xbc5c] >= 0`. Probability: 1% per tick. On trigger: sweep all type-`0x1f/0x20/0x21` objects. If `object[+0xc] == 0`, set it to `2`; otherwise set it to `0`. Fire notification `0x271a` if any object activated. This is cosmetic only and does not drive star evaluation.
2. **4→5 star advancement gate** (see Star Advancement Gate below).

**Secondary use**: `[0xbc5c]` is also used as a floor-range lower-bound for elevator-extension and object-placement validation. When `bc5c == −1`, the bound is `−2` and never activates.

### 5.6 Star Advancement Gate

Star count (`[0xbc40]`, 1–5 for stars, 6 for Tower) is incremented by `FUN_1148_002d` called from `FUN_1098_03ab`. Two conditions must both pass:

1. `compute_tower_tier_from_ledger() > bc40` — ledger total exceeds the activity threshold for the next star level.
2. `FUN_1150_007e()` — all per-star qualitative gate conditions are met.

On success: `bc40 += 1`, palette update fires, `FUN_1150_003d` resets evaluation state flags (`office_service_ok`, `office_service_in_progress`, `evaluation_pending`) and fires a star-advance notification.

#### Per-Star Gate Conditions

| Current stars | Required before advancing |
|---|---|
| 1 | None — always eligible once ledger threshold met |
| 2 | Security office placed (`[0xc19e] == 1`) |
| 3 | Office placed (`[0xc19f] == 1`); `security_adequate [0xc1a0] == 1`; office service ok (`[0xc197] == 1`); `daypart_index >= 4`; `calendar_phase_flag != 1`; viable commercial routes (`[0xc1a1] == 1`) |
| 4 | Metro station placed (`[0xbc5c] >= 0`); `security_adequate [0xc1a0] == 1`; `daypart_index >= 4`; `calendar_phase_flag != 1`; `routes_viable [0xc1a1] == 1` |
| 5 | Always blocked here; 5★ → Tower uses the cathedral evaluation pathway below |

#### Gate Flags

| Flag | Address | Set by |
|---|---|---|
| `security_office_placed` | `0xc19e` | `check_and_trigger_treasure` on type-`0x0e` build |
| `office_placed` | `0xc19f` | `check_and_trigger_treasure` on type-`0x05` build |
| `office_service_ok` | `0xc197` | Office service evaluation (every 9th day at `star==3`) |
| `security_adequate` | `0xc1a0` | `update_security_housekeeping_state` (param=2 or param=5) |
| `routes_viable` | `0xc1a1` | `rebuild_path_seed_bucket_table` when `star > 2` |
| `metro_station_floor_index` | `0xbc5c` | Metro station placement handler (floor index ≥ 0) |

All gate flags are cleared by `FUN_1150_0000` at new-game initialization.

### 5.7 5★ → Tower Advancement Via Cathedral Evaluation

The 5★ → Tower upgrade does not go through the normal `check_and_advance_star_rating` path. It is awarded through the cathedral-driven evaluation flow instead.

Implementation checkpoints:
- Building the cathedral (placement type `0x24`) stores its floor in `g_eval_entity_index` and is only available once the tower is already at 5 stars.
- At day start, when `g_eval_entity_index >= 0` and `star_count > 2`, activate the upper-tower evaluation runtime group across floors `0x6d..0x77`, spawning 40 evaluation entities (5 object types × 8 slots).
- Each arriving evaluation entity triggers `check_evaluation_completion_and_award`, but success only counts while `day_tick < 800`.
- Award Tower only when both conditions hold: ledger-derived tier already exceeds the current star count (`g_primary_family_ledger_total >= 15000` for the final upgrade) and all 40 evaluation entities have reached state `0x03`.
- On success, write `bc40 := 6`, fire the Tower popup/visual refresh, and reset the upper-tower evaluation objects for the next cycle.
- On failure or missed deadline, mark the arrived slots for retry and let the next day-start activation rerun the evaluation.

### 5.8 Notification + Prompt System

Implement the prompt blocking model from the spec:
- `collect_notifications()` returns accumulated `Notification[]` and `Prompt[]` since last call
- A blocking prompt (bomb ransom, fire rescue) pauses scheduler advancement until `respond_prompt` command received
- Non-blocking notifications (morning, afternoon, end-of-day, newspaper, star upgrade) emit immediately

### 5.9 Newspaper Trigger

`g_newspaper_trigger` fires when `g_family345_sale_count >= 20` on every 8th checkout (else every 2nd). Emits a newspaper notification to all clients — a cosmetic event signaling tower health to players.

### 5.10 Security and Housekeeping

Security office (type 0x14): enables bomb patrol; patrol entity state described in bomb section. Housekeeping cart (type 0x15): resets state 6→0 at checkpoint 0x020, then 0→6 at start-of-day for active carts. Both charge operating expenses every 3 days (security ¥200, housekeeping ¥100).

**`update_security_housekeeping_state(param)` — called 3× per day:**
1. Only executes when `star_count > 2`.
2. If `[0xbc68] == 0` (no security scaling factor): fire "security insufficient" notification, set `[0xc1a0] = 0`, return.
3. Compute `required_tier = primary_ledger_total / [0xbc68]`, clamped: < 500 → 1; < 1000 → 2; < 1500 → 3; < 2000 → 4; < 2500 → 5; else 6.
4. If `param < required_tier`: set `tier = param`; if `param == 5` fire "security insufficient" notification; set `[0xc1a0] = 0` (inadequate).
5. If `param >= required_tier`: set `tier = required_tier`; set `[0xc1a0] = 1` (adequate).
6. Sweep all type-0x14 and type-0x15 objects: if `[0xc1a0] != 0` or `object[+0xb] != 5`, set `object[+0xb] = tier` (the `stay_phase`), mark dirty.

Call schedule: `param=0` at `0x0640` (always resets — tier never exceeds 0); `param=2` at `0x07d0` (awards up to tier 2 if requirement met); `param=5` at `0x0a06` (final check — awards up to tier 5, sets `[0xc1a0] = 1` for the day if adequate).

The `stay_phase` / `object[+0xb]` value of type-0x14 objects is the duty tier read by the bomb-patrol check path.

### 5.11 Elevator Editor

Expose elevator configuration commands:
- Add/remove car
- Set waiting floors (served-floor bitmask)
- Weekday/weekend schedule (the 14-entry `served_floor_flags` array: 7 dayparts × 2 calendar phases)
- Express/local mode toggle
- After each edit: rebuild transfer-group cache and route reachability

---

## Unlocks by Star Rating

Several tile types and mechanics are gated on star count. Star advancement itself requires both an activity score threshold and all qualitative gate conditions (see Phase 5.6).

| Unlock | Condition |
|---|---|
| Hotel room assignment (rooms fill with guests) | `star_count > 2` |
| Fire events | `star_count > 2` |
| Upper tower entity activation (floors 109–119) | `star_count > 2` |
| Security/housekeeping state machine active | `star_count > 2` |
| `routes_viable` flag computed | `star_count > 2` |
| 1→2 star advancement | Ledger ≥ 300 (no qualitative gates) |
| 2→3 star advancement | Ledger ≥ 1000 + security office placed (`[0xc19e]`) |
| 3→4 star advancement | Ledger ≥ 5000 + office placed + security adequate + office service ok + routes viable + `daypart >= 4` + `calendar_phase != 1` |
| 4→5 star advancement | Ledger ≥ 10000 + metro station placed (`[0xbc5c] >= 0`) + security adequate + routes viable + `daypart >= 4` + `calendar_phase != 1` |
| Tower win condition | `star_count == 6` via cathedral evaluation (ledger ≥ 15000 and all 40 evaluation entities arrive before `day_tick < 800`) |

The UI should communicate these unlocks: locked tile types are shown greyed out in the toolbar with a star requirement badge.

---

## Phasing Summary

| Phase | Deliverable | Key spec sections |
|---|---|---|
| 1 | Correct grid, tile types (with 1:4 aspect ratio), time model, new-game init state, resource tables, modular sim core | Time Model, Floor Indexing, Money Model (tables), New Game Initialization |
| 2 | Full checkpoint skeleton, three-ledger money, build/demolish with side effects | Checkpoint Table, Ledger Roles, Build/Demolish commands |
| 3 | Elevator/escalator routing, carrier car state machine, transfer-group cache | Route Resolution, Carrier Car State Machine, Queue Drain |
| 4 | Entity AI: hotels, offices, condos, commercial venues, operational scoring | Families 3/4/5/7/9/6/0x0c/10, Demand Pipeline, Demand History |
| 5 | Entertainment, star rating evaluation, fire, bomb, full notification system | Families 0x12/0x1d/0x24–0x28, Event Mechanics, Star Rating |
