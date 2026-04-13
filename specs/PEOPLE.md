# Runtime Actors

This document covers shared actor behavior across people-like and transient simulation actors.

## Actor Kinds

Runtime actors include:

- hotel-room occupants
- office workers
- condo residents
- hotel guests visiting venues
- entertainment attendees
- cathedral guests
- helper/service actors

## Shared Fields

Every actor should track:

- anchor floor and subtype
- family
- current state
- base occupant index
- current target floor or facility
- current route state
- delay/countdown fields
- family-specific aux values

## Shared State-Code Convention

Bit 6 (`0x40`) is the **in-transit flag**. When set, the sim has committed
to a route leg and the gate handler is bypassed — the refresh handler calls
the dispatch handler directly every service tick until the leg completes.

The four state bands are:

| Band | Mask | Meaning |
|------|------|---------|
| `0x0x` | base states | idle, waiting, or ready to decide next action |
| `0x2x` | base states | support/service cycle, venue visits, checkout |
| `0x4x` | `0x0x \| 0x40` | in transit for the corresponding `0x0x` state |
| `0x6x` | `0x2x \| 0x40` | in transit for the corresponding `0x2x` state |

Special value: `0x27` = parked/night state (in the `0x2x` band but treated as terminal by the gate).

The base state is recovered by `state & ~0x40` (equivalently `state & 0x3f`).
Dispatch handlers are shared: state `0x00` and `0x40` hit the same handler,
state `0x20` and `0x60` hit the same handler, etc.

### Refresh handler flow

For every sim serviced in the 1/16 stride:

1. read `state_byte` from `entity[+5]`
2. if `state_byte < 0x40`:
   - scan the family's **gate jump table** for a matching entry
   - the gate checks daypart, tick, RNG, and sim-specific fields
   - if the gate allows: call the **dispatch handler**
   - if the gate denies: return (sim stays in current state)
   - some gates modify state directly (e.g. force `0x05` or `0x27`) without dispatching
3. if `state_byte >= 0x40`:
   - if `entity[+8] < 0x40`: call the **dispatch handler** directly (active leg)
   - if `entity[+8] >= 0x40`: call `maybe_dispatch_queued_route_after_wait` (queued on a carrier)

This means the gate is a **one-time barrier**: once a sim transitions
to a `0x4x`/`0x6x` state, it is serviced unconditionally until the route
leg completes and the dispatch handler drops it back to a base state.

## Shared Routing Contract

Family handlers own intent; the routing layer owns movement.

Typical loop:

1. family chooses destination or next action
2. family requests one route leg (calls `resolve_sim_route_between_floors`)
3. route result 0/1/2: entity sim `0x4x`/`0x6x` (in-transit) state
4. route result 3: same-floor arrival, dispatch handler handles immediately
5. route result -1: failure, family handler decides fallback
6. arrival hands control back to the family handler (state drops to base band)
5. family either continues the trip, begins an activity, or parks

## Shared Occupant Staggering

Multi-occupant facilities do not move all occupants identically. `occupant_index` is used to stagger:

- trip timing
- venue type selection
- activation order
- sync behavior before checkout or reset

## Shared Night/Park Semantics

Many actor families use a parked or dormant nightly state. That state usually:

- suppresses routing
- waits for a daypart threshold
- resets or re-enters the family's daytime loop at the next activation window

## Stress / Trip-Counter Pipeline

Each non-housekeeping sim accumulates **elapsed travel time** (measured in
`day_tick` deltas) across its trips. This per-sim elapsed counter is the
binary's implementation of the manual's "stress": the average number of ticks a
sim spends in transit per trip.

### Per-Sim Trip Fields

| Offset | Size | Field | Meaning |
|--------|------|-------|---------|
| `+0x09` | byte | `trip_count` | number of completed route legs / transit events |
| `+0x0a` | word | `last_trip_tick` | `g_day_tick` snapshot at route-start; zeroed after rebase |
| `+0x0c` | word | `elapsed_packed` | low 10 bits = current elapsed ticks; high 6 bits = flags |
| `+0x0e` | word | `accumulated_elapsed` | running sum of per-sample elapsed values |

### When Counters Advance

`advance_sim_trip_counters` (which increments `trip_count` and drains
`elapsed_packed` into `accumulated_elapsed`) is called at specific
transit-completion events — NOT per-tick:

