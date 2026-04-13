# Office

Family `7` is the office family.

This file now does both jobs:

- the top half describes office behavior in gameplay terms suitable for reimplementation
- the lower "Authoritative Parity" sections preserve the binary-derived transition rules needed for tick-for-tick fidelity

[`OFFICE-BINARY.md`](/Users/phulin/Documents/Projects/reaper/specs/facility/OFFICE-BINARY.md) remains as a provenance copy of the reverse-engineering notes, but `OFFICE.md` is now the single file that should be sufficient for both clean reimplementation and strict parity work.

## High-Level Identity

An office is a rentable daytime workplace.

- each office represents one business tenant
- a leased office contributes `6` workers to the tower population
- offices produce recurring income while occupied
- office workers create strong commuter traffic in the morning and evening
- office workers are a major source of midday fast-food demand

From a design perspective, offices are one of the main ways the game tests whether the tower's transportation network actually works.

## What The Player Should Experience

Offices should behave like this from the player's point of view:

1. The player places office space.
2. The office appears vacant and available for rent.
3. The office becomes occupied only after workers can successfully reach it from the lobby.
4. Once occupied, the office begins contributing population and recurring rent.
5. During the day, workers arrive, work, go out for lunch, return, and eventually leave.
6. The office's evaluation reflects whether it is a good place to work.
7. If conditions remain poor, the tenant eventually moves out and the office returns to the vacant state.

The key gameplay rule is that an office is not operational merely because it was built. It must be supportable by the real movement network.

## Core Office Model

A clean implementation only needs semantic state such as:

- lease status: vacant or occupied
- current rent tier
- current evaluation / satisfaction
- tenant age or occupancy duration
- whether the office is operational
- current visible activity level
- roster of `6` workers attached to the office

The original game encoded these concepts in tightly packed status bytes. A new implementation should preserve the behavior, not the encoding.

## Leasing And Opening

Placing an office creates a vacant office space, not an instantly functioning tenant.

- new offices start vacant
- default placement uses the standard office rent tier
- a vacant office opens only after at least one worker successfully reaches it from the lobby through the actual route network
- structural adjacency alone is not enough; the route must resolve

When the office opens:

- mark it occupied
- add `6` to the office population ledger
- begin recurring office income
- begin simulating the tenant's workers as active users of the tower

If worker access repeatedly fails, the office should remain vacant rather than faking occupancy.

## Daily Worker Simulation

Each office has `6` workers. They should be staggered rather than moved as a single synchronized group.

The intended daily pattern is:

- morning commute from lobby to office
- daytime work presence
- midday lunch trips, primarily to fast food
- short lunch dwell
- return to office
- evening departure from office to lobby
- overnight absence until the next morning

Preserve these gameplay effects:

- offices create upward morning traffic from the lobby
- offices create midday traffic toward fast-food businesses
- offices create downward evening traffic to the lobby
- workers stop starting new lunch trips once the day is late enough that they should be winding down

## Routing Requirements

Offices should use the same transportation and routing systems as other tower occupants.

- opening requires a valid route from lobby to office
- lunch trips require a valid route from office to an eligible fast-food venue
- evening departure requires a valid route from office back to the lobby
- route failures should hurt the office through missed trips, added stress, delayed opening, or eventual closure

The exact internal route-state representation does not matter for reimplementation. What matters is that office demand consumes real network capacity and reveals transportation weaknesses.

## Evaluation

Office evaluation should reflect how workable the office is for its employees.

The behavior to preserve is:

- better transportation access improves evaluation
- higher rent makes offices harder to keep satisfied
- nearby noisy commercial uses can reduce office quality
- evaluation should reflect the average experience of the office's workers over time, not a single momentary failure

This keeps office performance tied to tower design rather than to arbitrary scripted events.

## Closure And Re-Leasing

An occupied office should not vacate because of one bad commute. Closure should represent sustained dissatisfaction.

Recommended behavior:

- while evaluation remains acceptable, keep the tenant
- if evaluation sits in a failing band for long enough, the tenant leaves
- when the tenant leaves:
  - stop office income
  - remove `6` from the population ledger
  - clear worker presence/activity from the office
  - return the office to the vacant / for-rent state

The office can then be leased again when worker access succeeds on a later day.

## Rent

Offices use discrete rent tiers rather than freeform pricing.

Known recurring payouts are:

| Tier | Recurring payout |
|---|---:|
| 0 | `$15,000` |
| 1 | `$10,000` |
| 2 | `$5,000` |
| 3 | `$2,000` |

Default placement tier is `1`.

For a reimplementation, preserve the tradeoff:

- higher rent increases income
- higher rent increases tenant dissatisfaction pressure
- lower rent can be used to stabilize a struggling office

## Environmental Sensitivity

Offices are locally sensitive to noisy nearby commercial uses.

- nearby restaurants, fast food, retail, and entertainment can reduce office quality
- the penalty should be local rather than tower-wide
- offices are primarily judged by worker access and local operating conditions

The new implementation does not need to preserve the original byte-level neighborhood checks unless exact parity is required.

## UI Expectations

A replacement UI should clearly communicate:

- vacant / for-rent status
- occupied / operating status
- current evaluation
- current rent tier
- visible daytime activity level
- major complaints such as poor access, excessive noise, or high rent

Inspection UI is more useful if it explains why an office is struggling rather than only showing a raw score.

## Relationship To Other Specs

This office model depends on and should stay aligned with:

- [ECONOMY.md](/Users/phulin/Documents/Projects/reaper/specs/ECONOMY.md)
- [DEMAND.md](/Users/phulin/Documents/Projects/reaper/specs/DEMAND.md)
- [FACILITIES.md](/Users/phulin/Documents/Projects/reaper/specs/FACILITIES.md)
- [`COMMERCIAL.md`](/Users/phulin/Documents/Projects/reaper/specs/facility/COMMERCIAL.md)

Use those docs for shared systems. For exact office timing and state behavior, the parity sections below are authoritative.

## Authoritative Parity Scope

The remainder of this file uses binary state IDs where necessary. Those IDs are included because a faithful reimplementation needs them to preserve:

- exact stored-state bands and byte semantics
- activation/deactivation cadence details
- worker state-machine encodings
- route-result transition tables
- presence-counter mechanics
- queued-car callback behavior

These sections are the contract to follow if the goal is perfect or near-perfect parity.

## Parity: Identity

- population: 6 workers
- recurring positive cashflow while operational
- workers generate fast-food demand during their trip cycle

## Parity: Rent Payouts

