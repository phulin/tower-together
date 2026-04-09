# Routing Findings

This document answers the routing-simulator questions against the original `SIMTOWER.EX_` in Ghidra project `analysis-2825a3c53f`. It is written as a clean-room design note: behavior first, binary addresses only where they disambiguate semantics.

## Highest Priority

### 64 special-link segments vs 8 special-link records

The **64 segment entries** at `1288:c5e4` are the real placed stair/escalator objects. Each 10-byte entry stores:

- `+0`: active flag
- `+1`: `mode_and_span`
  - bit 0: express/escalator-mode segment
  - bits 7:1: vertical span in floors
- `+2..+3`: `height_metric`
- `+4`: `entry_floor`
- `+5`: reserved byte, written as `0`
- `+6..+7`: descending load counter
- `+8..+9`: ascending load counter

The **8 special-link records** at `1288:c864` are not placed objects. They are derived transfer spans around the lobby and sky-lobby bands, built by `11b8:06a4`:

- floor `10`
- floors `24, 39, 54, 69, 84, 99`

That means the array has room for 8 records, but the current tower size can activate at most 7 of them.

The derived records store:

- `+1`: active flag
- `+2`: lower inclusive floor of the span
- `+3`: upper inclusive floor of the span
- `+4..+1e3`: `reachability_masks_by_floor[120]`

No independent `startFloor` or `heightMetric` is stored in the derived records. Those spans come from scanning `g_floor_walkability_flags`, which itself is rebuilt from the 64 raw segment entries.

### How the 8 derived records are populated

`11b8:06a4` rebuilds them from `g_floor_walkability_flags`:

- For each center floor, it scans downward with `11b8:0763(center, 0)`.
- It scans upward with `11b8:0763(center, 1)`.
- The scan stops on the first floor with no walkability byte, or after the first local-gap sequence extends beyond 3 floors from the center.
- If the downward result is strictly below the upward result, the record is activated with that inclusive span.

So the derived records are purely a cache of “walkable transfer zones around lobby/sky-lobby anchors”, not a second object table.

`11b8:0763(center, dir)` is exact enough to treat as this pseudocode:

```c
int scan_special_link_span_bound(int center, int dir) {
    bool seen_gap = false;

    if (dir != 0) {
        for (int floor = center; floor < center + 6; floor++) {
            uint8_t flags = g_floor_walkability_flags[floor];
            if (flags == 0) return floor;
            if ((flags & 1) == 0) seen_gap = true;
            if (seen_gap && floor >= center + 3) return floor;
        }
        return center + 6;
    }

    for (int floor = center - 1; floor > center - 6; floor--) {
        uint8_t flags = g_floor_walkability_flags[floor];
        if (flags == 0) return floor + 1;
        if ((flags & 1) == 0) seen_gap = true;
        if (seen_gap && floor < center - 3) return floor + 1;
    }
    return center - 6;
}
```

The “first local-gap sequence extends beyond 3 floors from center” rule is therefore literal:

- upward: once any scanned floor loses local-walk bit 0, stop as soon as the scan reaches `center + 3` or higher
- downward: once any scanned floor loses local-walk bit 0, stop as soon as the scan reaches below `center - 3`; the returned bound is then `floor + 1`

### Are the 8 records purely derived caches?

Logically, yes.

They preserve no unique routing information that is absent from:

- the 64 raw special-link segments
- `g_floor_walkability_flags`
- the transfer-group cache

The binary archives them, but behaviorally they are recomputable.

### Fields in each derived special-link record

Logically relevant fields are:

- active flag
- lower span bound
- upper span bound
- `reachability_masks_by_floor[120]`

There is no separate carrier mask field in the record itself.

The `reachability_masks_by_floor` cells are a mixed-format cache, not a pure mask array:

- `0`: unreachable
- `1..16`: `transfer_group_index + 1` for a transfer floor that lies inside this record's own span
- otherwise: a bitmask using the same namespace as transfer groups
  - bits `0..23`: carriers
  - bits `24..31`: peer derived special-link records

### How transfer-group data propagates into special-link routing

Transfer-group masks are propagated by **span coverage**:

- `rebuild_transfer_group_cache` builds one transfer-group entry per qualifying concourse candidate.
- If `tagged_floor` lies within a derived special-link span, the rebuild ORs bit `24 + special_link_index` into that transfer-group entry's mask.

The special-link record is then rebuilt from transfer-group membership:

- if a floor inside the record span is itself a transfer-group floor, `reachability_masks_by_floor[floor] = transfer_group_index + 1`
- if a floor is outside the span, the rebuild projects any reachable carriers and peer special-link records whose bits are present in the linked transfer-group mask

So the rule is not endpoint-only. It is “transfer-group floor lies inside the derived span, then the group's membership mask connects that special-link record to all other members”.

Exact rebuild of one derived record's `reachability_masks_by_floor[120]`:

1. Find every transfer-group entry whose `membership_mask` already contains this record's bit (`24 + record_index`).
2. OR those masks together into a temporary aggregate.
3. Clear this record's own bit from that aggregate.
4. For each floor:
   - if the floor lies inside this record's span and a transfer-group entry exists exactly on that floor whose mask contains this record bit, store `transfer_group_index + 1`
   - otherwise, project the aggregate outward:
     - set carrier bit `n` if carrier `n` serves this floor
     - set peer special-link bit `24 + m` if derived record `m` spans this floor

So inside-span cells name the local transfer-group slot, while outside-span cells are reconstructed reachability bitmasks.

