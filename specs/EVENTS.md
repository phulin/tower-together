# Events

## Bomb Event

Binary-verified from `trigger_bomb_event` at `10d0:006e` and `resolve_bomb_search` at `10d0:01f7`.

Trigger conditions (at `day_counter % 60 == 59`):

- `game_state_flags & 9 == 0` (no active bomb or fire)
- `0xbc6e != 0` (tower has at least one valid floor)
- `g_day_tick < 0x4b1` (1201)
- `star_count` must be 2, 3, or 4 (star 1 and star 5 cannot trigger bombs)

Floor and tile selection:

- floor chosen randomly from `g_lobby_height + 10` to the highest populated floor
- selected floor must have width > 3 tiles (right\_tile − left\_tile > 3)
- tile chosen randomly within `[left_tile, right_tile - 4]`

Ransom amounts (from tuning data):

- 2-star tower: `[DS:0xe690]` (default `$200,000`)
- 3-star tower: `[DS:0xe692]` (default `$300,000`)
- 4-star tower: `[DS:0xe694]` (default `$1,000,000`)

Flow:

1. choose floor and tile as above
2. compute ransom from star rating
3. emit modal ransom prompt (notification 0x2713, negative amount)
4. if the player pays: deduct ransom, show notification 0x271f, event ends
5. if the player refuses: arm the bomb

Armed bomb behavior:

- `bomb_active` flag set (`[0xbc7a] += 1`)
- deadline stored at `[0xbc80] = 0x4b0` (1200 ticks)
- with security (`0xbc5e >= 0`): shows prompt 0xbcd with floor offset
- without security (`0xbc5e < 0`): shows prompt 0xbce

### Security Patrol

Binary-verified from `FUN_10d0_01c4` at `10d0:01c4`.

The "deterministic patrol" is the normal security guard entity movement. When a security
guard visits a floor/tile, `FUN_10d0_01c4(floor, tile)` is called. If the floor and tile
exactly match the bomb's stored position (`[0xbc7e]`, `[0xbc7c]`), the bomb is found and
`resolve_bomb_search(1)` is called. There is no special search algorithm — the guard's
normal route determines whether the bomb is discovered.

### Per-Tick Bomb Handler

Binary-verified from `FUN_10d0_0000` at `10d0:0000`.

Each tick checks:
1. If bomb flags `& 0x60` (found or detonated) and `g_day_tick == [0xbc80]`: run cleanup (`FUN_10d0_0254`)
2. If bomb flags `& 1` (active search) and `g_day_tick == [0xbc80]` (deadline): `resolve_bomb_search(0)` — detonation
3. If fire flags `& 8` (active fire): run fire per-tick logic

### Search Resolution (`resolve_bomb_search`)

- found (`param != 0`): flag `|= 0x20`, deadline extended: `[0xbc80] = g_day_tick + [DS:0xe64a]`
- not found (`param == 0`): flag `|= 0x40`, notification 0x2714, blast damage applied

### Bomb Cleanup (`FUN_10d0_0254`)

After the extended deadline:
- If bomb was found (flag `& 0x20`): shows "found" prompt (0xbcf), clears found flag
- If bomb detonated (flag `& 0x20 == 0`): shows "exploded" prompt (0xbd0), clears detonated flag
- Fast-forwards `g_day_tick` to 0x5dc (1500) and recomputes daypart

### Blast Area

Binary-verified from `FUN_10d0_02bd` at `10d0:02bd`.

Destruction rectangle:
- **Floors**: `bomb_floor - 2` to `bomb_floor + 3` (6 floors total)
- **Tiles**: `bomb_tile - 20` to `bomb_tile + 20` (40 tiles total)
- For each floor/tile in range: calls `delete_object_covering_floor_tile(floor, tile, 0)`
- Objects that span multiple floors are deleted if any of their tiles fall within the blast rectangle
- The deletion uses the same teardown path as normal demolition

## Fire Event

Binary-verified from `trigger_fire_event` at `10f0:0029`.

Trigger conditions (at `day_counter % 84 == 83`):

- `game_state_flags & 9 == 0` (no active bomb or fire)
- `0xbc6e != 0` (tower has at least one valid floor)
- `pre_day_4()` returns nonzero — i.e. `daypart_index < 4` (morning period)
- `star_count > 2` (must be 3-star or higher)
- `g_eval_entity_index < 0` (no cathedral evaluation currently active)

Note: OLD-SPEC.md misidentified type 0x28 as a "fire suppressor." Types 0x24–0x28
are all cathedral evaluation entity types. The `g_eval_entity_index < 0` guard simply
prevents fires during an active cathedral evaluation run — there is no fire suppressor
facility in the game.

Floor and tile selection:

- floor chosen randomly from `g_lobby_height + 10` to the highest populated floor
- selected floor must have width >= 32 tiles (right\_tile − left\_tile >= 0x20)
- fire position: `right_tile - 0x20` (fire starts 32 tiles from right edge)

Fire activation:

- `[0xbc7a] |= 8` (fire active flag)
- `[0xbc84] = g_day_tick` (fire start tick)
- with security (`0xbc5e >= 0`): prompt 0xbc2, rescue countdown from `[DS:0xe64c]`
- without security (`0xbc5e < 0`): prompt 0xbc3, rescue countdown = 0
- initializes two per-floor fire position arrays (120 entries each, one for left-spreading
  front, one for right-spreading front) to `0xffff` (inactive)

### Fire Spread Mechanics

Binary-verified from `FUN_10f0_0306` and `advance_fire_spread` at `10f0:0452`.

Two independent fire fronts track left-spreading and right-spreading fire per floor.

**Normal spread** (per-tick, `FUN_10f0_0306`):

- If `rescue_countdown` (`[0xbc86]`) > 0: decrement it and skip spread (helicopter en route)
- For each floor in the tower:
  - Fire starts on a new floor when `(floor - fire_floor) * [DS:0xe646] + fire_start_tick == g_day_tick` — fires spread vertically with a delay of `[DS:0xe646]` ticks per floor
  - Both fronts initialize at the fire tile position (`[0xbc88]`)
  - Left front: deletes objects at its position, moves left by 1 tile every `[DS:0xe644]` ticks; stops when it reaches the floor's left boundary
  - Right front: deletes objects at `position + 12`, moves right by 1 tile every `[DS:0xe644]` ticks; stops when `position + 12` exceeds the floor's right boundary
  - A front that reaches its boundary resets to -1 (inactive on that floor)

**Fire hit test** (`FUN_10f0_076c`):

- Left zone: `fire_left_pos[floor]` to `fire_left_pos[floor] + 6`
- Right zone: `fire_right_pos[floor] + 6` to `fire_right_pos[floor] + 12`

### Helicopter Rescue

Helicopter rescue prompt fires at `fire_start_tick + [DS:0xe64a]` ticks after ignition.

- If player accepts: deducts `[DS:0xe688]` from cash, sets `[0xbc8c]` to `floor_right_tile - 12` (extinguish start position), scrolls view to fire
- If player declines: fire continues spreading normally

**Helicopter extinguish** (`advance_fire_spread`):

- When `[0xbc8c]` > 0: decrements position by 1 every `[DS:0xe648]` ticks
- For each floor: if fire position > helicopter position, resets that floor's fire fronts to -1
- When the position reaches the floor's left boundary, extinguish is complete

### Fire Resolution

Fire ends when:
- All fire fronts on all floors are -1 (exhausted), OR
- `g_day_tick` reaches 2000

On resolution (`FUN_10f0_02a1`):
- Clears fire flag (`[0xbc7a] -= 8`)
- Re-enables build menu items
- Shows completion notification (0xbc5)
- Resets fire position arrays
- If `g_day_tick < 1500`: fast-forwards time to 1500 and recomputes daypart

### Tuning Parameters (Fire)

| Address | Meaning |
|---------|---------|
| `DS:0xe644` | fire spread rate: ticks per tile advance |
| `DS:0xe646` | vertical spread delay: ticks per floor |
| `DS:0xe648` | helicopter extinguish rate: ticks per tile |
| `DS:0xe64a` | helicopter prompt delay from fire start |
| `DS:0xe64c` | rescue countdown (with security) |
| `DS:0xe688` | helicopter rescue cost |

## VIP Special Visitor Event

Binary-verified from `trigger_vip_special_visitor` at `11f0:0273`.

Fires each tick when all of:

- `g_day_tick > 0xf0` (240)
- `daypart_index < 4` (morning period)
- `game_state_flags & 9 == 0` (no active bomb/fire)
- `g_vip_system_eligibility >= 0` (`0xbc5c`, set when a VIP suite is placed)

Probability: `sample_lcg15() % 100 == 0` (1% per eligible tick).

On trigger, sweeps all placed objects on all floors for types 0x1f, 0x20, 0x21 (hotel suite variants):

- if sidecar word at `+0x0c == 0`: set to 2 (activate special visitor), mark dirty, set activation flag
- if sidecar word at `+0x0c != 0`: clear to 0, mark dirty

If any suite was activated, shows notification `0x271a`.

This event is independent of star evaluation — it is a cosmetic/income event for VIP hotel suites.

## Random News Events

After the early daily checkpoint and before late-day periods, the simulation can emit random news events with a low per-tick chance. These are cosmetic outputs only and do not change core simulation state.
