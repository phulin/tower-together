# Facilities

This document covers shared facility logic. Family-specific state machines are in `specs/facility/`.

## Facility Evaluation Model

Facilities that depend on nearby support compute an operational score and map it into a
readiness grade (`eval_level`):

- `2`: excellent — well-serviced, income active
- `1`: acceptable — marginal
- `0`: poor — deactivation-eligible or refund-eligible
- `0xff`: not yet scorable (early lifecycle or transitional guard)

The scoring pipeline (`compute_object_operational_score`, called from
`recompute_object_operational_status`) runs for families 3, 4, 5, 7,
and 9 only. Other families use family-specific dispatch handlers within the same
caller. Early-exit guards per family:

| Family | Guard | Returns |
|---|---|---|
| 3/4/5 (hotel) | `unit_status > 0x37` | `0xffff` |
| 7 (office) | `unit_status > 0x0f` AND `eval_active_flag != 0` | `0xffff` |
| 9 (condo) | `unit_status > 0x17` AND `eval_active_flag != 0` | `0xffff` |

The shared scoring pipeline is:

1. compute a per-tile runtime metric as `0x1000 / sample_count`, returning `0` when
   `sample_count == 0`. Here `sample_count` is the runtime entity field — it counts the number of times `advance_entity_demand_counters` has been
   called for this entity (once per service-visit arrival or route-resolution event).
   The metric is therefore **inverse visit frequency**: a tile visited 10 times scores
   `4096 / 10 = 409`; a tile visited 50 times scores `4096 / 50 = 81`. Lower score
   = more frequently visited = better.
2. average that metric across the family's tile divisor:
   - family 3 (single room): 1
   - family 4 (twin room): 2
   - family 5 (suite): 2
   - family 7 (office): 6
   - family 9 (condo): 3
3. apply the pricing-tier modifier (keyed to `rent_level`):
   - tier `0` (highest price): `+30`
   - tier `1` (default): `+0`
   - tier `2` (lower price): `-30`
   - tier `3` (lowest price): force score to `0` (always passes)
4. if qualifying support **is** found on either side within the family's search
   radius, add `+60`. (Support missing → no adjustment.) This raises the performance
   bar for well-serviced locations: facilities near support must sustain higher
   visitor throughput to maintain the same readiness grade.
5. clamp the result to `>= 0`
6. map the score into `eval_level`

### Demand Pipeline (Per-Entity Runtime Counters)

Each runtime entity maintains demand counters used to compute the per-tile metric:

| Field | Meaning |
|-------|---------|
| `sample_count` | number of service-visit samples taken |
| `last_sample_tick` | `day_tick` snapshot at last rebase |
| `elapsed_packed` | low 10 bits = elapsed ticks since last sample, high 6 bits = flags |
| `accumulated_elapsed` | running sum of all per-sample elapsed values |

The pipeline runs in two steps, called from entity dispatch and route resolution:

1. **`rebase_entity_elapsed_from_clock`**: `elapsed = (elapsed_packed & 0x3ff) + day_tick - last_sample_tick`, clamped to 300, stored in low 10 bits of `elapsed_packed`, saves `day_tick` to `last_sample_tick`.
2. **`advance_entity_demand_counters`**: drains `elapsed_packed & 0x3ff` into `accumulated_elapsed`, increments `sample_count`, clears drained bits.

The 300-tick clamp prevents a single long gap from dominating the running average.
`accumulated_elapsed / sample_count` gives average inter-visit interval (lower = better), but the
scoring function reads only `sample_count` via `0x1000 / sample_count`.

## Support Search

Support search is local and tile-based. Different families use different support radii:

| Requester family | Radius |
|---|---|
| hotel rooms (`3/4/5`) | 20 tiles |
| office (`7`) | 10 tiles |
| condo (`9`) | 30 tiles |

## Support Matching

`map_neighbor_family_to_support_match` normalizes a neighbor's family
code into a support-match code, or returns 0 when the neighbor does not qualify.
Entertainment subtypes are grouped: `0x12/0x13/0x22/0x23` → party hall (`0x12`), `0x1d/0x1e` → cinema (`0x1d`).

Accepted support families:

| Requester | Accepts support from |
|---|---|
| hotel rooms (3/4/5) | restaurant (6), office (7), retail (10), fast food (12), entertainment |
| office (7) | restaurant (6), retail (10), fast food (12), entertainment |
| condo (9) | hotel rooms (3/4/5), restaurant (6), office (7), retail (10), fast food (12), entertainment |

Notable exclusions: hotels do **not** accept condos or other hotels as support. Offices
do **not** accept hotels or other offices. Commercial families (6, 10, 12) do not
participate in the support scoring pipeline — they use a separate commercial readiness
system with `apply_service_variant_modifier_to_score`.

## Thresholds By Star Rating

Thresholds are stored as tuning parameters (lower and upper) and are
rewritten when the star rating changes:

| Star rating | Lower | Upper |
|---|---:|---:|
| 1–3 | 80 | 150 |
| 4–5 | 80 | 200 |

Score mapping in `recompute_object_operational_status`:

- score `< 0`: `eval_level = 0xff`
- score `< lower`: `eval_level = 2` (excellent)
- score `< upper`: `eval_level = 1` (acceptable)
- score `>= upper`: `eval_level = 0` (poor)

### eval_active_flag Latching

`eval_active_flag` is set to `1` the first time `eval_level`
transitions to nonzero. For hotel rooms (families 3/4/5), the latch is further guarded
by `unit_status <= 0x27` — hotels past that lifecycle phase do not latch even if their
score is nonzero. The latch is **not retroactive**: if a room's `eval_level` transitions
to nonzero while `unit_status > 0x27`, the latch simply does not fire. It will not
catch up later when the room returns to a lower `unit_status` band. The flag is
forward-only.

## Commercial Readiness

Commercial families (fast food 6, restaurant 10, retail 12) use a separate readiness
model based on customer count from the commercial-venue sidecar record. Thresholds are stored in per-family threshold slots.

Restaurant (family 10) thresholds are adjusted by `apply_service_variant_modifier_to_score`,
which applies a smaller rent_level-based modifier:

- rent_level `0`: `+5`
- rent_level `1`: `+0`
- rent_level `2`: `-5`
- rent_level `3`: `-12`

Fast food (6) and retail (12) use fixed thresholds without rent_level adjustment.

## Warning State

Some facilities expose a degraded or warning state for outputs/inspection:

- hotels: degraded in the vacancy band, severe after checkout/extended inactivity
- offices: warning once deactivated
- condos: warning once unsold or refund-risk behavior begins
- retail/commercial: warning when unavailable

This is derived state. It should not be treated as a separate simulation authority.

## Family Index

- `facility/HOTEL.md`
- `facility/OFFICE.md`
- `facility/CONDO.md`
- `facility/COMMERCIAL.md`
- `facility/ENTERTAINMENT.md`
- `facility/LOBBY.md`
- `facility/PARKING.md`
- `facility/EVALUATION.md`
- `facility/HELPERS.md`
