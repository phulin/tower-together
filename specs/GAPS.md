# Specification Gaps

Prioritized list of gaps and ambiguities that would block or impede a tick-for-tick
behavior-parity reimplementation. Organized into tiers by impact.

---

## Tier 0 --- Blocks Core Simulation Loop

**All tier 0 items have been resolved.**

### G-001: Daypart definition and boundaries --- RESOLVED

Added to TIME.md: daypart boundary table (0–6, each 400 ticks), morning/evening period
definition (`pre_day_4()` = `daypart_index < 4`), and effects on `stay_phase` bands.

### G-002: People behavior state machines --- RESOLVED

Added to PEOPLE.md: complete per-family state machines for families 0x0f, 3/4/5, 7, 9,
0x12/0x1d, 0x21, 0x24–0x28, 0x18, 0x0e/0x15. Includes gate tables, dispatch tables,
route outcomes, and integration with routing layer.

### G-003: Stress mechanics --- RESOLVED

Added to PEOPLE.md: "stress" is not a separate mechanic. It is the same quantity as
the facility operational score (`0x1000 / sample_count`). Thresholds 80/150/200 match
`pairing_status` grades. No separate accumulator exists.

### G-004: Checkpoint sub-operation ordering --- RESOLVED

Expanded TIME.md: all 22 checkpoints now have full internal operation ordering,
including 0x000 (6 steps), 0x0f0 (3 steps), 0x0640 (9 steps), 0x09c4 (4 steps),
0x09e5 (5 steps), plus per-tick metro toggle and news events.

### G-005: Readiness scoring `sample_count` --- RESOLVED

Added to FACILITIES.md: `sample_count` is entity byte `+0x09`, incremented once per
`advance_entity_demand_counters` call (per service-visit arrival). Full demand pipeline
documented with field layout and two-step computation.

---

## Tier 1 --- Blocks Major Subsystem Implementation

### G-010: Elevator schedule table structure --- RESOLVED

Added to ELEVATORS.md: two 14-byte arrays at carrier offsets +0x20 (dwell multiplier)
and +0x2e (enable flag). Schedule index = `g_daypart_index + g_calendar_phase_flag * 7`
(7 dayparts × 2 calendar phases). Dwell threshold = `schedule_flag * 0x1e` (30 ticks).

### G-011: Elevator motion profile thresholds --- RESOLVED

Added to ELEVATORS.md: exact `compute_car_motion_mode` thresholds. carrier_mode 0:
dist < 2 → stop, both > 4 → fast (±3), else normal (±1). Non-zero mode: dist < 2 →
stop, dist < 4 → slow (±1, door_wait=2), else normal (±1). Mode 3 only for standard.

### G-012: Elevator home floor and idle behavior --- RESOLVED

Added to ELEVATORS.md: per-car home floor stored at
`carrier->reachability_masks_by_floor[car_index - 8]`. Set at construction.
`select_next_target_floor` returns home floor when `pending_assignment_count == 0`
and no special flag. Reversal at terminal floors when `schedule_flag == 1`.

### G-013: Transfer zone gap tolerance rules --- RESOLVED

Updated ROUTING.md: `scan_special_link_span_bound` has two distinct stop conditions:
(1) zero walkability byte = no floor → immediate stop; (2) nonzero byte with bit 0
clear = gap → tolerated within center ± 3 floors, but terminates scan beyond that.
Max range is center ± 6. Contradictory language replaced with exact algorithm.

### G-014: Route cost tie-breaking and distance penalties --- RESOLVED

Updated ROUTING.md: distance penalty thresholds are `abs(height_metric_delta)`:
≤79 = none, 80–124 = 0x1e (30 ticks), ≥125 = 0x3c (60 ticks). Applies only to
express/service carriers and all special-link segments. Tie-breaking already documented:
strict `<` comparison keeps first candidate in scan order (segments 0..63, then
zones 0..7, then carriers 0..23).

### G-015: Evaluation qualitative gates undefined --- RESOLVED

