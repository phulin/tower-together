# SimTower Headless Simulation Spec

## Purpose

This document specifies a headless simulation model for the mechanics-bearing binary at `/Users/phulin/Documents/Projects/reaper/artifacts/SIMTOWER.EX_/SIMTOWER.EX_`.

The target is not a UI clone. The target is a simulation core that can:

- load an initial tower state
- advance time deterministically
- accept player interventions as commands
- produce the same mechanical outcomes as the original game where those outcomes have been recovered

This is written at an English pseudocode level. Where a rule is directly supported by reverse engineering, it is stated as fact. Where a rule is needed for a practical headless interface but the exact UI-side behavior has not yet been recovered, it is marked as an inference or an unresolved detail.

## Scope

This spec covers:

- in-game time advancement
- scheduler checkpoints
- static tower state
- runtime actor state
- pathing and route assignment
- business, entertainment, parking, and occupancy mechanics
- money and ledgers
- star-rating evaluation entities
- save/load-relevant simulation state
- player interventions that alter simulation state, including building, rent changes, and prompt responses

This spec does not attempt to reproduce:

- rendering
- animation presentation
- sound
- window management
- exact dialog layouts

Some player-facing event semantics are still incomplete. Those are listed at the end.

## Design Principles

Implement the headless simulation with these rules:

- Treat the NE executable’s mechanics as the source of truth.
- Separate static placed-object state from transient runtime actor state.
- Do not model the simulation as “update everything every tick.” Most work happens only at specific scheduler checkpoints.
- Treat pathing as a first-class mechanic. Route feasibility and route cost affect occupancy, guest visits, business health, and evaluation outcomes.
- Preserve stateful sidecar tables. Several subsystems are not derivable from placed objects alone.

## Time Model

The simulation has two relevant time domains:

- real execution time, which gates how often the scheduler is allowed to run
- in-game time, represented by a fixed intra-day tick counter

For a headless implementation, the real-time gate should be replaced by an explicit `step()` or `advance_ticks(n)` API. The headless engine should not depend on wall-clock sampling.

### In-Game Tick Counters

Maintain:

- `day_tick`: integer from `0` to `0x0a27` inclusive
- `daypart_index`: integer `day_tick / 400`, therefore `0..6`
- `day_counter`: long-running day count, incremented when `day_tick` reaches `0x08fc`
- `g_calendar_phase_flag` (`0xbb8a`): computed each tick by `compute_calendar_phase_flag` as `(day_counter_dword % 12) % 3 >= 2 ? 1 : 0`. Flags days 2, 5, 8, 11 of each 12-day cycle. Used in condo/hotel state machines to trigger morning-specific behavior (sub-tile stagger, commercial trip selection). This was formerly listed as the mysterious `DAT_1288_bb8a`.
- `pre_day_4()` (`1208:072e`): returns `daypart_index < 4`. Used to select between "early" and "late" game phase bands for `stay_phase` initialization (0 vs 8) and other per-daypart logic.
- star/tower progress at `[0xbc40]`: current star rating (1-5). Drives operational scoring thresholds via `refresh_operational_status_thresholds_for_star_rating`.

### Headless Tick Entry Point

Define the core loop as:

1. Apply any queued player commands scheduled for this simulation instant.
2. Run one scheduler tick.
3. Return any emitted notifications, cash changes, state changes, and prompt requests.

## Top-Level Scheduler

Each scheduler tick performs:

1. Increment `day_tick`.
2. Recompute `daypart_index = day_tick / 400`.
3. If `day_tick == 0x08fc`, increment `day_counter`.
4. If `day_tick == 0x0a28`, wrap `day_tick` to `0`.
5. Execute checkpoint-driven subsystem work.

The scheduler is phase-triggered, not free-running.

### Checkpoint Table

At minimum, the headless scheduler must fire the following checkpoints:

- `0x000`
- `0x0f0`
- `0x04b0`
- `0x0578`
- `0x05dc`
- `0x0640`
- `0x076c`
- `0x07d0`
- `0x0898`
- `0x09c4`
- `0x09e5`

### Checkpoint `0x000`: Start Of Day

At `day_tick == 0x000`, perform:

- normalize start-of-day object states
- rebuild demand-history state
- rebuild path-seed buckets
- refresh event-related type-14/type-15 state
- activate upper-tower runtime group
- update any periodic facility progress override state

Interpretation:

- this is the daily reset point for several long-lived derived tables
- if a subsystem depends on path coverage or demand coverage, it should be considered stale until this checkpoint rebuild runs or a player command forces a local rebuild

### Checkpoint `0x0f0`: Facility Ledger Rebuild

At `day_tick == 0x0f0`, perform:

- rebuild linked facility records
- rebuild entertainment family ledger

This checkpoint establishes the base daily valuation state for:

- commercial/facility records
- entertainment/event links
- primary-ledger contributions

### Checkpoints `0x04b0`, `0x0578`, `0x05dc`, `0x0640`, `0x076c`: Entertainment Cycle

At `0x04b0`:

- promote entertainment links to ready phase for selector group `1`
- activate half-runtime phase for half `1`, selector group `0`

At `0x0578`:

- activate half-runtime phase for half `1`, selector group `1`

At `0x05dc`:

- advance entertainment facility phase for half `0`, selector group `1`

At `0x0640`:

- rebuild type-6 facility records
- promote entertainment links to ready phase for half `1`, selector group `1`
- advance entertainment facility phase for half `1`, selector group `0`

At `0x076c`:

- advance entertainment facility phase for half `1`, selector group `1`

### Checkpoint `0x07d0`: Late Facility Cycle

At `0x07d0`, advance linked facility records.

### Checkpoint `0x0898`: Final Type-6 Facility Cycle

At `0x0898`, advance the type-6-specific facility cycle.

### Checkpoint `0x09c4`: Runtime Refresh Sweep

At `0x09c4`, run the runtime-entity refresh/reset sweep.

This should include:

- family-specific runtime state normalization
- dispatch parking-state fallthrough as a no-op
- resetting or parking actors whose family gates close at end of day

### Checkpoint `0x09e5`: Ledger Rollover And Expenses

At `0x09e5`:

- perform ledger rollover
- apply periodic operating expenses
- every third day, clear income/expense-side ledgers while preserving the cash base

## Simulation State

The headless engine must serialize and restore at least the following classes of state.

### Static World State

Maintain:

- floors
- placed objects on each floor
- tile extents
- object type and state bytes
- object subtype/tile offsets
- object dirty flags
- linked sidecar indices
- family-specific aux bytes

Represent the core static object as a `PlacedObjectRecord` with these recovered stable fields:

- `left_tile_index`
- `right_tile_index`
- `object_type_code`
- `object_state_code`
- `linked_record_index`
- `aux_value_or_timer`
- `subtype_tile_offset`
- `needs_refresh_flag`
- four trailing family-specific state bytes

### Runtime Actor State

Maintain a global runtime-entity table. Each entry carries at least:

- floor anchor
- subtype index
- base tile offset
- family code
- current state code
- selected floor or facility slot
- origin floor / selector byte
- encoded route target or link code
- auxiliary state byte
- queue tick or countdown
- accumulated delay or target subtype
- auxiliary counter word