## Transfer Groups

### One transfer-group entry

Each entry is 6 bytes:

- `u32 membership_mask`
- `u8 tagged_floor`
- `u8 reserved`

`membership_mask` uses:

- bits `0..23`: carrier indices
- bits `24..31`: derived special-link record indices

### What the 16-entry table represents

It is **not** one-per-concourse-object and not one-per-floor+mask in the naive sense.

It is one entry per **merged concourse cluster**:

- the candidate source is a placed type-`0x18` concourse object
- candidates on the same floor merge only if their masks overlap
- otherwise they remain separate even on the same floor

### Multiple concourses on the same floor

They merge when both are true:

- same `tagged_floor`
- `old.membership_mask & new.membership_mask != 0`

They stay separate when their masks are disjoint.

### Overflow policy

Hard cap: 16 entries.

If a 17th candidate would be emitted, `rebuild_transfer_group_cache` returns immediately. It does not finish the later special-link projection pass. This is a real early-exit, not “drop one candidate and continue”.

### Entry order

Yes, order matters when overflow occurs and when later code stores `transfer_group_index + 1` into reachability cells.

The ordering rule is:

- floors ascending `0..119`
- within one floor, floor-object slot order
- merges collapse into the earlier surviving entry

### What tags an entry

Only the floor and membership mask survive in the final cache.

There is no retained object index, segment id, or side tag.

### How transfer masks reach special links

By the `tagged_floor`-inside-span rule described above. There is no per-endpoint or per-side propagation.

## Carrier Routing and Assignment

### Queued request vs assigned request vs in-car slot

Queued floor request:

- stored in a `TowerRouteQueueRecord`
- two 40-entry ring buffers per floor-slot: up and down
- counts/head indices are the bytes at offsets `+0..+3`

Assigned floor request:

- stored in carrier-header per-floor assignment tables
- `primary_route_status_by_floor[floor]` or `secondary_route_status_by_floor[floor]`
- value `0` means no car assigned
- value `1..8` means assigned car index + 1

In-car passenger slot:

- stored in `TowerUnitRouteRecord.active_request_refs[42]`
- destination in `slot_destination_floors[42]`
- logical usable count is `carrier.assignment_capacity`
  - `0x15` for standard/service
  - `0x2a` for express

The arrays are physically 42 entries, but non-express cars use only the first 21.

### Meaning of `0x28` and other nonzero route-status bytes

The important correction:

- `0x28` is not a dwell/depart state
- it is the literal queue count `40` in the floor-direction ring buffer

The per-floor assignment bytes use:

- `0`: unassigned
- `1..8`: assigned car index + 1

The per-queue count bytes use:

- `0..40`: queued request count
- `0x28`: full queue sentinel because `40 == 0x28`

### Car choice inside one shaft

`find_best_available_car_for_floor` ranks candidates in buckets:

- reject immediately if a closed-door car is already at the floor and is already in the serving posture
- best idle-home car
- best same-direction car already moving toward the request
- best reversal/wrap candidate

The final tie-break uses header byte `+0x12`, which is the “waiting car response” threshold:

- compare `moving_cost - idle_home_cost` against `carrier_header[+0x12]`
- if `moving_cost - idle_home_cost < threshold`, choose the moving car
- if `moving_cost - idle_home_cost >= threshold`, choose the idle-home car

Equality breaks toward the idle-home car.

The buckets are:

- idle-home: no pending assignments, no active destination load, doors closed, currently at home floor
- same-direction forward: already moving toward the request in the requested direction
- reversal / wrap fallback: usable but behind the request or otherwise requiring a worse retarget

If a car is already sitting on the requested floor with doors closed and either its schedule byte is nonzero or its current direction matches the request, the chooser returns that car immediately before threshold comparison.

### Faithful queue and slot structures

Per floor-slot queue record (`TowerRouteQueueRecord`, stride `0x144`):

- `+0x00`: up queue count
- `+0x01`: up queue head index
- `+0x02`: down queue count
- `+0x03`: down queue head index
- `+0x04..+0xa3`: `up_queue_request_refs[40]`
- `+0xa4..+0x143`: `down_queue_request_refs[40]`

Behavior is ordinary ring-buffer logic:

- enqueue writes at `(head + count) % 40`, then increments count
- pop reads at `head`, then advances `head = (head + 1) % 40` and decrements count
- `0x28` is just count `40`, so “queue full” is literally the full-ring state

Per car active-slot record (`TowerUnitRouteRecord`, stride `0x15a`):

- `+0x03`: active slot count used by removal / dispatch paths
- `+0x0c`: nonempty destination count
- `+0x10..+0xb7`: `active_request_refs[42]`
- `+0xb8..+0xe1`: `slot_destination_floors[42]`
- `+0xe2..+0x159`: `destination_request_counts[120]`

Faithful slot behavior:

- slot free sentinel is `slot_destination_floors[i] = 0xff`
- insertion scans from slot 0 upward and takes the first `0xff`
- removal and unload scans only the first `assignment_capacity` slots
- the physical arrays are 42 entries wide, but standard/service cars use only 21 logical slots because `assignment_capacity = 0x15`

### Schedule bytes and endpoint flags used for departure

`should_car_depart` uses:

- header `+0x02`: assignment capacity
- header `+0x20 + phase*7 + daypart`: dwell multiplier
- header `+0x2e + phase*7 + daypart`: schedule enable flag
- the car's current floor vs its home floor
- `is_lobby_or_express_floor(current_floor)`

Departure happens when any of these is true:

- `assigned_count == assignment_capacity`
- current schedule-enable byte is `0`
- current floor is not the home floor and is not a lobby / express floor
- elapsed dwell exceeds `dwell_multiplier * 30`

### Motion / dwell state machine

Per tick:

- if `door_wait_counter > 0`: recompute motion mode; decrement wait if still dwelling
- else if `speed_counter > 0`: decrement transit counter; on zero, save `prev_floor`, recompute target, test departure
- else idle:
  - if at target and either passengers are waiting here or the car is not full: clear floor assignments, set `speed_counter = 5`, maybe stamp `departure_timestamp`, set `departure_flag = 1`
  - otherwise cancel stale assignments, advance position, and possibly assign this floor to a car

`compute_car_motion_mode`:

- mode 0 carrier: `0` if near target/prev, `3` if both distances > 4, else `2`
- other carriers: `0` if either distance < 2, `1` if either < 4, else `2`

`advance_car_position_one_step`:

- motion mode `0` -> `door_wait_counter = 5`
- motion mode `1` -> `door_wait_counter = 2`
- motion mode `3` -> move by 3 floors
- otherwise move by 1 floor in current direction

### Destination counters

`destination_request_counts[floor]` on the car are authoritative for active in-car routing, not just cosmetic cache:

- incremented when `assign_request_to_runtime_route` stores an active slot
- decremented when `dispatch_destination_queue_entries` unloads or `remove_request_from_active_route_slots` cancels
- zero-to-one and one-to-zero transitions also maintain `nonempty_destination_count`

## Entity Transport

### Route bytes

`entity[+8]` is the encoded route target:

- `0x00..0x3f`: direct special-link segment index
- `0x40..0x57`: queued carrier, upward direction
- `0x58..0x6f`: queued carrier, downward direction
- `0xff`: carrier queue full; entity waiting on source floor

`entity[+7]` is the floor payload used by the transport state:

- on queue-full wait: source floor
- on carrier queue: source floor
- on direct special-link hop: immediate destination floor after that link leg
- on carrier arrival redispatch: destination floor being delivered

There is no separate runtime byte that stores the placed-object route preference; that comes from the object's own `+0x06` field when `resolve_entity_route_between_floors` begins.

### Common helper vs custom family selectors

`assign_request_to_runtime_route` uses one shared selector for:

- families `3, 4, 5, 6, 7, 9, 10, 0x0c`

Custom selectors are used for:

- `0x0f`
- `0x12`, `0x1d`
- `0x21`
- `0x24`

### Route helper return codes

`resolve_entity_route_between_floors` returns:

- `-1`: no route
- `0`: carrier queue full; wait in place
- `1`: direct special-link leg accepted
- `2`: queued onto a carrier
- `3`: same-floor success

Common family response pattern:

- `0/1/2`: enter or remain in the in-transit state band
- `3`: treat as immediate arrival
- `-1`: family-specific failure/reset path

### Immediate local / special-link travel

It does **not** finish the family transition inside `resolve_entity_route_between_floors`.

The helper stamps:

- `entity[+7] = post-link floor`
- `entity[+8] = segment index`

and returns `1`. The calling family handler then moves into its in-transit state, and later reconciliation happens through the family dispatch/finalize path.

### Carrier arrival mutation path

Carrier arrival first happens in the carrier tick:

- `advance_carrier_car_state`
- `dispatch_carrier_car_arrivals`
- `dispatch_destination_queue_entries`

`dispatch_destination_queue_entries` writes `entity[+7] = destination_floor` and then directly calls the family state handler. So the effective floor/state mutation happens in the carrier tick, not in a separate later entity sweep.

## Special Links and Walkability

### Object families feeding the system

Raw 64-entry special-link segment table:

- stairs
- escalators

Transfer-group cache:

- type `0x18` transit concourse / lobby connector objects

Derived 8-record special-link table:

- built from walkability around lobby and sky-lobby anchor floors, not from extra placed objects

### Escalator representation

Escalators and stairs share the same 64-entry segment table. Elevators are separate carrier records.

### Local vs express walkability

Local walkability:

- span must be `< 7`
- every floor in span must exist
- one gap sequence is tolerated, but once a non-local floor has been seen the scan must stop within 3 floors of the center

Express walkability:

- span must be `< 7`
- every floor in span must have express bit set
- no gap tolerance

Raw segment entry also has an endpoint rule:

- ascent can only start at `entry_floor`
- descent can only start at `entry_floor + span - 1`

## Save / Runtime Layout

### Persisted in the original save archive

The archive code writes:

- carrier record table / pointed carrier records
- 64 special-link segment entries
- 8 derived special-link records
- transfer-group cache
- walkability flags

### What should be recomputed in a clean-room implementation

Even though the binary archives them, these are logically caches and should be recomputed on load:

- `g_floor_walkability_flags`
- derived 8-record special-link table
- transfer-group cache
- carrier and special-link `reachability_masks_by_floor`

### Important sentinels / packed encodings

- transfer-group `tagged_floor = 0xff` means unused
- active route slot `slot_destination_floors[i] = 0xff` means free slot
- carrier route byte `0xff` means queue-full wait, not “no route”
- floor assignment bytes use car index + 1
- transfer-group membership uses mixed namespaces:
  - `0..23` carriers
  - `24..31` derived special-link records
- the derived special-link record's active flag is at byte `+1`, not byte `+0`
- raw special-link segment `height_metric` is at `+2`, `entry_floor` at `+4`

## Answers to Open Questions

