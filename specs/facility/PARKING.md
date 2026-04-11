# Parking

Families `0x0b` (parking space) and `0x2c` (parking ramp) cover parking spaces and parking ramps.

## Roles

- parking spaces are demand emitters
- parking ramps are coverage infrastructure that can suppress nearby parking demand
- parking contributes expense only; it has no positive cashflow path

## Operating Expense

Parking expense is charged on the same 3-day periodic sweep as other operating costs.

Formula:

- expense in cash units = `(right_tile_index - left_tile_index) * tier_rate / 10`
- `tier_rate` is chosen by current tower tier:
  - stars `< 3`: `0`
  - star `3`: `30`
  - stars `>= 4`: `100`
- cash units convert to dollars at `1` cash unit = `$100`
- effective per-tile charges are therefore `$0`, `$300`, and `$1,000`
- the expense is recorded under the parking expense ledger bucket

Expense gate:

- the parking-expense helper skips the upper floors of a multi-floor lobby, not an underground band
  - clone logical floors: `1 <= floor < lobby_height`
- this is an operating-expense gate only; it does not create or suppress parking demand
- parking variants swept by this path share the same expense math; their remaining distinction is visual/depth classification rather than operating-cost behavior

## Service Request Entries

Parking spaces allocate service-request entries. Each entry needs:

- floor index
- subtype index
- back-reference to the actor or service process handling it

Free entries are marked invalid and omitted from the active demand log.

Entry lifecycle:
- an entry is allocated at parking-space placement, writing floor_index and subtype_index
- `release_service_request_entry` (called at teardown) clears only the backlink handle field — the entry stays live
- the entry's subtype byte is set to `0xff` (tombstone) by the demolition dispatch path
- the entry is actually freed (floor byte set invalid, count decremented) only during the demand history rebuild at checkpoint 0, when it detects the tombstone subtype

An entry is **stale** when its subtype byte equals `0xff` — this is the demolished-object tombstone.

### Coverage Initialization

Parking-space objects have no coverage byte set at placement. The coverage byte defaults to `0` (uncovered), so newly placed spaces appear in the demand log immediately. Coverage is not applied until the first parking ramp coverage rebuild runs — either at demolition of a parking object or at the next start-of-day checkpoint 0.

### Demand Families

Parking demand is emitted by family `0x0b` parking spaces (and type-code variants `0x18`/`0x19`/`0x1a`). Consumers that route to parking include hotel suites (family `0x05`), condos (family `0x09`), and office workers (family `0x07`).

Parking demand routing:

- Parking spaces populate the service-request table.
- A random picker selects from available entries; returns invalid when the table is empty.
- Hotel suite guests (family 5) require any non-zero entity state.
- Office workers (family 7) require (floor + slot) % 4 == 1 and entity state == 2.
- Requires star level > 2.
- On assignment failure, the status bar shows "Office workers demand Parking".

Note: offices are **consumers** of parking demand, not producers. They do not allocate service-request entries. Parking spaces populate the service-request table; office workers pull from it.

## Demand History

The demand-history table is rebuilt from active service-request entries.

It:

- skips invalid entries
- removes stale entries
- keeps only uncovered parking-space demand
- feeds random selection for consumers that pull from parking/service demand

Structure:

- a flat array of up to 512 service-request indices, not a ring buffer
- one leading entry-count field
- append order matches the sweep order of the service-request table

Rebuild rules:

- skip free entries where `floor == -1`
- skip entries where `subtype_index == -1`
- stale entries are actively invalidated during the rebuild
- valid entries are appended only when the owning parking-space object's coverage flag is not `1`

Random selection:

- the random picker returns `log[abs(rng()) % count]`
- returns an invalid marker when the log is empty

Summary table:

- a derived 10-dword summary table is rebuilt from the log count
- positions `0` and `3` are weighted as `count * 2`
- the other positions are weighted as `count`
- the resulting totals are used as a cumulative-distribution helper elsewhere in the demand pipeline

## Coverage Propagation

Parking ramps propagate coverage across nearby parking spaces on the same floor.

Covered parking spaces:

- are marked suppressed
- do not appear in the demand log

Uncovered parking spaces:

- remain active demand sources
- are collected into the demand log

Rebuild order:

- the coverage rebuild scans floors from `9` down to `0`
- on each floor it searches for parking-ramp segments (`0x2c`)
- if an anchor exists, it clears the anchor state byte first, then checks the floor below for a same-x continuation
- anchor stack-state values:
  - `0`: standalone or terminal anchor
  - `1`: interior of a multi-floor chain
  - `2`: topmost anchor on floor `9` when the chain continues downward
- if no anchor exists on a floor, propagation still runs in disabled mode so previously covered spaces are reset
- after all floors are processed, the demand-history table is rebuilt from the resulting coverage flags

Same-floor propagation shape:

- propagation starts from the anchor x position
- it walks left, then right, across the floor
- it may cross empty tiles only while the empty run is at most `3` tiles wide
- propagation stops at any wider empty gap
- propagation also stops at any non-empty, non-parking-space object
- reachable parking-space tiles (`0x0b`) are marked covered with state `1`
- unreachable parking-space tiles are marked uncovered with state `0`
- changed objects are marked dirty
