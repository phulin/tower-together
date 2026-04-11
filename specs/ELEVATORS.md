# Elevators And Carrier Transit

## Carrier Types

There are three carrier modes:

- Express Elevator
- Standard Elevator
- Service Elevator

These labels are build identities. The router's local-vs-express selection is related but not identical.

Terminology used in this spec:

- **carrier** = the shaft/header-level record: mode, served-floor span, schedule tables, queue tables, transfer reachability, and up to 8 moving units
- **car** = one moving cab inside a carrier

The simulation uses data from both levels during dispatch, so older notes sometimes used
"carrier" and "car" interchangeably. This spec does not: queueing and reachability are
carrier-level; motion, doors, dwell, and assignments are car-level.

## Carrier Record

A carrier needs:

- carrier mode (0 = express, 1 = standard/local, 2 = service)
- top and bottom served floors
- assignment capacity
- per-daypart schedule data
- served-floor flags
- upward and downward floor-assignment tables
- up to 8 car units

### Schedule Tables

Each carrier has two 14-entry schedule arrays in the carrier header:

| Field | Meaning |
|-------|---------|
| `schedule_mode_table[14]` | per-slot operational mode / dwell multiplier (reloaded into car's `schedule_flag` at terminal floors) |
| `enable_table[14]` | per-slot enable flag (0 = disabled, nonzero = enabled) |

The current schedule slot index is computed as:

```
schedule_index = daypart_index + calendar_phase_flag * 7
```

This produces 14 values: 7 dayparts × 2 calendar phases. `daypart_index` ranges 0–6,
`calendar_phase_flag` is 0 or 1.

The same index is also used to read the idle-home vs moving-car comparison threshold from the carrier's `dispatch_threshold` field.

### Schedule Modes

The `schedule_mode_table` value controls both the car's operational mode (in
`select_next_target_floor`) and its dwell time (in `should_car_depart`):

| `enable_table[slot]` | `schedule_mode_table[slot]` | Mode | Dwell | Behavior |
|---|---|---|---|---|
| 0 | (any) | Disabled | 0 | Car departs immediately, does not pick up passengers |
| nonzero | 1 | Express up | 30 ticks | Scans downward for assignments; fallback target = `top_served_floor` |
| nonzero | 2 | Express down | 60 ticks | Scans upward for assignments; fallback target = `bottom_served_floor` |
| nonzero | other | Normal | `value * 30` ticks | Bidirectional sweep: scan current direction, wrap at endpoints |

- **Express up** (`schedule_flag == 1`): car prioritizes ascending. When it has no
  assignments in the downward scan, it returns to `top_served_floor`. This is the
  morning rush mode — shuttles passengers from lobby to upper floors.
- **Express down** (`schedule_flag == 2`): car prioritizes descending. When it has no
  assignments in the upward scan, it returns to `bottom_served_floor`. This is the
  evening rush mode — shuttles passengers from upper floors to lobby.
- **Normal** (any other value): standard bidirectional sweep. The car scans for
  assigned floors in its current direction, wraps around at endpoints, and returns
  -1 if no assignments exist.

Assignment capacities:

- Express Elevator: 42 logical assignment slots
- Standard Elevator: 21 logical assignment slots
- Service Elevator: 21 logical assignment slots

## Car Record

Each car needs:

- current floor
- previous floor
- target floor
- direction
- door wait counter
- speed counter
- departure flag
- departure timestamp
- assigned passenger count
- schedule dwell flag
- per-destination request counts

## Queue Drain

For each active car:

1. require the current floor queue to be dispatchable (i.e. the queue for this floor has at least one entry in either direction)
2. compute `remaining_slots = assignment_capacity - assigned_count`
3. look up the queue depth for the current direction; if it is empty and the car has no pending destination (`target_floor == -1` and `pending_assignment_count == 0`), flip direction
4. pop requests FIFO from the primary direction queue, up to `remaining_slots`
5. if the car's alternate-direction flag is enabled and slots remain, also pop FIFO from the reverse-direction queue
6. for each popped request:
   - ask the family-specific handler for the actor's target floor
   - choose the actual boarding or transfer floor from the carrier reachability tables
   - insert the request into the first free active route slot
   - increment the per-destination request counter
7. if transfer-floor resolution fails, apply the requeue-failure delay and force the actor back to its family dispatch path

Transfer-floor chooser:

- if the carrier serves the actor's target floor directly, use that floor
- otherwise read `reachability_masks_by_floor[target_floor]`
- scan transfer-group entries `0..15` in ascending order
- accept the first live entry whose tagged floor is not the current floor, whose carrier mask overlaps the target-floor reachability mask, and whose tagged floor lies in the requested travel direction
- if none match, fail the assignment