This section answers each numbered question in `ROUTING_QUESTIONS.md`. Full
pseudo-C extracts and exact addresses live in
`artifacts/routing_answers_AB.md`, `artifacts/routing_answers_CD.md`,
`artifacts/routing_answers_EF.md`, and `artifacts/routing_answers_GHIJ.md`.

Several answers correct earlier statements in this document; corrections are
called out with "**Correction**" markers.

### A. Carrier scoring constants

Source: `find_best_available_car_for_floor` at `0x10980dfc` (newly decompiled),
plus `select_best_route_candidate` at `FUN_11b8_1484`.

**Q1 — moving / same-direction bucket cost.** The score is **literally
`|car_floor − requestFloor|`**, with no `pendingAssignments*8` term and no
direction penalty. The bucket itself is only entered when the car's stored
direction byte already matches the request, and only cars that pass the
endpoint test reach it. The reversal/wrap-fallback bucket (cars behind the
request) uses an asymmetric "go via home, then back" cost driven by
`car_header[+0x51]` (the wrap pivot / home floor):

```
direction == 0 (down): wrap = floor + car_floor − 2*home
direction == 1 (up):   wrap = 2*home − car_floor − floor
```

**Q2 — tie-break threshold byte. Correction.** The earlier text in this doc
named header byte `+0x12` as the "waiting car response" threshold. That is
wrong. The byte actually compared is

```
served_floor_flags[ g_calendar_phase_flag * 7 + g_daypart_index − 0x30 ]
```

i.e. one cell of the same per-`(phase, daypart)` 14-byte array used by the
dwell/schedule code (see Section D below). The comparison itself is correct
(`moving_cost − idle_home_cost < threshold` picks the moving car; equality
breaks toward idle-home), but the threshold is per-carrier-per-daypart, not
a single header constant.

**Q3 — idle-home bucket score.** Pure `|currentFloor − requestFloor|`. No
transfer-floor penalty, no other terms. The "idle-home" gate that selects
into this bucket is the conjunction *pending_assignments == 0 AND
active_destinations == 0 AND currentFloor == homeFloor AND doors_closed*,
checked via header bytes `+-0x54`, `+-0x52`, `+-0x5d` and the
`reachability[..] == iVar2` test just above the score line.

**Q4 — secondary tie-break inside one bucket.** First-found wins. Cars are
scanned with `for (i = 0; i < 8; ++i)` and updates use strict `<`, so on a
tie the **lowest car index wins**. There is no closest-to-home secondary key.

### B. Route segment scoring

Sources: `score_local_route_segment` `FUN_11b8_18fb` @ `0x11b818fb`,
`score_express_route_segment` `FUN_11b8_19a8` @ `0x11b819a8`,
`score_carrier_transfer_route` `FUN_11b8_168e` @ `0x11b8168e`.

**Q5 — `score_local_route_segment`.** Per-floor cost is `8` applied to the
**height metric** (not the raw floor delta), and the **escalator surcharge
is `0x280` (= 640)**. Stairs have **no surcharge**. Endpoint check: ascending
requires `entry_floor == source`; descending requires
`entry_floor == source − (span >> 1) − 1`. Failed endpoint or inactive
segment returns `0x7fff`.

```
return ((mode_and_span & 1) == 0)
       ? dist * 8           // stair
       : dist * 8 + 0x280;  // escalator
```

**Q6 — `score_express_route_segment`.** Only accepts segments with
`mode_and_span & 1 == 1` (escalator/express); others return `0x7fff`.
Returns `dist * 8 + 0x280` unconditionally. There is no separate express
multiplier or bonus.

**Q7 — carrier route scoring. Correction.** There is no separate
`score_carrier_direct_route` function. `FUN_11b8_168e`
(`score_carrier_transfer_route`) handles **both** the direct and the
transfer branches:

| branch | normal | queue-full (`count == 0x28`) |
| --- | --- | --- |
| direct (target served by this carrier) | `\|car_pos − target_height\| * 8 + 0x280` | `... + 1000` |
| transfer (target reached via transfer-group mask) | `\|car_pos − target_height\| * 8 + 3000` | `... + 6000` |

So our previously-recorded `1000` and `6000` are correct, the direct base
surcharge is `0x280` (matches stairs/escalator scale), and the `3000`
constant is the **transfer** base, not the direct base.

**Q8 — "no available car" extra penalty?** None. Unreachable routes return
`0x7fff` and the bucket falls through. Per-car saturation does not add a
score penalty; saturated cars are instead filtered out of the idle-home
bucket entirely by the `pending_assignments == 0` and `active_destinations
== 0` gates. Moving buckets accept any car whose direction matches.

### C. Tick budgets / motion timing

Sources: `advance_carrier_car_state` `0x10980_6fb`,
`advance_car_position_one_step` `0x109810e4`,
`compute_car_motion_mode` `0x1098209f`,
`should_car_depart` `0x109823a5`.

**Q9 — speed-counter reload for mode 0/1 (local). Correction.** There is
**no per-mode speed-counter reload table**, and no `8`. Mid-transit cruise
steps are 1 floor per tick. The speed counter (`car +-0x5c`) is only
restamped to `1` when `should_car_depart` returns "stay", and it is stamped
to **`5`** at post-pickup launch (which is the `DEPARTURE_SEQUENCE_TICKS`
value, see Q13). Per-floor pacing is governed entirely by the door-wait
counter values written by `advance_car_position_one_step` (Q11) — and that
counter is `0` for cruise (motion mode 2), so cruise is uncapped at one
floor per tick.