| Call site | When |
|-----------|------|
| `dispatch_sim_behavior` | queued-car arrival callback for in-transit states |
| `resolve_sim_route_between_floors` | same-floor route success (result 3) |
| `resolve_sim_route_between_floors` | route failure (result −1) |
| `finalize_runtime_route_state` | route leg completion / cancellation |
| `acquire_commercial_venue_slot` | venue slot claimed |
| `FUN_1178_0291` | (additional transit event) |

`trip_count` therefore counts **completed route legs and transit events**,
not simulation ticks. The per-tick refresh handler for in-transit entities
(`state >= 0x40, entity[+8] < 0x40`) calls the family dispatch handler
directly, bypassing `dispatch_sim_behavior` and the trip-counter pipeline entirely.

### Trip-Counter Functions

1. **`rebase_sim_elapsed_from_clock`** — called from `dispatch_sim_behavior`
   (queued-car arrival callback) and `cancel_runtime_route_request`:
   - `elapsed = (elapsed_packed & 0x3ff) + g_day_tick - last_trip_tick`
   - clamp to 300
   - store back: `elapsed_packed = (elapsed_packed & 0xfc00) | elapsed`
   - clear `last_trip_tick = 0`

2. **`advance_sim_trip_counters`** — called at the transit events above:
   - `trip_count += 1`
   - `accumulated_elapsed += (elapsed_packed & 0x3ff)`
   - clear `last_trip_tick = 0`
   - clear low 10 bits of `elapsed_packed` (keep flags)

3. **`accumulate_elapsed_delay_into_current_sim`** — called from
   `assign_request_to_runtime_route` when a carrier leg is assigned
   (non-service carriers only; both express and standard):
   - `elapsed = (elapsed_packed & 0x3ff) + g_day_tick - last_trip_tick`
   - call `scale_delay_for_speed_mode(elapsed, source_floor)` to apply the
     lobby-boarding reduction (see below)
   - clamp to 300, store back, clear `last_trip_tick`

4. **`add_delay_to_current_sim`** — adds a fixed tick penalty:
   - `elapsed = (elapsed_packed & 0x3ff) + delay_delta`
   - clamp to 300, store back, clear `last_trip_tick`
   - used for: no-route delay (300 ticks), distance penalties (30 or 60 ticks),
     queue-full waiting delay (5 ticks)
   - the distance penalty is gated by `emit_distance_feedback` in the route
     resolver — only certain base states enable it (see ROUTING.md
     "`emit_distance_feedback` Gating")

5. **Route-start timestamp** — at the end of `resolve_sim_route_between_floors`,
   `last_trip_tick = g_day_tick`. This starts the clock for the next leg.

### Scoring

`compute_runtime_tile_stress_average` computes:

```
if trip_count == 0: return 0
return accumulated_elapsed / trip_count
```

This is the **average elapsed ticks per trip** — the sim's stress.
Higher values = more stressed = worse evaluation.

`compute_object_operational_score` averages this metric across the facility's
population count (family 3: 1 sim, family 4/5: 2 sims, family 7: 6 sims,
family 9: 3 sims), then passes through `apply_rent_and_noise_penalty_to_score`
for rent-level and noise-proximity adjustments (see FACILITIES.md).

### Stress Color Bands (Manual)

The manual describes three visible stress colors for individual sims:

| Score range | Color | Meaning |
|-------------|-------|---------|
| < 80 | black | low stress |
| 80–119 | pink | moderate stress |
| 120–300 | red | high stress |

These thresholds apply to the per-sim `accumulated_elapsed / trip_count` value.
The 300-tick clamp on `elapsed_packed` prevents any single leg from dominating.

### Lobby-Boarding Stress Reduction

`reduce_elapsed_for_lobby_boarding` reduces accumulated elapsed time when a sim
boards a non-service carrier at the lobby floor (EXE floor 10 / clone logical
floor 0). The reduction is keyed to `g_lobby_height`:

- `source_floor != 10` (not the lobby): no adjustment
- `g_lobby_height <= 1`: no adjustment
- `g_lobby_height == 2`: subtract 25 ticks (min 0)
- `g_lobby_height == 3`: subtract 50 ticks (min 0)

The bonus applies to both express and standard carriers (the only exclusion is
service carriers, which skip `accumulate_elapsed_delay_into_current_sim` entirely).
A taller lobby reduces elevator-boarding stress for sims departing from the ground
floor.

### Reset

