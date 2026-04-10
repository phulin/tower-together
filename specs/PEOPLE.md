# Runtime Actors

This document covers shared actor behavior across people-like and transient simulation actors.

## Actor Kinds

Runtime actors include:

- hotel-room occupants
- office workers
- condo residents
- hotel guests visiting venues
- entertainment attendees
- evaluation visitors
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

- `0x0x`: idle or waiting
- `0x2x`: local active state
- `0x4x`: in transit
- `0x6x`: arrived at remote destination
- `0x27`: parked/night state

## Shared Routing Contract

Family handlers own intent; the routing layer owns movement.

Typical loop:

1. family chooses destination or next action
2. family requests one route leg
3. actor enters traveling state or queueing state
4. arrival hands control back to the family handler
5. family either continues the trip, begins an activity, or parks

## Shared Occupant Staggering

Multi-occupant facilities do not move all occupants identically. `base_offset` is used to stagger:

- trip timing
- venue type selection
- activation order
- sync behavior before checkout or reset

## Shared Night/Park Semantics

Many actor families use a parked or dormant nightly state. That state usually:

- suppresses routing
- waits for a daypart threshold
- resets or re-enters the family's daytime loop at the next activation window

## Stress / Operational Score

The game manual describes inhabitant "stress" as accumulating travel time, with three
visible bands (black ≤ 80, pink 80–119, red 120–300) and a quality formula. The
recovered binary shows this is **not** a separate per-actor stress counter. The
manual's "stress" is the same quantity as the facility operational score: average
inter-visit interval per tile, computed via `0x1000 / sample_count` (see
FACILITIES.md "Shared Readiness / Pairing Model").

The thresholds (80 / 150 / 200) match the `eval_level` grade cutoffs exactly.
There is no separate stress accumulator, no per-actor frustration counter, and no
behavioral branching based on a "stress" field. The A/B/C ratings displayed to the
player map directly to `eval_level` values 2/1/0.

A clean-room implementation should use the documented `compute_object_operational_score`
pipeline and threshold mapping. The manual's "stress" wording can be used in
player-facing labels without adding any simulation-level stress tracking.

## Runtime Entity Record Layout

| Offset | Size | Field | Notes |
|--------|------|-------|---------|
| `+0x00..+0x03` | 4B | reserved / link header | family-specific use |
| `+0x04` | byte | `family_code` | matches placed object's family |
| `+0x05` | byte | `state_code` | the entity state machine byte |
| `+0x06` | byte | `route_mode` / family selector | read by route resolution |
| `+0x07` | byte | `spawn_floor` / source floor | written when route begins |
| `+0x08` | byte | `route_carrier_or_segment` | `0x40+i` = carrier i up, `0x58+i` = down, `0xfe` = invalid, `0xff` = none |
| `+0x09` | byte | `sample_count` | feeds operational score (see FACILITIES.md) |
| `+0x0a` | word | `route_queue_tick` | `g_day_tick` snapshot when queued |
| `+0x0c` | word | `target_floor_packed` | `(10 - floor) * 0x400`, or elapsed/flags packed |
| `+0x0e` | word | `accumulated_elapsed` | running sum for demand pipeline |

Save/load must preserve all 16 bytes per entity to round-trip the demand pipeline.

---

## Per-Family State Machines

Each family has a **gate handler** (states < 0x40) that decides whether to dispatch,
and a **dispatch handler** (states >= 0x40 or when gate allows) that performs routing
and state transitions. States `0x4x` are in-transit aliases of `0x0x`; states `0x6x`
are at-destination aliases of `0x2x`.

### Family `0x0f` — Vacancy Claimant

Transient entity that searches for and claims vacant hotel rooms. One per hotel room
entity slot. Not a persistent occupant.

Entity fields: `+6` = target floor (`0x58` = searching), `+7` = spawn floor
(negative = uninitialized), `+0xa` = pending countdown (set to 3 on claim).

| State | Behavior |
|-------|----------|
| 0 | **Initial search**: if `[+7] < 0` → store current floor. Call `find_matching_vacant_unit_floor`. Write `0x58` to `[+6]`. Fall through to route setup |
| 1/4 | **Route to candidate floor**: resolve route using `[+7]` as destination. Result 0/1/2 → state 4. Result 3 or fail → state 0 |
| 3 | **Route to room floor**: resolve route using `[+6]`. Result 0/1/2 → stay at 3. Result 3 + valid daytime (`day_tick < 0x05dc`) → `activate_selected_vacant_unit`, state 2, `[+0xa] = 3`. Otherwise → state 0 |
| 2 | **Pending countdown**: if `[+0xa] != 0` → decrement, return. If 0 → `flag_selected_unit_unavailable`, state 0 |