**Q10 — speed-counter reload for mode 2 (express).** Same answer as Q9 —
no per-mode reload. The mode distinction lives in `compute_car_motion_mode`
itself: mode 0 carriers can return motion mode `3` (3-floor jump) when both
distances exceed `4`, while mode 1/2 carriers cap at motion mode `2` (1
floor per tick). Our previously-recorded `4` constant is unsupported.

**Q11 — `door_wait_counter` for motion mode 2.** **Not stamped.** Motion
mode 2 falls through `advance_car_position_one_step` directly to the +/-1
step, leaving `door_wait_counter = 0`. The next tick re-runs the same
branch. So our existing model (door_wait = 0, step normally) is correct.

**Q12 — motion mode 3 long-hop.** Literal `current_floor +/- 3` with **no
clamp**, including no transfer-floor clamp. The only safety net is
`compute_car_motion_mode`'s `dist_to_target > 4 && dist_from_prev > 4`
gate, which drops the mode to `2` once the gap closes to 4 or fewer floors.

**Q13 — `DEPARTURE_SEQUENCE_TICKS`.** **`5`.** Stamped into the speed
counter (`car +-0x5c`) at the moment the car launches from a dwell. The
same `5` is reached on arrival via motion-mode 0's `door_wait_counter = 5`
branch in `advance_car_position_one_step`, so it is the unified
launch/arrival door-sequence constant.

### D. Dwell multiplier and schedule-enable arrays

Sources: `archive_tower_state` `0x10d80ac4`, plus accesses in
`should_car_depart` `0x109823a5` and `reset_out_of_range_car`.

**Q14 — `+0x20 + phase*7 + daypart` dwell multiplier.** Read **directly
from the save file**. For archive version `>= 0x2100`, `archive_tower_state`
reads the entire `0xc2`-byte carrier header in one `FUN_10d8_299a` call,
which covers `+0x20..+0x2d` (dwell), `+0x2e..+0x3b` (schedule-enable), and
`+0x42..+0xb9` (per-floor served-floor flags). For older archives the
schedule-enable byte at `+0x2e` is broadcast across the 14-cell
`+0x2e..+0x3b` range with an explicit `phase*7 + daypart + 0x2e` loop.

No analyzed runtime code writes the dwell array. The only sources are the
save file itself and (presumably) the in-game elevator scheduling dialog,
which writes through the same fields. The dwell array is **not** synthesized
from the carrier mode at init.

**Q15 — `+0x2e` schedule-enable.** Same provenance as Q14, same `0xc2`-byte
save block. The legacy compat path broadcasts the single byte across the 14
cells; modern saves store all 14 directly. Note that the legacy broadcast is
only applied to the schedule-enable cells, never to the dwell cells — the
dwell array was already 14 bytes wide in the 1.x format.

**Q16 — separate served-floor array. Correction.** Yes, it is distinct from
both of the above. There is a **120-byte per-floor** served-floor array at
carrier-header offset `+0x42` (one byte per floor 0..119, nonzero = served),
which is what `rebuild_transfer_group_cache` reads as
`served_floor_flags[floor]`. Several per-`(phase, daypart)` accesses in the
decompiler print as negative offsets into the same `served_floor_flags`
identifier, but that is a Ghidra aliasing artifact — `served_floor_flags`
is rooted at `+0x42`, so `served_floor_flags[phase*7 + daypart − 0x14]`
resolves to `+0x2e + phase*7 + daypart` (schedule-enable), and `... − 0x22`
resolves to `+0x20 + phase*7 + daypart` (dwell). The three subranges are
distinct fields:

| offset | meaning |
| --- | --- |
| `+0x20..+0x2d` | dwell-multiplier (14 bytes, 2 phases × 7 dayparts) |
| `+0x2e..+0x3b` | schedule-enable (14 bytes) |
| `+0x42..+0xb9` | per-floor served-floor flags (120 bytes) |

The `world.ts` `servedFloorFlags[14]` constant in the clean-room sim is
conflating the 14-cell schedule-enable array with the 120-cell per-floor
served array; these should be split.

**Q17 — `(calendar_phase, daypart)` → index.** Literally `phase * 7 +
daypart`. The two inputs come from globals refreshed once per day-tick:

- `g_daypart_index = g_day_tick / 400` (`compute_daypart_index_from_tick`
  at `0x12080543`). Day tick wraps at `0xa28`, so daypart ∈ 0..6 (7
  dayparts).
- `g_calendar_phase_flag = ((g_day_counter % 12) % 3 >= 2) ? 1 : 0`
  (`compute_calendar_phase_flag` at `0x12080558`). Set on days 2, 5, 8, 11
  of every 12-day cycle.

Combined: 14 cells, no rest-day or wrap nonlinearity in the lookup itself.

### E. Custom family selectors

Source: `assign_request_to_runtime_route` at `0x12180d4e` (only called from
`process_unit_travel_queue` at `0x12180351`). Only runs when a carrier is
loading queued passengers.

The function itself is not the route planner — for each request popped from
the floor's directional ring it calls a **per-family selector** to compute
a small *selector_value*, then passes that value to `FUN_11b8_0e41`
(`choose_transfer_floor_from_carrier_reachability`) which masks it against
the unit's served-floors mask `unit_header[+0xc2]` and returns the
destination floor for this leg. The shared 8-family group
(`3,4,5,6,7,9,10,0xc`) goes through the standard 8-entry state-jump
dispatcher; the "custom" families bypass that and call tiny per-family
helpers.