Office payout per activation is determined by `rent_level`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$15,000` | `$10,000` | `$5,000` | `$2,000` |

Default placement tier is `1`.

## Parity: Placement And Stored State

When an office is placed, the simulation initializes separate fields for:

- rental / occupancy status
- visual variant seed
- dirty / refresh state
- operational-evaluation active latch
- operational score
- rent tier
- activation age / cumulative uptime

The initial office values are:

- rental status = open-band value `0`
- visual variant = the next value from the rotating office variant counter
- dirty / refresh state = dirty
- operational-evaluation active latch = active
- operational score = unsampled / unset
- rent tier = `1`
- activation age = `0`

The operational-evaluation active latch is not the vacancy/rental flag. A newly placed, not-yet-rented office already has that latch enabled, so "For Rent" cannot be derived from it.

Office rental/open state and office operational score are stored as separate concepts. The selected-object status text treats rental-status values above `0x0f` as vacant/"For Rent" and values `<= 0x0f` as occupied/open.

Normal office placement also creates the six worker runtime entities immediately. They are not created lazily at rental time. Each worker starts with family `7`, `occupant_index` `0..5`, state `0x20`, no active route token, no saved route floor, and zeroed timing state.

## Parity: Readiness Scoring

Office readiness is computed from:

- per-sim activity average across the office's population
- rent-tier modifier
- noise penalty when a commercial/entertainment neighbor is within 10 tiles

The result maps into the shared readiness grades `2`, `1`, or `0`.

## Parity: Activation And Deactivation

Open offices:

- contribute to the population ledger
- realize cashflow on the 3-day activation sweep and again on worker-arrival reopen paths
- increment `activation_tick_count`

Deactivated offices:

- move into a deactivated `unit_status` band
- clear readiness latch state
- clear activation tick count
- stop contributing recurring cashflow

Operational status and pairing:

- office readiness is recomputed by the shared `recompute_object_operational_status` path used by families `7`, `9`, and `10`
- the recomputed `pairing_state` byte is a 3-level operational grade, not just a boolean paired/unpaired flag:
  - `0`: unpaired / failed readiness
  - `1`: operational but only in the lower passing band
  - `2`: strong readiness, waiting to pair with another same-family unit on the floor
- the companion `pairing_active_flag` latches whether the office has entered a successful operational pairing and is used by the vacancy-expiry path
- the score thresholds feeding `pairing_state` are star-rating dependent shared thresholds, so office operational grade tightens as the tower star rating rises

Exact open/closed bands:

- `0x00..0x0f`: open / active
- `0x10`: deactivated in early-day regime
- `0x18`: deactivated in late-day regime

Activation cadence:

- `recompute_object_operational_status` runs every day
- office activation and deactivation cashflow changes only run on the `day_counter % 3 == 0` cadence at the daily sweep; because the sweep runs after the day-counter increment, a fresh game first hits this cadence at `day_counter == 3`, not day 0
- activation increments `activation_tick_count` up to a cap of 120; this is cumulative, not per-day, and resets to 0 only on deactivation
- fresh reopen after a close resets `unit_status` to `0`, adds `+6` to the population ledger, and refreshes the 6-tile span

Deactivation trigger:

- if `eval_level == 0` and the office is still in the active band, deactivation writes the office back into a vacant band: `unit_status = 0x10` in the early-day regime, or `unit_status = 0x18` in the late-day regime
- deactivation clears `occupied_flag`
- deactivation resets `activation_tick_count`
- deactivation subtracts the office's recurring contribution from cash and removes `6` from the population ledger
- deactivation sets the dirty / visual refresh byte, so the next object-status draw sees the "For Rent" band through `unit_status > 0x0f`
- after a deactivation, the same-floor scan (`refresh_occupied_flag_and_trip_counters`) may immediately re-pair it with a same-floor, same-family slot whose `pairing_state == 2`
- a successful match promotes both offices to `pairing_state == 1`, sets `pairing_active_flag`, and refreshes the office span
- if `pairing_state >= 1` when the pairing helper runs, the helper does not search; it just asserts `pairing_active_flag` and refreshes

Low evaluation is split by severity. A low but nonzero `eval_level` changes the operational score and keeps the office open. A zero `eval_level` closes an occupied office back into the vacant/"For Rent" band and clears the evaluation latch.

Worker arrival does not run the shared readiness/evaluation recompute. Arrival helpers for families `3/4/5/7` only adjust the office stay/rental-status countdown and mark the room dirty for redraw.

Visible status changes are driven by the status-and-dirty path. Activation sets the office to the occupied/open status, marks it dirty, and refreshes the office span. Deactivation writes the vacant status band, clears the operational-evaluation active latch, clears activation age, and marks the room dirty.

## Parity: Worker Loop

Workers alternate between:

- idle/working in the office
- routing to lunch
- dwelling at lunch
- routing back

Workers are staggered by `occupant_index`, which is the worker's zero-based slot index within the 6-worker office runtime group.

Worker-cycle timing:

- idle state dispatches probabilistically in early dayparts, then more aggressively through the workday
- lunch-trip states stop dispatching once late-day cutoff handling begins
- venue dwell uses a fixed 16-tick hold before the return leg can start
- workers use the shared route queue / commercial-slot pipeline, with `0x4x` and `0x6x` as in-transit state aliases for their corresponding base states
- late-day placement leaves fresh state-`0x20` workers parked until the next morning gate; daypart `>= 3` does not depart them or convert them to another state
- end-of-day reset parks family-7 workers in hidden state `0x27` with route fields cleared; the next morning loop moves parked states back to `0x20` only after `day_tick > 2300`

### Gate Table

- `0x00`: daypart `>= 4` forces state `0x05`. Occupant `0`: daypart `0` -> 1/12 chance (`rand() % 12 == 0`), dayparts `1..3` -> dispatch. Occupant `!= 0`: dayparts `0..2` -> no dispatch, daypart `3` -> 1/12 chance
- `0x01` and `0x02`: daypart `>= 4` forces state `0x05`; daypart `0` waits; daypart `1` -> 1/12 chance; dayparts `2..3` -> dispatch
- `0x05`: daypart `4` -> 1/6 chance (`rand() % 6 == 0`); dayparts `5..6` -> dispatch; daypart `< 4` -> no dispatch
- `0x20`: blocked when `calendar_phase_flag != 0`; requires `occupied_flag != 0`; daypart `0` -> 1/12 chance; dayparts `1..2` -> dispatch; daypart `>= 3` -> no dispatch
- `0x21`: daypart `>= 4` -> force state `0x27` and release service request; daypart `3` -> 1/12 chance; dayparts `0..2` -> no dispatch
- `0x22` and `0x23`: daypart `>= 4` forces `0x27` and releases the service request; dayparts `2..3` -> dispatch; dayparts `0..1` -> no dispatch
- `0x25`, `0x26`, and `0x27`: remain parked until `day_tick > 2300`, then force state `0x20`

Entry meanings for the parked states:

- `0x25`: route failure on the rental/opening path (`0x20/0x60`) when office is already open
- `0x26`: route failure from any other dispatch (`0x00`, `0x01`, `0x05`, `0x21`, `0x22`, `0x23`)
- `0x27`: successful evening arrival at lobby (`0x05` result 3), or forced late-day parking from the gate (`0x21`/`0x22`/`0x23` when daypart `>= 4`)

### Dispatch Table

- `0x00` / `0x40`: route from lobby floor `0` (EXE raw floor `10`) to the assigned office floor; queued or en-route results stay in `0x40`, same-floor arrival becomes `0x21`, and failure becomes `0x26` plus service-request release
- `0x01` / `0x41`: route from office to lunch (fast-food bucket, selector `2`); failure returns to `0x26` and releases the service request
- `0x02` / `0x42`: continue lunch transit toward the saved fast-food venue floor-zone index; same-floor arrival tries to claim the office slot and either enters `0x23` or keeps waiting
- `0x05` / `0x45`: route from the office floor back to lobby floor `0` (EXE raw floor `10`); on first dispatch (`0x05`, not `0x45`), call `decrement_office_presence_counter` regardless of route result; queued and en-route results stay in `0x45`, same-floor arrival becomes `0x27` and releases the service request, failure becomes `0x26` and releases the service request
- `0x20` / `0x60`: assign a service request destination on first entry, then route from lobby floor `0` / EXE raw floor `10` to the assigned office floor; if route resolution fails while the office is still vacant, the worker returns to `0x20` and its route fields are cleared; if route resolution fails while the office is already open (`unit_status < 0x10`), the worker is parked at `0x25`; if route resolution succeeds with return code `0`, `1`, or `2`, a vacant office is activated and the worker enters `0x60`; same-floor success (`3`) also activates a vacant office, calls `advance_office_presence_counter`, then branches on `occupant_index`: occupant `0` -> `0x00`; occupant `!= 0` -> `0x01` or `0x02`
- `0x21` / `0x61`: route either to lobby or the saved floor; queued or en-route results enter `0x61`, same-floor arrival calls `advance_office_presence_counter` then always transitions to `0x05`, failure becomes `0x26` and releases the service request
- `0x22` / `0x62`: release the lunch-venue slot, route home; same-floor arrival calls `advance_office_presence_counter` then checks `occupant_index == 1` -> `0x00`, else -> `0x05`; failure becomes `0x26` and releases the service request
- `0x23` / `0x63`: enforce the 16-tick lunch dwell, then route to the saved target; same-floor arrival calls `advance_office_presence_counter` then checks `occupant_index == 1` -> `0x00`, else -> `0x05`; failure becomes `0x26` and releases the service request

### Full State-Byte Transition Table

This table describes the full worker `state_code` byte, not `state & 0x3f`. For the in-transit aliases, runtime byte `+8` decides whether continuation is direct-route (`entity[+8] < 0x40`) or queued-car (`entity[+8] >= 0x40`).

For direct-route continuation, the in-transit aliases reuse the same route-result logic as their corresponding base states. The queued-car callback only applies to in-transit states that reached the carrier queue path.

| State | Meaning | Gate / entry condition | Transition |
|---|---|---|---|
| `0x00` | At-office daytime path | daypart `>= 4` | force `0x05` |
| `0x00` | At-office daytime path | occupant 0, daypart `0`, `rand() % 12 == 0` | dispatch office-floor route; result `0/1/2 -> 0x40`, `3 -> 0x21`, `-1 -> 0x26` |
| `0x00` | At-office daytime path | occupant 0, dayparts `1..3` | dispatch office-floor route; result `0/1/2 -> 0x40`, `3 -> 0x21`, `-1 -> 0x26` |
| `0x00` | At-office daytime path | occupant `!= 0`, daypart `3`, `rand() % 12 == 0` | dispatch office-floor route; result `0/1/2 -> 0x40`, `3 -> 0x21`, `-1 -> 0x26` |
| `0x01` | Lunch-trip start | daypart `>= 4` | force `0x05` |
| `0x01` | Lunch-trip start from office | daypart `1`, `rand() % 12 == 0`; or dayparts `2..3` | dispatch via `route_entity_to_commercial_venue(2, ...)`; selector `2` maps to fast food, so route `0/1/2 -> 0x41`, route `3 -> 0x42` or `0x23` depending on later venue-floor resolution, route `-1 -> 0x26` + release request |
| `0x02` | Lunch-trip return | daypart `>= 4` | force `0x05` |
| `0x02` | Lunch-trip return | dayparts `2..3` | dispatch continuation; result `0/1/2 -> 0x42`, `3 -> try_claim_office_slot` then `claimed -> 0x23`, `busy -> 0x42`, `none -> 0x41`, `-1 -> 0x26` + release |
| `0x05` | Evening departure from office floor to lobby | daypart `4`, `rand() % 6 == 0`; or dayparts `5..6` | first dispatch decrements office presence; route `0/1/2 -> 0x45`, route `3 -> 0x27` + release, route `-1 -> 0x26` + release |
| `0x20` | Morning commute in / office opening | `calendar_phase_flag != 0` or `occupied_flag == 0` | no dispatch |
| `0x20` | Morning commute in / office opening | daypart `0`, `rand() % 12 == 0`; or dayparts `1..2` | assign service request on exact state `0x20`, then dispatch lobby-to-office route; result `-1 -> 0x20` if still vacant else `0x25`, `0/1/2 -> activate office if vacant, then 0x60`, `3 -> activate office if vacant, advance presence, then occupant `0 -> 0x00`, occupant `!= 0 -> 0x01` or `0x02`` |
| `0x21` | Post-arrival office-floor path | daypart `>= 4` | write `0x27` + release service request |
| `0x21` | Post-arrival office-floor path | daypart `3`, `rand() % 12 == 0` | dispatch route; result `0/1/2 -> 0x61`, `3 -> advance presence -> 0x05`, `-1 -> 0x26` + release |
| `0x22` | Return from lunch | daypart `>= 4` | write `0x27` + release service request |
| `0x22` | Return from lunch | dayparts `2..3` | release lunch slot, dispatch route home; result `0/1/2 -> 0x62`, `3 -> advance presence, occupant_index == 1 -> 0x00, else -> 0x05`, `-1 -> 0x26` + release |
| `0x23` | At lunch | daypart `>= 4` | write `0x27` + release service request |
| `0x23` | At lunch | dayparts `2..3` and dwell timer ready | dispatch route to saved target; result `0/1/2 -> 0x63`, `3 -> advance presence, occupant_index == 1 -> 0x00, else -> 0x05`, `-1 -> 0x26` + release |
| `0x25` | Parked after rental/opening failure while office already open | `day_tick > 2300` | force `0x20` |
| `0x26` | Parked after route failure/cancellation | `day_tick > 2300` | force `0x20` |
| `0x27` | Parked after evening arrival or late-day forced park | `day_tick > 2300` | force `0x20` |
| `0x40` | In-transit alias of `0x00` | `entity[+8] < 0x40` on refresh | same as `0x00` direct continuation: result `0/1/2 -> 0x40`, `3 -> 0x21`, `-1 -> 0x26` |
| `0x40` | In-transit alias of `0x00` | queued-car callback | `advance_office_presence_counter` -> `0x05` |
| `0x41` | In-transit alias of `0x01` | `entity[+8] < 0x40` on refresh | same as `0x01` direct continuation: failed lunch route -> `0x26` + release; otherwise continue into `0x42`/`0x23` |
| `0x41` | In-transit alias of `0x01` | queued-car callback | `advance_office_presence_counter` -> `0x05` |
| `0x42` | In-transit alias of `0x02` | `entity[+8] < 0x40` on refresh | same as `0x02` direct continuation: result `0/1/2 -> 0x42`, `3 -> claimed 0x23 / busy 0x42 / none 0x41`, `-1 -> 0x26` + release |
| `0x42` | In-transit alias of `0x02` | queued-car callback | `advance_office_presence_counter` -> `0x05` |
| `0x45` | In-transit alias of `0x05` | `entity[+8] < 0x40` on refresh | same as `0x05` direct continuation: result `0/1/2 -> 0x45`, `3 -> 0x27`, `-1 -> 0x26` + release |
| `0x45` | In-transit alias of `0x05` | queued-car callback | `0x26` + release request |
| `0x60` | In-transit alias of `0x20` | `entity[+8] < 0x40` on refresh | same as `0x20` direct continuation: result `-1 -> 0x20` if vacant else `0x25`, `0/1/2 -> 0x60`, `3 -> advance presence then `0x00`/`0x01`/`0x02`` |
| `0x60` | In-transit alias of `0x20` | queued-car callback | `0x26` + release request |
| `0x61` | In-transit alias of `0x21` | `entity[+8] < 0x40` on refresh | same as `0x21` direct continuation: result `0/1/2 -> 0x61`, `3 -> advance presence -> 0x05`, `-1 -> 0x26` + release |
| `0x61` | In-transit alias of `0x21` | queued-car callback | `0x26` + release request |
| `0x62` | In-transit alias of `0x22` | `entity[+8] < 0x40` on refresh | same as `0x22` direct continuation: result `0/1/2 -> 0x62`, `3 -> advance presence then `0x00` or `0x05``, `-1 -> 0x26` + release |
| `0x62` | In-transit alias of `0x22` | queued-car callback | `0x26` + release request |
| `0x63` | In-transit alias of `0x23` | `entity[+8] < 0x40` on refresh | same as `0x23` direct continuation: result `0/1/2 -> 0x63`, `3 -> advance presence then `0x00` or `0x05``, `-1 -> 0x26` + release |
| `0x63` | In-transit alias of `0x23` | queued-car callback | `0x26` + release request |

The rental condition is a real route-resolution success, not a purely structural connectivity flag. Offices require a route from the lobby to the office floor through the shared resolver. When no valid route exists, the vacant office remains in the for-rent band until a later retry succeeds.

## Parity: Office Presence Counter

The presence counter is `unit_status` cycled within the active band (values `1..8`). The same field holds deactivation values `0x10` / `0x18` in the vacant bands, so the advance/decrement functions only operate while the office is active.

- `advance_office_presence_counter`: increments `unit_status`; wraps `8 -> 1`
- `decrement_office_presence_counter`: decrements `unit_status`; if it reaches `0` and daypart `>= 4`, resets to `8`
- both always mark dirty, triggering a visual refresh

### When Advance Fires

| Context | Behavior |
|---|---|
| queued-car arrival for `0x40` / `0x41` / `0x42` | advance counter, then write `0x05` |
| state `0x20` / `0x60` same-floor arrival | advance counter during immediate morning arrival |
| state `0x21` / `0x61` result `3` | advance counter, then `0x05` |
| state `0x22` / `0x62` result `3` | advance counter, then branch to `0x00` or `0x05` |
| state `0x23` / `0x63` result `3` | advance counter, then branch to `0x00` or `0x05` |

### When Decrement Fires

| Context | Behavior |
|---|---|
| state `0x00` first dispatch (not `0x40`) | decrement counter immediately, regardless of route result |
| state `0x01` first dispatch (not `0x41`) | decrement counter immediately, regardless of route result |
| state `0x02` first dispatch (not `0x42`) | decrement counter immediately, regardless of route result |
| state `0x05` first dispatch (not `0x45`) | decrement counter immediately, regardless of route result |

All four base states call `decrement_office_presence_counter` on their **first dispatch** (base state, not continuation/in-transit alias). The dispatch handler checks `[BP-4] == base_state_code` at each handler's exit and jumps to the shared decrement call at `1228:2a59` when the check passes. Continuation states (`0x4x`) have different `[BP-4]` values and skip the decrement.

The counter therefore tracks real-time worker presence in the office: it decrements whenever a worker begins a route leg away from the office, and increments whenever a worker arrives back.

## Parity: In-Transit Queue Arrival Handler

`dispatch_sim_behavior` fires when the queue drain delivers a family-7 worker from a carrier-backed in-transit state.

| State | Action |
|---|---|
| `0x40`, `0x41`, `0x42` | `advance_office_presence_counter` -> write state `0x05` |
| `0x45`, `0x60`, `0x61`, `0x62`, `0x63` | write state `0x26` and release service request |

States `0x40` / `0x41` / `0x42` are successful queued arrivals onto the office floor. States `0x45` / `0x60` / `0x61` / `0x62` / `0x63` are treated as error or cancellation paths and park the worker in `0x26`.

`0x4x` / `0x6x` should be read as in-transit states, not as a pure elevator bit. Runtime byte `+8` distinguishes the continuation mode:

- `entity[+8] < 0x40`: direct-route continuation, handled by the normal office state handler
- `entity[+8] >= 0x40`: queued-car continuation, handled later by queue-drain logic and this callback

Workers are staggered by the gate table, not by a bulk "queue all six workers" scheduler. Occupant `0` is the early-morning special case in state `0x00`; occupants `1..5` wait until the daypart-3 random gate. In the fresh-rental `0x20` path, each of the six existing worker entities is checked independently on its stride tick.

## Parity: No Fast Food Available (Lunch Fallback)

When state `0x01` dispatches and no fast-food venue exists (or all are dormant/closed), `select_random_commercial_venue_record_for_floor(2, origin_floor)` returns `-1`. The system degrades gracefully:

### Venue Lookup Failure Path

1. `route_sim_to_commercial_venue` stores the `-1` venue index into `entity[+6]` (becomes `0xff` as a byte).
2. `get_current_commercial_venue_destination_floor` reads `entity[+6]` as a signed byte (`-1`); since negative, it returns floor `10` (lobby) as the fallback destination.
3. `resolve_sim_route_between_floors` routes from the office floor to floor `10` (lobby).

### Route to Lobby Succeeds (Typical)

If the route resolves (result `0`/`1`/`2`):
- `entity[+5]` = `0x41` (in-transit to "venue", actually heading to lobby)
- `decrement_office_presence_counter` fires (first dispatch from `0x01`)
- Worker travels to the lobby

**On arrival via stairs/direct route** (`entity[+8] < 0x40`):
- Dispatch handler runs for state `0x41` (shares handler with `0x01`)
- `route_sim_to_commercial_venue` re-enters with state `0x41` (not `0x01`), reads `entity[+6]` = `-1` → destination floor `10` (lobby)
- Source floor = `entity[+7]` (current position, already at lobby)
- Same-floor route (result `3`) → `acquire_commercial_venue_slot(entity, -1)`
- `acquire_commercial_venue_slot` guards on `facility_slot_index >= 0`; for `-1`, skips all processing and returns `3`
- `route_sim_to_commercial_venue` sees acquire result `3` → writes `entity[+5]` = `0x22` (return from lunch)
- State `0x22` dispatches: `release_commercial_venue_slot(entity, -1)` guards on `facility_slot_index < 0`, sets `entity[+7]` = `10` (lobby), returns `1`
- Route resolves from lobby back to office floor → worker returns to office
- On arrival: `advance_office_presence_counter`, then `occupant_index == 1` → `0x00`, else → `0x05`

**On arrival via elevator** (`entity[+8] >= 0x40`, queued-car callback):
- `dispatch_sim_behavior` fires for state `0x41` → `advance_office_presence_counter` → state `0x05`
- Worker skips the lunch cycle entirely and enters evening departure

### Route to Lobby Fails (Edge Case)

If `resolve_sim_route_between_floors` returns `-1` (no path to lobby):
- `route_sim_to_commercial_venue` handles the failure specially for state `0x01`:
  - `entity[+5]` = `0x41`, `entity[+6]` = `0xff`, `entity[+7]` = `origin_floor`, `entity[+8]` = `0xff`
  - Returns `0x40` (not `-1`), so the caller does not see a failure
- `decrement_office_presence_counter` still fires
- Worker enters state `0x41` with `entity[+8]` = `0xff` (fake queued-car sentinel)
- After route delay elapses: `dispatch_queued_route_until_request` → `dispatch_sim_behavior` fires for `0x41` → `advance_office_presence_counter` → state `0x05`

### Net Effect

In all cases, the worker **never gets stuck**. The presence counter remains balanced (decrement on dispatch, advance on arrival/callback). The worker either does a wasted round-trip to the lobby or skips directly to evening departure (`0x05`).

The key guard functions are:
- `get_current_commercial_venue_destination_floor`: returns floor `10` for negative `entity[+6]`
- `acquire_commercial_venue_slot`: returns `3` (success) for `facility_slot_index < 0`
- `release_commercial_venue_slot`: sets `entity[+7]` = `10` and returns `1` for `facility_slot_index < 0`
