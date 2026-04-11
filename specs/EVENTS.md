# Events

## Bomb Event

Trigger conditions (at `day_counter % 60 == 59`):

- no active bomb or fire event
- tower has at least one valid floor
- `day_tick < 1201`
- `star_count` must be 2, 3, or 4 (star 1 and star 5 cannot trigger bombs)

Floor and tile selection:

- floor chosen randomly from `lobby_height + 10` to the highest populated floor
- selected floor must have width > 3 tiles (right\_tile − left\_tile > 3)
- tile chosen randomly within `[left_tile, right_tile - 4]`

Ransom amounts (from tuning data):

- 2-star tower: $200,000
- 3-star tower: $300,000
- 4-star tower: $1,000,000

Flow:

1. choose floor and tile as above
2. compute ransom from star rating
3. emit modal ransom prompt (notification 0x2713, negative amount)
4. if the player pays: deduct ransom, show notification 0x271f, event ends
5. if the player refuses: arm the bomb

Armed bomb behavior:

- bomb_active flag is set
- deadline: bomb detonates at day_tick == 1200
- with security: shows armed-with-search prompt (0xbcd) with floor offset
- without security: shows armed-no-security prompt (0xbce)

### Security Patrol

Bomb search reuses the shared service-response helper pool seeded from the 10-slot security office table (type `0x0e`, capped at 10 placements). Each security office registers itself via `allocate_secondary_facility_slot` at placement time. The table is cleared together with the security office counter by `FUN_1100_0000`.

Behavior:

- On bomb arming, the system seeds up to 10 live stack slots, with 6 helper entities per slot.
- If no security exists, the helpers are left idle — there is no active bomb-search patrol.
- If security exists, one helper per live stack starts active and the others idle.
- There is no separate global "guard patrol" scheduler: active helpers advance only when their runtime-entity slots are visited by the normal 1/16 entity refresh stride (see TIME.md).
- Multi-stack coverage is the interleaving of all live state-0 helpers in runtime-table order.
- Each time a helper moves onto a floor, its scan counter is seeded from that floor's right edge: `scan_tile = right_tile - 2`.
- While `left_tile < scan_tile`, the helper decrements `scan_tile` and checks each tile against the bomb position.
- This yields a deterministic right-to-left tile sweep over `[right_tile - 3 .. left_tile]` on every visited floor.
- Once a floor is exhausted, the helper chooses the next floor from mutable lower/upper bounds (`object[+0xb]`, `object[+0xc]`) stored on the owning security office placed object, validates the move with the floor-traversal validator, then reseeds the tile scan on the destination floor.
- Helpers below their owning security office floor try `upper_bound - 1` first and fall back to `lower_bound + 1`; helpers at or above do the opposite.
- On bomb arming with security, those floor bounds start at `bomb_floor - 1` and `bomb_floor`, then tighten after each successful move, so the search expands one floor at a time around the target area.
- A helper that cannot advance to either candidate floor is permanently demoted to idle state 1.

The tile check compares the visited floor/tile against the stored bomb position. On an exact match, the bomb is found.

### Per-Tick Bomb Handler

Each tick checks:
1. If the bomb has been found or detonated and `day_tick` reaches the cleanup deadline: run bomb cleanup
2. If bomb search is active and `day_tick` reaches the detonation deadline: bomb detonates
3. If fire is active: run fire per-tick logic

### Search Resolution

- Found: mark bomb as found, extend deadline by `cleanup_delay` ticks from current tick
- Not found: mark bomb as detonated, show notification 0x2714, apply blast damage

### Bomb Cleanup

After the extended deadline:
- If bomb was found: shows found prompt (0xbcf), clears found flag
- If bomb detonated: shows exploded prompt (0xbd0), clears detonated flag
- Fast-forwards `day_tick` to 1500 and recomputes daypart

### Blast Area

Destruction rectangle:
- **Floors**: `bomb_floor - 2` to `bomb_floor + 3` (6 floors total)
- **Tiles**: `bomb_tile - 20` to `bomb_tile + 20` (40 tiles total)
- For each floor/tile in range: deletes the object covering that floor/tile position
- Objects that span multiple floors are deleted if any of their tiles fall within the blast rectangle
- The deletion uses the same teardown path as normal demolition

## Fire Event

Trigger conditions (at `day_counter % 84 == 83`):

- no active bomb or fire event
- tower has at least one valid floor
- `daypart_index < 4` (morning period)
- `star_count > 2` (must be 3-star or higher)
- `eval_entity_index < 0` (no cathedral evaluation currently active)

Note: OLD-SPEC.md misidentified type 0x28 as a "fire suppressor." Types 0x24–0x28
are all cathedral evaluation entity types. The `eval_entity_index < 0` guard simply
prevents fires during an active cathedral evaluation run — there is no fire suppressor
facility in the game.

Floor and tile selection:

- floor chosen randomly from `lobby_height + 10` to the highest populated floor
- selected floor must have width >= 32 tiles (right\_tile − left\_tile >= 32)
- fire position: `right_tile - 32` (fire starts 32 tiles from right edge)

Fire activation:

- fire_active flag is set
- `fire_start_tick = day_tick`
- with security: prompt 0xbc2, rescue countdown from `rescue_countdown` tuning parameter
- without security: prompt 0xbc3, rescue countdown = 0
- initializes two per-floor fire position arrays (120 entries each, one for left-spreading
  front, one for right-spreading front) to -1 (inactive)

### Fire Spread Mechanics

Two independent fire fronts track left-spreading and right-spreading fire per floor.

