# Time And Scheduler

## Tick Model

Maintain:

- `day_tick`: `0..0x0a27`
- `daypart_index = day_tick / 400`, giving `0..6`
- `day_counter`: increments once per day
- `calendar_phase_flag = ((day_counter % 12) % 3) >= 2`

`pre_day_4()` means `daypart_index < 4`.

### Daypart Boundaries

| Daypart | `day_tick` range | Label |
|---------|-----------------|-------|
| 0 | 0x000..0x18f (0–399) | early morning |
| 1 | 0x190..0x31f (400–799) | morning |
| 2 | 0x320..0x4af (800–1199) | late morning |
| 3 | 0x4b0..0x63f (1200–1599) | midday |
| 4 | 0x640..0x7cf (1600–1999) | afternoon |
| 5 | 0x7d0..0x95f (2000–2399) | evening |
| 6 | 0x960..0xa27 (2400–2599) | night |

**Morning vs evening period**: `pre_day_4()` (i.e. `daypart_index < 4`) selects the
"morning" behavioral period. When false (`daypart_index >= 4`), the game is in the
"evening" period. This distinction controls:

- `unit_status` initialization: morning starts at `0`, evening starts at `8`
- checkout band selection: morning → `0x28`, evening → `0x30`
- deactivation mark: morning → `0x18`, evening → `0x20` (condos); `0x10`/`0x18` (offices)
- hotel vacancy band: morning → `0x18`, evening → `0x20`

New game initializes `day_tick = 2533` which gives `daypart_index = 6` (night).
The first full `0x000..0xa27` cycle begins on the second sim day.

## RNG

Recovered generator:

- 32-bit linear congruential generator
- state update: `state = state * 0x015a4e35 + 1` modulo `2^32`
- returned value: `(state >> 16) & 0x7fff`

Recovered state storage:

- low word at `0x0fe0`
- high word at `0x0fe2`

Recovered seed flow:

- image-initialized seed is `1`
- the game has a small seed-setter helper, but no call sites to it have been recovered
- no reseed sites have been recovered in new-game initialization or normal simulation flow

Clean-room rule:

- initialize the RNG state to `1`
- advance it exactly once per recovered call site
- if exact replay across save/load is required, persist the 32-bit RNG state

## Top-Level Tick Order

Each simulation tick, in this exact order:

1. increment `day_tick`
2. recompute `daypart_index`
3. increment `day_counter` at the end-of-day boundary
4. wrap `day_tick` after the full daily range
5. run checkpoint-triggered work (if `day_tick` matches a checkpoint value)
6. run the entity refresh stride when not paused
7. run the carrier tick for every active car

Checkpoints always run before entity refresh on the same tick. Entities serviced
in the stride therefore see state that was already modified by any checkpoint that
fired on this tick.

## Entity Refresh Stride

The simulation does not update every actor every tick. It processes one sixteenth of the runtime-actor table per tick. Every actor therefore gets serviced once per 16-tick window.

Recovered visitation order:

- stride start index = `day_tick % 16`
- visit entity indices `start, start + 16, start + 32, ...` while the index is still `< runtime_entity_count`
- this is raw runtime-table order, not grouped by family or floor
- for each visited entity, the scheduler dispatches exactly one family-specific gate or refresh helper based on `family_code`
- family `3/4/5` has one extra guard: the refresh helper is skipped when the state word is `<= 0`

## Daily Checkpoints

Important checkpoints:

- `0x000`: start-of-day reset and reachability rebuild
- `0x020`: daily housekeeping reset
- `0x050`: conditional progress notification
- `0x078`: conditional progress notification
- `0x0a0`: morning notification
- `0x0f0`: facility-ledger rebuild and bomb/fire trigger checks
- `0x03e8`: entertainment half-runtime activation pass 1
- `0x04b0`: hotel sale reset, entertainment phase change, evaluation midday return
- `0x0578`: entertainment half-runtime activation pass 2
- `0x05dc`: entertainment phase advance pass 1
- `0x0640`: midday sweep, request flush, stay-phase advance, support/security reset, progress-override clear
- `0x06a4`: afternoon notification
- `0x0708`: no-op
- `0x076c`: entertainment phase advance pass 2
- `0x07d0`: linked-facility advance, security tier-2 check, periodic event trigger
- `0x0898`: type-6 facility advance
- `0x08fc`: increment day counter
- `0x0960`: no-op
- `0x09c4`: runtime refresh/reset sweep
- `0x09e5`: ledger rollover, cashflow activation, periodic expenses
- `0x09f6`: end-of-day notification
- `0x0a06`: final security check

## Composite Checkpoint Order

Recovered internal order for all multi-step checkpoints. Single-step checkpoints
are listed inline; multi-step checkpoints are expanded below.

### `0x000` — Start of Day

1. clear `g_facility_progress_override` to 0
2. **normalize object state bytes** (sweep all floors, exact-value matches only —
   values not listed below are left unchanged):
   - hotel (3/4/5): map `unit_status` 0x20→0x18, 0x30→0x28, 0x40→0x38 (step down one tier)
   - elevator (type 7): 0x18→0x10; any other nonzero → 0 (if `calendar_phase_flag == 0`) or 8 (if != 0)
   - escalator (type 9): 0x20→0x18
   - families 0x1f..0x21, 0x24..0x28: clear `object[+0xc]` and `object[+0xd]` to 0
   - mark each modified object dirty
3. **rebuild demand history table**: clear log, sweep 0x200-slot source table dropping invalid entries (an entry is **invalid** when its subtype byte equals `0xff` — the demolished-object tombstone), append live entries where the owning parking-space object's coverage flag is not `1`, recompute summary totals
4. **rebuild path-seed bucket table**: clear seed list, sweep the 10 service-link (type 0x0d) tracking slots, drop invalid entries, rebuild zone bucket tables for retail/restaurant/fast-food. Zone assignment: `bucket_index = max(0, (floor - 9) / 15)`, dividing the tower into 7 fifteen-floor bands. If `star_count > 2`, set flag enabling upper-tower entity activation
5. **refresh security/housekeeping states**: if `star_count <= 2` → fire low-star notification. Otherwise sweep placed objects: reset security guard (type 0x0e) state to 0, housekeeping cart (type 0x0f) state to 6; fire start-of-day notification
6. **activate upper-tower runtime group**: gated on `g_eval_entity_index >= 0` and `star_count > 2`. Sweep floors 100–104 for types 0x24..0x28; force 8 consecutive runtime entity slots per object to state `0x20` (yielding 40 eval entities total)
7. **update facility progress override**: if `day_counter % 8 == 4` AND `star_count < 5` → set `facility_progress_override = 1`

### `0x020` — Housekeeping Daily Reset

1. sweep type-0x0f (housekeeping) objects: reset state 6→0

### `0x050`, `0x078` — Conditional Progress Notification

1. if progress-override gate bit is set, fire notification (no state change)

### `0x0a0` — Morning Notification

1. fire morning notification popup (no state change)

### `0x0f0` — Facility Ledger Rebuild

1. **rebuild linked facility records**: clear family-0xc and family-0xa population ledger buckets; sweep 0x200-entry commercial-venue record table:
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

### `0x3e8` — Entertainment Half-Runtime Activation Pass 1

1. for paired-link records (`family_selector >= 0`) with `link_phase_state == 0`: set forward-half entity slots to state `0x20`, advance `link_phase_state` to 1

### `0x04b0` — Hotel Sale Reset / Entertainment Ready / Eval Midday Return

1. reset `g_family345_sale_count = 0`
2. promote paired entertainment links with `link_phase_state >= 2` to ready phase (state 3)
3. activate reverse-half runtime slots for single-link records with `link_phase_state == 0`: set slots to state `0x20`, advance to phase 1
4. **evaluation midday return**: if `g_eval_entity_index >= 0`: sweep floors 100–104 for types 0x24–0x28; clear `object[+0xc]` to 0, mark dirty; advance associated entities in state `0x03` to state `0x05`; if `game_state_flags bit 2` set → clear it