The placed-object → family map (from `recompute_object_runtime_links_by_type`
at `0x12300103`):

| placed type | runtime family | meaning |
| --- | --- | --- |
| `0x0f` | `0x0f` | single-room hotel guest connection |
| `0x12, 0x13, 0x22, 0x23` | `0x12` | linked-pair service connector |
| `0x1d, 0x1e` | `0x1d` | linked-pair medical/cleaning connector |
| `0x21` | `0x21` | commercial venue customer (restaurant/shop/fast food) |
| `0x24..0x28` | `0x24` | cathedral / VIP arrival (`0x28` = the cathedral itself) |

**Q18 — family `0x0f` selector** (`resolve_family_0f_selector_value` at
`1228:6757`):

```
state = entity[+5];
if      (state == 3) value = entity[+6];      // matched unit slot index
else if (state == 4) value = current_entity_type();
return value;
```

State `3` = "found a vacant unit, slot index in `entity[+6]`" (set inside
`update_object_family_0f_connection_state` after `find_matching_vacant_unit_floor`).
State `4` = "in transit toward the unit, fall back to the entity-type tag".
Single-room hotel guest connector. No carrier or segment filtering.

**Q19 — family `0x12` selector** (`dispatch_object_family_12_1d_state_handler_small`
at `1228:662a`). 4-entry jump table on `entity[+5]` at CS:`0x66f0`. Same
dispatcher as Q20. Covers the housekeeper / service-request connector
lifecycle (request created → accepted → served → done). Placed types
`0x12, 0x13, 0x22, 0x23` all funnel here. Dispatch itself does no filtering;
**UNCERTAIN** whether the four state-handler bodies behind the jump table
add any.

**Q20 — family `0x1d` selector.** Same function as Q19; medical / cleaning
linked-pair entity. Placed types `0x1d, 0x1e`.

**Q21 — family `0x21` selector** (`resolve_family_21_selector_value` at
`1228:65c1`):

```
state = entity[+5];
if      (state == 0x41 'A') value = get_current_commercial_venue_destination_floor(entity);
else if (state == 0x62 'b') value = current_entity_type() + 2;
return value;
```

`0x41` = "going to the venue", `0x62` = "going from venue back to lobby".
Commercial venue customer. The two state codes are the in-transit codes
written by `FUN_1228_4fab` and `FUN_1228_50ef`. No filtering.

**Q22 — family `0x24` selector** (`resolve_family_24_selector_value` at
`1228:6700`):

```
state = entity[+5];
if      (state == 0x45 'E') value = 10;     // floor 10 = lobby
else if (state == 0x60 '`') value = 0x6d;   // floor 109 = cathedral level
return value;
```

`0x45` = descending from cathedral; `0x60` = ascending to cathedral.
Cathedral / VIP arrival entity, including all five placed-type variants
`0x24..0x28`. Placed type `0x28` (the cathedral itself) writes its runtime
subtype index to the `*(int*)0xbc60` global that the 5★→Tower victory
check at `FUN_1048_00f0` polls.

**Q23 — do any custom selectors filter carriers/segments?** No. Every
custom selector just reads `entity[+5]` (and optionally `[+6]` or a
destination-floor helper) and returns a small int. The actual filtering
against the loading unit's served-floors mask happens downstream in
`FUN_11b8_0e41`, which is the **same** helper used by the shared 8-family
dispatcher. So custom families share the carrier-filtering logic with the
common families.

### F. Entity in-transit state machine

The canonical per-tick entity refresh is
`refresh_object_family_3_4_5_state_handler` at `1228:2aec`:

```
state = entity[+5];
if      (state < 0x40)        // 7-entry idle/normal jump table at CS:0x2d92
else if (entity[+8] < 0x40)   dispatch_object_family_3_4_5_state_handler(...)
else                          maybe_dispatch_queued_route_after_wait(entity)
```

**State codes >= 0x40 are universally the "in-transit band"** for all
families. `entity[+8]`'s value determines whether it is a segment leg
(`< 0x40`) or a carrier-queue leg (`>= 0x40`).

**Q24 — per-tick behavior during a special-link leg (return code 1).** No
per-tile walk loop on the entity itself. `resolve_entity_route_between_floors`
adds a **single one-shot delay** proportional to the span at leg commit:

```
per_stop = (segment.mode_and_span & 1) == 0
         ? g_per_stop_even_parity_delay     // stair
         : g_per_stop_odd_parity_delay;    // escalator/express