The runtime table is not cosmetic. It drives:

- occupancy claimants
- hotel guest activity
- special evaluation visitors
- entertainment attendees
- other family-specific transient actors

### Queue And Path State

Maintain:

- per-floor directional route queues
- per-unit route records
- path buckets
- active requests
- blocked-pair history where route failures are archived
- path-seed tables
- transfer-group cache
- carrier reachability tables
- special-link reachability tables

### Sidecar Tables

Maintain:

- commercial/facility records
- entertainment link records
- service-request sidecar entries for covered emitters
- subtype allocation maps
- reverse subtype-to-object maps

### Ledger State

Maintain:

- live cash balance
- primary ledger
- secondary ledger
- tertiary ledger
- any current-day or previous-day mirrored contribution values held inside facility records

## Headless Engine API

The original executable is event-driven through a Windows message loop. A headless rewrite should expose explicit commands.

Recommended API:

- `load_state(snapshot)`
- `save_state()`
- `step()`
- `advance_ticks(n)`
- `submit_command(command)`
- `collect_notifications()`

Commands should be applied atomically before the next scheduler tick unless the command itself explicitly says “apply immediately.”

This command queue model is an implementation choice for the headless rewrite. It is not yet proven to match the original UI message ordering exactly.

## Route Resolution

Route resolution is a shared service used by multiple subsystems.

### Route Request Flow

When an actor wants to move:

1. Determine source floor and destination floor.
2. Ask the route scorer for the best route candidate.
3. Accept one of:
   - same-floor success
   - direct local route
   - direct express route
   - direct carrier route
   - transfer-assisted carrier route
   - special-link route
   - failure
4. Write routing results back into the runtime record.
5. If the route requires queueing, place the request into the relevant queue and stamp the enqueue tick.
6. Apply route delay.

### Route Costs

Preserve these recovered rules:

- local direct cost: `abs(height_delta) * 8`, plus `0x280` when the segment mode has bit `0` set
- express direct cost: `abs(height_delta) * 8 + 0x280`
- special-link cost: `0` when viable, otherwise impossible
- direct carrier coverage:
  - `abs(height_delta) * 8 + 0x280`, or
  - `1000 + abs(height_delta) * 8` when internal status is `0x28`
- transfer-assisted carrier coverage:
  - `3000 + abs(height_delta) * 8`, or
  - `6000 + abs(height_delta) * 8` when internal status is `0x28`

### Route Delays

Preserve these startup-tuned values:

- queue-entry delay: `5`
- route-failure delay: `300`
- per-stop direct delay for even-parity segments: `16`
- per-stop direct delay for odd-parity segments: `35`

Also preserve the long-distance penalty:

- if chosen segment height difference exceeds `0x4f`:
  - add `0x1e` below `0x7d`
  - add `0x3c` at or above `0x7d`

### Walkability Guards

Preserve:

- local and express floor-span walkability both reject spans of `7` floors or more
- both allow at most `2` consecutive incompatible floor flags

### Queue Consumption

Each tick does not necessarily drain every queue. The queue layer is driven by:

- queued demand created by route resolution
- later dispatch from `process_unit_travel_queue`
- bucket-based destination dispatch

For headless parity, queue operations must preserve:

- ring-buffer ordering
- per-direction counts
- per-destination counters
- route-slot assignment semantics

## Runtime Family Behavior

The headless engine should dispatch runtime actors by family code and state code.

### Family `0x0f`: Rentable-Unit Occupancy Claimant

This family is a transient claimant, not a passive room.

Behavior:

1. Search for a vacancy among families `3`, `4`, and `5` in the same modulo-6 floor group.
2. Record chosen destination floor and subtype.
3. Probe route feasibility.
4. If route result is immediate success before tick `0x05dc`, reserve the selected unit.
5. Enter state `2` and start a short countdown.
6. If claim finalizes, the unit stays taken.
7. If claim stalls or fails, mark the unit unavailable and reset the actor.

Implication:

- occupancy is asynchronous
- route access is a hard prerequisite for successful room acquisition

### Families `3`, `4`, `5`: Rentable Units

These families are passive placed objects with shared occupancy mechanics.

Known behavior:

- vacancy search treats them as one mechanical pool
- activation and unavailable handling is shared
- selected-object status degradation thresholds are shared
- construction-cost ordering matches the three hotel-room build strings:
  - `3`: probable Single Hotel Room
  - `4`: probable Twin Hotel Room
  - `5`: probable Hotel Suite
- family-resource payout rows are consistent with recurring room income rather than condo sale semantics

Unknown behavior:

- exact confirmation of the `3 -> single`, `4 -> twin`, `5 -> suite` mapping from non-string code paths
- exact hotel-room income trigger timing and any variant-specific differences
- exact interaction between these room records and the family `0x21` hotel guest actors

### Family `7`: Office

Known behavior:

- 6-tile object span
- recurring positive cashflow through the family-resource table
- readiness depends on a score derived from runtime metrics, subtype variant, and nearby support
- requests fast food only
- open/close state is reflected in object byte `+0x0b`

Operational flow:

1. Compute averaged runtime score across the object span.
2. Apply variant-specific modifier.
3. Apply support bonus if nearby support is present.
4. If operational, activate office cashflow.
5. If not operational, deactivate office cashflow.

### Family `9`: Condo Family