Updated EVALUATION.md with binary-verified star advancement flow from
`check_and_advance_star_rating` (1148:002d). Per-tier gate conditions already
documented in GAME-STATE.md were confirmed correct. Added function addresses and
evaluation visitor details.

### G-016: Star advancement gate details --- RESOLVED

Confirmed GAME-STATE.md gates correct. Added to EVALUATION.md: star 5 normal
advancement returns 0 unconditionally (cathedral path only). Ledger tier thresholds
from tuning data at DS:e630–e63c plus hardcoded 15000 for tier 6
(`compute_tower_tier_from_ledger` at 1148:041d).

### G-017: VIP special visitor system undocumented --- RESOLVED

Added to EVENTS.md: `trigger_vip_special_visitor` (11f0:0273). Fires when
`day_tick > 0xf0`, `daypart_index < 4`, `game_state_flags & 9 == 0`,
`g_vip_system_eligibility >= 0`. 1% chance per tick. Sweeps types 0x1f/0x20/0x21,
toggles sidecar +0x0c (0→2 activate, else→0 clear). Notification 0x271a on activation.

### G-018: Fire event details underspecified --- RESOLVED

Updated EVENTS.md with full binary-verified fire mechanics. "Early daypart band" =
`daypart_index < 4`. Target floor width >= 32 tiles; fire starts at `right_tile - 32`.
No fire suppressor in binary; guard is `g_eval_entity_index < 0`. Fire spread: two
per-floor fronts (left/right) advance by 1 tile every `[DS:0xe644]` ticks, spread
vertically with `[DS:0xe646]` tick delay per floor. Helicopter: prompt at
`fire_start + [DS:0xe64a]` ticks, extinguishes at `[DS:0xe648]` ticks/tile rate.
Fire ends when all fronts exhausted or `g_day_tick == 2000`.

### G-019: Bomb event details underspecified --- RESOLVED

Updated EVENTS.md with full binary-verified bomb mechanics. Security patrol is normal
guard movement — `FUN_10d0_01c4` checks if guard's current floor/tile matches bomb
position. Blast area: 6 floors (`bomb_floor - 2` to `+3`) × 40 tiles (`bomb_tile ± 20`),
using `delete_object_covering_floor_tile` per cell. Stars 1 and 5 cannot trigger bombs.
Post-resolution: fast-forwards `g_day_tick` to 1500. Timer extension on found:
`g_day_tick + [DS:0xe64a]`.

---

## Tier 2 --- Requires Guesswork but Workaroundable

**All tier 2 items have been resolved.**

### G-020: Office worker stagger initialization --- RESOLVED

Binary-verified from `reinitialize_entity_slot_family_fields` at `1228:0631`.
`base_offset` is entity record word `+0x02`, initialized to the 0-indexed occupant
slot number (0..5 for offices, 0..2 for condos, etc.) via a plain loop counter.
Dispatch stagger comes from entity table position: `refresh_runtime_entities_for_tick_stride`
(`1228:0d64`) processes entity index `g_day_tick % 16`, so workers with different
`base_offset` values are processed on different ticks. Additional stagger from
probabilistic gates (1/12 chance in daypart 0). `base_offset == 1` has a special
branch in the family 7 dispatch handler: worker #1 returns to state 0x00 (morning
re-arrival) while all others go to state 0x05 (evening departure).

### G-021: Condo sale trigger timing --- RESOLVED

Binary-verified from `dispatch_object_family_9_state_handler` at `1228:3870`.
The sale fires **once on state transition**, not per-tick. In the state 0x20/0x60
handler, any non-failure route result (1/2/3/4) when `stay_phase >= 0x18` (unsold)
calls `activate_commercial_tenant_cashflow` (`1180:105d`), which resets `stay_phase`
below 0x18 as part of the sale. This prevents the `stay_phase >= 0x18` condition from
ever being true again. Route failure (0xFFFF) returns to state 0x20 for retry but
never triggers the sale.