### `0x0578` — Entertainment Half-Runtime Activation Pass 2

1. for paired-link records with `link_phase_state == 1`: set reverse-half entity slots to state `0x20`

### `0x05dc` — Entertainment Phase Advance Pass 1

1. for paired-link records: process forward-half entities in state `0x03`:
   - if family is `0x1d` OR `pre_day_4() == false` → entity state `0x05`
   - else → entity state `0x01`
   - decrement `active_runtime_count`
   - set `link_phase_state`: 1 (if count reaches 0) or 2 (if entities remain)

### `0x0640` — Midday Sweep

1. **rebuild type-6 facility records**: clear family-6 population ledger bucket; sweep venue table: for type-6 entries call `recompute_facility_runtime_state`
2. **hotel pair-state update**: for hotel rooms (3/4/5) with `state >= 0x38`: check adjacent same-floor objects; if neighbor is hotel with state < 0x38: set neighbor's state to `0x40` (pre-day-4) or `0x38` (post); reset neighbor pairing fields
3. **hotel operational update**: for each hotel room: `recompute_object_operational_status`; `handle_extended_vacancy_expiry`. Then for each: `attempt_pairing_with_floor_neighbor`
4. **clear periodic vacancy slot**: if `day_counter % 9 != 3` → clear
5. **flush hotel requests**: sweep `g_active_request_table`, remove entries for families 3/4/5
6. **advance stay-phase tiers** (sweep all placed objects, exact-value matches only —
   values not listed are left unchanged):
   - hotel (3/4/5): 0x18→0x20, 0x28→0x30, 0x38→0x40; mark dirty
   - elevator (7): 0x10→0x18, 0x00→0x08; mark dirty
   - escalator (9): 0x18→0x20; if `state & 0xf8 == 0` → `state = (state & 7) | 0x08`
   - sky/transfer lobby (0xd): mark dirty
   - families 0x1f..0x21, 0x24..0x28: set `object[+0xc] = 1`, `object[+0xd] = 0`; mark dirty
7. **entertainment midday cycle**:
   - promote paired-link reverse-half `link_phase_state` 2→3
   - advance reverse phase for all links: single-link entities in `0x03` → `0x05`/`0x01`, accrue income (family 0x1d), reset `link_phase_state = 0`. Paired-link: same, accrue income (family 0x12), reset phase
8. **security housekeeping reset**: `update_security_housekeeping_state(0)` — clears `security_adequate` flag, sets all type-0x0e/0x0f `unit_status` to 0
9. **clear progress override**: clear `facility_progress_override` gate bit

### `0x06a4` — Afternoon Notification

1. fire afternoon notification popup (no state change)

### `0x0708` — No-Op

### `0x076c` — Entertainment Phase Advance Pass 2

1. advance reverse-half phase for paired-link records (same logic as midday reverse-phase advance for any link whose midday pass did not complete)

### `0x07d0` — Late Facility Cycle

1. **advance non-type-6 facility records**: sweep venue table; for non-type-6 entries call `seed_facility_runtime_link_state(floor, subtype, record_index)` (sets `availability_state = 3`, accrues income, derives state code)
2. **security tier-2 check**: `update_security_housekeeping_state(2)`. If `g_security_ledger_scale == 0` → fire "security insufficient", clear adequate flag. Otherwise: if `required_tier <= 2` → set adequate flag, update objects; else → clamp to tier 2, adequate stays clear
3. if `day_counter % 12 == 11` → set gate byte, fire periodic maintenance notification

### `0x0898` — Type-6 Facility Advance

1. sweep venue table; for type-6 entries call `seed_facility_runtime_link_state`

### `0x08fc` — Day Counter Increment

1. increment `g_day_counter` (wrap to 0 at 0x2ed4)
2. recompute `g_calendar_phase_flag`
3. palette update (display only)

### `0x0960` — No-Op

### `0x09c4` — Runtime Refresh Sweep

