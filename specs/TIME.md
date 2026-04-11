# Time And Scheduler

## Tick Model

Maintain:

- `day_tick`: 0..2599
- `daypart_index = day_tick / 400`, giving `0..6`
- `day_counter`: increments once per day
- `calendar_phase_flag = ((day_counter % 12) % 3) >= 2`

`daypart_index < 4` selects the morning period.

### Daypart Boundaries

| Daypart | `day_tick` range | Label |
|---------|-----------------|-------|
| 0 | 0–399 | early morning |
| 1 | 400–799 | morning |
| 2 | 800–1199 | late morning |
| 3 | 1200–1599 | midday |
| 4 | 1600–1999 | afternoon |
| 5 | 2000–2399 | evening |
| 6 | 2400–2599 | night |

**Morning vs evening period**: `daypart_index < 4` selects the
"morning" behavioral period. When false (`daypart_index >= 4`), the game is in the
"evening" period. This distinction controls:

- `unit_status` initialization: morning starts at `0`, evening starts at `8`
- checkout band selection: morning → `0x28`, evening → `0x30`
- deactivation mark: morning → `0x18`, evening → `0x20` (condos); `0x10`/`0x18` (offices)
- hotel vacancy band: morning → `0x18`, evening → `0x20`

New game initializes `day_tick = 2533` which gives `daypart_index = 6` (night).
The first full 0–2599 cycle begins on the second sim day.

## RNG

RNG algorithm:

- 32-bit linear congruential generator
- state update: `state = state * 0x015a4e35 + 1` modulo `2^32`
- returned value: `(state >> 16) & 0x7fff`

Seed behavior:

- image-initialized seed is `1`
- the game has a seed-setter helper, but no callers have been identified
- no reseed occurs during new-game initialization or normal simulation flow

Clean-room rule:

- initialize the RNG state to `1`
- advance it exactly once per RNG consumption point
- if exact replay across save/load is required, persist the 32-bit RNG state

Scheduler-level RNG order:

- command handlers may consume RNG immediately during command application, before the next scheduler tick begins
- within `run_simulation_day_scheduler()`, per-tick RNG consumers run in this top-level order:
  1. increment `day_tick` and recompute `daypart_index`
  2. if `day_tick > 240` and `daypart_index < 6`: run `trigger_random_news_event()` first
  3. if `day_tick > 240` and `daypart_index < 4`: run `trigger_vip_special_visitor()` second
  4. run the matching checkpoint body for the new tick value
  5. after the scheduler body returns, run the entity refresh stride in raw runtime-table order
  6. after entity refresh, run carrier ticks
- checkpoint-local ordering matters at `240`: `trigger_fire_event()` is called before `trigger_bomb_event()`
- the entity refresh stride is deterministic: start index `day_tick % 16`, then `start, start + 16, ...`; any family handler RNG calls therefore occur in raw runtime-entity order, not grouped by subsystem
- no carrier-tick step consumes RNG

Practical replay rule:

- for deterministic replay, preserve RNG consumption order across:
  - command application
  - scheduler per-tick event hooks (`news` before `VIP`)
  - checkpoint body order (`fire` before `bomb` at `240`)
  - entity refresh visitation order
- the exact RNG count inside a family handler is specified by that family's own rules; the scheduler-level ordering above is the global sequencing boundary

## Top-Level Tick Order

Each simulation tick, in this exact order:

1. increment `day_tick`
2. recompute `daypart_index`
3. increment `day_counter` at the end-of-day boundary
4. wrap `day_tick` after the full daily range
5. run the early per-tick event hooks for the new tick value (`trigger_random_news_event`, then `trigger_vip_special_visitor`, when eligible)
6. run checkpoint-triggered work (if `day_tick` matches a checkpoint value)
7. run the entity refresh stride when not paused
8. run the carrier tick for every active car

The pre-checkpoint event hooks always run before the checkpoint body on the same tick.
Checkpoints then run before entity refresh. Entities serviced in the stride therefore
see state that was already modified by any checkpoint that fired on this tick.

## Entity Refresh Stride

The simulation does not update every actor every tick. It processes one sixteenth of the runtime-actor table per tick. Every actor therefore gets serviced once per 16-tick window.

Visitation order:

- stride start index = `day_tick % 16`
- visit entity indices `start, start + 16, start + 32, ...` while the index is still `< runtime_entity_count`
- this is raw runtime-table order, not grouped by family or floor
- for each visited entity, the scheduler dispatches exactly one family-specific gate or refresh helper based on `family_code`
- family `3/4/5` has one extra guard: the refresh helper is skipped when the state word is `<= 0`

## Daily Checkpoints

Important checkpoints:

- `0`: start-of-day reset and reachability rebuild
- `32`: daily recycling center reset
- `80`: conditional progress notification
- `120`: conditional progress notification
- `160`: morning notification
- `240`: facility-ledger rebuild and bomb/fire trigger checks
- `1000`: entertainment half-runtime activation pass 1
- `1200`: hotel sale reset, entertainment phase change, evaluation midday return
- `1400`: entertainment half-runtime activation pass 2
- `1500`: entertainment phase advance pass 1
- `1600`: midday sweep, request flush, stay-phase advance, support/recycling reset, progress-override clear
- `1700`: afternoon notification
- `1800`: no-op
- `1900`: entertainment phase advance pass 2
- `2000`: linked-facility advance, recycling tier-2 check, periodic event trigger
- `2200`: type-6 facility advance
- `2300`: increment day counter
- `2400`: no-op
- `2500`: runtime refresh/reset sweep
- `2533`: ledger rollover, cashflow activation, periodic expenses
- `2550`: end-of-day notification
- `2566`: final recycling adequacy check

## Composite Checkpoint Order

Internal order for all multi-step checkpoints. Single-step checkpoints
are listed inline; multi-step checkpoints are expanded below.

### 0 — Start of Day

1. clear `facility_progress_override` to 0
2. **normalize object state bytes** (sweep all floors, exact-value matches only —
   values not listed below are left unchanged):
   - hotel (3/4/5): map `unit_status` 0x20→0x18, 0x30→0x28, 0x40→0x38 (step down one tier)
   - elevator (type 7): 0x18→0x10; any other nonzero → 0 (if `calendar_phase_flag == 0`) or 8 (if != 0)
   - escalator (type 9): 0x20→0x18
   - families 0x1f..0x21, 0x24..0x28: clear `special_visitor_flag` and `special_visitor_counter` to 0
   - mark each modified object dirty
3. **rebuild demand history table**: clear log, sweep 512-slot source table dropping invalid entries (an entry is **invalid** when its subtype byte equals `0xff` — the demolished-object tombstone), append live entries where the owning parking-space object's coverage flag is not `1`, recompute summary totals
4. **rebuild path-seed bucket table**: clear seed list, sweep the 10 service-link (type 0x0d) tracking slots, drop invalid entries, rebuild zone bucket tables for retail/restaurant/fast-food. Zone assignment: `bucket_index = max(0, (floor - 9) / 15)`, dividing the tower into 7 fifteen-floor bands. If `star_count > 2`, set flag enabling upper-tower entity activation
5. **refresh recycling center states**: if `star_count <= 2` → fire low-star notification. Otherwise refresh the live recycling center state (types `0x14/0x15`) for the new day, then fire the start-of-day notification
6. **activate upper-tower runtime group**: gated on `eval_entity_index >= 0` and `star_count > 2`. Sweep floors 100–104 for types 0x24..0x28; force 8 consecutive runtime entity slots per object to state `0x20` (yielding 40 eval entities total)
7. **update facility progress override**: if `day_counter % 8 == 4` AND `star_count < 5` → set `facility_progress_override = 1`

### 32 — Recycling Center Daily Reset

1. sweep live type-`0x15` recycling center (lower floor) objects: reset `stay_phase` `6 -> 0`, mark dirty

### 80, 120 — Conditional Progress Notification

1. if progress-override gate bit is set, fire notification (no state change)

### 160 — Morning Notification

1. fire morning notification popup (no state change)

### 240 — Facility Ledger Rebuild

1. **rebuild linked facility records**: clear family-0xc and family-0xa population ledger buckets; sweep 512-entry commercial-venue record table:
   - `floor_index == -1` → skip
   - `subtype_index == -1` → mark invalid, decrement active venue count
   - else if object is not type 6 → `recompute_facility_runtime_state(floor, subtype, record_index)`
