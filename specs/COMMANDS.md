# Commands And Player Interventions

## Command Ordering

Recovered headless rule:

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

Recovered shared placement validators:

- `validate_floor_support_span_for_placement` is the common horizontal support/span check used by single-floor placers, drag/span placers, and the anchor segment of multifloor placers
- `validate_floor_class_for_placement` is the common floor-class gate used by the family helpers
- `validate_multifloor_segment_placement` is the shared empty-slot / insertion validator for 2-floor, 3-floor, and 5-floor stacks

Recovered support/span rules:

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

Recovered floor-class rules:

- hotel rooms, offices, and condos must be above grade (`floor > 0`) or reject with `0x0a`
- parking-space, recycling/security-service-style basement utilities, and parking ramps must be below grade (`floor < 0`) or reject with `0x0b`
- transit concourse / lobby spans must satisfy the lobby-or-express-floor predicate or reject with `0x0d`
- evaluation/cathedral anchor placement must target floor `103` or reject with `0x10`
- non-evaluation families are rejected above floor `99` with `0x05`
- once the metro station exists, generic families cannot be placed below `metro_floor - 1` or reject with `0x0e`
- entertainment/security-linked families that use the stricter metro gate must satisfy `floor >= metro_floor`
- elevator families and lobby spans are exempt from the dispatcher-wide floor-0 rejection precheck

Recovered family-specific floor and stack rules:

- security office is basement-only
- office is above-grade only
- metro station placement is a 3-floor stack and is accepted only on floors `-8..-1` with the required floor-class descriptor present
- cathedral/evaluation placement is a 5-floor stack rooted at floor `103`
- evaluation entities occupy floors `99..109`
- carrier shafts require `top_served_floor <= 99`
- express and service shaft placements are capped at 31 floors of span
- standard elevators are instead limited by the 10-slot served-floor mapping
- parking ramps are single-tile, single-floor segments fixed to column `9`
- stairs/escalators are multifloor special-link overlays, not shaft objects

Recovered special-link placement rules:

- stairs/escalators allocate from the 64-slot special-link table
- `g_lobby_height` is a saved tower parameter (1, 2, or 3) that `new_game_initializer` resets to `0` on a fresh game and that the dispatcher locks in on the player's first construction click
- the selector is the modifier-key state on that first click: a plain click sets `g_lobby_height = 1`, holding `Ctrl` sets it to `2`, holding `Ctrl + Shift` sets it to `3`; if the requested NE resource for the chosen height (resource id `0x67b`, index `0xfe7 + g_lobby_height`) cannot be loaded, the dispatcher snaps `g_lobby_height` back to `1`
- the very first click is also gated by an empty-game guard: if it lands on floor `-10` column `0` while cash is still the starting `20000` and no objects are placed yet, the dispatcher refunds the click and skips selection so the choice is not accidentally locked in by a stray initial event
- once selected, `g_lobby_height` is persisted by `archive_tower_state_compat` and is never modified again at runtime
- if `g_lobby_height > 1`, and the requested top landing lies between floors `1` and `g_lobby_height`, placement clamps the top landing upward to `g_lobby_height` and increases the stored span so the lower landing stays fixed
- both top and bottom landing validators require the overlapping underlay object to be one of: `0x00`, `0x06`, `0x0a`, `0x0c`, `0x12`, `0x13`, `0x18`, `0x1d`, `0x1e`, `0x1f`
- top landing footprint requires the destination floor to exist and the requested 8-tile footprint to fit within an existing object span with a 2-tile left inset
- bottom landing footprint requires the source floor to exist and the requested 8-tile footprint to fit within an existing object span without that extra left inset
- express-branch placement skips the allowlist object-type dispatch once the raw 8-tile footprint fit checks succeed
- narrow geometry uses a stepped 2-floor shape: one full 8-tile bounding rectangle plus two 4-tile half-rectangles, and rejects if that shape intersects carrier clearance rectangles, any express-style special link, or either half of an existing local-style special link
- wide geometry uses one continuous rectangle whose vertical span grows with `(stored_span >> 1)` and rejects if it intersects any carrier clearance rectangle or any existing special link
- carrier-clearance rectangles used by these geometry checks reserve width `6` for carrier mode `0` and width `4` for other carrier modes, expanded vertically from `bottom_floor - 2` through `top_floor + 1`
- escalators are therefore overlays on a narrow set of commercial/public footprints, not free-standing structures
- the special-link placement behavior itself is now resolved; only UI-side drag acceptance remains outside the core sim model

Recovered command-dispatch limits:

- metro station is a singleton
- cathedral / evaluation entity is a singleton
- commercial venues are capped at 200 active placements
- sky-lobby / transit concourse objects are capped at 10 active placements
- security offices are capped at 10 active placements
- entertainment links are capped at 16 active placements

Recovered placement constraints:

- some vertical-anchor families require column `x = 9`
- transit concourse viability depends on nearby carriers and is validated at placement time
- parking-ramp placement uses its own column-9 constraint path
- stairs and escalators use dedicated top-footprint, bottom-footprint, and width validators
- elevator-editor placement enforces a minimum 6-tile gap from standard elevators and 4-tile gap from non-standard carriers, with additional side-clearance checks
- drag-family preview/commit acceptance still has some UI-layer details that remain partially recovered

Recovered dispatch-level build errors:

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

Recovered headless rule:

1. validate that the target object exists
2. reject non-removable families
3. run the unified teardown path
4. run the global rebuild sweep
5. allow the next normal reset/checkpoint sweep to normalize any stale runtime entities that still referenced the removed object

Recovered teardown notes:

- No cash refund is given for demolition.
- The teardown primitive performs family-specific ledger and sidecar cleanup, but global rebuilds are the responsibility of the command/event caller.
- A conservative faithful implementation may run the full rebuild sweep after any player demolition, even where the original caller may have used a smaller per-family subset.
- Runtime entities and in-flight requests anchored at the removed object are not confirmed to be synchronously culled inside teardown; the clean-room rule should therefore preserve them until the normal reset sweep clears or rewrites them.

Recovered non-removable families:

- security office
- connector family `0x0f`
- parking variants `0x18..0x1a`
- metro-station variants `0x1f..0x21`
- evaluation-chain entities `0x24..0x28`
- paired-connector families `0x2d..0x32`

Recovered demolition rejection behavior:

- connector-family rejection returns `0x15`
- other non-removable-family rejection returns `0x21`
- both rejection classes leave the object in place and suppress the demolish chime

Recovered per-family teardown effects:

- commercial venues and entertainment links mark their auxiliary records stale so the next ledger/rebuild sweep drops them
- parking-space emitters invalidate the corresponding demand-history entry
- parking ramps force a parking coverage and demand-history rebuild
- carrier edits and demolition rebuild transfer-group and route-reachability caches immediately

Demolition confirmation prompts are known for some carrier edits:

- elevator served-floor removal emits confirm prompt `0x3ed` if any active route currently uses that floor
- elevator car removal and whole-shaft demolition also emit confirm prompt `0x3ed` if any active route exists

## Price / Rent Change

Price-change commands update `rent_level` (placed-object offset `+0x16`) and then recompute readiness and cashflow consequences for the affected facility. Valid for priced families (3, 4, 5, 7, 9, 10); values 0–3. Condo (family 9) rejects changes while sold (`unit_status < 0x18`).

## Prompt Response

Prompt-response commands resolve the currently active modal event or decision point and then allow the simulation to continue.

## Pause / Resume

Recovered headless rule:

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