Queue records are ring buffers:

- Each floor has an upward queue and a downward queue.
- Each queue has a count, a head index, and 40 request-reference slots.
- Enqueue writes at (head + count) % 40.
- Dequeue reads head, then advances head = (head + 1) % 40 and decrements count.

Per-car active-route storage has 42 physical slots, but standard and service cars only consume the first 21 because `assignment_capacity = 21`.

Active-slot behavior:

- free slot sentinel: destination floor `0xff`
- insertion scans from slot `0` upward and uses the first free slot
- unload and removal paths scan only `0 .. assignment_capacity - 1`

## Arrival Dispatch

When a car reaches a floor:

1. unload every active route slot whose destination matches the current floor
2. write the actor's current floor
3. hand control back to that actor family's arrival/dispatch logic
4. decrement assigned counts and destination counters

Arrival dispatch uses the family-specific state handler for the arriving actor family; the elevator layer does not directly interpret family states beyond invoking the correct handler.

## Car State Machine

Per tick, each active car is in one of three broad phases:

- doors open / boarding
- in transit
- idle at a floor

Behavior:

- if doors are open, the car either continues waiting or completes the dwell sequence
- if in transit, the motion timer counts down and the car reevaluates its target when the timer expires
- if idle, the car either begins a departure sequence at the current floor or moves one step toward its next target

Idle-floor behavior:

- at target floor, if passengers are waiting there or the car is still below assignment capacity:
  - reload `schedule_flag` at terminal floors from the 14-entry dwell table
  - clear stale floor-request assignments for the current floor
  - set `speed_counter = 5`
  - if `departure_flag == 0`, stamp `departure_timestamp = day_tick`
  - set `departure_flag = 1`
- otherwise:
  - clear stale assignments for the current floor
  - move one step toward the current target
  - if the current floor still has pending direction flags, assign this car to those floor requests

## Motion Profile

Motion profile is computed by `compute_car_motion_mode`, which returns a mode 0–3 based
on `carrier_mode`, distance to target, and distance from previous floor.

### carrier_mode 0 (express elevator)

| Condition | Mode | Step | Door wait |
|-----------|------|------|-----------|
| `dist_to_target < 2` OR `dist_from_prev < 2` | 0 (stop) | set `speed_counter = 5` | 5 ticks |
| `dist_to_target > 4` AND `dist_from_prev > 4` | 3 (fast) | ±3 floors/step | — |
| otherwise | 2 (normal) | ±1 floor/step | — |

### carrier_mode ≠ 0 (standard / service elevator)

| Condition | Mode | Step | Door wait |
|-----------|------|------|-----------|
| `dist_to_target < 2` OR `dist_from_prev < 2` | 0 (stop) | set `speed_counter = 5` | 5 ticks |
| `dist_to_target < 4` OR `dist_from_prev < 4` | 1 (slow) | ±1 floor/step | 2 ticks |
| otherwise | 2 (normal) | ±1 floor/step | — |

Notes:
- Mode 3 (±3 floors/step) exists **only** for carrier_mode 0 (express elevators).
- Standard and service elevators have a slow-stop band (mode 1) that express elevators lack.
- `speed_counter = 5` is also the boarding/departure-sequence marker checked by the arrival handler.
- Distance is `abs(current_floor - target_floor)` or `abs(current_floor - prev_floor)`.

## Departure Rules

A car departs immediately when any of these are true:

- it reaches assignment capacity
- the current schedule slot is disabled
- it has waited longer than its current dwell threshold

Otherwise it can continue waiting at the floor for more passengers.

At top and bottom served floors, the current dwell/schedule flag is reloaded from the carrier's 14-entry daypart/calendar schedule table.

Dwell-threshold rule:

- depart when `abs(day_tick - departure_timestamp) > schedule_flag * 30`
- `departure_timestamp` is set when `departure_flag` transitions from 0 to 1 (first boarding event at a floor)
- `departure_flag` is cleared when the car begins moving away from the floor
- a car that arrives at a floor with no waiting passengers and no pending assignments does not set `departure_flag` — it either moves toward its next target or idles

## Floor Assignment

When a floor request is raised:

- if the floor is already assigned, do nothing
- otherwise choose the best car
- prefer an immediately available car at the floor when possible
- otherwise compare moving-car cost against idle-home-car cost

Candidate classes:

- idle-home candidate: active, no pending assignments, no active destination load, doors closed, current floor at home floor
- same-direction forward candidate: already moving in the requested direction and the request lies ahead
- reversal / wrap candidate: fallback that would need retargeting behind the current sweep

Cost formulas:

- idle-home cost: `abs(request_floor - current_floor)`
- same-direction forward cost:
  - upward request: `request_floor - current_floor`
  - downward request: `current_floor - request_floor`
- same-direction wrap cost:
  - upward request behind the current sweep: `(target_floor - current_floor) + (target_floor - request_floor)`
  - downward request behind the current sweep: `(current_floor - target_floor) + (request_floor - target_floor)`
- fallback reversal cost when the car is not already a same-direction candidate:
  - if the request lies before the next turn floor in the requested direction, use direct distance from current floor to request floor
  - otherwise use distance to the next turn floor plus distance back from that turn floor to the request floor

Tie-break rules:

- immediate early-accept: if a car is already at the requested floor with doors closed and either its schedule byte is nonzero or its direction already matches the request, select it immediately
- otherwise compare the best moving-car cost against the best idle-home cost using the carrier's `dispatch_threshold` as a threshold
- if `moving_cost - idle_home_cost < threshold`, choose the moving candidate
- if `moving_cost - idle_home_cost >= threshold`, choose the idle-home candidate
- exact equality breaks toward the idle-home candidate

Observed selector ordering:

- same-floor early accept returns immediately
- otherwise the scorer keeps the best idle-home candidate, best same-direction-forward candidate, and best wrap/reversal candidate separately
- if a forward candidate exists, it is compared against the idle-home candidate first
- otherwise the best wrap/reversal candidate is compared against the idle-home candidate

Edge case note:

- If no forward or wrap/reversal moving candidate is available, the selector falls back to car index 0 rather than the best idle-home candidate. This appears intentional and should be preserved for parity.

## Home Floor

Each car has a per-car home floor value (`home_floor_by_car[car_index]`).

- First car in a shaft: home floor = the floor where the player started the shaft.
- Later cars: home floor = the floor the player clicked when placing that car.

When a car has no pending assignments and no special flag, it returns to its home floor.

Target-floor selection:

- if a car has no pending assignments (`pending_assignment_count == 0`) and no special
  flag, it returns to its home floor
- otherwise behavior depends on the car's current `schedule_flag`:

**`schedule_flag == 1` (express up):**
- scans downward from current floor for assigned floors (passengers to pick up or
  destination requests)
- if no downward assignment found, returns `top_served_floor` as the target
- this biases the car toward ascending — ideal for morning rush

**`schedule_flag == 2` (express down):**
- scans upward from current floor for assigned floors
- if no upward assignment found, returns `bottom_served_floor` as the target
- this biases the car toward descending — ideal for evening rush

**Any other `schedule_flag` value (normal):**
- scans for assigned floors in the current travel direction
- if nothing found in current direction, wraps around: reverses direction and scans
  from the opposite endpoint back toward the current floor
- if still nothing found, returns -1 (no target)

The nearest-work-floor helper uses the same home_floor_by_car slot as its final fallback when no pending work exists in the current travel direction.

## Door And Boarding Counters

Each car has two countdown fields:

- `door_wait_counter`: counts down while doors are open
- `boarding_countdown`: tracks the boarding/departure sequence

Behavior:

- A full stop (motion mode 0) sets door_wait_counter = 5; a slow stop (motion mode 1) sets it to 2.
- While door_wait_counter > 0, the car re-evaluates its motion mode each tick.
- If motion mode remains 0, door_wait_counter decrements.
- If motion mode becomes nonzero, door_wait_counter clears immediately.
- When a car starts boarding at its target floor, boarding_countdown is set to 5.
- Arrival/unload effects fire exactly when boarding_countdown == 5.
- After that, boarding_countdown decrements once per tick.
- When boarding_countdown reaches 0, the car snapshots prev_floor, recomputes target and direction, and checks departure conditions.
- If departure conditions are not met, boarding_countdown reloads to 1, creating a one-tick retry loop.

## Queue-Full Retry Behavior

When an entity encounters a full queue (40 entries) at its source floor:

- the route resolver returns the queue-full waiting result with a 5-tick delay
- the entity enters a waiting state and is re-evaluated after the 300-tick queued-leg timeout
- there is no retry counter or maximum retry limit — the timeout is the only gate
- when the timeout fires, the entity re-dispatches through its full family route logic, which re-runs `select_best_route_candidate` from scratch
- this re-dispatch can select an alternate carrier if another one serves the same floor pair at lower cost, or fall back to stair/escalator links
- the entity does not remember which carrier it previously tried; the cost function naturally penalizes full queues via the `+1000` / `+6000` surcharges

## Slot Limits

- maximum carriers: 24
- maximum cars per carrier: 8
- per-floor queue capacity per direction: 40
- per-car physical slot storage: 42

Standard and Service elevators only use 21 logical passenger-assignment slots because of their lower assignment capacity.