Vacant-room search scope: rentable units (families 3/4/5) in the same modulo-6 floor
group (`floor / 6`). Claim writes guest entity ref into the room's ServiceRequestEntry
sidecar, sets `room.unit_status = rand(2..14)`, sets `room[+0x13] = 1` (occupied).

### Families `3`, `4`, `5` — Hotel Room Occupants

Per-room entity count: family 3 = 1, family 4 = 2, family 5 = 3.
Lifecycle: check-in → venue trips → sibling sync → checkout → vacancy.

#### Gate Table (states < 0x40)

| State | Gate condition |
|-------|---------------|
| 0x20 | if `room[+0x14] != 0`: daypart 4 → 1/12 chance; daypart > 4 and tick < 0x8fc → dispatch |
| 0x01 | daypart == 4 → 1/6 chance (`day_counter % 6 == 0`); daypart > 4 → state 0x04 |
| 0x22 | daypart > 3 → dispatch |
| 0x04 | daypart > 4 AND (tick > 0x960 OR `day_counter % 12 == 0`) → dispatch |
| 0x10 | daypart < 5 OR (tick > 0xa06 AND `day_counter % 12 == 0`) → dispatch |
| 0x05 | daypart 0 → only if `day_counter % 12 == 0`; daypart 6 → no dispatch; else → dispatch |
| 0x26 | tick > 0x8fc → state 0x24 (if `[+0xa] == 0`) else state 0x20 |

#### Dispatch Table

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x20/0x60 | Route to hotel room. If 0x20: `assign_hotel_room` first (sets `unit_status = rand(2..14)`, encodes target floor). If `unit_status > 0x17` and no route-block: state → 0x26 | 0/1/2 → 0x60; 3 → `activate_family_345_unit` + `increment_unit_status` → 0x01 or 0x04; fail → clear/reset |
| 0x01/0x41 | Call `decrement_unit_status_345`. Route to commercial venue | 0/1/2 → 0x41; 3 → 0x22; fail → `increment_unit_status` → 0x04 |
| 0x22/0x62 | Release venue slot, route back | 0/1/2 → 0x62; 3 → `increment_unit_status` → 0x04; fail → 0x04 |
| 0x04 | Sibling sync: state → 0x10. `sync_unit_status_if_all_siblings_ready_345`: family 3 → unconditional; family 4/5 → if `unit_status & 7 == 1` OR sibling at 0x10 → write `unit_status = 0x10` | |
| 0x10 | If `unit_status == 0x10`: family 3 → `unit_status = 1`; family 4/5 → `unit_status = 2`. State → 0x05 | |
| 0x05/0x45 | `decrement_unit_status_345`. If `unit_status & 7 == 0`: checkout (set `unit_status = 0x28`/`0x30`, clear occupancy, credit income, increment sale count). Route to lobby | 0/1/2 → 0x45; 3 → 0x20 (reset); fail → 0x20 if vacant, else increment |

`activate_family_345_unit`: sets `unit_status` to 0 (morning) or 8 (evening), marks
dirty, adds to population ledger (+1/+2/+2 for families 3/4/5).

### Family `7` — Office Workers

6 entities per office (one per tile). Recurring cashflow on 3-day cadence.

#### Gate Table (11 entries)

| State | Gate condition |
|-------|---------------|
| 0x00 | daypart ≥ 4 → state 0x05; daypart 1–3 → dispatch; daypart 0 → 1/12 chance |
| 0x01 | daypart ≥ 4 → state 0x05; daypart 2–3 → dispatch; daypart 1 → 1/12 chance; daypart 0 → wait |
| 0x02 | (shared with 0x01) |
| 0x05 | daypart == 4 → 1/6 chance; daypart > 4 → dispatch |
| 0x20 | `calendar_phase_flag != 0` → skip; `eval_active_flag != 0` required; daypart 0 → 1/12; daypart 1–2 → dispatch; daypart ≥ 3 → dispatch |
| 0x21 | daypart ≥ 4 → dispatch; daypart 3 → 1/12 chance; daypart < 3 → wait |
| 0x22 | daypart ≥ 4 → state 0x27 + release request; daypart ≥ 2 → dispatch; daypart < 2 → wait |
| 0x23 | (shared with 0x22) |
| 0x25 | `day_tick > 2300` → state 0x20; else wait |
| 0x26 | (shared with 0x25) |
| 0x27 | (shared with 0x25) |

