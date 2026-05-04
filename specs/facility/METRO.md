---
name: Metro Station
description: 3-floor underground metro stack — placement, cost, display-variant flag, gates.
type: facility
---

# Metro Station

Binary evidence below cites segment:offset addresses in `SIMTOWER.EX_`. Key
entry points: `place_metro_station_stack` (1200:2159),
`dispatch_construction_tool` metro case (1200:0d58),
`trigger_vip_special_visitor` (11f0:0273), the per-type tool-rect init
`FUN_1200_0000` (1200:0000), and `g_metro_station_floor_index` (1288:bc5c).
Related scheduler display behavior is documented in `TIME.md`.

## Identity

A singleton three-floor placed-object stack:

| Type | Position | Sprite (W × H px) | Resource id |
|------|----------|--------------------|-------------|
| `0x1f` | top (anchor) | 480 × 24 | 2984 |
| `0x20` | middle       | 480 × 36 | 3048 |
| `0x21` | bottom       | 480 × 36 | 3112 |

Bitmap id formula: `id = type * 64 + 1000` (NE resource type 0x8002,
8-bpp DIBs at file offsets 0x555c00 / 0x55aa00 / 0x561800). Standard
floor height is 36 px; the top floor is two-thirds height (24 px). Width
is 480 px at 16 px/tile = **30 tiles wide**.

`g_metro_station_floor_index` stores the **top** (anchor) floor number, the
same value passed to `place_metro_station_stack`. It is initialized to
`-1` and reset to `-1` when the metro is removed.

## Tool / Cursor

`FUN_1200_0000` writes the metro tool's tile-count to the per-type rect
array at `1288:7ca4 + type*0xc`. The `0x1f` slot is hardcoded to 30; the
`0x20` and `0x21` slots inherit the previous slot's value (also 30). The
construction dispatcher computes `xRight = xLeft + 30` for the metro tool.

## Placement

Construction-action dispatcher (1200:0d58) for the metro tool:

1. **Singleton check.** If `g_metro_station_floor_index >= 0`, push error
   code `0x11` and abort. The dispatcher enforces this *before* the
   placement helper runs.
2. Calls `place_metro_station_stack(type=0x1f, variant=0,
   status = !pre_day_4(), floor=cursorFloor, xL, xR)`, where
   `pre_day_4()` returns 1 when `g_daypart_index < 4`. This daypart-derived
   value is the placed-object `+0xc` status word: `0` before daypart 4 and
   `1` from daypart 4 onward. It is **not** the construction skip-cost flag.
3. On success the dispatcher writes `g_metro_station_floor_index = anchor floor`.

`place_metro_station_stack` (1200:2159) then:

1. `validate_floor_class_for_placement(type=0x1f, anchor)` (1200:304b).
2. `check_construction_funds_available_for_floor_range(type, anchor−2,
   anchor)` (1180:0172). Per-object cost from YEN res #1000 at index
   `type*4` is 0 for 0x1f/0x20/0x21; only the per-floor base rate
   (`compute_floor_construction_base_cost`, 1180:05fd) contributes.
3. Three calls to `validate_multifloor_segment_placement` (1200:330f), one
   per floor. When `anchor < 11` validation runs top-down (anchor first);
   when `anchor >= 11` it runs bottom-up. Metro is always underground so
   the top-down branch is taken.
4. Three calls to `place_object_on_floor` (1200:1847), one per floor:
   - anchor       → type `0x1f`
   - anchor − 1   → type `0x20`
   - anchor − 2   → type `0x21`

The helper passes literal `0` as the final `place_object_on_floor`
`skipCost` argument for all three rows. Therefore metro construction always
runs the funds/charge path; it is not free during early dayparts. Its binary
cost is `3 × 30 × YEN[0]` plus `YEN[0x1f] + YEN[0x20] + YEN[0x21]` (= 0).

The −8..−1 floor range is **not** enforced inside
`place_metro_station_stack` or the floor-class handler (1200:315c only
checks `floor < 10` and `floor > [bc5a]+10`). The basement-only band is
shaped by where the cursor can land plus the multifloor segment validator;
the explicit numeric range was not located in static analysis.

## Display Variant Flag (`+0xc`)

Each placed-object record (18 bytes, stride 0x12) carries a word at offset
`+0xc` that selects the rendered sprite variant:

| `+0xc` | Meaning            |
|--------|--------------------|
| `0`    | empty platform     |
| `2`    | train at platform  |

Confirmed by `FUN_1110_08bc` (1110:08bc), which overlays the metro text
labels (resource indices `0x1e`/`0x1f`/`0x20`) only when `[+0xc] == 2`
during mid-day, and by `trigger_vip_special_visitor` (below). The `+0x13`
byte on every record is the redraw-dirty flag.

## Per-Tick Special-Visitor Toggle

The scheduler-tick hook (`trigger_vip_special_visitor`, 11f0:0273) runs
when:

- `day_tick > 0xf0`,
- `daypart_index < 4`,
- `g_metro_station_floor_index >= 0`,
- `(g_game_state_flags & 9) == 0` (no fire bit `0x1`, no bomb bit `0x8`),
- `sample_lcg15() % 100 == 0`.

It iterates the 120 facility lists at `g_unknown_ptr_array[0..0x77]`. For
every record whose type byte (`+0xa`) is `0x1f`, `0x20`, or `0x21`:

- Toggles word at `+0xc` between 0 and 2 (sets to 2 if currently 0, else
  clears to 0).
- Sets `+0x13 = 1` (dirty).

If at least one record transitioned 0 → 2, plays wave resource `0x271a`
(= 9994 — the train-arrival audio cue) via `play_wave_resource(0x271a, 0,
1)`. There is no separate visual handler keyed on the wave id; the visual
cue is the redraw of the dirty records with the new variant.

## Placement Gates Referencing Metro Floor

- **Carrier extend-down (`extend_carrier_down`, 10a8:0bac).** Rejects with
  error `0xe` when `target_floor < g_metro_station_floor_index − 1`.
- **General floor-class gate (`validate_floor_class_for_placement`,
  1200:309c).** When `g_metro_station_floor_index − 1 <= target_floor`,
  the stricter gate below is skipped.
- **Stricter gate (1200:30a9–30c5).** Applies only to types `0x12`
  (cinema), `0x14` (recycling-center upper), and `0x1d` (party hall):
  requires `target_floor >= 1` AND
  `target_floor >= g_metro_station_floor_index`. These three families
  cannot be placed below the metro's top floor when a metro exists.

## Star Progression (4 → 5)

`check_star_advancement_conditions` (1150:007e), star-4 branch at
1150:0112: requires `g_metro_station_floor_index >= 0`,
`g_recycling_adequate_flag`, `pre_day_4() == 0` (daypart >= 4), not
weekend, and `g_office_medical_service_ok_flag`.