add_delay_to_current_entity(entity, per_stop * span);
```

The entity then sleeps on its delay accumulator until the global clock
catches up. Subsequent ticks just see "delay not yet elapsed" and skip.

**Q25 — walk timer storage and ticks per floor.** `entity[+10]` (4-byte
word) is the wait-start clock baseline. The per-stop delay constants live
in two globals named in the decomp:
`g_per_stop_even_parity_delay` (stair) and `g_per_stop_odd_parity_delay`
(escalator/express). **UNCERTAIN** literal byte values. There is also a
flat carrier-side "long ride" surcharge of `0x1e` (30 ticks) for spans
`0x50..0x7c` and `0x3c` (60 ticks) for spans `>= 0x7d`, hard-coded inside
`resolve_entity_route_between_floors`.

**Q26 — who clears `entity[+7]` / `[+8]` after the leg.** Nobody zeros
them. The family state handler transitions `entity[+5]` out of the
`>= 0x40` band; once `state < 0x40`, the refresh handler stops reading
`entity[+8]`, so the bytes are implicitly invalidated. On carrier arrival,
`dispatch_destination_queue_entries` overwrites `entity[+7] =
destination_floor` and calls the family handler directly. On cancellation
via `cancel_runtime_route_request` (`0x12181a86`), only the queue/slot
linkage is cleaned up; bytes `+7/+8` are left dirty until the next family
re-stamp.

**Q27 — state code while waiting in carrier queue (return code 2).**
`resolve_entity_route_between_floors` writes `entity[+7] = source_floor`,
`entity[+8] = 0x40 + tower_index` (up) or `0x58 + tower_index` (down),
`entity[+10] = g_day_tick`, but does **not** touch `entity[+5]`. The
*family handler* writes the transit state code (e.g. family 21 → `0x41`
or `0x62`; family 24 → `0x60` or `0x45`). The shared invariant is just
`entity[+5] >= 0x40`.

While waiting, the per-tick path is `maybe_dispatch_queued_route_after_wait`
at `1228:15a0`, which only does work if `g_day_tick - entity[+10] >=
g_route_delay_table_base` — i.e. it polls a "give up waiting" timeout and
otherwise no-ops. The wait is **passive**; there is no per-tick re-poll of
carrier readiness.

**Q28 — carrier-arrival redispatch.** `dispatch_destination_queue_entries`
(`0x12180883`) loops over the unit's active slot table; for each slot
matching the arrival floor it pops the entity ref, stamps `entity[+7] =
destination_floor`, then dispatches by family byte directly (not via the
shared 8-family table):

| family | call |
| --- | --- |
| `3, 4, 5` | `dispatch_object_family_3_4_5_state_handler(entity)` |
| `6, 0xc` | `dispatch_object_family_6_0c_state_handler(entity, hi, type)` |
| `7` | `dispatch_object_family_7_state_handler(entity, hi, type)` |
| `9` | `dispatch_object_family_9_state_handler(entity, hi, type)` |
| `10` | `dispatch_object_family_10_state_handler(entity, hi, type)` |
| `0xe` | `activate_object_family_0f_connection_state(entity)` (no `[+7]` stamp) |
| `0xf` | `update_object_family_0f_connection_state(entity, type)` |
| `0x12, 0x1d` | `dispatch_object_family_12_1d_state_handler(entity, hi, type)` |
| `0x21` | `dispatch_object_family_21_state_handler(scratch, entity, hi, type)` |
| `0x24` | `dispatch_object_family_24_state_handler(entity, hi, type)` |

`force_dispatch_entity_state_by_family` at `1228:1614` mirrors the same
mapping; it is the entry point used when the abandon timer fires.

### G. Reachability mask rebuild

Source: `rebuild_route_reachability_tables` at `0x11b800f2`.

**Q29 — Step 4 outside-span branch. Correction.** The previous wording
("set carrier bit `n` if carrier `n` serves this floor") omitted the
gate. The full predicate is:

- carrier bit `n` set **iff** `aggregate_mask` already contains carrier
  `n` AND carrier `n` is not mode 2 AND carrier `n` serves this floor;
- peer-link bit `24+m` set **iff** `aggregate_mask` already contains peer
  `m` AND peer record `m` spans this floor.

The aggregate is consulted exactly once per bit, in the predicate itself.
Bit testing uses the big-endian helper `FUN_1210_0405(mask, n) =
((*mask) >> (31 − (n & 0x1f))) & 1`.

**Q30 — Inside-span priority for `transfer_group_index + 1`.** The
inside-span branch only writes the cell when a transfer-group entry exists
whose `tagged_floor == this_floor` exactly. When that branch fires, the
projected mask is **never computed for that cell** — there is no merging.
So the two formats never coexist; "preferred over" should be read as
"exclusive of". If multiple entries match the same floor (different masks),
the loop walks them in entry order and the **last matching index** wins
(though `rebuild_transfer_group_cache`'s merge step should prevent this
when masks overlap).

### H. Multi-leg routing

**Q31 — `assign_request_to_runtime_route` chains carriers upfront?** No.
Exactly **one leg per call**. `local_6` is a single destination floor
(`FUN_11b8_0e41`'s output), only that floor is bumped on the carrier's
`destination_request_counts`, and the function exits without recursion or a
second carrier call.

**Q32 — Where is leg 2 stored on the entity during leg 1?** Nowhere. The
"ultimate destination" lives in the entity's higher-level family state
(office target, restaurant target, hotel suite, etc.), not in the routing
scratch bytes. Multi-leg trips are emergent: each leg completion drops back
into the family tick which calls `resolve_entity_route_between_floors(
current_floor, ultimate_target)` again.

**Q33 — Single trip through two segments?** No. `resolve_entity_route_between_floors`
selects exactly one route target via `FUN_11b8_1484`, which returns either
a segment index (`< 0x40`) or a carrier index (`>= 0x40`). There is no
two-segment branch. "Stairs A → walk → stairs B" only happens as two
consecutive legs, with the family handler picking stairs B after stairs A
completes.

### I. Queue / slot edge cases

**Q34 — what wakes a `0x28` floor-assignment byte? Correction.** There is
no `0x28` floor-assignment byte. ROUTING.md previously conflated two
unrelated tables:

1. **Per-floor assignment bytes** (`primary_route_status_by_floor[floor]`,
   `secondary_route_status_by_floor[floor]`) carry only `0` (unassigned)
   or `car_index + 1` in `1..8`. Written by `assign_car_to_floor_request`
   (`0x10980a4c`) and cleared by `cancel_stale_floor_assignment`
   (`0x109812c9`), `clear_floor_requests_on_arrival` (`0x109813cc`), and
   `decrement_car_pending_assignment_count` (`0x1098151c`). They never
   carry `0x28`.

2. **Per-`TowerRouteQueueRecord` queue count bytes** at `+0x394` (down
   count), `+0x395` (down head), `+0x392` (up count), `+0x393` (up head)
   count entries in the matching 40-entry ring. `0x28 == 40` literally
   means "ring full". `resolve_entity_route_between_floors` reads this
   byte; on `0x28` it returns `0` (carrier-queue-full) and the entity
   waits. The count is auto-decremented every time
   `pop_unit_queue_request` (called from `dispatch_queued_route_until_request`)
   or `remove_request_from_unit_queue` removes an entry, so the queue
   self-recovers as soon as one waiter is popped. There is no separate
   sweep.

**Q35 — express `0x2a` capacity.** Literally `mode == 0 ? 0x2a : 0x15`,
set in `archive_tower_state`'s legacy migration block:

```
if ((archive_version & 0xff00) < 0x2200) {
    cVar3 = header[+1];               // carrier mode
    if (cVar3 == 0) header[+2] = 0x2a;
    else if (cVar3 == 1 || cVar3 == 2) header[+2] = 0x15;
}
```

For `>= 0x2200` archives, `header[+0x02]` (`assignment_capacity`) is read
directly from save. There is no overlay flag, no per-segment express bit,
and no daypart dependency. `header[+0x01]` is canonical carrier mode
(`0` = express, `1` = standard, `2` = service).

**Q36 — demolishing a carrier with queued entities. UNCERTAIN.** No
active cleanup pass. `delete_paired_vertical_connector_object`
(`0x1090038d`) only blanks the placed-object slot, decrements
`g_security_ledger_scale`, and removes the connector half. It does not
touch any queue ring, per-floor assignment byte, per-car slot table, or
load counter. `cancel_runtime_route_request` (`0x12181a86`) has only one
caller (per-entity teardown `FUN_1228_1481`); there is no
`for entity in waiting_on_carrier(c): cancel_runtime_route_request(...)`
sweep. Stale entities likely self-recover when their next family tick
re-runs `resolve_entity_route_between_floors`. A clean-room
implementation should rely on the same passive re-resolution rather than
implementing an explicit demolish-time cleanup.

### J. Special-link load counters

**Q37 — increment site.** `FUN_1218_0f8f` (sibling of
`decrement_route_queue_direction_load`), called from a single site:
`resolve_entity_route_between_floors` at `0x12180000`, in the
special-link branch (`local_6 < 0x40`), immediately before stamping
`entity[+7]` and `entity[+8]`:

```
void FUN_1218_0f8f(int seg, int dir) {
    if (dir == 0)  *(int*)(seg*10 + ASCEND_OFF)  += 1;   // +8 ascending
    else           *(int*)(seg*10 + DESCEND_OFF) += 1;   // +6 descending
    DAT_1288_39a4 = 1;   // route-display dirty flag
}
```

So **one increment per accepted segment-leg resolution**, per entity. Not
per tick, not per departure. Each update marks the route-display dirty
flag.

The matching decrement is `decrement_route_queue_direction_load`
(`FUN_1218_0fc4` @ `0x12180fc4`), called from each per-family state
handler at leg completion (`dispatch_object_family_3_4_5_state_handler`,
`_7_`, `_9_`, `_10_`, `_6_0c_`, plus `update_object_family_0f_connection_state`
and `FUN_1228_1481`). The decrement uses an `entry_floor == direction_flag`
test that is slightly opaque in the decompiler — possibly a Ghidra
parameter-naming artifact — but the **net effect is one decrement per leg
completion**, paired one-for-one with the increment.

**Q38 — cleared at end-of-day, or monotonic?** Neither. They are
**in-flight counts** of entities currently traversing each segment.
Increment at leg start, decrement at leg end, paired. No end-of-day reset
path touches them, and they do not grow unboundedly.

**Q39 — does any consumer read them?** **Yes.** `FUN_1108_372f` (in the
`1108`/`1078` sprite/blit family) uses `descending_load + ascending_load`
as the loop bound when enumerating runtime entities on a segment via
`FUN_1220_0586` — almost certainly the **per-segment sprite-draw
enumerator** that draws each waiting/walking person on a stair or
escalator. That makes the counters load-bearing: the renderer relies on
them, which is why each enqueue/dequeue marks `DAT_1288_39a4 = 1`.
**UNCERTAIN** whether any other reader (scoring/AI/popup) exists; none
was found.

### Suggested clean-room follow-ups

- Replace the `world.ts` `servedFloorFlags[14]` constant with two distinct
  arrays: a 14-cell schedule-enable (per-`(phase, daypart)`) and a
  120-cell per-floor served-floor mask (Q16).
- Stop using header byte `+0x12` as the "waiting car response" threshold
  and read the per-`(phase, daypart)` schedule-enable cell instead (Q2).
- Drop the per-mode `8/4` speed-counter constants; cruise is one floor
  per tick, with `5` only at launch / arrival (Q9, Q10, Q13).
- Move the `3000` carrier base surcharge from the direct-route scorer to
  the transfer-route scorer; the direct base is `0x280` (Q7).
- Treat segment legs as a single one-shot delay of `per_stop * span`
  rather than a per-tile walk loop, using two distinct globals for stair
  vs escalator (Q24, Q25).