#### Dispatch Table (16 entries, `0x0x`/`0x4x`/`0x6x` share handlers)

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x00/0x40 | Route from floor 10 → assigned floor | 0–2 → 0x40; 3 → 0x21; fail → 0x26 |
| 0x01/0x41 | `route_entity_to_commercial_venue(2, ...)` | fail → 0x26 + release request |
| 0x02/0x42 | Continue venue transit, resolve route to venue floor | 0–2 → 0x42; 3 → `try_claim_office_slot`: claimed → 0x23, busy → 0x42, none → 0x41 |
| 0x05/0x45 | Route from assigned floor to lobby (floor 10) | 0–2 → 0x45; fail → 0x26 |
| 0x20/0x60 | If 0x20: `assign_hotel_room` then route to assigned floor. If 0x60: continue | 0–2 → 0x40; 3 → 0x21 |
| 0x21/0x61 | Route to floor 10 (0x21) or saved floor (0x61) | 0–2 → 0x61; 3 → `advance_unit_status_or_wrap` |
| 0x22/0x62 | Release venue slot, route home | 0–2 → 0x62; 3 → `advance_unit_status_or_wrap`; fail → failure |
| 0x23/0x63 | Enforce 16-tick venue dwell, then route to saved target | 0–2 → 0x63; 3 → `advance_unit_status_or_wrap`; if `base_offset == 1` → 0x00 else → 0x05 |

`advance_unit_status_or_wrap`: increments trip counter, wraps back to start when
per-family bound is reached. Next state: `base_offset == 1` → 0x00 (idle); else → 0x05.

### Family `9` — Condo Residents

3 entities per condo. Sale fires once on first successful route while unsold.

#### Gate Table (states < 0x40)

```
State 0x10: daypart < 5 → dispatch; daypart >= 5 AND day_tick > 0xa06 → 1/12 chance
State 0x00: daypart == 0 AND day_tick > 0xf0 → 1/12 chance; daypart 6 → no-op; else → dispatch
State 0x01: if calendar_phase_flag == 1 AND subtype_index % 4 == 0 → SPECIAL PATH; else same as 0x00
State 0x04: base_offset == 2 → daypart >= 5 → dispatch; else daypart >= 5, day_tick > 0x960 OR 1/12 chance
```

**State 0x01 SPECIAL PATH** (`calendar_phase_flag == 1` AND `subtype_index % 4 == 0`):
- daypart < 4 → no action (wait)
- daypart == 4 → `rand() % 6 == 0` → normal dispatch; else wait
- daypart > 4 → force state 0x04 (skip trip cycle)

#### Dispatch Table

| States | Operation | Route outcomes |
|--------|-----------|----------------|
| 0x10 | If `unit_status == 0x10`: rewrite to 3, mark dirty. If `calendar_phase_flag == 1`: odd subtype → INC unit_status → 0x04; even → 0x01. Else: `base_offset == 1` → 0x01; else → 0x00 | |
| 0x01/0x41 | If 0x01: DEC unit_status. Choose venue selector by calendar phase + subtype parity. Route to commercial venue | fail → INC unit_status → 0x04; else → 0x41 |
| 0x20/0x60 | Route to commercial venue. **SALE POINT**: if `unit_status >= 0x18` and route succeeds → `activate_commercial_tenant_cashflow` (credit sale, reset unit_status to 0/8, +3 ledger) | fail + unsold → 0x20; fail + sold → INC → 0x04; success + unsold → 0x60 (SALE); arrived → 0x04 |
| 0x21/0x61 | Route to floor 10 / saved floor | 0–2 → 0x61; fail or arrived → INC unit_status → 0x04 |
| 0x22/0x62 | Release venue, route home | fail/arrived → INC → 0x04 |
| 0x04 | State → 0x10. `try_set_parent_state_in_transit_if_all_slots_transit`: if `unit_status & 7 == 1` → shortcut `unit_status = 0x10`; else check all 3 siblings at 0x10 | |

Trip counter net effect per morning cycle: even tiles DEC, odd tile INC → net −1.
After ~2 cycles from 3, unit_status reaches 1 → sync shortcut → back to 0x10.

### Families `0x12`, `0x1d` — Entertainment Entities

4-entry gate table (states < 0x40); 8-entry dispatch table.

