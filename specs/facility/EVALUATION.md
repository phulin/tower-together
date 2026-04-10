# Evaluation

This document covers star-rating evaluation visitors and the final Tower promotion path.

## Tower Activity Thresholds

Tower activity must exceed these thresholds to qualify for the next tier:

| Current rating | Next threshold |
|---|---:|
| 1 star | 300 |
| 2 stars | 1000 |
| 3 stars | 5000 |
| 4 stars | 10000 |
| 5 stars | 15000 |

## Normal Star Advancement

Normal star advancement (daily check via `check_and_advance_star_rating` at `1148:002d`) requires:

1. `compute_tower_tier_from_ledger() > g_star_count` — population ledger total exceeds the next tier threshold
2. `check_star_advancement_conditions() == 1` — all qualitative gates pass

See GAME-STATE.md for the exact per-tier gate conditions.

On success: `g_star_count` incremented, visual refresh, `reset_star_gate_state` called.

## Cathedral Building

The cathedral is a 5-floor-tall building (type 0x24, $3,000,000, singleton). Placement
via `place_cathedral_stack` at `1200:2347` creates 5 placed-object records on floors
100–104 with types 0x24 (bottom, floor 100) through 0x28 (top, floor 104), each 28 tiles
wide. Floor 100 is exclusively reserved for the cathedral — no other facility may be
placed there. These are per-floor slices of a single building, not separate facilities.

Placement stores the cathedral floor in `g_eval_entity_index` (`0xbc60`), enabling the
evaluation system. Cathedral availability is gated to star 5 by the build menu.

## Evaluation Visitors

Types 0x24–0x28 each host 8 runtime entity slots → 5 floors × 8 = 40 visitors total.

**Daily activation** (`activate_upper_tower_runtime_group` at `1048:0000`, checkpoint
0x000): when `g_eval_entity_index >= 0` and `star_count > 2`, sweeps floors 100–104
for types 0x24–0x28 and forces all 40 entity slots into state 0x20.

**Dispatch gate**: entities only activate when `calendar_phase_flag == 1`. During
`daypart_index == 0`, dispatch is staggered: 1/12 random chance per tick after tick 80,
guaranteed after tick 240 (but only if still in daypart 0; if daypart has advanced, entity
parks instead). Each entity is evaluated independently — there is no "force all remaining"
mechanism. Entities still in state 0x20 at `daypart_index >= 1` are parked (state 0x27)
and must wait for the next day.

**Outbound journey**: each entity routes from floor 0 (lobby) to floor 100 (cathedral base).
On arrival (state 0x03), `check_evaluation_completion_and_award` (`1048:00f0`) fires.

**Arrival check** (`check_all_evaluation_entities_arrived` at `1048:03bb`):
- Iterates floors 100–104, counts entities in state 0x03 for types 0x24–0x28
- The count is **recounted fresh** each invocation — not remembered across ticks
- Returns 1 only when count == 0x28 (40) AND `compute_tower_tier_from_ledger() > g_star_count`
- Guards: `g_eval_entity_index >= 0` AND `g_day_tick < 800`
- If not all 40 arrived yet: stamps the arrived entity's placed-object record `aux = 3, dirty = 1`

**Midday return** (`dispatch_evaluation_entity_midday_return` at `1048:0179`, checkpoint
0x04b0): all entities in state 0x03 are advanced to state 0x05 and route back to floor 0 (lobby).

There is no cross-day accumulation. A failed run parks the missed visitors and retries
on a later day. See PEOPLE.md "Families 0x24–0x28" for the full per-entity state machine.

## Tower Promotion

The final promotion from 5 stars to Tower uses the cathedral evaluation path exclusively.
`check_star_advancement_conditions` returns 0 unconditionally for `star_count == 5`.

The promotion fires when `check_all_evaluation_entities_arrived` returns 1, which calls
`award_star_rating_upgrade` (`1048:02b5`) → `set_star_count_to_tower` (`1148:00af`),
writing `g_star_count := 6`. This is the only code path in the binary that writes 6 to
`g_star_count`.

Requirements:
- cathedral placed (`g_eval_entity_index >= 0`)
- `compute_tower_tier_from_ledger() > g_star_count` (population ledger total >= 15000 for tier 6)
- all 40 evaluation entities in state 0x03 before `g_day_tick < 800`