### G-022: Hotel sibling synchronization for 3-person suites --- RESOLVED

Binary-verified from `sync_stay_phase_if_all_siblings_ready_345` at `1228:6b5c`.
Occupants are tracked as **individual entities** with 1-based `base_offset` (1..3 for
suites). Pairwise sync uses formula `3 - base_offset`: occupant 1 checks occupant 2
and vice versa. Occupant 3 computes `3 - 3 = 0`, which is the inactive tile-base
entity, so it **cannot pass the sibling check**. Instead, occupant 3 relies on the
`stay_phase & 7 == 1` shortcut (unconditional sync regardless of sibling state).
Checkout resets shared `stay_phase` to 2 (same as twin). Two decrements bring it to 0,
firing checkout exactly once. The third occupant decrements post-checkout (0x28 → 0x27,
`& 7 == 7 ≠ 0`) and simply routes to lobby without double payment.

### G-023: Commercial venue struct fields --- RESOLVED

Binary-verified from `rebuild_linked_facility_records` (`11b0:0184`),
`acquire_commercial_venue_slot` (`11b0:0d92`), `try_consume_commercial_venue_capacity`
(`11b0:1150`). Full 18-byte (0x12) struct: `+0x00` owner_floor_index (byte),
`+0x01` owner_subtype_index (byte, 0xFF = orphaned), `+0x02` availability_state
(byte, 0xFF=invalid, 0=open, 1=partial, 2=near-full, 3=closed),
`+0x03/+0x04/+0x05` capacity_seed_phase_A/B/override (bytes, init 10 each),
`+0x06` active_capacity_limit (byte), `+0x07` today_visit_count (byte),
`+0x08` yesterday_visit_count (byte), `+0x09` current_active_count (byte, max 39),
`+0x0A` derived_state_byte (byte), `+0x0B` variant_index (byte, round-robin),
`+0x0C` negative_capacity_gate (word), `+0x10` visitor_count (word).
**Attendance is two fields**: `today_visit_count` (+0x07) feeds the family ledger;
`visitor_count` (+0x10) counts cross-owner visitors for income derivation (thresholds
25/35/50). Capacity order: seed selection first (phase A/B/override based on
`g_calendar_phase_flag` and `g_facility_progress_override`), tuning cap second
(`min(seed, type_limit)`), floor at 10.

### G-024: Entertainment phase system --- RESOLVED

Binary-verified from `activate_entertainment_link_half_runtime_phase` (`1188:06a8`),
`promote_entertainment_links_to_ready_phase` (`1188:0826`),
`advance_entertainment_facility_phase` (`1188:090a`),
`increment_entertainment_link_runtime_counters` (`1188:0c2b`).
Phase values: 0=idle/reset, 1=activated (awaiting guests), 2=first-guest-arrived
(arrival-driven: 1→2 on first entity arrival), 3=ready (checkpoint-driven: any
phase > 1 promoted to 3 by `promote_entertainment_links_to_ready_phase`).
`link_age_counter`: starts at 0, incremented by 1 at tick 0x0F0 in
`rebuild_entertainment_family_ledger` (`1188:05af`), capped at 127 (0x7F).
Budget tier = `link_age_counter / 3` (truncating C integer division on non-negative
value). Tier 0 (age 0–2), tier 1 (age 3–5), tier 2 (age 6–8), tier 3 (age 9+).
Paired-link (family 0x12) budget from `compute_entertainment_income_rate` (`1188:0b3e`):
subtype < 7 gets {40,40,40,20}, subtype ≥ 7 gets {60,60,40,20} by tier.
Single-link (family 0x1d): hardcoded forward=0, reverse=50.

### G-025: Parking expense formula semantics --- RESOLVED