`reset_sim_trip_counters` clears `trip_count` and `accumulated_elapsed` to 0
for a single sim. `reset_facility_sim_trip_counters` calls it in a loop for
all sims belonging to a facility. This fires at the 3-day cashflow pass
(via `activate_family_cashflow_if_operational`) and on first reopen after vacancy
(via `activate_office_cashflow`).

## Sim Entity Record Layout

Each sim has a 16-byte record in `g_sim_table`, indexed by `entity_tile_index << 4`.

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| `+0x00` | 4 | reserved / link header | family-specific use |
| `+0x04` | 1 | `family_code` | matches placed object's family |
| `+0x05` | 1 | `state_code` | the entity state machine byte |
| `+0x06` | 1 | `route_mode` / family selector | read by route resolution |
| `+0x07` | 1 | `spawn_floor` / source floor | written when route begins |
| `+0x08` | 1 | `route_carrier_or_segment` | carrier_up(i) = carrier i ascending, carrier_down(i) = descending, or invalid/none sentinel |
| `+0x09` | 1 | `trip_count` | number of completed trips (stress pipeline) |
| `+0x0a` | 2 | `last_trip_tick` | day_tick snapshot; zeroed after rebase |
| `+0x0c` | 2 | `elapsed_packed` | low 10 bits = current elapsed ticks; high 6 bits = flags |
| `+0x0e` | 2 | `accumulated_elapsed` | running sum of per-trip elapsed values |

Save/load must preserve all fields per entity to round-trip the trip-counter pipeline.

---

## Per-Family State Machines

Each family has a **gate handler** (states < 0x40) that decides whether to dispatch,
and a **dispatch handler** (states >= 0x40 or when gate allows) that performs routing
and state transitions. States `0x4x` are in-transit aliases of `0x0x`; states `0x6x`
are at-destination aliases of `0x2x`.

### Family `0x0f` — Housekeeping

Housekeeping entity that searches for and claims vacant hotel rooms. One per hotel room
entity slot. Not a persistent occupant.

Entity fields: `route_mode` = target floor (searching sentinel when not yet assigned), `spawn_floor`
(negative = uninitialized). The shared `last_trip_tick` field remains as defined;
family 0x0f uses other family-specific countdown state instead of repurposing that field.

| State | Behavior |
|-------|----------|
| 0 | **Initial search**: if `spawn_floor < 0` → store current floor. Call `find_matching_vacant_unit_floor`. Set `route_mode` to searching sentinel. Fall through to route setup |
| 1/4 | **Route to candidate floor**: resolve route using `spawn_floor` as destination. Result 0/1/2 → state 4. Result 3 or fail → state 0 |
| 3 | **Route to room floor**: resolve route using `route_mode`. Result 0/1/2 → stay at 3. Result 3 + valid daytime (`day_tick < 1500`) → `activate_selected_vacant_unit`, state 2, `last_trip_tick = 3`. Otherwise → state 0 |
| 2 | **Pending countdown**: if `last_trip_tick != 0` → decrement, return. If 0 → `flag_selected_unit_unavailable`, state 0 |

Vacant-room search scope: rentable units (families 3/4/5) in the same modulo-6 floor
remainder class (`floor % 6`). Claim writes guest entity ref into the room's ServiceRequestEntry
sidecar, sets `room.unit_status = rand(2..14)`, sets `room[+0x13] = 1` (occupied).

### Families `3`, `4`, `5` — Hotel Room Occupants

Per-room entity count: family 3 = 1, family 4 = 2, family 5 = 3.
Lifecycle: check-in → venue trips → sibling sync → checkout → vacancy.

#### Gate Table (states < 0x40)

| State | Gate condition |
|-------|---------------|
| 0x20 | if `room.pairing_pending_flag != 0`: daypart 4 → 1/12 chance (`rand() % 12 == 0`); daypart > 4 and tick < 2300 → dispatch; daypart > 4 and tick >= 2300 → no dispatch |
| 0x01 | daypart 4 → 1/6 chance (`rand() % 6 == 0`); daypart > 4 → force state 0x04; daypart <= 3 → no dispatch |
| 0x22 | daypart >= 4 → dispatch; daypart < 4 → no dispatch |
| 0x04 | daypart < 5 → no dispatch; daypart >= 5 AND tick > 2400 → dispatch; daypart >= 5 AND tick <= 2400 → 1/12 chance (`rand() % 12 == 0`) |
| 0x10 | daypart < 5 → dispatch; daypart >= 5 AND tick > 2566 → 1/12 chance (`rand() % 12 == 0`); daypart >= 5 AND tick <= 2566 → no dispatch |
| 0x05 | daypart 0 → 1/12 chance (`rand() % 12 == 0`); daypart 6 → no dispatch; dayparts 1–5 → dispatch |
| 0x26 | tick > 2300 → state 0x24 (if `last_trip_tick == 0`) else state 0x20 |

