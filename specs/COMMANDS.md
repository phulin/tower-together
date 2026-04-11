# Commands And Player Interventions

## Command Ordering

Headless rule:

1. apply all pending commands
2. update any immediate derived state those commands require
3. continue the next simulation tick
4. collect notifications and prompt emissions after simulation work
5. if a blocking prompt was emitted, stop further advancement until a prompt-response command arrives

## Build

Build validation should check:

- cost
- tile occupancy
- geometry/span rules
- tower-state prerequisites
- per-type singleton or quota limits

Shared placement validators:

- `validate_floor_support_span_for_placement` is the common horizontal support/span check used by single-floor placers, drag/span placers, and the anchor segment of multifloor placers
- `validate_floor_class_for_placement` is the common floor-class gate used by the family helpers
- `validate_multifloor_segment_placement` is the shared empty-slot / insertion validator for 2-floor, 3-floor, and 5-floor stacks

Support/span rules:

- horizontal placement is bounded by the world width cap of 375 tiles
- out-of-bounds horizontal spans reject with `0x14`
- floors above the lobby boundary require an existing support-span record and must stay within that cached support range
- missing above-grade support rejects with `0x03`
- above-grade span overflow beyond the supported footprint rejects with `0x06`
- floor `0` is the free lobby boundary
- basement placement requires the floor above to exist
- missing basement ceiling/floor-above support rejects with `0x04`
- basement placement must stay within the basement entrance footprint or reject with `0x02`
- if a basement floor is still empty, the new span must overlap the occupied range on the floor above or reject with `0x04`

Floor-class rules:

- hotel rooms, offices, and condos must be above grade (`floor > 0`) or reject with `0x0a`
- parking-space, recycling-center, and parking ramps must be below grade (`floor < 0`) or reject with `0x0b`
- transit concourse / lobby spans must satisfy the lobby-or-express-floor predicate or reject with `0x0d`
- evaluation/cathedral anchor placement must target floor `103` or reject with `0x10`
- non-evaluation families are rejected above floor `99` with `0x05`
- once the metro station exists, generic families cannot be placed below `metro_floor - 1` or reject with `0x0e`
- entertainment-linked families that use the stricter metro gate must satisfy `floor >= metro_floor`
- elevator families and lobby spans are exempt from the dispatcher-wide floor-0 rejection precheck

Family-specific floor and stack rules:

- security office is basement-only
- office is above-grade only
- the recycling center (type `0x14/0x15`) is a two-floor paired stack with an extra overlap validator:
  - if no recycling center exists yet (`g_recycling_center_count == 0`), the first center is allowed immediately
  - otherwise the proposed center must overlap an existing live `0x14/0x15` recycling center within the search band of floors `anchor - 2` through `anchor + 1`
  - matches manual: "They must be placed adjacent to one another to operate."
- metro station placement is a 3-floor stack and is accepted only on floors `-8..-1` with the required floor-class descriptor present
- cathedral/evaluation placement is a 5-floor stack rooted at floor `103`
- evaluation entities occupy floors `99..109`
- carrier shafts require `top_served_floor <= 99`
- express and service shaft placements are capped at 31 floors of span
- standard elevators are instead limited by the 10-slot served-floor mapping
- parking ramps are single-tile, single-floor segments fixed to column `9`
- stairs/escalators are multifloor special-link overlays, not shaft objects

Special-link placement rules:

- stairs/escalators allocate from the 64-slot special-link table
- `lobby_height` is a saved tower parameter (1, 2, or 3) that `new_game_initializer` resets to `0` on a fresh game and that the dispatcher locks in on the player's first construction click
- the selector is the modifier-key state on that first click: a plain click sets `lobby_height = 1`, holding `Ctrl` sets it to `2`, holding `Ctrl + Shift` sets it to `3`; if the resource for the chosen lobby height cannot be loaded, the dispatcher snaps `lobby_height` back to `1`
- the very first click is also gated by an empty-game guard: if it lands on floor `-10` column `0` while cash is still the starting `20000` and no objects are placed yet, the dispatcher refunds the click and skips selection so the choice is not accidentally locked in by a stray initial event
- once selected, `lobby_height` is persisted by `archive_tower_state_compat` and is never modified again at runtime
- if `lobby_height > 1`, and the requested top landing lies between floors `1` and `lobby_height`, placement clamps the top landing upward to `lobby_height` and increases the stored span so the lower landing stays fixed
- both top and bottom landing validators require the overlapping underlay object to be one of: empty, restaurant, retail, fast food, party hall (forward), party hall (reverse), lobby, cinema (forward), cinema (reverse), single hotel room
- top landing footprint requires the destination floor to exist and the requested 8-tile footprint to fit within an existing object span with a 2-tile left inset
- bottom landing footprint requires the source floor to exist and the requested 8-tile footprint to fit within an existing object span without that extra left inset
- express-branch placement skips the allowlist object-type dispatch once the raw 8-tile footprint fit checks succeed
- narrow geometry uses a stepped 2-floor shape: one full 8-tile bounding rectangle plus two 4-tile half-rectangles, and rejects if that shape intersects carrier clearance rectangles, any express-style special link, or either half of an existing local-style special link
- wide geometry uses one continuous rectangle whose vertical span grows with `(stored_span >> 1)` and rejects if it intersects any carrier clearance rectangle or any existing special link
- carrier-clearance rectangles used by these geometry checks reserve width `6` for carrier mode `0` and width `4` for other carrier modes, expanded vertically from `bottom_floor - 2` through `top_floor + 1`
- escalators are therefore overlays on a narrow set of commercial/public footprints, not free-standing structures
- the special-link placement behavior itself is now resolved; only UI-side drag acceptance remains outside the core sim model

Command-dispatch limits:

- metro station is a singleton
- cathedral / evaluation entity is a singleton
- commercial venues are capped at 200 active placements
- sky-lobby / transit concourse objects are capped at 10 active placements
- security offices are capped at 10 active placements
- entertainment links are capped at 16 active placements

Placement constraints:

- some vertical-anchor families require column `x = 9`
- transit concourse viability depends on nearby carriers and is validated at placement time
- parking-ramp placement uses its own column-9 constraint path
- stairs and escalators use dedicated top-footprint, bottom-footprint, and width validators
- elevator-editor placement enforces a minimum 6-tile gap from standard elevators and 4-tile gap from non-standard carriers, with additional side-clearance checks
- drag-family preview/commit acceptance still has some UI-layer details that remain partially recovered, but the sim-level placement legality for parking spaces, parking ramps, drag-span floor/lobby families, and special links is now mostly pinned down

Dispatch-level build errors:

- metro already placed -> `0x11`
- evaluation/cathedral already placed -> `0x13`
- quota exhausted -> `0x1e`
- parking-ramp wrong column -> `0x1f`
- parking-ramp anchor/floor mismatch -> `0x20`
- parking-space placement rejected on the selected floor -> `0x22`

Successful build should:

- deduct cost
- insert or update placed-object state
- allocate subtype and sidecars as needed
- initialize family fields
- mark affected objects dirty
- rebuild any impacted caches

## Demolish

Demolition should:

- reject non-removable families
- tear down sidecars
- reverse ledger contributions where appropriate
- invalidate related demand/request state as part of family-specific teardown
- rebuild affected caches

Headless rule:

1. validate that the target object exists
2. reject non-removable families
3. run the unified teardown path
4. run the global rebuild sweep
5. allow later normal reset/checkpoint sweeps to normalize any broader derived state not handled by the immediate teardown helpers

Teardown notes:

- No cash refund is given for demolition.
- The teardown primitive performs family-specific ledger and sidecar cleanup, but global rebuilds are the responsibility of the command/event caller.
- A conservative faithful implementation may run the full rebuild sweep after any player demolition, even where the original caller may have used a smaller per-family subset.
- Runtime cleanup is partly synchronous inside teardown:
  - the teardown primitive first walks the removed object's tile span to finalize entity state for most removable families
  - this walk visits each entity with active route state and finalizes its route, clearing per-entity family and route-mode fields for the removed span and removing matching entries from the active-request table
  - for hotel/condo-type spans it also releases attached service-request backlinks
  - for office spans it releases attached service-request backlinks while walking the office runtime records
- So the faithful rule is not "leave all in-flight state untouched until next reset". The removed object's directly anchored runtime/request state is cleaned up immediately, while broader cache normalization still relies on the caller rebuilds and later scheduler checkpoints.

Non-removable families:

- security office
- connector family `0x0f`
- parking variants `0x18..0x1a`
- metro-station variants `0x1f..0x21`
- evaluation-chain entities `0x24..0x28`
- paired-connector families `0x2d..0x32`

Demolition rejection behavior:

- connector-family rejection returns `0x15`
- other non-removable-family rejection returns `0x21`
- both rejection classes leave the object in place and suppress the demolish chime

Per-family teardown effects:

- commercial venues and entertainment links mark their auxiliary records stale so the next ledger/rebuild sweep drops them
- parking-space emitters invalidate the corresponding demand-history entry
- parking ramps force a parking coverage and demand-history rebuild
- carrier edits and demolition rebuild transfer-group and route-reachability caches immediately
- hotel/condo spans synchronously finalize route state, clear active-request entries, and release attached service-request backlinks via the tile-span teardown walk
- office spans synchronously finalize route state and release attached service-request backlinks via the tile-span teardown walk

Demolition confirmation prompts are known for some carrier edits:

- elevator served-floor removal emits confirm prompt `0x3ed` if any active route currently uses that floor
- elevator car removal and whole-shaft demolition also emit confirm prompt `0x3ed` if any active route exists

## Price / Rent Change

Price-change commands update `rent_level` and then recompute readiness and cashflow consequences for the affected facility. Valid for priced families (3, 4, 5, 7, 9, 10); values 0–3. Condo (family 9) rejects changes while sold (`unit_status < 0x18`).

## Prompt Response

Prompt-response commands resolve the currently active modal event or decision point and then allow the simulation to continue.

Decision-bearing prompt classes:

- bomb ransom prompt (`0x2713`): response chooses pay vs refuse
- fire rescue prompt (`0xbc2` or `0xbc3`): response chooses helicopter dispatch vs decline
- carrier-edit confirmation prompt (`0x3ed`): response chooses continue vs cancel for served-floor removal, car removal, or whole-shaft demolition when active routes would be disrupted

Dialogs that are not separate prompt-response command types:

- bomb armed / search-start status dialogs (`0xbcd`, `0xbce`)
- bomb found / exploded cleanup dialogs (`0xbcf`, `0xbd0`)
- treasure dialog (`0xbe0`)
- object inspector dialogs (`0x2fb`, `0x2fc`)

These may block the original UI until dismissed, but they do not introduce extra
branching command payloads in a headless implementation.

## Pause / Resume

Headless rule:

- explicit paused state means no scheduler ticks advance
- inspection-only commands remain allowed
- original UI-side restrictions on which state-changing commands were allowed immediately versus queued are still not fully recovered

## Elevator Editing

Supported actions:

- toggle served floor
- remove a car
- demolish a shaft
- extend top served floor
- extend bottom served floor

Editing elevator coverage must also:

- clear stale assignments
- drain affected floor queues
- rebuild reachability and transfer caches

## Hard Limits

- maximum carriers: 24
- maximum cars per carrier: 8
- maximum per-direction floor queue: 40

Some facility families also have singleton or quota limits that are enforced at build time.
