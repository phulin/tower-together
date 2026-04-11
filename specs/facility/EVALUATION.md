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

Normal star advancement (daily check) requires:

1. `compute_tower_tier_from_ledger() > star_count` — population ledger total exceeds the next tier threshold
2. `check_star_advancement_conditions() == 1` — all qualitative gates pass

See GAME-STATE.md for the exact per-tier gate conditions.

On success: `star_count` incremented, visual refresh, `reset_star_gate_state` called.

## Cathedral Building

The cathedral is a 5-floor-tall building (type 0x24, $3,000,000, singleton). Placement
creates 5 per-floor slices on floors
100–104 with types 0x24 (bottom, floor 100) through 0x28 (top, floor 104), each 28 tiles
wide. Floor 100 is exclusively reserved for the cathedral — no other facility may be
placed there. These are per-floor slices of a single building, not separate facilities.

Placement stores the cathedral floor in `eval_entity_index`, enabling the
evaluation system. Cathedral availability is gated to star 5 by the build menu.

## Evaluation Visitors

Types 0x24–0x28 each host 8 runtime entity slots → 5 floors × 8 = 40 visitors total.

**Daily activation** (checkpoint
0): when `eval_entity_index >= 0` and `star_count > 2`, sweeps floors 100–104
for types 0x24–0x28 and forces all 40 entity slots into state 0x20.

**Dispatch gate**: entities only activate when `calendar_phase_flag == 1`. During
`daypart_index == 0`, dispatch is staggered: 1/12 random chance per tick after tick 80,
guaranteed after tick 240 (but only if still in daypart 0; if daypart has advanced, entity
parks instead). Each entity is evaluated independently — there is no "force all remaining"
mechanism. Entities still in state 0x20 at `daypart_index >= 1` are parked (state 0x27)
and must wait for the next day.

**Outbound journey**: each entity routes from floor 0 (lobby) to floor 100 (cathedral base).
On arrival (state 0x03), the arrival check fires.

**Arrival check**:
- Iterates floors 100–104, counts entities in state 0x03 for types 0x24–0x28
- The count is **recounted fresh** each invocation — not remembered across ticks
- Returns 1 only when count == 40 AND `compute_tower_tier_from_ledger() > star_count`
- Guards: `eval_entity_index >= 0` AND `day_tick < 800`
- If not all 40 arrived yet: stamps the arrived entity's placed-object record and marks dirty

**Midday return** (checkpoint
1200): all entities in state 0x03 are advanced to state 0x05 and route back to floor 0 (lobby).

There is no cross-day accumulation. A failed run parks the missed visitors and retries
on a later day. See PEOPLE.md "Families 0x24–0x28" for the full per-entity state machine.

## Tower Promotion

The final promotion from 5 stars to Tower uses the cathedral evaluation path exclusively.
`check_star_advancement_conditions` returns 0 unconditionally for `star_count == 5`.

The promotion fires when the arrival check returns 1, which triggers
the star rating upgrade, writing `star_count := 6`. Tower rank (star_count = 6) can only be achieved through the cathedral evaluation path.

Requirements:
- cathedral placed (`eval_entity_index >= 0`)
- `compute_tower_tier_from_ledger() > star_count` (population ledger total >= 15000 for tier 6)
- all 40 evaluation entities in state 0x03 before `day_tick < 800`