#### Dispatch Table

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x20/0x60 | Route to hotel room. If 0x20: `assign_hotel_room` first (sets `unit_status = rand(2..14)`, encodes target floor). If `unit_status > 0x17` and no route-block: state → 0x26 | 0/1/2 → 0x60; 3 → `activate_family_345_unit` + `increment_unit_status` → 0x01 or 0x04; fail → clear/reset |
| 0x01/0x41 | Call `decrement_unit_status_345`. Route to commercial venue | 0/1/2 → 0x41; 3 → 0x22; fail → `increment_unit_status` → 0x04 |
| 0x22/0x62 | Release venue slot, route back | 0/1/2 → 0x62; 3 → `increment_unit_status` → 0x04; fail → 0x04 |
| 0x04 | Sibling sync: state → 0x10. `sync_unit_status_if_all_siblings_ready_345`: family 3 shortcut when `unit_status & 7 == 1`; otherwise the helper requires the sibling set to be ready before writing `unit_status = 0x10` | |
| 0x10 | If `unit_status == 0x10`: family 3 → `unit_status = 1`; family 4/5 → `unit_status = 2`. State → 0x05 | |
| 0x05/0x45 | `decrement_unit_status_345`. If `unit_status & 7 == 0`: checkout (set `unit_status = 0x28`/`0x30`, clear occupancy, credit income, increment sale count). Route to lobby | 0/1/2 → 0x45; 3 → 0x20 (reset); fail → 0x20 if vacant, else increment |

`activate_family_345_unit`: sets `unit_status` to 0 (morning) or 8 (evening), marks
dirty, adds to population ledger (+1/+2/+2 for families 3/4/5).

### Family `7` — Office Workers

6 entities per office. Recurring cashflow on 3-day cadence.

#### Gate Table (11 entries)

| State | Gate condition |
|-------|---------------|
| 0x00 | daypart ≥ 4 → force state 0x05; **occupant 0**: daypart 0 → 1/12 chance, dayparts 1–3 → dispatch; **occupant != 0**: dayparts 0–2 → no dispatch, daypart 3 → 1/12 chance |
| 0x01 | daypart ≥ 4 → force state 0x05; daypart 0 → no dispatch; daypart 1 → 1/12 chance; dayparts 2–3 → dispatch |
| 0x02 | (shared with 0x01) |
| 0x05 | daypart 4 → 1/6 chance (`rand() % 6 == 0`); dayparts 5–6 → dispatch; daypart < 4 → no dispatch |
| 0x20 | `calendar_phase_flag != 0` → no dispatch; `occupied_flag == 0` → no dispatch; daypart 0 → 1/12 chance; dayparts 1–2 → dispatch; daypart ≥ 3 → **no dispatch** |
| 0x21 | daypart ≥ 4 → **force state 0x27 + release service request** (NOT dispatch); daypart 3 → 1/12 chance; dayparts 0–2 → no dispatch |
| 0x22 | daypart ≥ 4 → force state 0x27 + release request; dayparts 2–3 → dispatch; dayparts 0–1 → no dispatch |
| 0x23 | (shared with 0x22) |
| 0x25 | `day_tick > 2300` → force state 0x20; else parked |
| 0x26 | (shared with 0x25) |
| 0x27 | (shared with 0x25) |