Binary-verified from `add_parking_operating_expense` at `1180:0ae4` and exclusion
check `FUN_10a8_133b` at `10a8:133b`. Tile indices are world tile coordinates from
the placed-object record (offsets +6 and +8), so the difference is span width in tiles.
Underground exclusion band: `11 <= floor_index < g_lobby_height + 10`. Since
`g_lobby_height` is 1–3, this excludes atrium floors directly above the lobby.
`g_lobby_height == 1`: no exclusion; `== 2`: floor 11 only; `== 3`: floors 11–12.
Expense applies to types 0x18/0x19/0x1a (parking variants).

### G-026: Carrier mode definitions --- RESOLVED

Binary-verified from `place_carrier_shaft` at `1200:1034` and
`apply_periodic_operating_expenses` at `1180:0bbe`. **Mode 0 = Express** (6-wide
clearance, cap 0x2a = 42 slots, expense type 0x2a). **Mode 1 = Standard** (4-wide
clearance, cap 0x15 = 21 slots, expense type 0x01). **Mode 2 = Service** (4-wide
clearance, cap 0x15 = 21 slots, expense type 0x2b). The route scorer treats mode 0
as skipping distance-based delay; mode 2 skips route delay accumulation. Updated
ELEVATORS.md to correct the swapped mode 0/1 labels.

### G-027: Queue-full retry and route failure lifecycle --- RESOLVED

Binary-verified from `resolve_entity_route_between_floors` at `1218:0000`,
`enqueue_request_into_route_queue` at `1218:1002`,
`maybe_dispatch_queued_route_after_wait` at `1228:15a0`.
Three distinct failure paths: (1) **Queue full** (count == 40): 5-tick delay
(`g_waiting_state_delay`), entity byte +8 = 0xFF sentinel, entity does NOT re-route
(waits in place). (2) **Route failure** (no candidate): 300-tick delay
(`g_route_failure_delay`), `advance_entity_demand_counters` called (entity gives up
this trip and advances demand state), returns -1. (3) **Transfer-floor resolution
failure**: 0-tick delay (`g_requeue_failure_delay`), `force_dispatch_entity_state_by_family`
(`1228:1614`) re-dispatches through the family-specific state handler for a fresh
route attempt.

### G-028: Command validation ordering and failure --- RESOLVED

Binary-verified from `place_object_on_floor` at `1200:1847` and
`place_carrier_shaft` at `1200:1034`. Validation is a short-circuit chain — first
failing check wins and returns its error code immediately. No error accumulation.
Generic placement order: (1) bounds check → error 0x14, (2) funds availability →
return 0, (3) support/span validation → errors 0x14/0x03/0x06/0x02/0x04,
(4) floor class validation → errors 0x0c/0x05/0x0e/0x0a/0x0b, (5) slot insertion →
error 0x09. **Cost is never deducted before validation passes** —
`charge_single_floor_construction_cost` is called only inside the successful placement
branch, after all checks.

### G-029: Office service evaluation trigger cadence --- RESOLVED

Binary-verified from `check_office_service_evaluation_trigger` at `1248:0000`.
Fires every 9th day: `g_day_counter % 9 == 3`, gated to `star_count == 3` only.
Additional guards: `[0xc197] == 0` (not already passed) and `[0xc19c] == 0` (not
in progress). On trigger: sets `[0xc19c] = 1`, stores entity reference in `[0xc198]`,
fires notification 3000. Resolution at `resolve_office_service_evaluation` (`1248:0115`):
computes `compute_runtime_tile_average()` against threshold at `[DS:0xe5ec]`;
pass sets `[0xc197] = 1`, fail clears it.

### G-030: Venue unavailable delay --- RESOLVED

Binary-verified from `load_startup_tuning_resource_table` at `1198:0005`.
`g_venue_unavailable_delay` at `[DS:0xe5f6]` is loaded from tuning resource
(type 0xff05, id 1000) with value **0 ticks**. The global is **vestigial** — it is
never read after initialization (no xrefs outside the loader). The venue-unavailable
code path falls through to other delay mechanisms. Since the value is 0, even if it
were read, it would add zero delay.

### G-031: Commands during disasters and pause --- RESOLVED

