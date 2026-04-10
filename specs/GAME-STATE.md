# Game State And Progression

## Global Progression Fields

Maintain at least:

- `star_count`
- `calendar_phase_flag`
- `facility_progress_override`
- metro-station presence and floor
- evaluation-site presence and floor
- security-adequate flag
- office-placed flag
- route-viable flag
- office-service-ok flag

## `calendar_phase_flag`

`calendar_phase_flag` alternates inside a 12-day cycle and affects:

- commercial capacity selection
- some hotel timing
- condo staggering
- some progression gates

## `facility_progress_override`

When active and the tower is below 5 stars, commercial venues use the more generous capacity tier normally reserved for the override state. This flag is periodically set and cleared by scheduler checkpoints.

## Metro Station

The simulation tracks whether a metro station has been placed. That state:

- enables metro-related display behavior
- gates 4-star to 5-star advancement
- affects some vertical-placement bounds

## Star Advancement

Star progression depends on both:

- sufficient total tower activity
- qualitative gate conditions

Exact qualitative gates by current star tier:

- `1 -> 2`: no additional gate once the activity threshold is met
- `2 -> 3`: a security office must have been placed
- `3 -> 4`: office placed, security adequate, office-service evaluation passed, route viability true, `daypart_index >= 4`, and `calendar_phase_flag == 0`
- `4 -> 5`: metro station placed, security adequate, route viability true, `daypart_index >= 4`, and `calendar_phase_flag == 0`

The Tower-grade promotion uses a separate cathedral/evaluation path rather than the normal star gate.

## Gate Meanings

- `route_viable`: set when the tower's path-seed rebuild finds viable commercial routes in the post-3-star regime
- `office-service-ok` (`[0xc197]`): set by the office-service evaluation system (see below)

## Office Service Evaluation

Binary-verified from `check_office_service_evaluation_trigger` at `1248:0000` and
`resolve_office_service_evaluation` at `1248:0115`.

This is the mechanism behind the 3→4 star gate's "office-service evaluation passed"
condition.

### State fields

| Address | Size | Name | Meaning |
|---------|------|------|---------|
| `0xc197` | byte | `office_service_ok` | 0 = not passed, 1 = passed. The 3→4 gate flag. |
| `0xc198..0xc19b` | dword | `eval_target_entity` | Identity of the office entity under evaluation. `0xFFFFFFFF` = none, `0x0000FFFF` = cleared after resolution. |
| `0xc19c` | byte | `eval_in_progress` | 0 = idle, 1 = evaluation in progress. |

All three are reset to zero/`0xFFFFFFFF` by `init_star_gate_flags` (`1150:0000`) at
new game and `reset_star_gate_state` (`1150:003d`) on each star advancement.

### Trigger

Every 9th day (`g_day_counter % 9 == 3`), when all of:
- `star_count == 3`
- `office_service_ok == 0` (not already passed)
- `eval_in_progress == 0`

The system scans for an office entity in state 0x01 with an active service assignment.
On match: stores entity identity in `eval_target_entity`, sets `eval_in_progress = 1`,
fires notification 3000.

### Resolution

When the evaluation visitor arrives at the target office,
`resolve_office_service_evaluation` fires:
1. Validates `eval_in_progress != 0` and entity matches `eval_target_entity`
2. Computes `compute_runtime_tile_average()` for the office
3. Compares against threshold at `[DS:0xe5ec]` (from startup tuning resource)
4. If average ≤ threshold: **pass** → `office_service_ok = 1`, notification 0xBBA
5. If average > threshold: **fail** → `office_service_ok = 0`, notification 0xBBB
6. Clears `eval_in_progress = 0` and `eval_target_entity = 0xFFFF`

### Cleanup

At checkpoint 0x0640, `clear_evaluation_slot_if_not_eval_day` (`1248:01c3`) clears
the evaluation state if `g_day_counter % 9 != 3`, preventing stale state from
persisting across non-evaluation days.

If the target entity becomes invalid before resolution, `fail_office_service_evaluation`
(`1248:017d`) unconditionally fails the evaluation and clears state.

## Simulation-Wide Persistent State

The top-level game state includes:

- time counters
- tower progression flags
- cash and ledgers
- placed objects
- runtime actors
- sidecar tables
- route/reachability caches
- event state
- pending outputs/prompts