#### Dispatch Table (16 entries, `0x0x`/`0x4x`/`0x6x` share handlers)

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x00/0x40 | Route from lobby to assigned floor | 0–2 → 0x40; 3 → 0x21; fail → 0x26 |
| 0x01/0x41 | `route_entity_to_commercial_venue(2, ...)` | fail → 0x26 + release request |
| 0x02/0x42 | Continue venue transit, resolve route to venue floor | 0–2 → 0x42; 3 → `try_claim_office_slot`: claimed → 0x23, busy → 0x42, none → 0x41 |
| 0x05/0x45 | Route from assigned floor back to lobby. On **first dispatch** (state 0x05, not 0x45): calls `decrement_office_presence_counter` regardless of route result | 0–2 → 0x45; 3 → 0x27 + release service request; fail → 0x26 + release service request |
| 0x20/0x60 | If `0x20`: request selector-2 service for the current entity, then route from lobby to assigned floor. If `0x60`: continue the in-transit leg | 0–2 → 0x60 (activate vacant office); 3 → activate + `advance_office_presence_counter` + occupant 0 → 0x00, else → 0x01 (default) or 0x02 (`g_star_count ≥ 3` AND `rand() % 10 == 0`); fail + vacant → 0x20; fail + open → 0x25 |
| 0x21/0x61 | Route from lobby to assigned floor (0x21) or saved floor to assigned floor (0x61) | 0–2 → 0x61; 3 → `advance_office_presence_counter` → 0x05; fail → 0x26 + release |
| 0x22/0x62 | Release venue slot, route home | 0–2 → 0x62; 3 → `advance_office_presence_counter`, then `occupant_index == 1` → 0x00, else → 0x05; fail → 0x26 + release |
| 0x23/0x63 | Enforce 16-tick venue dwell, then route to saved target | 0–2 → 0x63; 3 → `advance_office_presence_counter`, then `occupant_index == 1` → 0x00, else → 0x05; fail → 0x26 + release |

`advance_office_presence_counter` (`1228:68c3`): increments `unit_status` (accessed as
`ES:[BX + 0x0b]` due to the 6-byte FloorObjectTable header); wraps 8 → 1. Always marks
dirty. Fires on every worker arrival: elevator delivery (`dispatch_sim_behavior` for states
0x40/0x41/0x42), same-floor arrival from 0x20/0x60, and same-floor return from
0x21/0x22/0x23.

`decrement_office_presence_counter` (`1228:698a`): decrements `unit_status`; if the value
reaches 0 AND daypart ≥ 4, resets to 8. Always marks dirty. Fires on first dispatch from
**all four base states** (`0x00`, `0x01`, `0x02`, `0x05`), not just `0x05`. Continuation
states (`0x40`/`0x41`/`0x42`/`0x45`) do not decrement. The dispatch handler checks the
saved base state code at each handler's exit and calls decrement when the check passes.

The presence counter is `unit_status` cycled within the active band (1–8). The same field
holds deactivation values (0x10, 0x18) in the vacant bands. See OFFICE.md for full call-site
table and elevator arrival handler details.

#### Elevator Arrival (`dispatch_sim_behavior`)

When an elevator delivers a family-7 worker, `dispatch_sim_behavior` (`1228:186c`) runs
the family-7 jump table at `1228:1c51`:

- States 0x40/0x41/0x42 (inbound/lunch transit): `advance_office_presence_counter` → state 0x05
- States 0x45/0x60/0x61/0x62/0x63 (evening/rental/return): state 0x26 + release service request

The 0x40/0x41/0x42 path is the normal inbound arrival: the worker reaches the office floor,
the counter advances, and the worker enters state 0x05 (at work, gated until daypart ≥ 4).

The 0x45/0x60/0x61/0x62/0x63 path is an error/cancellation fallback.

#### Parked States (0x25, 0x26, 0x27)

All three park until `day_tick > 2300`, then transition to 0x20. Entry conditions:

| State | How entered |
|-------|-------------|
| 0x25 | Route failure on the rental/opening path (0x20/0x60) when office is already open (`unit_status < 0x10`) |
| 0x26 | Route failure from any other dispatch (0x00, 0x01, 0x05, 0x21, 0x22, 0x23) |
| 0x27 | Successful evening arrival at lobby (0x05 result 3), OR forced late-day parking from the gate (states 0x21/0x22/0x23 at daypart ≥ 4) |

### Family `9` — Condo Residents

3 entities per condo. Sale fires once on first successful route while unsold.

#### Gate Table (states < 0x40)

