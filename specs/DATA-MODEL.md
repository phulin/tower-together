# Data Model

This document defines shared state and terminology used across the simulation spec.

## World Indexing

- There are 120 floors, indexed `-10..109`.
- Floor `0` is the ground-floor lobby.
- Floors `-10..-1` are below grade (10 basement levels).
- Floors `1..109` are above grade (109 above-ground levels).
- Sky lobbies may be placed on floors `15`, `30`, `45`, etc.

Each placed object is addressed by `(floor_index, subtype_index)`, where `subtype_index` is that floor's object-slot index.

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

The implementation can choose any internal struct layout. The important part is preserving these behaviors and fields.

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

## `base_offset`

`base_offset` is the occupant index within a multi-occupant object.

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
- `population_ledger`: live per-family active-unit counts (drives star thresholds and security tier)
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

The simulation also maintains derived or sidecar tables such as:

- commercial venue records
- entertainment-link records
- service-request entries
- transfer-group cache
- walkability flags
- route queues
- per-car active route slots
- subtype allocation maps
- reverse subtype lookups

These must be persisted or rebuilt in a way that preserves deterministic behavior.
