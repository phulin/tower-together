# Routing

## Model

Routing is one-leg-at-a-time, not full-path planning.

For a request from `source_floor` to `target_floor`, the router picks the cheapest valid next leg:

- direct stair or escalator segment
- elevator ride
- transfer-oriented elevator ride toward a reachable transfer floor

When that leg completes, the family state machine asks for the next leg if the actor is not yet at its final destination.

## Route Resolution Results

The route resolver returns:

- same-floor success
- direct stair/escalator leg accepted
- elevator queue assignment accepted
- waiting state because the source-floor queue is full
- failure because no route exists

## Candidate Priority

Passenger/local mode:

1. direct local stair links when viable
2. special transfer zones around lobby and sky lobbies
3. elevator fallback

Express/helper mode:

1. express-capable stair/escalator links when viable
2. express-compatible elevator fallback

Recovered selector behavior:

- the selector scans direct raw special-link segments in ascending index order `0..63`
- in local mode, any direct local-segment hit suppresses later special-transfer-zone scoring entirely
- special transfer zones are scanned only when no direct local segment candidate exists
- special transfer zones are scanned in ascending index order `0..7`
- carrier candidates are scanned last in ascending carrier index order `0..23`
- all candidate replacement checks use strict `<`, not `<=`, so equal-cost ties keep the first candidate seen in scan order

## Route Costs

### Stair / Escalator Segments

- local-branch special-link segment: `abs(height_delta) * 8`
- express-branch special-link segment: `abs(height_delta) * 8 + 0x280`

Express-mode routing only considers express-branch special-link segments.

Binary-confirmed object-type mapping:

- placed-object type `0x16` is player-facing `Stairs` and passes the local-branch flag (low bit `0`)
- placed-object type `0x1b` is player-facing `Escalator` and passes the express-branch flag (low bit `1`)

This is the intuitive mapping: stairs are local links, escalators are express links. An earlier version of this spec had the mapping inverted due to a decompilation misread; the binary confirms the intuitive assignment.

## Carrier Costs

If a carrier directly serves both source and target floors:

- normal direct ride: `abs(height_delta) * 8 + 0x280`
- full queue at source floor: use `abs(height_delta) * 8 + 1000`

If a carrier serves the source floor and the target is reachable through transfers:

- normal transfer ride: `abs(height_delta) * 8 + 3000`
- full queue at source floor: use `abs(height_delta) * 8 + 6000`

## Delays

Use these delays:

- queued-leg timeout threshold: `300`
- queue-full waiting delay: `5`
- requeue-failure delay: `0`
- no-route delay: `300`
- invalid-venue delay: `0`
- local-branch special-link per-stop delay: `16`
- express-branch special-link per-stop delay: `35`

Long-distance penalty (applied when `emit_distance_feedback` is set):

- computed from `abs(height_metric_delta)` between the segment/carrier and entity
- `<= 0x4f` (79): no penalty
- `> 0x4f` (79) and `< 0x7d` (125): add `0x1e` (30 ticks) delay
- `>= 0x7d` (125): add `0x3c` (60 ticks) delay
- for carriers, this penalty applies only when `carrier_mode != 0` (standard/service)
- for special-link segments, it applies to all branches

## Walkability Rules

`g_floor_walkability_flags` is a 120-entry byte array (one per floor, indices 0–119).

Bit semantics:
- bit 0: local walkability (set by local-branch special-link segments, i.e. stairs)
- bit 1: express walkability (set by express-branch special-link segments, i.e. escalators)

Rebuild trigger: walkability flags are rebuilt whenever a special-link segment (stairs or escalator) is placed or demolished. The rebuild scans all 64 special-link slots and sets the appropriate bit on each floor covered by a live segment.

Local walkability:

- maximum span checked: 6 floors in each direction from center (i.e. `center ± 6`)
- two distinct stop conditions on each floor:
  1. **zero walkability byte** (no floor exists): immediate stop, returns that floor as the bound
  2. **nonzero walkability byte but bit 0 clear** (floor exists but not locally walkable): marks a "gap"
- after the first gap, the scan continues only within the 3-floor center band (`center ± 3`); once the scan reaches 3 floors from center with a gap having been seen, it stops
- if no gap is encountered, the scan extends to the full 6-floor range

Express walkability:

- maximum span checked: 6 floors in each direction from center
- every floor in the span must have express walkability (bit 1 of walkability byte)
- no gap tolerance

## Transfer Groups

Transfer groups describe floors where carriers and transfer zones intersect.

They are rebuilt from:

- lobby/concourse transfer infrastructure
- carrier served-floor coverage
- sky-lobby transfer spans

Recovered rebuild algorithm (`rebuild_transfer_group_cache`):

1. clear all 16 transfer-group cache entries
2. scan all floors for placed objects of type `0x18` (sky lobby / transit concourse)
3. for each such object, determine which carriers serve that floor by scanning carriers `0..23` and building a carrier bitmask
4. if an existing cache entry already has the same tagged floor, merge the new carrier bitmask into the existing entry via bitwise OR
5. otherwise allocate the next free cache entry (up to 16), storing the tagged floor and carrier bitmask
6. after the object scan, also merge in the derived transfer-zone records (lobby and sky-lobby walkable spans) — each zone contributes its own carrier reachability to overlapping cache entries
7. entries are stored in discovery order; the 16-entry cap is a hard limit