| State | Gate condition |
|-------|---------------|
| 0x10 | daypart < 5 → dispatch; daypart >= 5 AND tick > 2566 → 1/12 chance (`rand() % 12 == 0`); daypart >= 5 AND tick <= 2566 → no dispatch |
| 0x00 | daypart 0 → 1/12 chance (`rand() % 12 == 0`); daypart 6 → no dispatch; dayparts 1–5 → dispatch |
| 0x01 | **standard path**: daypart 0 AND tick > 240 → 1/12 chance; daypart 0 AND tick <= 240 → no dispatch; daypart 6 → no dispatch; dayparts 1–5 → dispatch |
| 0x01 | **calendar path** (`calendar_phase_flag == 1` AND `subtype_index % 4 == 0`): daypart < 4 → no dispatch; daypart 4 → 1/6 chance (`rand() % 6 == 0`); daypart > 4 → force state 0x04 |
| 0x04 | `resident_index == 2`: daypart >= 5 → dispatch; daypart < 5 → no dispatch |
| 0x04 | `resident_index != 2`: daypart < 5 → no dispatch; daypart >= 5 AND tick > 2400 → dispatch; daypart >= 5 AND tick <= 2400 → 1/12 chance (`rand() % 12 == 0`) |
| 0x20 | `pairing_pending_flag == 0` → no dispatch; daypart >= 5 → no dispatch; daypart < 5 → dispatch |
| 0x21 | `resident_index != 2`: daypart 4 → 1/12 chance; daypart > 4 → dispatch; daypart <= 3 → no dispatch |
| 0x21 | `resident_index == 2`: daypart 3 → 1/12 chance; daypart > 3 → dispatch; daypart < 3 → no dispatch |
| 0x22 | daypart >= 3 → dispatch; daypart < 3 → no dispatch |

The outbound service selector is based on `resident_index`, not `floor_local_object_id`: selector `1` when `resident_index % 4 == 0`, otherwise selector `2`.

#### Dispatch Table

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x10 | If `unit_status == 0x10`: rewrite to 3, mark dirty. If `calendar_phase_flag == 1`: odd subtype → INC unit_status → 0x04; even → 0x01. Else: `resident_index == 1` → 0x01; else → 0x00 | |
| 0x01/0x41 | If 0x01: DEC unit_status. Choose venue selector by calendar phase + subtype parity. Route to commercial venue | fail → INC unit_status → 0x04; else → 0x41 |
| 0x20/0x60 | Route to commercial venue. **SALE POINT**: if `unit_status >= 0x18`, service lookup succeeded, and the follow-up route resolver returns `0`, `1`, `2`, or `3`, call `finalize_condo_sale` (credit family-9 YEN value, reset `unit_status` to `0/8`, `+3` primary ledger) | service lookup `0xffff` → INC → `0x04`; route result `-1` + unsold → `0x60` (no sale); route result `-1` + sold → INC → `0x04`; route result `0/1/2` + unsold → `0x60` (SALE); route result `3` + unsold → INC → `0x04` (SALE) |
| 0x21/0x61 | Route to lobby / saved floor | 0–2 → 0x61; fail or arrived → INC unit_status → 0x04 |
| 0x22/0x62 | Release venue, route home | fail/arrived → INC → 0x04 |
| 0x04 | State → 0x10. `try_set_parent_state_in_transit_if_all_slots_transit`: if `unit_status & 7 == 1` → shortcut `unit_status = 0x10`; else check all 3 siblings at 0x10 | |

Trip-cycle selector note:

- `dispatch_object_family_9_state_handler` sets the commercial selector with `resident_index % 4 == 0 ? 1 : 2`
- with the recovered 3-occupant condo pattern, this yields restaurant / fast-food / fast-food across the three occupants

Trip counter net effect per morning cycle: even sims DEC, odd sim INC → net −1.
After ~2 cycles from 3, unit_status reaches 1 → sync shortcut → back to 0x10.

### Families `0x12`, `0x1d` — Entertainment Entities

4-entry gate table (states < 0x40); 8-entry dispatch table.

| State | Behavior |
|-------|----------|
| 0x20 | Check phase budget gate (forward or reverse byte). If 0 → blocked. Else decrement, route from floor 0 (lobby) to entertainment floor | 0/1/2 → 0x60; 3 → increment counters (runtime count + attendance), promote phase 1→2 → 0x03; fail → 0x20 or 0x27 |
| 0x03 | At venue — waits for `advance_entertainment_facility_phase`. On advance: if family 0x1d OR not `pre_day_4()` → 0x05; else → 0x01. Decrement `active_runtime_count` |
| 0x05/0x45 | Route to reverse floor, then to floor 0 (lobby) | 0/1/2 → 0x45; 3 or fail → 0x27 |
| 0x01/0x41 | If 0x01: pick random commercial venue (`rng() % 3`). Route to venue | 0/1/2 → 0x41; 3 → acquire slot → 0x22 or overcapacity → 0x41; fail → 0x27 |
| 0x22/0x62 | Release venue slot (min-stay enforced), route to floor 0 (lobby) | 0/1/2 → 0x62; 3 or fail → 0x27 |
| 0x27 | Parked (night) |

