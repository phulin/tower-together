# Condo

Family `9` is the condo family.

## Identity

- population: 3 residents
- income is a sale, not recurring rent
- ongoing activity preserves readiness and avoids refunds

## Sale And Refund Values

Condo sale value and refund amount are the same table keyed by `rent_level`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$200,000` | `$150,000` | `$100,000` | `$40,000` |

Default placement tier is `1`.

## Lifecycle

1. unsold condo waits for a sale path
2. sale realizes one-time income and activates the unit
3. residents perform periodic commercial trips
4. readiness is maintained through continued operation
5. prolonged poor state can lead to refund/expiry behavior

Sale timing:

- a condo sells when an entity in the unsold regime (`unit_status >= 0x18`) gets any non-failure route result for its outbound commercial trip
- queued, en-route, and same-floor-arrived results all trigger the sale transition
- sale resets `unit_status` to `0x08` in morning periods (`is_early_progress_phase()` true, i.e. `daypart_index < 4`) or `0x00` in evening periods
- sale is credited exactly once at that activation crossing

Stay phase changes per trip:
- each successful outbound trip: `unit_status -= 1`
- each failure/bounce: `unit_status += 1`
- all changes are ±1 per event

## `unit_status`

Condo meanings:

- `0x00..0x0f`: sold/active
- `0x10`: sync/reset marker
- `0x18..0x27`: unsold
- `0x28..0x37`: expiry or refund-risk band
- `>= 0x38`: extended vacancy/inactive

## Readiness

Condo readiness uses the shared thresholds but has its own support radius and occupant staggering.

## 3-Occupant Stagger Pattern

Condo occupants are indexed by `subtype_index` (0, 1, 2) within the 3-tile span. On each morning dispatch cycle:
- even `subtype_index` (0, 2): `decrement_stay_phase_9` fires → `unit_status -= 1`
- odd `subtype_index` (1): `increment_stay_phase_9` fires → `unit_status += 1`

Net effect per full cycle: 2 decrements + 1 increment = net -1 step of progress toward checkout. The middle occupant bounces while the outer ones advance.

## Activation / Refund Behavior

- sale adds cash and contributes to the population ledger
- refund or teardown removes the contribution
- `activation_tick_count` grows while the condo is active and is cleared when it deactivates

Refund timing:

- refund is checked on the 3-day cashflow/deactivation cadence
- refund fires only when `eval_level == 0` and the condo is still in the sold regime (`unit_status < 0x18`)
- refund returns the object to the unsold band: `0x18` in morning periods or `0x20` in evening periods

Trip-cycle timing:

- outbound support trips decrement `unit_status`
- bounces and some failed teardown paths increment `unit_status`
- the sibling-sync shortcut forces `unit_status = 0x10` once the cycle reaches its last round
- under the recovered stagger rules, the net effect is roughly one countdown step per full morning cycle

Calendar-phase stagger:

- the state `0x20` (outbound trip) dispatch path is gated by `calendar_phase_flag`
- when `g_calendar_phase_flag == 1` (every 3rd day in a 12-day cycle: days 2, 5, 8, 11), odd-subtype occupants (`subtype_index % 2 != 0`) skip the decrement and instead increment (bounce), delaying the cycle by one step that day