2. **rebuild entertainment family ledger**: clear family-0x12 and family-0x1d population ledger buckets; sweep 16-entry entertainment-link table:
   - `forward_floor_index == -1` → skip
   - single-link (`family_selector < 0`): `forward_runtime_phase = 0`, `reverse_runtime_phase = 50`; family = 0x1d
   - paired-link: compute `income_rate` for both halves; family = 0x12
   - add combined rate to population ledger bucket
   - increment `link_age_counter` (capped at 0x7f)
   - clear `pending_transition_flag`, `active_runtime_count`, `attendance_counter`
3. **event triggers**:
   - if `day_counter % 84 == 83` → `trigger_fire_event()`
   - if `day_counter % 60 == 59` → `trigger_bomb_event()`

### 1000 — Entertainment Half-Runtime Activation Pass 1

1. for paired-link records (`family_selector >= 0`) with `link_phase_state == 0`: set forward-half entity slots to state `0x20`, advance `link_phase_state` to 1

### 1200 — Hotel Sale Reset / Entertainment Ready / Eval Midday Return

1. reset `family345_sale_count = 0`
   - this is the same counter incremented by hotel-room checkout income; it is not a global lifetime statistic
2. promote paired entertainment links with `link_phase_state >= 2` to ready phase (state 3)
3. activate reverse-half runtime slots for single-link records with `link_phase_state == 0`: set slots to state `0x20`, advance to phase 1
4. **evaluation midday return**: if `eval_entity_index >= 0`: sweep floors 100–104 for types 0x24–0x28; clear `special_visitor_flag` to 0, mark dirty; advance associated entities in state `0x03` to state `0x05`; if `game_state_flags bit 2` set → clear it

### 1400 — Entertainment Half-Runtime Activation Pass 2

1. for paired-link records with `link_phase_state == 1`: set reverse-half entity slots to state `0x20`

### 1500 — Entertainment Phase Advance Pass 1

1. for paired-link records: process forward-half entities in state `0x03`:
   - if family is `0x1d` OR `daypart_index >= 4` → entity state `0x05`
   - else → entity state `0x01`
   - decrement `active_runtime_count`
   - set `link_phase_state`: 1 (if count reaches 0) or 2 (if entities remain)

### 1600 — Midday Sweep

1. **rebuild type-6 facility records**: clear family-6 population ledger bucket; sweep venue table: for type-6 entries call `recompute_facility_runtime_state`
2. **hotel pair-state update**: for hotel rooms (3/4/5) with `state >= 0x38`: check adjacent same-floor objects; if neighbor is hotel with state < 0x38: set neighbor's state to `0x40` (pre-day-4) or `0x38` (post); reset neighbor pairing fields
3. **hotel operational update**: for each hotel room: `recompute_object_operational_status`; `handle_extended_vacancy_expiry`. Then for each: `attempt_pairing_with_floor_neighbor`
4. **clear periodic vacancy slot**: if `day_counter % 9 != 3` → clear
5. **flush hotel requests**: sweep `active_request_table`, remove entries for families 3/4/5
6. **advance stay-phase tiers** (sweep all placed objects, exact-value matches only —
   values not listed are left unchanged):
   - hotel (3/4/5): 0x18→0x20, 0x28→0x30, 0x38→0x40; mark dirty
   - elevator (7): 0x10→0x18, 0x00→0x08; mark dirty
   - escalator (9): 0x18→0x20; if `state & 0xf8 == 0` → `state = (state & 7) | 0x08`
   - sky/transfer lobby (0xd): mark dirty
   - families 0x1f..0x21, 0x24..0x28: set `special_visitor_flag = 1`, `special_visitor_counter = 0`; mark dirty
7. **entertainment midday cycle**:
   - promote paired-link reverse-half `link_phase_state` 2→3
   - advance reverse phase for all links: single-link entities in `0x03` → `0x05`/`0x01`, accrue income (family 0x1d), reset `link_phase_state = 0`. Paired-link: same, accrue income (family 0x12), reset phase
8. **recycling center reset**: `update_recycling_center_state(0)`. Guarded by `star_count > 2`. If `g_recycling_center_count == 0` → fire popup `3`, clear `g_recycling_adequate_flag`, do not sweep objects. Otherwise compute `required_tier = compute_recycling_required_tier()`, clamp the applied tier to `0`, clear `g_recycling_adequate_flag`, and sweep live recycling center objects (types `0x14`/`0x15`): write `stay_phase = 0` and `dirty = 1`, except that objects already at `stay_phase == 5` are left unchanged
9. **clear progress override**: clear `facility_progress_override` gate bit