### Family `0x21` — Hotel Guest

Visits commercial venues during the day. Not tied to hotel revenue.

| State | Gate | Dispatch |
|-------|------|----------|
| 0x01 | dayparts 0–3, tick > 241, `rng() % 36 == 0` | Pick random venue (uniform: `rng() % 3` → type, bucket 0). Route to venue floor (source = `hotel_floor + 2`). Success → 0x41; arrived + slot → 0x22; arrived + overcapacity → 0x41; fail → 0x27 |
| 0x41 | (in-transit) | Delegates to family 0x12/0x1d dispatch |
| 0x22 | No daypart restriction | Release venue slot (min-stay enforced). Route to hotel floor. 0/1/2 → 0x62; 3 → 0x01; fail → 0x27 |
| 0x62 | (in-transit back) | Delegates to family 0x12/0x1d dispatch |
| 0x27 | `day_tick >= 2301` → state 0x01 | (parked) |

### Families `0x24`–`0x28` — Cathedral Guests

Types 0x24–0x28 are the 5 per-floor slices of the cathedral building (bottom to top).
Each floor hosts 8 sim slots → 5 floors × 8 = 40 cathedral guests.

**Daily spawn** (`activate_upper_tower_runtime_group`, checkpoint 0x000):
when `eval_entity_index >= 0` (cathedral placed) and `star_count > 2`,
sweeps floors 100–104 for types 0x24–0x28, forces 8 entity slots each to state 0x20.

**Gate** (state 0x20):
- Requires `calendar_phase_flag == 1`
- `daypart_index == 0`: staggered dispatch — `random() % 12 == 0` (1/12 chance)
  per tick after `day_tick > 80`; guaranteed every tick after `day_tick > 240`
- `daypart_index >= 1`: missed dispatch window → state 0x27 (parked)

**Selector** (`resolve_family_24_selector_value`):
- State 0x45 → target floor 0 (lobby)
- State 0x60 → target floor 100 (cathedral base)

| State | Gate | Behavior |
|-------|------|----------|
| 0x20 | `calendar_phase_flag == 1`, daypart 0, stagger | Route from floor 0 to floor 100 (cathedral). Result: 0/1/2 → 0x60; 3 → 0x03 + award check; fail → 0x27 |
| 0x60 | — | In transit to cathedral. On arrival → 0x03 + `check_evaluation_completion_and_award` |
| 0x03 | — | Arrived. If `day_tick < 800` and all 40 in state 0x03 and ledger tier > star_count → Tower promotion. Otherwise stamp object `aux = 3, dirty = 1` |
| 0x05 | — | Midday return (set by `dispatch_evaluation_entity_midday_return` at checkpoint 0x04b0). Route from floor 100 to floor 0. Result: 0/1/2 → 0x45; 3 or fail → 0x27 |
| 0x45 | — | In transit back to lobby. On arrival → 0x27 |
| 0x27 | — | Parked. Reset to 0x20 at next day-start |

### Family `0x18` — Lobby

Passive transfer infrastructure. No sim behavior. Contributes to
route/transfer-group cache via carrier reachability. Never dispatched in tick-stride.

### Recycling Center (Types `0x14/0x15`)

The recycling center is a two-floor paired structure. The live checkpoint logic
operates on placed-object types `0x14` (upper floor) / `0x15` (lower floor).
`update_recycling_center_state` assigns their stay-phase tier and marks them dirty;
checkpoint `0x020` resets live type-`0x15` stacks from stay-phase `6` back to `0`.

The recycling adequacy check (`g_recycling_adequate_flag`) gates star progression
from 3→4 and 4→5. Required tier scales with population / `g_recycling_center_count`.

Bomb and fire response use transient helper entities seeded from the shared 10-slot
service-response pool rather than separate always-running placed-object actors.
These are part of the Security Office (`0x0e`) system, not the recycling center.

Note: family code `0x0f` is also used for the housekeeping entity (see above).
The type code and family code namespaces are independent — context determines which
is meant.
