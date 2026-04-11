## Bomb Event

Trigger:

- checked at checkpoint `0x00f0`
- fires when `day_counter % 60 == 59`
- suppressed while a bomb or fire event is already active

Behavior:

- selects a random candidate floor through the same floor-selection helper used by the fire event
  - helper semantics from the binary: scan floors upward from the supplied lower bound, find the
    first non-empty floor, then the first empty floor after that contiguous occupied run; the bomb
    chooses uniformly from the inclusive range `[lower_bound, top_live_floor]`
- the bomb starts floor selection at clone logical floor `lobby_height`, so multi-floor lobby floors are excluded
- requires the selected floor width to be at least `4` tiles
- chooses the bomb x-position uniformly from `[left_tile_index, right_tile_index - 4]`
- computes ransom from the current star rating using startup-tuning values:
  - 2 stars: `$200,000`
  - 3 stars: `$300,000`
  - 4 stars: `$1,000,000`
- shows the bomb prompt popup (`0x2713`)
- if the player pays: deduct ransom, show notification `0x271f`, event ends
- if the player does not pay: arm the delayed bomb-resolution path that is checked later in the day (`day_tick == 0x04b0`) while response helpers search

Bomb resolution:

- `resolve_bomb_search(0)`: search failed, detonates, sets the detonation state bit, applies damage, emits popup `0x2714`
- `resolve_bomb_search(nonzero)`: search succeeded, sets the found/defused state bit and extends the timer state instead of detonating
- either branch then schedules a short cleanup delay of `2` ticks
- cleanup jumps simulation time forward to `day_tick = 1500` and recomputes `daypart_index`

Bomb damage:

- detonation deletes objects in a `40 x 6` rectangle centered on the planted bomb
  - floors `[bomb_floor - 2, bomb_floor + 3]`
  - tiles `[bomb_x - 20, bomb_x + 19]`

## Fire Event

Trigger:

- checked at checkpoint `0x00f0`
- fires when `day_counter % 84 == 83`
- suppressed while a bomb or fire event is already active

Behavior:

- only triggers when the tower is still in the morning-period gate used by the original code,
  `star_count > 2`, and no cathedral evaluation site is active
- chooses a random fire-eligible floor through the same contiguous-live-floor helper used by the bomb event
- requires the selected floor width to be at least `32` tiles
- the helper excludes multi-floor lobby floors by starting its candidate range at clone logical floor `lobby_height`
- records the fire floor and seeds the initial fire x-position at `right_tile_index - 32`
- shows the fire-rescue prompt family (`0x2716`), sets the fire-active bit in `game_state_flags`, and initializes the spread state

Fire rescue follow-up:

- two ticks after ignition, the game resolves the rescue choice prompt
- the branch that dispatches the rescue path charges `$500,000`, seeds the active fire core at `right_tile_index - 12`,
  and keeps the event running
- the other branch shows the loss dialog, idles the helper pool, and leaves the fire to run out through normal cleanup

Spread / follow-up:

- the live spread ticker periodically decrements the fire-width counter every `1` tick, emits ongoing notification `0x2719`, and applies fire damage
- active fire fronts delete covered tiles as they advance inward from both sides
- if no fire-front cells remain, or when `day_tick == 2000`, the event finalizes
- final cleanup clears the fire bit, emits popup `0xBC5`, idles the helper pool, and forces
  `day_tick` up to `1500` if it was still earlier in the day
- cathedral-evaluation handling explicitly prevents fires while that evaluation run is active; there is no separate fire suppressor object

## VIP / Special Visitor Event

Trigger:

- runs on eligible per-tick passes when `day_tick > 240`
- requires `daypart_index < 4`
- requires `metro_station_floor_index >= 0`
- requires `vip_system_eligibility >= 0`
- suppressed while a bomb or fire event is active
- probability: `random() % 100 == 0`

Behavior:

- sweeps all placed objects of types `0x1f`, `0x20`, `0x21`
- if `special_visitor_flag == 0`: sets it to `2`, marks the object dirty, and records that at least one suite activated
- if `special_visitor_flag != 0`: clears it back to `0` and marks the object dirty
- if any suite flipped from `0` to `2`, emits popup `0x271a`

This event is cosmetic / display-state only. It does not feed the star gate or route logic.

## Checkout Newspaper Popup

Family-`3/4/5` sale / checkout completions drive a separate newspaper-style popup path from the per-tick viewport-sampled news system.

Producer (`deactivate_family_345_unit_with_income`):

- increments the cumulative `family345_sale_count`
- if `family345_sale_count < 20`: sets `newspaper_trigger = 1` exactly on even counts, else `0`
- if `family345_sale_count >= 20`: sets `newspaper_trigger = 1` exactly on counts divisible by `8`, else `0`