1. **rebuild all entity tile spans**: sweep all floors, call `update_entity_tile_span` per object
2. **reset runtime entity state** (sweep entity table, normalize by family):
   - 3/4/5 (hotel): state-word == 0 → `0x24`; unit_status ≤ 0x17 → `0x10`; else → `0x20`. Clear `[+7]`, `[+8]`
   - 6/10/12 (commercial): → `0x20`
   - 7 (office): → `0x20`. Clear `[+7]`, `[+8]`, word `[+0xc]`
   - 9 (condo): unit_status < 0x18 → `0x10`; else → `0x20`. Clear `[+7]`, `[+8]`
   - 14/33 (0xe/0x21 — security/hotel guest): → `0x01`
   - 15 (0xf — VIP claimant): → `0x00`, `[+7] = 0xff`
   - 18/29/36 (0x12/0x1d/0x24 — entertainment/eval): → `0x27`. Clear `[+7..+0x0e]`
3. **active-request dispatch**: sweep `g_active_request_table`, dispatch each entry through family handler
4. **object-state floor pass**: sweep placed objects, enforce minimums:
   - hotel (3/4/5): state < 0x18 → set 0x10
   - elevator (7): state < 0x10 → set 0x08
   - escalator (9): state < 0x18 → set 0x10

### `0x09e5` — Ledger Rollover And Expenses

1. if `day_counter % 3 == 0`: roll income/expense ledgers — save `g_cash_balance` into cycle base, clear 11 bucket slots each
2. for all objects: `recompute_object_operational_status`. If `day_counter % 3 == 0`: also `deactivate_family_cashflow_if_unpaired` then `activate_family_cashflow_if_operational`
3. if `day_counter % 3 == 0`: `apply_periodic_operating_expenses` — sweep floors, carriers, special links:
   - parking (0x18/0x19/0x1a): `add_parking_operating_expense`
   - other types: `add_infrastructure_expense_by_type(type_code)`
   - carriers: express (mode 0) → ¥400/unit, standard (mode 1) → ¥200/unit, service (mode 2) → ¥100/unit; scaled by car count
   - special links: stairwell → ¥50/unit; lobby-connector → separate rate; scaled by `(unit_count >> 1) + 1`
4. rebuild all entity tile spans (same as 0x09c4 step 1)
5. reset runtime entity state (same as 0x09c4 step 2)

### `0x09f6` — End-of-Day Notification

1. fire end-of-day notification popup (no state change)

### `0x0a06` — Final Security Check

1. `update_security_housekeeping_state(5)` — if required tier ≤ 5 → set adequate flag, assign tier. If > 5 → clamp to 5, adequate stays clear

### Per-Tick Work (when `day_tick > 0x0f0`)

In addition to the checkpoints above, every tick when `day_tick > 0x0f0`:
- if `daypart_index < 6`: 1/16 chance to trigger a random news event
- if `daypart_index < 4` and `g_metro_station_floor_index >= 0` and not paused: 1% chance to toggle metro-station display objects (sweep types 0x1f/0x20/0x21, toggle `object[+0xc]` between 0 and 2; fire notification 0x271a on first activation)

## Metro-Station Gate

The simulation tracks whether a metro station exists and on which floor its stack is anchored.

This value affects:

- metro display behavior
- 4-star to 5-star advancement eligibility
- placement bounds for some vertical infrastructure; when present, some placement checks reject anchors below `metro_floor - 1`

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

## Security/Housekeeping Tier Check

The tower computes a required duty tier from total population-ledger activity divided by the security scaling factor.

Two daily checkpoints use this:

- a tier-2 midday check
- a tier-5 end-of-day check

If the required tier is above the allowed checkpoint tier, the tower is considered security-inadequate for that phase of the day.

Required duty tier maps from total population-ledger activity using these thresholds:

- `< 500`: tier `1`
- `< 1000`: tier `2`
- `< 1500`: tier `3`
- `< 2000`: tier `4`
- `< 2500`: tier `5`
- otherwise: tier `6`