Identity: **confirmed condo**. The build-price string `Condo - $80000` appears in the same ordered block as `Office - $40000` and the hotel room classes. The family-resource payout row (YEN #1001, family 9: `2000/1500/1000/400`) is a one-time sale price, not recurring rent.

Confirmed behavior:

- 3-tile object span
- raw type code `9` routes into family `9`
- the condo is **sold** (revenue credited) when a runtime entity arrives at the condo tile while `object.stay_phase >= 0x18` (the inactive/unsold threshold)
- the condo is **refunded** (revenue removed) by a periodic deactivation check every third day, when `object.stay_phase < 0x18` and `pairing_status == 0` (sold but operational score too poor)
- family `0x0f` does not target family `9`; vacancy-claimant path only searches families `3/4/5`
- alternates between restaurant and fast-food demand according to phase and sub-tile index parity
- nearby-support matching accepts hotel-room families `3/4/5`, parking, and commercial support families

#### `object.stay_phase` (offset +0x0b) — Occupancy Lifecycle Counter

This byte encodes the **entire tenancy lifecycle** from move-in through active occupancy to checkout/vacancy. It is used across all commercial families (3/4/5, 7, 9, 10) with family-specific value ranges. The Ghidra-named helper functions reveal its nature: `decrement_slot_stay_duration_and_reset` ("stay duration"), `advance_object_state_record_phase` ("phase"), `collect_hotel_checkout_income` (sets to 0x28/0x30 on checkout).

**Cross-family value ranges:**

| Range | Hotels (3/4/5) | Condos (9) | Offices (7) |
|---|---|---|---|
| `0x00..0x07` | Occupied (pre-day-4) | Sold (pre-day-4) | Active |
| `0x08..0x0F` | Occupied (post-day-4) | Sold (post-day-4) | Active (late) |
| `0x10` | Sibling sync signal | Sibling sync signal | Deactivation mark |
| `0x18..0x1F` | Vacant / available | Unsold (pre-day-4) | Deactivation mark |
| `0x20..0x27` | — | Unsold (post-day-4) | — |
| `0x28..0x2F` | Checked out (pre-day-4) | Expiry zone | — |
| `0x30..0x37` | Checked out (post-day-4) | — | — |
| `>= 0x38` | Extended vacancy | Extended vacancy | — |

Within the occupied/sold band (`0x00..0x0F`), the byte acts as a **trip counter**: each outbound commercial trip decrements it, failures/bounces increment it. There are two parallel helper sets — `_a` for families 3/4/5 and `_b` for family 9:

| Operation | Families 3/4/5 | Family 9 |
|---|---|---|
| DEC on trip start | `decrement_entity_slot_counter_a` (`6c77`) | `decrement_entity_slot_counter_b` (`6ee8`) |
| INC on failure/bounce | `advance_slot_from_in_transit_or_increment_counter` (`6a56`) | `advance_slot_state_from_in_transit_or_increment` (`6ce4`) |
| Sync gate | `set_entity_slot_state_in_transit_if_ready` (`6b5c`) | `try_set_parent_state_in_transit_if_all_slots_transit` (`6dea`) |

**Per-family trip-counter reset values** (set when `stay_phase == 0x10` on dispatch entry):

| Family | Tile span | Reset value | Trips per round |
|---|---|---|---|
| 3 (office) | 1 | 1 | 1 |
| 4 (hotel) | 2 | 2 | 2 |
| 5 (3-tile in 3/4/5) | 3 | 2 | 2 |
| 9 (condo) | 3 | 3 | ~2 (net, due to sub-tile stagger) |

For **hotels**, when the counter reaches `& 7 == 0`, `collect_hotel_checkout_income` fires and kicks `stay_phase` up to `0x28`/`0x30`. For **condos**, income fires once on arrival (sale), not per-round — the ongoing trips maintain the operational score that prevents refund.

The pre/post-day-4 split (`pre_day_4()`) selects the starting band: pre-day-4 starts at `0`, post at `8`. Post-day-4 tenants require more trips per round before syncing.

**Condo-specific lifecycle:**

After sale: `activate_commercial_tenant_cashflow` resets to `0` (pre-day-4) or `8` (post-day-4). The sold regime is `< 0x18`.

#### Condo Sale — Exact Trigger

`activate_commercial_tenant_cashflow` (`1180:105d`) fires in the state-`0x20`/`0x60` handler when:
- `object.stay_phase >= 0x18` (condo currently unsold/inactive), AND
- the entity routing call to `route_entity_to_commercial_venue` returns `0`, `1`, `2`, or `3` (any non-failure result)

Return `3` (same-floor arrived) fires the activation and then immediately tears down the actor (state → `0x04`). Returns `0/1/2` (queued or en-route) fire the activation and move the entity to state `0x60` (active sold regime), where it continues its visit loop.

Effects of `activate_commercial_tenant_cashflow`:
1. `add_cashflow_from_family_resource(9, variant_index)` → `g_cash_balance += payout_table[9][variant_index]`
2. Play UI effect `#3` (sale notification sound/visual)
3. Reset `object.stay_phase` to `0` (early game) or `8` (late game)
4. Set `object.dirty_flag = 1`
5. `add_to_primary_family_ledger_bucket(9, +3)`
6. Refresh all 3 tiles of the condo span

The `variant_index` (at `object+0x16`) indexes into YEN `#1001` at `family_9 * 0x10 + variant * 4`, giving sale prices of `2000`, `1500`, `1000`, or `400` depending on the selected condo subtype/quality tier.

#### Condo Refund — Exact Trigger

**Mechanism A: Periodic deactivation (every 3rd day)**

`deactivate_family_cashflow_if_unpaired` fires on the `g_day_counter % 3 == 0` cadence. For family 9, it checks:
- `object.pairing_status == 0` (no active resident entities paired to this tile), AND
- `object.stay_phase < 0x18` (condo is currently in the active/sold regime)

If both conditions hold, it calls `deactivate_commercial_tenant_cashflow` (`1180:1102`):
1. Set `object.stay_phase` to `0x18` (early game) or `0x20` (late game)
2. Set `object.dirty_flag = 1` (+0x13)
3. Set `object.pairing_active_flag = 0` (+0x14)
4. Set `object.activation_tick_count = 0` (+0x17)
5. `remove_cashflow_from_family_resource(9, variant_index)` → `g_cash_balance -= payout_table[9][variant_index]` (the full refund)
6. `add_to_primary_family_ledger_bucket(9, -3)`

**What drives `pairing_status`:** `recompute_object_operational_status` (`1138:0860`) periodically recomputes `pairing_status` based on a score from `compute_object_operational_score` (`1138:040f`). For family 9 condos, the score averages `compute_runtime_tile_average()` across the 3 tiles, then applies variant/support bonuses. The result is compared against two global thresholds:

| Score range | `pairing_status` | Meaning |
|---|---|---|
| `< threshold_1` (`[0xe5ea]`) | `2` | Good — paired-waiting |
| `< threshold_2` (`[0xe5ec]`) | `1` | OK — active |
| `>= threshold_2` | `0` | Bad — unpaired (refund-eligible) |
| `< 0` (error) | `0xFF` | Invalid |

So the refund trigger is ultimately a **quality-of-service metric**: when the floor area around a sold condo lacks adequate commercial support (restaurants, shops), the operational score degrades past the threshold, `pairing_status` drops to `0`, and the next 3rd-day check issues the refund. The condo's own entities making commercial support trips are part of what drives the tile-level metrics that feed back into this score.

**Mechanism B: Expiry via `FUN_1138_0e77`**

Called when `stay_phase > 0x27` (39): if `pairing_active_flag` (+0x14) is set, clears `pairing_status` to `0`, `activation_tick_count` to `0`, and `pairing_active_flag` to `0`. If `pairing_active_flag == 0`, increments `activation_tick_count`. When `activation_tick_count` reaches `3`, sets `stay_phase` to `0x40` (pre-day-4) or `0x38` (post), marking dirty. This is a "three strikes" expiry for objects stuck in extended vacancy.

#### `route_entity_to_commercial_venue` (`1238:0000`) Return Codes

Now confirmed:
- `-1` / `0xffff`: no route found or blocked. Entity gets a delay; actor advances failure counter.
- `0`: route queued (entity waiting for elevator/stair slot)
- `1`: en route via stairwell
- `2`: en route via elevator
- `3`: arrived (source floor == target floor, or elevator at same floor)

#### Helper Semantics

`FUN_1228_6ce4` (`advance_slot_state_from_in_transit_or_increment`):
- If `object.stay_phase == 0x10`: rewrite to `1` (pre-day-4) or `9` (post-day-4) — this is a reset after the sibling-sync signal
- Otherwise: `object.stay_phase += 1` — **increment** the counter (not decrement). Called on teardown bounces and routing failures.

`FUN_1228_6ee8` (`decrement_entity_slot_counter_b`):
- `object.stay_phase -= 1` — **decrement** the counter. Called from state `0x01` dispatch handler (outbound commercial trip start). Each successful trip start decrements by 1.

`FUN_1228_6dea` (`try_set_parent_state_in_transit_if_all_slots_transit`, called from state `0x04`):
- If `object.stay_phase & 7 == 1`: immediately set `object.stay_phase = 0x10` (shortcut — last round)
- Otherwise: checks all 3 sibling entity slots; only when all siblings are in state `0x10` does it write `0x10` to `object.stay_phase`
- The net effect per morning cycle: tiles 0 and 2 (even) decrement via `6ee8`, tile 1 (odd) increments via `6ce4` → net -1 per cycle. After ~2 cycles from 3, stay_phase reaches 1, triggering the sync shortcut.

#### Full State Machine

```
REFRESH GATE (family 9, states < 0x40):
  State 0x10: daypart < 5 → dispatch; daypart >= 5 AND day_tick > 0xa06 → 1/12 RNG → dispatch
  State 0x00: daypart == 0 AND day_tick > 0xf0 → 1/12 RNG → dispatch; daypart == 6 → no-op; else → dispatch
  State 0x01: morning AND subtype_index % 4 == 0 → special path (see below); else same as 0x00
  State 0x04: base_offset == 2 → daypart >= 5 → dispatch; else daypart >= 5, day_tick > 0x960 OR 1/12 RNG → dispatch

DISPATCH (has_tenant path):
State 0x10 (re-arm / sibling sync):
  if object.stay_phase == 0x10: rewrite to 3, mark dirty
  if morning_flag == 1:
    subtype_index % 2 != 0 → advance_slot (INC stay_phase) → state 0x04  [stagger bounce]
    subtype_index % 2 == 0 → state 0x01
  else:
    base_offset == 1 → state 0x01
    else → state 0x00

State 0x01/0x41 (outbound commercial support trip):
  if state == 0x01: decrement_entity_slot_counter_b (DEC stay_phase)
  choose selector: 0 (not morning), 1 (morning + subtype_index%4==0), 2 (morning + other)
  call route_entity_to_commercial_venue (1238:0000)
    -1 → teardown (6ce4 INC) → state 0x04
    other → state 0x41

State 0x20/0x60 (arrival check — SALE POINT):
  call route_to_floor (1218:0000), passing is_sold=(stay_phase < 0x18)
  switch on result:
    no-route: stay_phase >= 0x18 → state 0x20, clear counters; stay_phase < 0x18 → teardown (6ce4) → state 0x04
    queued/en-route: stay_phase >= 0x18 → activate_commercial_tenant_cashflow → state 0x60 [SALE]; stay_phase < 0x18 → state 0x60
    arrived: stay_phase >= 0x18 → activate + teardown → state 0x04 [SALE]; stay_phase < 0x18 → teardown → state 0x04

State 0x21/0x61 (return route):
  call 1218:0000
    1/2/3 → state 0x61
    0/4 → teardown (6ce4) → state 0x04

State 0x22/0x62 (release venue slot, route home):
  call 1238:0244 (release + route back)
    -1/3 → teardown (6ce4) → state 0x04
    other → continue

State 0x04 (reset):
  entity state → 0x10
  call try_set_parent_state_in_transit_if_all_slots_transit (6dea)
    → sets stay_phase = 0x10 when all siblings in state 0x10 or stay_phase & 7 == 1
```

States `0x20..0x22` are the **unsold** equivalents of `0x60..0x62`. The activation (sale) is crossed at the `0x20`→`0x60` boundary. The `0x60`-series loop continues while the condo is occupied and the entity is making commercial support trips.

#### Headless Modeling Rules

- `object.stay_phase >= 0x18` → inactive/unsold; entity arriving here triggers sale
- `object.stay_phase < 0x18` → active/sold; entity is in the residential visit loop
- Credit sale revenue exactly once per activation crossing, using `payout_table[9][variant_index]`
- The condo can be sold again after a refund (byte resets to unsold threshold after deactivation)
- Refund fires on the next `g_day_counter % 3 == 0` tick after `pairing_status` falls to `0` and `stay_phase < 0x18`
- `pairing_status` is driven by `recompute_object_operational_status`: average tile-level runtime metrics across the 3 condo tiles, apply variant/support bonuses, compare against thresholds → `pairing_status` = 2/1/0
- Nonzero `pairing_status` blocks refund; zero allows it. The score reflects quality of commercial support in the condo's floor area.
- `activation_tick_count` (+0x17, capped at 120) is incremented per-tick while sold — its exact role in A/B/C condo rating display is not yet recovered, but it drives the "three strikes" vacancy expiry mechanism
- `stay_phase` oscillates: sale resets to 0/8 → dispatch resets from 0x10 to 3 → net -1 per morning cycle (even tiles DEC, odd tile INC) → reaches 1 → sync shortcut → back to 0x10

#### Operational Scoring — Resolved

**`compute_runtime_tile_average`** (`1138:037b`): computes `entity.word_0xe / entity.byte_0x9` — an accumulated per-tick metric divided by a sample count. Returns 0 if sample_count is 0. Higher average = worse (closer to refund threshold).

**`apply_variant_and_support_bonus_to_score`** (`1138:064b`): adjusts the raw tile average:

| `variant_index` (+0x16) | Adjustment | Meaning |
|---|---|---|
| 0 | +30 | Cheapest variant, penalty |
| 1 | 0 | Default, no change |
| 2 | -30 | Expensive variant, bonus |
| 3 | score = 0 | Best variant, always passes |

Missing nearby support adds +60 penalty. Result clamped to >= 0.

**Final score** = `avg(entity.word_0xe / entity.byte_0x9, across all tiles) + variant_adjustment + support_penalty`.

#### Demand Pipeline (Per-Entity Runtime Counters)

Each runtime entity maintains per-tick demand counters in the RuntimeEntityRecord:

- `word_0xa`: last-sampled `g_day_tick` (baseline for elapsed computation)
- `word_0xc`: packed — low 10 bits = elapsed ticks since last sample, high 6 bits = flags
- `word_0xe`: accumulated total of all per-sample elapsed values (running sum)
- `byte_0x9`: sample count (number of times the entity has been sampled)

The pipeline runs in two steps, called from `dispatch_entity_behavior` and from route resolution/venue acquisition:

1. **`rebase_entity_elapsed_from_clock`** (`11e0:00fc`): computes `elapsed = (word_0xc & 0x3ff) + g_day_tick - word_0xa`, clamps to 300, stores in `word_0xc` low 10 bits, saves current `g_day_tick` to `word_0xa`.
2. **`advance_entity_demand_counters`** (`11e0:0000`): drains `word_0xc & 0x3ff` into `word_0xe`, increments `byte_0x9`, clears the drained bits.

The tile average is then `word_0xe / byte_0x9` = **average elapsed ticks between entity visits**. This is an inter-visit interval: lower = more frequently visited = better operational score. The 300-tick clamp prevents a single long gap from dominating the running average.

**Thresholds** are per-star-rating, loaded by `refresh_operational_status_thresholds_for_star_rating` (`1148:01a9`) from a tuning table:

| Star rating | threshold_1 source | threshold_2 source |
|---|---|---|
| 1-2 | `[0xe5f8]` | `[0xe5fe]` |
| 3 | `[0xe5fa]` | `[0xe600]` |
| 4+ | `[0xe5fc]` | `[0xe602]` |

The tuning table at `[0xe5f8..0xe602]` is loaded from YEN resource type `0xff05`, id `1000` by `load_startup_tuning_resource_table`. Extracted values:

| Star rating | threshold_1 | threshold_2 |
|---|---|---|
| 1-2 | 80 | 150 |
| 3 | 80 | 150 |
| 4+ | 80 | 200 |

So: score < 80 → `pairing_status = 2` (good); score < 150/200 → `pairing_status = 1` (OK); score >= 150/200 → `pairing_status = 0` (refund-eligible). Stars 4+ is slightly more lenient (threshold_2 = 200 vs 150).

**`activation_tick_count`** (offset +0x17, formerly called `readiness_counter`/`visit_count`): incremented each tick by `activate_family_cashflow_if_operational` while the object is in the sold/active regime (`stay_phase` below the active threshold). Capped at 120 (0x78). Cleared on deactivation. Also reused as a "three strikes" counter by `handle_extended_vacancy_expiry` when `stay_phase > 0x27`.

**`pairing_active_flag`** (offset +0x14): set to 1 when the object is first paired or when `pairing_status` transitions from 0 to nonzero. Cleared by deactivation and by `handle_extended_vacancy_expiry`. Distinguishes "was once paired" from "never paired."

**`attempt_pairing_with_floor_neighbor`** (`1138:0f79`): when `pairing_status == 0` (unpaired) and `stay_phase < 0x28`, scans all slots on the same floor for another object with the same `family_code` and `pairing_status == 2` (waiting). If found, promotes both to `pairing_status = 1` (active pair) and sets `pairing_active_flag = 1`. If `pairing_status >= 1` already, just sets `pairing_active_flag = 1` and refreshes.

#### A/B/C Rating — Resolved

The manual describes condo ratings as A (brings inhabitants), B (continues living), C (leaves). These map directly to `pairing_status`:

| `pairing_status` | Rating | Score condition | Behavior |
|---|---|---|---|
| 2 | A | score < 80 | Well-serviced. Acts as "beacon" — the pairing scan can match this slot with an unpaired neighbor, enabling the neighbor's entity to proceed. |
| 1 | B | score < 150/200 | Active pair. Stable, continues living. |
| 0 | C | score >= 150/200 | Unpaired. Refund fires on next 3rd-day check. |

**The "A rating brings additional inhabitants" mechanism:**

1. A sold condo with excellent service (score < 80) gets `pairing_status = 2`.
2. `attempt_pairing_with_floor_neighbor` runs periodically. It finds a vacant same-family neighbor on the same floor with `pairing_status = 0`.
3. Both are promoted to `pairing_status = 1`. The neighbor's `pairing_active_flag` (+0x14) is set to 1.
4. The neighbor's entity was previously **blocked** at state 0x20 in the refresh handler: the no_tenant state 0x20 handler (`1228:3735`) gates on `pairing_active_flag != 0` — if 0, the entity idles and never routes to a commercial venue.
5. With `pairing_active_flag = 1`, the entity can now dispatch → route to a commercial venue → if routing succeeds and `stay_phase >= 0x18` → **sale fires** (`activate_commercial_tenant_cashflow`).

So the "additional inhabitant" is not a new entity spawning — it's an **existing idle entity on a vacant condo being unblocked** by a well-serviced neighbor. The pairing system is the A-rating mechanism.

All major condo mechanics are now resolved.

### Families `6`, `0x0c`, `10`: Commercial Venues

These are venue-side placed objects with associated sidecar records.

Interpretation:

- `6`: Restaurant
- `0x0c`: Fast Food
- `10`: Retail Shop

Important identification rule:

- the player-facing subtype-name tables `0x2ca`, `0x2cb`, and `0x2cc` belong to these raw venue families only
- those tables do not identify family `9`

These families maintain `CommercialVenueRecord` entries and participate in:

- slot acquisition and release
- demand/capacity tracking
- phase-gated dispatch
- direct income or readiness adjustments

Selector mapping:

- `0`: Retail Shop
- `1`: Restaurant
- `2`: Fast Food

#### Family `10` Extra Gate

Retail shares most visible states with restaurant and fast food, but state `0x20` does not dispatch if linked venue availability is negative unless an object aux byte is already set.

### Families `0x12` And `0x1d`: Entertainment / Event Facilities

These use a fixed 16-entry entertainment-link table.

Each link stores:

- forward and reverse anchors
- per-half phase bytes
- shared link phase
- selector/single-link flag
- age counter
- active-runtime count
- attendance counter

Daily flow:

1. At `0x0f0`, rebuild the family ledger:
   - recompute half-phase values
   - increment link age up to `0x7f`
   - clear pending transition state
   - clear active count
   - clear attendance count
2. At later checkpoints, promote, activate, and advance the link phases.
3. Runtime attendees in state `0x20/0x60` decrement phase budget, route to the entertainment anchor, and increment both active count and attendance on arrival.
4. Later phase advancement drains state-`3` actors, decrements active count, and on the second half accrues income.

Income rules:

- family `0x12`: payout derived from attendance thresholds
- family `0x1d`: fixed payout `0xc8` when attendance is nonzero

### Family `0x21`: Hotel Guest Behavior

This family models what hotel guests do, not hotel-room revenue itself.

Loop:

1. During active dayparts, randomly pick a venue bucket from retail/restaurant/fast food.
2. Choose a venue in that bucket.
3. Route there.
4. On arrival, acquire a venue slot.
5. Route back to the origin floor.
6. Repeat.
7. Park in state `0x27` at night.

Gate behavior:

- state `0x01` dispatches only in dayparts `0..3`, after tick `0x0f1`, on a `1/36` chance
- parked state resets for the next day after tick `0x08fd`

### Families `0x24` Through `0x28`: Star-Rating Evaluation Entities

These families model the “VIP visit” or evaluation event mechanically.

Known structure:

- 5 families
- 8 runtime slots each
- total of 40 evaluation entities

Flow:

1. If the tower has reached the required threshold and `g_calendar_phase_flag == 1`, evaluation becomes eligible.
2. Evaluation entities spawn or activate at ground floor `10`.
3. They route to floors `109..119`.
4. On arrival, each marks its placed-object state as evaluated.
5. When all 40 entities have arrived, award a star-rating upgrade.
6. Then route them back to ground and park them.

Gate behavior:

- outbound routing dispatches only during daypart `0`
- before `0x0050`, dispatch is suppressed
- from `0x0051` to `0x00f0`, dispatch is probabilistic
- after `0x00f0`, dispatch is forced
- after daypart `0`, entities park

### Family `0x18`: Parking

Parking is passive infrastructure.

Rules:

- allocate subtype slot
- do not create active runtime entity behavior
- never dispatch in tick-stride handlers
- only apply expense every third day during the expense sweep
- contribute to route/transfer-group cache via parking reachability

### Families `0x0b` And `0x2c`: Demand Anchors And Covered Emitters

Interpretation:

- `0x2c` is a vertical anchor family
- `0x0b` is a lateral covered-emitter family

Flow:

1. Clear service-request sidecar state.
2. Scan floors top-down for anchor objects.
3. For each anchor:
   - record its x coordinate
   - determine whether the stack continues below
   - write anchor state `0`, `1`, or `2`
   - propagate coverage laterally
4. Lateral propagation crosses only empty gaps of width `<= 3`
5. Covered emitters in range become active
6. Demand history is rebuilt only from emitters that remain covered

This subsystem is mechanically understood, but the exact player-facing object identities are still unresolved.

## Facility Readiness And Support Search

For families whose business health depends on support:

1. Compute a per-tile runtime metric.
2. Average across the object span.
3. Apply subtype variant modifier.
4. Search for support within the family-specific radius.
5. If support exists on either side, add a bonus.
6. Use the resulting score to determine activation/deactivation and selected-object warning state.

Family-specific support radii:

- families `3/4/5`: `0x14`
- family `7`: `0x0a`
- family `9`: `0x1e`

Exact nearby-family remap rules recovered from the binary should be preserved in a table-driven implementation.

## Money Model

Maintain:

- `cash_balance`
- `primary_ledger`
- `secondary_ledger`
- `tertiary_ledger`

### Income And Expense Rules

Positive cashflow:

- add to cash
- clamp so cash never exceeds `99,999,999`
- mirror into the secondary ledger

Expense:

- subtract from cash
- mirror into the tertiary ledger

### Resource Tables

Load and preserve these startup data sets:

- YEN `#1000`: construction/placement costs
- YEN `#1001`: family payout table
- YEN `#1002`: infrastructure expense table
- custom type `0xff05`, id `1000`: route-delay and status-threshold tuning values

### Periodic Expense Sweep

At periodic expense time:

- charge infrastructure by type
- charge scaled carrier expenses by carrier mode and unit count
- charge parking by width and tower-progress-selected rate

### Family Cashflow Activation and Pricing

#### Payout Table (YEN #1001)

Income is computed as `YEN_1001[family_code * 0x10 + variant_index * 4]`, byte-swapped from big-endian, and added to `g_cash_balance` via `add_cashflow_from_family_resource`. The full table (units: ¥10,000):

| Family | Name | Tier 0 (High) | Tier 1 (Default) | Tier 2 (Low) | Tier 3 (Lowest) |
|--------|------|---:|---:|---:|---:|
| 3 | Single Room | 30 | 20 | 15 | 5 |
| 4 | Twin Room | 45 | 30 | 20 | 8 |
| 5 | Hotel Suite | 90 | 60 | 40 | 15 |
| 7 | Office | 150 | 100 | 50 | 20 |
| 9 | Condo | 2000 | 1500 | 1000 | 400 |
| 10 | Retail Shop | 200 | 150 | 100 | 40 |

`variant_index = 4` is a special "no payout" sentinel (skipped by code).

#### Initial Pricing

Objects are initialized by the placement function (`FUN_1200_1847`):
- Families 7 (office), 9 (condo), 10 (retail): `variant_index = 1` (default tier)
- All other families (entertainment, etc.): `variant_index = 4` (no payout)

#### When Income Fires

| Family | Trigger | Function | Timing |
|--------|---------|----------|--------|
| 3/4/5 (Hotels) | Checkout | `deactivate_family_345_unit_with_income` | When `stay_phase & 7 == 0` after completing trip round |
| 7 (Office) | Periodic activation | `activate_office_cashflow` | Each tick while `stay_phase < 0x10` (occupied) |
| 9 (Condo) | One-time sale | `activate_commercial_tenant_cashflow` | When entity arrives while `stay_phase >= 0x18` (unsold) |
| 10 (Retail) | Periodic activation | `activate_retail_shop_cashflow` | Each tick while venue active |
| General | Periodic accrual | `accrue_facility_income_by_family` | Every 60th and 84th tick, rate-limited |

#### Price Adjustment

The player can change `variant_index` via the in-game price/rent editor (Windows dialog, code at `1108:0e10`). Changing the tier immediately calls `recompute_object_operational_status` to update `pairing_status`, because the scoring adjustment differs per tier:
- Tier 0 (highest price): +30 penalty to operational score
- Tier 1 (default): no adjustment
- Tier 2 (lower price): -30 bonus to operational score
- Tier 3 (lowest price): score forced to 0 (always satisfied, never refunded)

The trade-off: higher rent earns more per event but risks tenant departure (refund) due to worse operational score. Lower rent earns less but guarantees satisfaction.

#### Expense Table (YEN #1002)

Operating expenses are charged periodically by `apply_periodic_operating_expenses` (`1180:0bbe`), which sweeps all floors, carriers, and special-link records:
- Most placed objects: `add_infrastructure_expense_by_type` → `YEN_1002[type_code * 4]`
- Parking (types 0x18/0x19/0x1a): `add_parking_operating_expense` → star-rating-tiered rate × usage
- Carriers: `add_scaled_infrastructure_expense_by_type` with type codes 0x2a/0x01/0x2b × unit count
- Special links: type codes 0x1b/0x16 by link mode

Known expense values from YEN #1002: type 1=100, 14=200, 15=100, 20=500, 27=50, 31=1000, 42=200, 43=100, 44=100.

Do not treat ledger effects as informational only. Several open/close transitions change object bytes that feed later simulation behavior.

## Save And Load

A headless save state must include more than placed objects and money.

Persist and restore:

- demand-history queue
- path-seed list
- active-request list
- per-person runtime blocks
- entertainment link records
- commercial/facility sidecars
- runtime subtype mappings
- queue state
- ledger state
- calendar and day tick state

On load, rebuild any derived bucket tables required by the original restore path.

## Player Intervention Model

The original game receives player intervention through UI events, menus, dialogs, and tool actions. A headless reimplementation should normalize these into explicit commands.

### Command Ordering

Recommended rule:

- apply all player commands before the next simulation tick
- emit resulting prompts or notifications immediately
- only then continue time advancement

This ordering is an inference for the headless engine, not yet a fully recovered property of the original message-loop sequencing.

## Player Command: Build Something

This command covers:

- placing a room/facility/object
- adding a transport segment
- adding an elevator car or waiting floor
- constructing floor tiles or special structures

### Build Preconditions

The command should:

1. Validate cost using the construction-cost table where applicable.
2. Validate placement geometry and tile occupancy.
3. Validate special placement rules for the selected type.
4. Validate tower-state prerequisites, if any.
5. If invalid, reject with the relevant error notification.
6. If valid, deduct cash and mutate placed-object state.

### Build Side Effects

After a successful placement:

1. Insert or update the relevant `PlacedObjectRecord`.
2. Allocate any required runtime subtype index.
3. Allocate any required sidecar record:
   - facility record
   - entertainment link
   - service-request entry
4. Initialize family-specific object state bytes.
5. Mark affected objects dirty.
6. Rebuild any required reverse subtype mapping.
7. Trigger any local or global derived-state rebuilds required by the object class.

Examples:

- building a restaurant/fast-food/retail venue must allocate a `CommercialVenueRecord`
- building an entertainment pair must allocate or link an `EntertainmentLinkRecord`
- building a `0x0b` emitter must allocate a service-request entry and participate in demand-history rebuilds
- building parking must affect transfer-group cache inputs even though it creates no active runtime behavior

### Post-Build Rebuild Requirements

Depending on the object class, a successful build may require:

- route reachability rebuild
- transfer-group cache rebuild
- path bucket rebuild
- demand-history rebuild
- facility ledger rebuild
- object-span refresh

The exact minimal rebuild set per object class is not fully recovered. A safe headless implementation can conservatively rerun the relevant global rebuilds after each build command, then optimize later.

## Player Command: Demolish Or Remove Something

This command is the inverse of building.

Perform:

1. Validate that the target object exists and is removable.
2. Remove or deactivate the placed object.
3. Free any associated sidecar records or mark them free.
4. Invalidate runtime subtype mappings that pointed to the object.
5. Remove any dependent queued requests or route references, if the original code does so.
6. Rebuild derived route, demand, and facility state as needed.

This area is not fully recovered. Exact teardown behavior for every family and every in-flight runtime actor is still incomplete.

## Player Command: Change Rent Or Pricing

The manual states that rent changes alter stress and therefore tenant behavior. The reverse-engineered mechanics do not yet recover the full rent-setting path or exact formulas.

Headless spec:

1. Store a discrete pricing tier on each priced placed object, not as one global setting.
2. Distinguish at least these pricing modes:
   - office rent
   - hotel-room rent
   - shop rent
   - condo sale price
3. On later simulation evaluation, use the selected price tier as an input into tenant stress or satisfaction calculations.
4. Allow rent changes while the simulation is paused or running.
5. Do not apply an immediate occupancy flip purely because rent changed. Effects should appear through later stress/evaluation and occupancy checkpoints.
6. For condo-family objects, reject sale-price changes while the unit is occupied.

Known behavioral consequences:

- higher or lower rent affects perceived space quality
- that changes whether inhabitants stay, bring more tenants, or leave
- condo pricing is a sale-price decision, not recurring rent

Unknowns:

- exact data storage location for rent setting
- exact timing of recomputation
- exact formulas by family
- exact numeric tier tables for hotel, office, shop, and condo pricing
- whether the binary stores price tier on the object record, in a sidecar, or in a global pricing table keyed by subtype

## Player Command: Respond To A Prompt

Prompts include decisions such as:

- event dialogs
- spend-money-or-refuse decisions
- emergency-response choices
- star-upgrade acknowledgements
- other notification-acknowledgement flows

Headless model:

1. When the simulation reaches a decision point, emit a prompt object instead of blocking on UI.
2. Pause time advancement for that prompt if the original game blocks simulation there.
3. Accept a response command with the selected option.
4. Apply the side effects.
5. Resume stepping.

Known event-like examples from the manual:

- terrorist ransom prompt
- fire rescue / helicopter prompt
- hidden treasure notification
- VIP-related notifications

Recovered mechanics support:

- star-rating evaluation entities and upgrade award flow are partly recovered
- some prompt text and message ids exist

Not yet recovered:

- exact prompt scheduling code for fire flows (helicopter/rescue)
- exact damage and timing side effects for fire
- whether prompts pause the scheduler or merely gate specific commands

## Player Command: Pause Or Resume

For a headless engine:

- paused state means no scheduler ticks advance
- inspection commands remain allowed
- state-changing commands may either be allowed immediately or queued

The manual says the original pause mode still allows inspection via the magnifying glass. Exact command restrictions while paused are not yet recovered.

## Player Command: Change Elevator Configuration

This includes:

- adding cars
- changing waiting floors
- changing weekday/weekend scheduling
- express/local behavior settings

Mechanically, this should:

1. Update carrier/unit records.
2. Update served-floor or waiting-floor state.
3. Rebuild transfer-group cache and route reachability tables.
4. Preserve limits such as shaft count, car count, and route coverage.

The manual gives many behavior claims here, but the full control-path implementation is not yet recovered. A full headless implementation should therefore treat exact elevator-edit semantics as partially specified.

## Notifications And Outputs

Each step or command should be able to emit:

- cash deltas
- ledger updates
- object state changes
- occupancy changes
- star-rating upgrades
- prompt requests
- informational notifications

For parity testing, the most useful headless outputs are:

- complete serialized state
- per-tick event log
- per-command result log
- per-day ledger snapshots

## Recommended Execution Order For A Headless Tick

Use this order unless later reverse engineering disproves it:

1. Apply queued player commands.
2. Update any immediate derived data required by those commands.
3. Increment `day_tick`.
4. Recompute `daypart_index`.
5. Run checkpoint handlers for this tick.
6. Run any family gates or queued-route dispatch paths that the original scheduler executes at this tick.
7. Collect state changes, notifications, and prompt emissions.
8. If a blocking prompt is emitted, stop further advancement until the user responds.

## Missing Details

The following details are still missing for a full exact headless spec. Items are grouped by how early they block implementation.

### Tier 1: Blocks Core Simulation Loop

These gaps prevent even a minimal simulation from running.

#### Route Resolution Internals

The spec describes the route request flow, cost formulas, and delay values, but the pathfinding algorithm itself is not recovered:

- How the route scorer ranks and selects among candidates (local vs express vs carrier vs transfer-assisted)
- Carrier dispatch logic: elevator car scheduling, car-to-passenger assignment, queue drain order
- Transfer-group cache construction: how multi-segment routes are composed from single-segment reachability
- Path-seed and path-bucket data structures and their rebuild algorithms
- The exact walkability floor-flag scan: what constitutes an "incompatible floor flag" and how the 2-consecutive-incompatible-flag tolerance works
- The `0x28` internal status flag referenced in carrier route costs: what triggers it and what it means

Without route resolution, no entity can move, no income fires, and no occupancy changes.

#### Carrier (Elevator / Stair / Escalator) State Machines

Carriers are infrastructure for route resolution but have no specified internal behavior:

- How elevator cars move between floors tick-by-tick
- Car assignment to waiting passengers (FIFO? nearest? load-balanced?)
- Queue capacity limits per shaft
- Express vs local elevator behavioral differences
- Stair and escalator throughput modeling (capacity per tick, directionality)
- Weekend/weekday schedule effects on carrier behavior

#### Checkpoint Subsystem Bodies

The checkpoint table (ticks `0x000` through `0x09e5`) names what fires at each tick, but most handler bodies are described only in abstract terms:

- `0x000` "normalize start-of-day object states": which objects, which bytes, what values?
- `0x000` "rebuild demand-history state" / "rebuild path-seed buckets": algorithms not specified
- `0x0f0` "rebuild linked facility records" / "rebuild entertainment family ledger": data flow not specified
- `0x07d0` "advance linked facility records": what state transitions occur?
- `0x0898` "advance the type-6-specific facility cycle": type-6 phase machine not specified
- `0x09c4` "runtime-entity refresh/reset sweep": which families get parked, which get reset, in what order?

Only the ledger rollover checkpoint (`0x09e5`) and the entertainment cycle checkpoints have enough detail to implement directly.

### Tier 2: Blocks Primary Income Loops

These gaps prevent the main revenue-generating families from functioning even if routing worked.

#### Families `3/4/5` (Hotel Rooms) — Full State Machine

Condo family 9 has a complete state-by-state machine. Hotels are missing the equivalent:

- Full state transition diagram (states, guards, transitions) analogous to the family 9 machine
- How `stay_phase` evolves through the occupied → checkout → vacant cycle for each room size
- Per-state dispatch gates (which dayparts, which ticks, what RNG)
- How family `0x0f` vacancy claimants interact with hotel room state on successful claim
- Hotel checkout flow: exact sequence from `stay_phase & 7 == 0` through income credit to vacancy

#### Family `0x21` (Hotel Guest) — Venue Selection and Slot Mechanics

The guest loop says "randomly pick a venue bucket" and "choose a venue in that bucket," but:

- Distribution or weighting for bucket selection (uniform? biased by availability?)
- How a specific venue is chosen within the bucket (nearest? random? capacity-weighted?)
- Slot acquisition protocol on the venue side (what fields change in `CommercialVenueRecord`)
- Slot release protocol (what `1238:0244` does to the venue record)
- How guest count or visit frequency feeds back into venue income or capacity

#### Commercial Venue Records — Field Layout and Slot Protocol

Families `6` (restaurant), `0x0c` (fast food), and `10` (retail) maintain `CommercialVenueRecord` entries, but:

- No field-by-field layout for `CommercialVenueRecord`
- No slot acquisition/release algorithm
- No capacity tracking mechanics (max occupancy, current occupancy, how these are stored)
- Family 10 (retail) extra gate at state `0x20` references "linked venue availability" without defining what that field is or how it is computed
- How venue demand/capacity state feeds into the periodic facility-ledger rebuilds

### Tier 3: Blocks Secondary Systems

These gaps affect important but non-core subsystems.

#### Entertainment Link Phase Machine

Families `0x12` and `0x1d` use a 16-entry entertainment-link table. The daily flow is outlined but:

- Phase byte state machine: exact values and transitions for `per-half phase bytes` and `shared link phase`
- Promotion and activation conditions at each entertainment checkpoint
- Attendance threshold table for family `0x12` income calculation
- How runtime attendees interact with the link record (decrement phase budget, increment attendance — exact field offsets and semantics)
- How `active_runtime_count` gates or limits new attendees

#### Demand-History and Service-Request Pipeline

Families `0x0b` (lateral covered-emitter) and `0x2c` (vertical anchor) are mechanically understood at a high level, but:

- Data structures for the demand-history queue (ring buffer? fixed array? per-floor?)
- Exact lateral propagation algorithm (how does coverage cross empty gaps of width <= 3?)
- How covered emitters feed into the per-entity runtime tile metrics (`word_0xe / byte_0x9`)
- Relationship between demand-history rebuild and the `compute_runtime_tile_average` pipeline
- What "service-request sidecar entries" contain beyond the coverage state byte

#### Office Family `7` — Operational Details

The spec covers the scoring pipeline but:

- Exact `compute_averaged_runtime_score` algorithm across the 6-tile span
- What "variant-specific modifier" values are (beyond the generic +30/0/-30/force-0 table shared with condos)
- What constitutes "nearby support" for offices and the exact search radius semantics
- How office cashflow activates/deactivates per-tick (what `activate_office_cashflow` does to the ledger each tick vs. the periodic accrual at ticks 60/84)

### Tier 4: Blocks Player Interaction

These gaps prevent full player command support but do not block autonomous simulation.

#### Build / Demolish Rebuild Dependencies

- Exact minimal rebuild set per object class after placement
- Exact minimal rebuild set per object class after demolition
- Required rebuild ordering (must route reachability precede demand-history?)
- Which rebuilds are local (affected floor only) vs global

A conservative implementation can rerun all global rebuilds after every command, but this will be slow.

#### Elevator Editor Controls

- Adding/removing cars: effect on carrier records and route tables
- Changing waiting floors: how the served-floor bitmask or list is stored and updated
- Weekday/weekend schedule: storage format and how it gates carrier behavior per day
- Express/local mode: how it changes route scoring and floor coverage
- Shaft count and car count limits

#### Rent / Pricing UI Mapping

The pricing system is mechanically resolved (variant_index 0-3, scoring adjustments, payout table), but:

- Player-facing tier labels (what text the UI shows for each tier)
- Whether the rent-change dialog is per-object or per-family
- Exact validation rules (e.g., can you change condo price while sold? spec says no, but the exact guard is not recovered)

### Tier 5: Event System Residual Gaps

Fire, bomb/terrorist, VIP, security/housekeeping, hidden treasure, and prompt blocking are mechanically recovered (see earlier sections). Remaining gaps:

- **Bomb damage handler**: `FUN_10d0_02bd` (detonation damage) is called but its exact effects on placed objects (which tiles are destroyed, what happens to in-flight entities, cash impact) are not recovered
- **Fire damage handler**: `FUN_10f0_0858` (fire damage/rendering) is called during spread but its exact effects on placed objects are not recovered
- **Security search resolution**: `FUN_1100_033d(1)` starts the bomb search sequence, but the exact search algorithm (how security objects locate the bomb, success probability, timing) is not recovered

### Tier 6: Data Model and Tooling Completeness

These do not block any specific feature but limit confidence in edge cases.

- Full field-by-field layouts for every sidecar record type beyond what is already recovered
- Full field-by-field layout for carrier records (elevator shaft state, car state, served floors)
- Full naming coverage for parameters and locals across the mechanics codebase
- Exact purpose of generically named non-core functions adjacent to mechanics
- Player-facing tier labels for `variant_index` 0-3
- Exact command sequencing relative to the original Windows message loop
- Movie-theater management commands (changing the movie)
- Room name / label / inspector-driven setting edits
- Ledger/report presentation: how UI report pages derive numbers from the underlying ledgers
- Save file (`.twr`) binary format for loading original game saves

### Confidence Notes

- **Fully specified and implementable now**: time model, scheduler skeleton, money model (cash/ledgers/expense sweep), condo family 9 (complete state machine + scoring + sale/refund + A/B/C rating), star-rating evaluation entities (families `0x24`-`0x28`), parking (family `0x18`), payout and expense tables, object placement/demolish framework, operational scoring pipeline, demand counter pipeline, fire/bomb/VIP/security/treasure event triggers and flow, prompt blocking semantics.
- **Partially specified**: hotel rooms (identity and income trigger confirmed, full state machine missing), hotel guests (loop structure known, venue selection mechanics missing), commercial venues (role clear, record layout missing), entertainment (daily flow outlined, phase machine missing), route resolution (costs and delays recovered, pathfinding algorithm missing).
- **Unrecovered**: carrier state machines, checkpoint handler bodies, commercial venue record layout, elevator editor controls.