Consumer (`update_cash_display_and_maybe_show_newspaper_popup`):

- runs from the shared cash-display refresh helper used by income, refunds, and construction-cost updates
- if `cash_report_dirty_flag != 0` and `newspaper_trigger != 0`: emits popup `0x271d` with style `(2,3)` before redrawing the cash panel
- after polling, forces `newspaper_trigger = 1` again; later non-milestone family-`3/4/5` transactions are what clear it back to `0`

This is not a queued event type. It is a single flag recomputed by each family-`3/4/5` checkout/sale and then polled opportunistically by the next cash-display refresh.

## Random News Events

After the early daily checkpoint and before late-day periods, the simulation can emit random news popups by sampling the currently visible map. This system is separate from the family-`3/4/5` newspaper popup above.

Trigger path:

- runs only while notifications are enabled and `(game_state_flags & 0x09) == 0` (the same bomb/fire suppression bits used elsewhere in the event system)
- first RNG gate: `random() % 16 == 0`
- second RNG roll: `random() % 6`, selecting one of six viewport buckets
- bucket-to-viewport coordinates:
  - `0`: `x = visible_width / 4`, `y = (visible_height - 1) / 2`
  - `1`: `x = visible_width / 2`, `y = (visible_height - 1) / 2`
  - `2`: `x = visible_width - visible_width / 4`, `y = (visible_height - 1) / 2`
  - `3`: `x = visible_width / 4`, `y = (visible_height - 1) - (visible_height - 1) / 4`
  - `4`: `x = visible_width / 2`, `y = (visible_height - 1) - (visible_height - 1) / 4`
  - `5`: `x = visible_width - visible_width / 4`, `y = (visible_height - 1) - (visible_height - 1) / 4`
- the sampled viewport row is converted back to an absolute floor index before classification

Classifier return codes:

- `-2`: suppress the event entirely
- `-1`: empty tile above ground; eligible for the general-tower fallback news path
- positive values: family / subject codes consumed by the popup mapper

Empty-tile handling:

- if the sampled occupancy slot is empty and the absolute floor index is below `10`, classification returns `-2` and the event is suppressed
- if the slot is empty on floor `10` or above, classification returns `-1`, which the random-news caller turns into the general tower news fallback

Facility eligibility rules:

- hotel families `3/4/5`: state byte `< 0x10` and `(state_byte & 0x07) != 0`
- condo family `9`: state byte `< 0x10` and `(state_byte & 0x07) != 0`
- office family `7`: state byte `< 0x08` and `(state_byte & 0x07) != 0`
- restaurant / fast-food / retail families `6`, `0x0c`, `0x10`: linked `CommercialVenueRecord.state` must be neither `-1` nor `3`, and `CommercialVenueRecord.activity_byte` must be nonzero
- parking ramp family `0x0b`: state byte must be `> 1`
- single-screen entertainment families `0x1d/0x1e`: linked entertainment `link_phase_state` must be `> 1`
- paired entertainment families `0x12/0x13/0x22/0x23`: linked entertainment `link_phase_state` must equal `3`; on success the classifier returns `0x2329 + family_selector_or_single_link_flag`
- all other families, and all inactive / not-ready records, return `-2`

Popup mapping for positive classifier codes:

- `3`, `4`, `5` -> popup `0x629`
- `6` -> popup `0x568` or `0x569` with equal probability
- `7` -> popup `0x5a8`
- `9` -> popup `0x628` on `1/10`, else `0x629`
- `0x0b` -> popup `0x6a8` or `0x6a9` with equal probability
- `0x0c`, `0x10` -> popup `0x569` or `0x668` with equal probability
- `0x1d`, `0x1e` -> popup `0x0b28`

General-tower fallback for classifier result `-1`:

- random news reaches the popup mapper through a one-argument far-call shim, so the helper treats `-1` as enabled there
- if the periodic-maintenance gate is set, emit `0x2712`
- otherwise:
  - if `(day_counter / 3) % 4 == 2` and `pre_day_4() != 0`, emit `0x271c`
  - if `(day_counter / 3) % 4 == 3` and `pre_day_4() == 0`, emit `0x271b`
  - all other cases suppress the event

Paired-entertainment note:

- the paired-link classifier path returns `0x2329 + family_selector_or_single_link_flag`
- the downstream popup switch does not recognize that range, and no bitmap resources in the `0x2329..0x2335` range were recovered from the extracted manifest
- inference: ready paired entertainment samples do not produce a visible news popup in practice, despite reaching a distinct classifier branch