### 1700 — Afternoon Notification

1. fire afternoon notification popup (no state change)

### 1800 — No-Op

### 1900 — Entertainment Phase Advance Pass 2

1. advance reverse-half phase for paired-link records (same logic as midday reverse-phase advance for any link whose midday pass did not complete)

### 2000 — Late Facility Cycle

1. **advance non-type-6 facility records**: sweep venue table; for non-type-6 entries call `seed_facility_runtime_link_state(floor, subtype, record_index)` (sets `availability_state = 3`, accrues income, derives state code)
2. **recycling tier-2 check**: `update_recycling_center_state(2)`. Guarded by `star_count > 2`. If `g_recycling_center_count == 0` → fire popup `3` ("recycling insufficient"), clear `g_recycling_adequate_flag`, do not sweep objects. Otherwise compute `required_tier = compute_recycling_required_tier()`: if `required_tier <= 2` → set `g_recycling_adequate_flag = 1` and assign the exact required tier; else → clear the flag and clamp the applied tier to `2`. Sweep live recycling center objects (types `0x14`/`0x15`), writing `stay_phase = applied_tier` and `dirty = 1`, except that an inadequate pass leaves any stack already at `stay_phase == 5` unchanged
3. if `day_counter % 12 == 11` → set gate byte, fire periodic maintenance notification

### 2200 — Type-6 Facility Advance

1. sweep venue table; for type-6 entries call `seed_facility_runtime_link_state`

### 2300 — Day Counter Increment

1. increment `day_counter` (wrap to 0 at 11988)
2. recompute `calendar_phase_flag`
   - the wrap is immediate and consistent: when the incremented counter reaches 11988, the scheduler first writes `day_counter = 0` and then calls `compute_calendar_phase_flag()`
   - the wrapped day therefore starts a fresh 12-day cycle with `calendar_phase_flag = 0`; no stale pre-wrap phase survives the rollover tick
3. palette update (display only)

### 2400 — No-Op

### 2500 — Runtime Refresh Sweep

1. **rebuild all entity tile spans**: sweep all floors, call `update_entity_tile_span` per object
2. **reset runtime entity state** (sweep entity table, normalize by family):
   - 3/4/5 (hotel): state-word == 0 → `0x24`; unit_status ≤ 0x17 → `0x10`; else → `0x20`. Clear `spawn_floor`, `route_carrier`
   - 6/10/12 (commercial): → `0x20`
   - 7 (office): → `0x20`. Clear `spawn_floor`, `route_carrier`, `target_floor_packed`
   - 9 (condo): unit_status < 0x18 → `0x10`; else → `0x20`. Clear `spawn_floor`, `route_carrier`
   - 14/33 (0xe/0x21 — security/hotel guest): → `0x01`
   - 15 (0xf — VIP claimant): → `0x00`, `spawn_floor = 0xff` (null sentinel)
   - 18/29/36 (0x12/0x1d/0x24 — entertainment/eval): → `0x27`. Clear all aux fields
3. **active-request dispatch**: sweep `active_request_table`, dispatch each entry through family handler
4. **object-state floor pass**: sweep placed objects, enforce minimums:
   - hotel (3/4/5): state < 0x18 → set 0x10
   - elevator (7): state < 0x10 → set 0x08
   - escalator (9): state < 0x18 → set 0x10

### 2533 — Ledger Rollover And Expenses

This checkpoint runs after checkpoint 2300, so it tests the already-incremented `day_counter`
value. It is physically late in the day, but it starts the accounting cycle for the new
day number. On a fresh game, the first live checkpoint 2533 sees `day_counter == 1`;
the first rollover/expense pass therefore occurs when `day_counter == 3`.

1. if `day_counter % 3 == 0`: roll income/expense ledgers first — save `cash_balance` into cycle base, clear 11 bucket slots each
2. for all objects: `recompute_object_operational_status`. If `day_counter % 3 == 0`: then `deactivate_family_cashflow_if_unpaired`, then `activate_family_cashflow_if_operational`
3. if `day_counter % 3 == 0`: after that object sweep, run `apply_periodic_operating_expenses` — sweep floors, carriers, special links:
   - parking (0x18/0x19/0x1a): `add_parking_operating_expense`
   - other types: `add_infrastructure_expense_by_type(type_code)`
   - carriers: remap carrier mode to expense type for express/standard/service, then charge the table value times `unit_record_count`
   - concrete carrier costs per 3-day pass: express `$20,000` per car, standard `$10,000` per car, service `$10,000` per car
   - special links: local stair branch charges `$5,000` per scaled unit and express escalator branch charges `$0`; both are scaled by `(unit_count >> 1) + 1`
   - the raw branch-to-type remap is inverted relative to player-facing type codes: low-bit-`0` local links use the stair expense rate, low-bit-`1` express links use the escalator expense rate
