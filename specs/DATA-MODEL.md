# Data Model

This document defines shared state and terminology used across the simulation spec.

## World Indexing

- The clone exposes 120 logical floors indexed `-10..109`.
- Clone logical floor `0` is the ground-floor lobby.
- Floors `-10..-1` are below grade (10 basement levels).
- Floors `1..109` are above grade.
- Sky lobbies may be placed on clone logical floors `15`, `30`, `45`, etc.

Binary-translation note:

- The original `SIMTOWER.EX_` does not use the clone's logical floor IDs internally.
- EXE floor index `0` corresponds to original-game logical floor `-10`.
- EXE floor index `10` is the original game's ground lobby floor (displayed as `1F`).
- For the clone spec, we intentionally remap that same physical floor to logical floor `0`.
- When this spec cites binary constants recovered from the EXE, translate them to clone logical floors with:
  - `clone_logical_floor = exe_floor_index - 10`
  - example: EXE transfer-zone center `10` => clone logical floor `0`
  - example: EXE transfer-zone center `24` => clone logical floor `14`

Each placed object is addressed by `(floor_index, floor_local_object_id)`.

`floor_local_object_id` is the floor-local object identifier stored in the floor's subtype lookup
tables. It is not a gameplay subtype. The floor table keeps a reverse map from this ID back to the
current placed-object slot.

## Type Namespaces

Two type namespaces exist:

- `object_type_code`: the placed facility/infrastructure type
- `family_code`: the runtime behavior family

They often match, but not always. Docs should treat them as separate concepts.

## Shared Object Record

Every placed object needs, at minimum:

- horizontal span: `left_tile_index`, `right_tile_index`
- `object_type_code`
- lifecycle/state byte: `unit_status`
- family-specific aux/timer field
- optional linked sidecar index
- dirty/refresh flag
- readiness latch: `eval_active_flag`
- current readiness grade: `eval_level`
- pricing tier: `rent_level` (player-configurable, 0–3)
- activity counter: `activation_tick_count`

The implementation can choose any internal struct layout. The important part is preserving these behaviors.

## Shared Runtime Actor Record

Every runtime actor needs, at minimum:

- anchor floor and subtype
- family code
- state code
- base occupant index within the parent object
- selected target floor or facility slot
- route state
- countdown/delay fields
- one or more aux bytes/words for family-specific behavior

Runtime actors are not cosmetic. They drive occupancy, commercial visits, entertainment attendance, evaluation movement, and helper flows.

## State Code Convention

Many families follow this pattern:

- `0x0x`: idle or waiting
- `0x2x`: active local action
- `0x4x`: traveling
- `0x6x`: arrived at remote destination
- `0x27`: parked/night state

Not every family uses every value, but this convention is useful across the spec.

## `unit_status`

`unit_status` is the main per-object lifecycle field.

Shared meanings:

- hotel rooms: occupancy lifecycle plus trip countdown
- condos: sold/unsold lifecycle plus refund-risk progression
- offices: active vs deactivated
- some support facilities: current duty tier or local phase marker

Common ranges:

| Range | Generic meaning |
|---|---|
| `0x00..0x0f` | active / occupied / sold band |
| `0x10` | sync or deactivation marker |
| `0x18..0x27` | vacant, unsold, or deactivated band |
| `0x28..0x37` | checked-out or expiry-related band |
| `>= 0x38` | extended vacancy / terminal inactive band |

The exact interpretation is family-specific.

## `floor_local_object_id`

`floor_local_object_id` is the compact per-floor object identifier used by runtime actors and
sidecar systems.

The floor-local blob contains:

- `placed_object_records[150]`: the actual placed-object slots
- `object_slot_by_subtype_index[150]`: the reverse lookup map from `floor_local_object_id` to the
  current placed-object slot

So conceptually:

- `floor_local_object_id` = stable floor-local object ID
- `object_slot_index` = current slot inside the floor's placed-object array

## `occupant_index`

`occupant_index` is the zero-based occupant slot within a multi-occupant object.

The decompiler/binary-facing notes previously called this `base_offset`. The recovered helper
`compute_object_occupant_runtime_index(floor_index, floor_local_object_id, occupant_index)` confirms the meaning:
it returns `anchor_runtime_index + occupant_index`.

Examples:

- single room: `0`
- twin room: `0..1`
- suite: `0..2`
- office: `0..5`
- condo: `0..2`

This field is used to stagger per-occupant behavior. It is based on population, not geometric width.

## Ledgers

The simulation maintains:

- `cash_balance`
- `population_ledger`: live per-family active-unit counts (drives star thresholds and recycling adequacy tier)
- `income_ledger`: realized income accumulated since 3-day rollover
- `expense_ledger`: realized operating expenses accumulated since 3-day rollover

## Global State

The top-level simulation state must include:

- time counters
- star/progression state
- placed objects
- runtime actors
- sidecar tables
- route queues and reachability caches
- ledgers and cash
- event state
- pending prompts/notifications

## Sidecars And Caches

In this spec, **sidecar systems** means the stateful tables that sit beside the shared
placed-object/runtime-actor records instead of inside them.

They fall into two different classes that the implementation should not blur together:

- **Object-owned sidecars**: allocated slots that are attached to specific placed objects or
  object families and are torn down explicitly when those owners are demolished or invalidated.
- **Derived caches**: rebuildable support tables that summarize routing, coverage, or selection
  state from the current tower layout and sidecars.

Recovered object-owned sidecar systems include:

- `commercial_venue_records[512]` plus the per-type bucket tables built from them
- `entertainment_link_records[16]`
- `service_request_entries[512]` used for parking-demand emitters and rentable-unit/helper
  backlinks

Recovered derived-cache sidecar systems include:

- transfer-group cache
- carrier reachability masks
- derived lobby local-access reachability records
- floor walkability flags
- demand-history log and its summary table

The binary distinction is operational, not cosmetic:

- `delete_placed_object_and_release_sidecars` invalidates or frees the object-owned sidecars
  attached to the demolished object
- caller-side rebuild helpers then recompute the affected derived caches such as route
  reachability, transfer groups, parking coverage, and demand history

The simulation also maintains concrete sidecar/cached tables such as:

- commercial venue records
- entertainment venue records
- service-request entries
- transfer-group cache
- walkability flags
- route queues
- per-car active route slots
- subtype allocation maps
- reverse subtype lookups

These must be persisted or rebuilt in a way that preserves deterministic behavior.