**Normal spread** (per-tick):

- If `rescue_countdown` > 0: decrement it and skip spread (helicopter en route)
- For each floor in the tower:
  - Fire starts on a new floor when `abs(floor - fire_floor) * vertical_spread_delay + fire_start_tick == day_tick` — fires spread vertically (both up and down) with a delay of `vertical_spread_delay` ticks per floor. The fire floor itself ignites at `day_tick == fire_start_tick` (the `abs` term is zero)
  - Both fronts initialize at the fire tile position
  - Left front: deletes objects at its position, moves left by 1 tile every `fire_spread_rate` ticks; stops when it reaches the floor's left boundary
  - Right front: deletes objects at `position + 12`, moves right by 1 tile every `fire_spread_rate` ticks; stops when `position + 12` exceeds the floor's right boundary
  - A front that reaches its boundary resets to -1 (inactive on that floor)

**Fire hit test**:

- Left zone: `fire_left_pos[floor]` to `fire_left_pos[floor] + 6`
- Right zone: `fire_right_pos[floor] + 6` to `fire_right_pos[floor] + 12`

### Helicopter Rescue

Helicopter rescue prompt fires at `fire_start_tick + cleanup_delay` ticks after ignition.

- If player accepts: deducts `helicopter_cost` from cash, sets `extinguish_position` to `floor_right_tile - 12` (extinguish start position), scrolls view to fire
- If player declines: fire continues spreading normally

**Helicopter extinguish**:

- When `extinguish_position` > 0: decrements position by 1 every `extinguish_rate` ticks
- The helicopter has a single tile position that sweeps all floors simultaneously: for each floor in the tower, if that floor's fire front position > helicopter position, reset that floor's fire fronts to -1
- This means the helicopter extinguishes fire on every affected floor at once as it passes each tile column — there is no per-floor sequencing
- When the position reaches the floor's left boundary, extinguish is complete

### Fire Resolution

Fire ends when:
- All fire fronts on all floors are -1 (exhausted), OR
- `day_tick` reaches 2000

On resolution:
- Clears fire_active flag
- Re-enables build menu items
- Shows completion notification (0xbc5)
- Resets fire position arrays
- If `day_tick < 1500`: fast-forwards time to 1500 and recomputes daypart

### Tuning Parameters (Fire)

Default tuning parameter values:

| Parameter | Meaning | Default value |
|-----------|---------|---:|
| fire_spread_rate | ticks per tile advance | `7` |
| vertical_spread_delay | ticks per floor | `80` |
| extinguish_rate | helicopter extinguish rate: ticks per tile | `1` |
| cleanup_delay | helicopter/bomb deadline extension delay | `2` |
| rescue_countdown | rescue countdown ticks (with security) | `80` |
| helicopter_cost | helicopter rescue cost ($100 units) | `5000` ($500,000) |

## VIP Special Visitor Event

Fires each tick when all of:

- `day_tick > 240`
- `daypart_index < 4` (morning period)
- no active bomb or fire event
- `vip_system_eligibility >= 0` (set when a VIP suite is placed)

Probability: `random() % 100 == 0` (1% per eligible tick).

On trigger, sweeps all placed objects on all floors for types 0x1f, 0x20, 0x21 (hotel suite variants):

- if `special_visitor_flag == 0`: set to 2 (activate special visitor), mark dirty, set activation flag
- if `special_visitor_flag != 0`: clear to 0, mark dirty

If any suite was activated, shows notification `0x271a`.

This event is independent of star evaluation — it is a cosmetic/income event for VIP hotel suites.

## Random News Events

After the early daily checkpoint and before late-day periods, the simulation can emit random news events with a low per-tick chance. These are cosmetic outputs only and do not change core simulation state.

Trigger path:

- runs only while notifications are enabled and no active bomb or fire event
- first RNG gate: `random() % 16 == 0`, so the base trigger rate is `1/16` per eligible tick
- second RNG gate: `random() % 6` chooses one of six visible-map sample buckets, not a star tier
- the six buckets sample the current viewport at:
  - mid-height, quarter-width
  - mid-height, half-width
  - mid-height, three-quarter-width
  - lower-quarter-height, quarter-width
  - lower-quarter-height, half-width
  - lower-quarter-height, three-quarter-width
- the sampled screen slot is converted back to a placed object; if the slot is empty above ground, a fallback "tower/general news" path is used instead

Object-to-notification mapping:

- hotel families `3/4/5`: notification `0x629`
- condo family `9`: notification `0x629` in the common case, with a `1/10` branch to `0x628`
- office family `7`: notification `0x5a8`
- restaurant family `6`: `0x568` or `0x569` with equal probability
- fast-food / retail families `0x0c` and `10`: `0x569` or `0x668` with equal probability
- parking ramp family `0x0b`: `0x6a8` or `0x6a9` with equal probability
- single-screen entertainment families `0x1d/0x1e`: notification `0xb28`
- paired entertainment families `0x12/0x13/0x22/0x23`: use the ready link selector byte when `link_phase_state == 3`; otherwise no news event is emitted from that sample
- empty above-ground sample: emits one of the general tower news notifications `0x2712`, `0x271b`, or `0x271c`, gated by the periodic-maintenance flag and by `(day_counter / 3) % 4`
- unsupported, inactive, or not-ready samples suppress the event

No recovered branch in this helper depends on star rating. The probabilities are driven by:

- eligible-tick frequency
- the uniform 6-bucket viewport sample
- whether the sampled object is active / news-eligible
- small per-family variant rolls inside the mapper