4. rebuild all entity tile spans (same as checkpoint 2500 step 1)
5. reset runtime entity state (same as checkpoint 2500 step 2)

### 2550 — End-of-Day Notification

1. fire end-of-day notification popup (no state change)

### 2566 — Final Recycling Adequacy Check

1. `update_recycling_center_state(5)` — guarded by `star_count > 2`. If `g_recycling_center_count == 0` → fire popup `3`, clear `g_recycling_adequate_flag`, do not sweep objects. Otherwise compute `required_tier`: if `required_tier <= 5` → set adequate flag and assign the exact tier; if `required_tier > 5` → fire popup `4`, clear adequate flag, clamp the applied tier to `5`. Sweep live recycling center objects (types `0x14`/`0x15`), writing `stay_phase = applied_tier` and `dirty = 1`, except that an inadequate pass leaves any stack already at `stay_phase == 5` unchanged

### Per-Tick Work (when `day_tick > 240`)

In addition to the checkpoints above, every tick when `day_tick > 240`:
- if `daypart_index < 6`: `trigger_random_news_event()` runs when notifications are enabled and no bomb/fire event is active; it rolls `rand() % 16`, and on `0` samples one of six fixed screen buckets (`x = 1/4, 1/2, 3/4` of visible width; `y = 1/2 or 3/4` of visible height) before mapping the sampled object to a news notification family
- if `daypart_index < 4` and `metro_station_floor_index >= 0` and not paused: `trigger_vip_special_visitor()` runs with extra guards that no bomb/fire event is active and `vip_system_eligibility >= 0`; on `rand() % 100 == 0`, it sweeps metro-stack types `0x1f/0x20/0x21`, toggles `special_visitor_flag` between `0` and `2`, marks each touched object dirty, and fires notification `0x271a` if any object flipped from `0` to `2`

Ordering note:

- these per-tick hooks run before the checkpoint body for the same tick value, not after it

## Metro-Station Gate

The simulation tracks whether a metro station exists and on which floor its stack is anchored.

This value affects:

- metro display behavior
- 4-star to 5-star advancement eligibility
- placement bounds for some vertical infrastructure; when present, some placement checks reject anchors below `metro_floor - 1`

- progression and placement use the global metro presence/floor state, not the per-object aux word
- the random VIP/special-visitor event only mutates metro-stack `special_visitor_flag` and dirty flags
- no routing, economy, or progression gate reads metro `special_visitor_flag`
- clean-room implementations can therefore treat metro `special_visitor_flag` as a display-variant flag

## New Game Initialization

New game state should initialize:

- starting cash to `$2,000,000`
- `day_tick = 2533`
- `day_counter = 0`
- `star_count = 1`
- no placed objects
- no metro station
- no active evaluation site
- all progression gates cleared
- empty ledgers, queues, caches, sidecars, and runtime actors

## Recycling Center Adequacy Check

The tower computes a required duty tier from total population-ledger activity divided by
`g_recycling_center_count` (the number of placed recycling center stacks).

Two daily checkpoints use this:

- a tier-2 midday check (tick 2000)
- a tier-5 end-of-day check (tick 2566)

`update_recycling_center_state(0)` at checkpoint 1600 uses the same machinery
but always clears adequacy by clamping the applied tier to `0` whenever the count is
nonzero.

If the required tier is above the allowed checkpoint tier, the tower is considered
recycling-inadequate for that phase of the day. This matches the manual: "When your
building attains a certain size, it will require a recycling center to process its
trash; larger buildings will require additional centers."

The checker only runs when `star_count > 2`. Live sweeps operate on
recycling center types (`0x14` upper floor / `0x15` lower floor).

Required duty tier maps from total population-ledger activity using these thresholds:

- `< 500`: tier `1`
- `< 1000`: tier `2`
- `< 1500`: tier `3`
- `< 2000`: tier `4`
- `< 2500`: tier `5`
- otherwise: tier `6`