Binary-verified from `trigger_bomb_event` (`10d0:006e`), `trigger_fire_event`
(`10f0:0029`), and entity state handlers. `g_game_state_flags` at `[0xbc7a]`:
bit 0 = bomb active, bit 3 = fire active, bit 4 = game running, bit 5 = bomb found,
bit 6 = bomb detonated. `bc7a & 9` (bomb OR fire) blocks entity state transitions
(`gate_object_family_0f_connection_state` at `1228:5f39`) and random events. **No
evidence that build/demolish commands are blocked during disasters** — placement
validation functions (`place_object_on_floor`, `place_carrier_shaft`) do not check
`bc7a`. Build commands appear to remain available during active bomb/fire events.

### G-032: Ledger mirroring and overflow behavior --- RESOLVED

Binary-verified from `add_cashflow_from_family_resource` at `1180:08ce` and
`add_income_to_cash_with_display` at `1180:07e9`. `clamp_cash_balance_addition`
(`1180:13f2`) takes a **pointer** to the amount and modifies it in place before
addition. The **clamped delta** (not the nominal) is then added to both
`g_cash_balance` and the secondary family ledger bucket. Secondary ledger receives
the clamped value. Clamping applies only to additions —
`remove_cashflow_from_family_resource` (`1180:0966`) subtracts directly without
clamping.

### G-033: `calendar_phase_flag` formula vs cycle length --- RESOLVED

Binary-verified from `compute_calendar_phase_flag` at `1208:0558`. Formula:
`((g_day_counter % 12) % 3) >= 2`. This produces flag=1 on days 2, 5, 8, 11 of each
12-day period (pattern: off, off, ON repeating). Since `12 % 3 == 0`, the formula is
functionally equivalent to `(g_day_counter % 3) >= 2` — a **3-day repeating pattern**.
The "12-day cycle" in TIME.md refers to the outer modulus but is observationally
redundant. Day counter wraps at 12,500 (0x2ed4).

---

## Tier 3 --- Polish / Edge Cases

### G-040: Lobby placement rules and revenue model

LOBBY.md says lobby "participates in transfer and walkability logic" and "can be
drag-laid across valid floors" but specifies no constraints, capacity limits, or
cost/revenue model.

### G-041: Landing footprint and narrow geometry coordinates

COMMANDS.md describes an "8-tile footprint with 2-tile left inset" and a "stepped
2-floor shape" for narrow geometry but gives no coordinate diagrams or exact tile
layouts.

### G-042: News events completely unspecified

EVENTS.md mentions "low per-tick chance" cosmetic news events but gives no probability,
no event list, and no specification of whether they have state effects.

### G-043: Save/load sidecar catalog

SAVE-LOAD.md says "sidecar records" must persist but doesn't enumerate which sidecar
types exist or their serialization format.

### G-044: Notification and prompt queuing

OUTPUTS.md mentions a "shared timed on-screen message slot" but no timeout duration,
queue depth, or behavior when multiple notifications fire on the same tick.

### G-045: RNG call-site enumeration

TIME.md documents the LCG formula and seed but "call sites" for RNG advances are
never enumerated. For tick-parity with native RNG divergence accepted, this is less
critical, but it means the number of RNG advances per tick is unknown.

### G-046: Variant index ranges and pricing tier mechanics

Multiple facility specs use `variant_index` to index payout tables (typically 4 tiers)
but valid ranges, defaults, and the player-facing price-change command interaction
are scattered and incomplete.

### G-047: Inconsistent terminology

"Actors" vs "entities" vs "residents" vs "workers" vs "guests" are used
interchangeably. "Pairing" vs "readiness" vs "pairing_active_flag" vs
"pairing_status" overlap without clear delineation.

### G-048: Startup tuning resource structure

RE data shows resource type 0xff05 id 1000 loads 11 sequential big-endian words
(delays, thresholds, commercial tuning, carrier costs, star-eval thresholds,
entertainment tuning). Not documented in specs.