The cache is rebuilt:
- at start-of-day (`0x000` checkpoint)
- after any carrier edit or demolition that changes served-floor coverage
- after placement or demolition of a sky lobby / transit concourse

They feed:

- carrier transfer scoring
- special-link reachability
- transfer-floor selection during queue drain

Recovered transfer-reachability behavior:

- carrier and special-link transfer tests both scan the 16 transfer-group cache entries in ascending index order `0..15`
- entries whose tagged floor equals the current floor are skipped
- the first valid entry whose carrier-mask overlaps the candidate's target-floor reachability mask succeeds
- the emitted direction flag is derived from whether the current floor is below that entry's tagged floor
- no weighted comparison exists inside these helpers; they are first-match scans over the cache

Recovered transfer-floor selection behavior during queue drain:

- if a carrier directly serves the target floor, the chosen transfer floor is just the target floor
- otherwise the queue-drain path reads that carrier's `reachability_masks_by_floor[target_floor]`
- if the mask is nonzero, it scans transfer-group entries `0..15` in ascending order
- each candidate must be live, must not be tagged to the current floor, and must have a `carrier_mask` overlap with the target-floor reachability mask
- the candidate floor must also lie in the requested travel direction:
  - upward travel accepts only tagged floors above the current floor
  - downward travel accepts only tagged floors below the current floor
- the first candidate that passes those checks is returned as the boarding / transfer floor
- if no candidate passes, transfer-floor selection fails with `-1`

## Derived Transfer Zones

The lobby / sky-lobby transfer zones are derived records, not placed objects.

Recovered record set:

- up to 8 records in `special_link_record_table`
- one centered around floor `10`
- one each centered around floors `24`, `39`, `54`, `69`, `84`, and `99`
- at most 7 of those records are typically live at once

Recovered zone-building rule (`scan_special_link_span_bound`):

- each record scans outward from its center using `g_floor_walkability_flags`
- upward scan (`dir != 0`):
  - start at `center`, iterate `floor` from `center` to `center + 5`
  - if `walkability[floor] == 0`: return `floor` (exclusive upper bound)
  - if `walkability[floor] & 1 == 0`: set gap flag
  - if gap flag set AND `floor >= center + 3`: return `floor`
  - if loop completes: return `center + 6`
- downward scan (`dir == 0`):
  - start at `center`, iterate checking floors `center` down to `center - 5`
  - if `walkability[floor] == 0`: return `floor` (exclusive lower bound)
  - if `walkability[floor] & 1 == 0`: set gap flag
  - if gap flag set AND next floor `< center - 3`: exit, return current floor
  - if loop completes: return `center - 6`
- the span stored in the record is `[downward_bound, upward_bound)` (lower inclusive, upper exclusive)
- `is_floor_within_special_link_span` tests `bottom_floor <= floor <= top_floor`

Recovered route-use rule for these zones:

- they are considered only in local mode
- they are scanned only when no direct local special-link candidate exists
- zone scoring is viability-only:
  - active record required
  - source floor must lie inside the derived span
  - target floor must either lie inside the same span or be reachable through the record's per-floor transfer mask cache
- a viable zone contributes cost `0`; an invalid one contributes `0x7fff`
- once a zone is chosen, the router computes the first one-floor leg in the emitted direction and requires that first step to be covered by a direct local special-link segment

Recovered per-floor cache format:

- `0`: unreachable
- `1..16`: direct transfer-group index + 1 for a tagged floor inside the record's own span
- other nonzero values: transfer-participant bitmask
  - bits `0..23`: carriers
  - bits `24..31`: peer derived transfer-zone records

## Queues

Each floor/carrier direction has a ring buffer with:

- count
- head index
- up to 40 queued requests

The literal count `40` is the queue-full condition.

Queue behavior:

- enqueue writes to `(head + count) % 40`
- dequeue reads from `head`, then advances `head = (head + 1) % 40`
- the queue-full sentinel is the literal count `40`, not a separate state code

## Path State

The routing system also maintains:

- per-car active route slots
- path buckets
- special-link reachability by floor
- walkability flags

These are simulation state.

Separately, the executable keeps a visible route-failure suppression cache for notifications:

- one byte per source floor, starting at floor-table offset `0x7fae`
- when route resolution fails with feedback enabled, the cache is checked by source floor
- if the byte is clear, a route-failure notification is built and shown, then that source-floor byte is set to `1`
- this cache is cleared in bulk on new-game initialization

This cache affects repeated popup emission. It does not participate in route scoring or path selection.

## Route-Selector Details

`select_best_route_candidate` applies these additional rules:

- express mode checks raw express-branch segments first and immediately accepts the best one if any exists
- local mode immediately accepts a direct local-branch segment only when its cost is below `0x280`
- otherwise local mode continues on to carrier fallback, but still preserves the best direct-segment candidate found so far
- special transfer-zone records return only viability (`0` or `0x7fff`); when one succeeds, the selector computes the first one-floor leg in the chosen direction and then requires a direct local-branch segment for that first step
- direct carrier service and transfer-assisted carrier service are both folded into the same final carrier scan

## Raw Special-Link Flags

Raw special-link records carry a `mode_and_span` byte.

Recovered branch semantics:

- low bit `0`: local-branch special link
- low bit `1`: express-branch special link
- local route scoring accepts both branches, but adds the `+0x280` surcharge to the low-bit-`1` branch
- express route scoring accepts only the low-bit-`1` branch
- reachability rebuild writes local walkability for the low-bit-`0` branch and express walkability for the low-bit-`1` branch