| State | Behavior |
|-------|----------|
| 0x20 | Check phase budget gate (forward or reverse byte). If 0 → blocked. Else decrement, route from floor 10 to entertainment floor | 0/1/2 → 0x60; 3 → increment counters (runtime count + attendance), promote phase 1→2 → 0x03; fail → 0x20 or 0x27 |
| 0x03 | At venue — waits for `advance_entertainment_facility_phase`. On advance: if family 0x1d OR not `pre_day_4()` → 0x05; else → 0x01. Decrement `active_runtime_count` |
| 0x05/0x45 | Route to reverse floor, then to floor 10 | 0/1/2 → 0x45; 3 or fail → 0x27 |
| 0x01/0x41 | If 0x01: pick random commercial venue (`rng() % 3`). Route to venue | 0/1/2 → 0x41; 3 → acquire slot → 0x22 or overcapacity → 0x41; fail → 0x27 |
| 0x22/0x62 | Release venue slot (min-stay enforced), route to floor 10 | 0/1/2 → 0x62; 3 or fail → 0x27 |
| 0x27 | Parked (night) |

### Family `0x21` — Hotel Guest

Visits commercial venues during the day. Not tied to hotel revenue.

| State | Gate | Dispatch |
|-------|------|----------|
| 0x01 | dayparts 0–3, tick > 0x0f1, `rng() % 36 == 0` | Pick random venue (uniform: `rng() % 3` → type, bucket 0). Route to venue floor (source = `hotel_floor + 2`). Success → 0x41; arrived + slot → 0x22; arrived + overcapacity → 0x41; fail → 0x27 |
| 0x41 | (in-transit) | Delegates to family 0x12/0x1d dispatch |
| 0x22 | No daypart restriction | Release venue slot (min-stay enforced). Route to hotel floor. 0/1/2 → 0x62; 3 → 0x01; fail → 0x27 |
| 0x62 | (in-transit back) | Delegates to family 0x12/0x1d dispatch |
| 0x27 | `day_tick >= 0x8fd` → state 0x01 | (parked) |

### Families `0x24`–`0x28` — Cathedral Evaluation Visitors

Types 0x24–0x28 are the 5 per-floor slices of the cathedral building (bottom to top).
Each floor hosts 8 runtime entity slots → 5 floors × 8 = 40 evaluation visitors.

Binary-verified from `gate_object_family_24_state_handler` at `1228:5b5a`,
`handle_evaluation_entity_outbound_route` at `1228:5ddd`,
`handle_evaluation_entity_return_route` at `1228:5e7e`.

**Daily spawn** (`activate_upper_tower_runtime_group`, checkpoint 0x000):
when `g_eval_entity_index >= 0` (cathedral placed) and `star_count > 2`,
sweeps floors 100–104 for types 0x24–0x28, forces 8 entity slots each to state 0x20.

**Gate** (state 0x20):
- Requires `calendar_phase_flag == 1`
- `daypart_index == 0`: staggered dispatch — `sample_lcg15() % 12 == 0` (1/12 chance)
  per tick after `g_day_tick > 0x50` (80); guaranteed every tick after `g_day_tick > 0xf0` (240)
- `daypart_index >= 1`: missed dispatch window → state 0x27 (parked)

**Selector** (`resolve_family_24_selector_value`):
- State 0x45 → target floor 0 (lobby)
- State 0x60 → target floor 100 (cathedral base)

| State | Gate | Behavior |
|-------|------|----------|
| 0x20 | `calendar_phase_flag == 1`, daypart 0, stagger | Route from floor 0 to floor 100 (cathedral). Result: 0/1/2 → 0x60; 3 → 0x03 + award check; fail → 0x27 |
| 0x60 | — | In transit to cathedral. On arrival → 0x03 + `check_evaluation_completion_and_award` |
| 0x03 | — | Arrived. If `g_day_tick < 800` and all 40 in state 0x03 and ledger tier > star_count → Tower promotion. Otherwise stamp object `aux = 3, dirty = 1` |
| 0x05 | — | Midday return (set by `dispatch_evaluation_entity_midday_return` at checkpoint 0x04b0). Route from floor 100 to floor 0. Result: 0/1/2 → 0x45; 3 or fail → 0x27 |
| 0x45 | — | In transit back to lobby. On arrival → 0x27 |
| 0x27 | — | Parked. Reset to 0x20 at next day-start |

### Family `0x18` — Lobby

Passive transfer infrastructure. No runtime entity behavior. Contributes to
route/transfer-group cache via carrier reachability. Never dispatched in tick-stride.

### Family `0x0e` — Security Guard / Family `0x0f` — Housekeeping Cart

These are placed-object types, not actor families with dispatch state machines.
State managed by security/housekeeping checkpoint system. Security guard (type 0x0e)
state reset to 0 at day start; housekeeping cart (type 0x0f) state reset 6→0 at
checkpoint 0x020. Stay-phase set to required tier by `update_security_housekeeping_state`.

Note: family code `0x0f` is also used for the vacancy claimant entity (see above).
The type code and family code namespaces are independent — context determines which
is meant.
