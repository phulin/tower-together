# Economy

## Units

All values in the tables below are denominated in `$100` units.

## Ledgers

The simulation maintains:

- `cash_balance`
- `population_ledger`: live per-family active-unit counts (drives star thresholds and security tier)
- `income_ledger`: realized income since the last 3-day rollover
- `expense_ledger`: realized operating expenses since the last 3-day rollover

Income:

- add to cash
- clamp so cash never exceeds `$99,999,999`
- mirror into the income ledger

Expenses:

- subtract from cash
- mirror into the expense ledger

## Construction Costs

Construction costs are indexed by placed-object type:

| type | value | dollar cost | label |
|---:|---:|---:|---|
| `0x00` | 5 | $500 | floor tile |
| `0x01` | 2000 | $200,000 | Standard Elevator shaft |
| `0x03` | 200 | $20,000 | Single Hotel Room |
| `0x04` | 500 | $50,000 | Twin Hotel Room |
| `0x05` | 1000 | $100,000 | Hotel Suite |
| `0x06` | 2000 | $200,000 | Restaurant |
| `0x07` | 400 | $40,000 | Office |
| `0x09` | 800 | $80,000 | Condo |
| `0x0a` | 1000 | $100,000 | Retail Shop |
| `0x0b` | 30 | $3,000 | Parking Space |
| `0x0c` | 1000 | $100,000 | Fast Food |
| `0x0d` | 5000 | $500,000 | Medical Center |
| `0x0e` | 1000 | $100,000 | Security |
| `0x0f` | 500 | $50,000 | Housekeeping |
| `0x11` | 1000 | $100,000 | SECOM |
| `0x12` | 5000 | $500,000 | Movie Theater |
| `0x14` | 5000 | $500,000 | Recycling Center |
| `0x16` | 50 | $5,000 | Stairs |
| `0x18` | 50 | $5,000 | Lobby |
| `0x1b` | 200 | $20,000 | Escalator |
| `0x1d` | 1000 | $100,000 | Party Hall |
| `0x1f` | 10000 | $1,000,000 | Metro Station |
| `0x24` | 30000 | $3,000,000 | Cathedral |
| `0x2a` | 4000 | $400,000 | Express Elevator shaft |
| `0x2b` | 1000 | $100,000 | Service Elevator shaft |
| `0x2c` | 500 | $50,000 | Parking Ramp |

## Floor Construction Premium

Recovered behavior:

- `g_lobby_height` is a saved tower parameter (1, 2, or 3) that defaults to `0` in `new_game_initializer` and is locked in to one of `{1, 2, 3}` on the player's first construction click; see `COMMANDS.md` for the selector and snap-back rules
- the lobby occupies floor 0, with `g_lobby_height - 1` additional atrium floors directly above it; the predicate `0 < floor < g_lobby_height` identifies the atrium floors above the lobby base
- floors strictly inside that atrium band use a premium floor-construction base cost instead of the normal floor-tile base cost
- the premium path multiplies the recovered high-band base rate by `g_lobby_height`, so a 2-floor lobby charges `premium_rate * 2` per tile on floor 1 and a 3-floor lobby charges `premium_rate * 3` per tile on floors 1 and 2
- the same parameter also affects special-link placement, fire ignition floors, the per-click commit count for lobby drag, and at least one family floor-class validator; see `COMMANDS.md` and `EVENTS.md`

## Family Payouts

Priced families use a per-family, per-variant payout table.

Division of responsibility:

- `ECONOMY.md` owns shared money semantics: units, ledger timing, booking checkpoints, cash caps, and infrastructure expenses
- facility-specific docs may own family-specific payout tables and booking triggers for their own lifecycles
- when a family-specific table is documented outside this file, `ECONOMY.md` should cross-reference it rather than duplicate it

Still required somewhere in the spec set:

- hotel stay payouts by room type and rent tier
- office recurring payouts by rent tier
- condo sale values and refunds by tier
- entertainment income by attendance tier

Cross-references:

- hotel room stay payouts: `facility/HOTEL.md`
- office rent payouts: `facility/OFFICE.md`
- condo sale/refund values: `facility/CONDO.md`
- retail-family priced payouts: `facility/COMMERCIAL.md`
- restaurant / fast-food closure-state income: `facility/COMMERCIAL.md`
- entertainment attendance/phase payouts: `facility/ENTERTAINMENT.md`

## Periodic Expenses

Periodic operating expenses charge:

- elevators
- service/security infrastructure
- medical/recycling/support facilities
- other infrastructure that contributes upkeep rather than direct income

These expenses are charged at the `0x09e5` ledger/expense checkpoint on the same 3-day cadence as ledger rollover, not continuously per tick.

Confirmed per-unit infrastructure expenses:

- Standard Elevator unit: `$10,000`
- Security office: `$20,000`
- Housekeeping: `$10,000`
- Recycling Center: `$50,000`
- Escalator-family special-link unit: `$5,000`
- Metro Station: `$100,000`
- Express Elevator unit: `$20,000`
- Service Elevator unit: `$10,000`
- Parking Ramp: `$10,000`

Binary-confirmed expense lookup rules:

- placed-object infrastructure expenses index YEN `#1002` directly by placed-object type
- carrier sweeps remap carrier mode to type `0x2a`, `0x01`, or `0x2b`, then multiply by carrier `unit_record_count`
- special-link sweeps charge either type `0x1b` or type `0x16`, scaled by `(unit_count >> 1) + 1`
- parking uses a separate parking-expense routine and is not a direct YEN `#1002` row lookup

Recovered special-link branch mapping:

- raw special-link records with low flag bit `0` charge as type `0x1b`
- raw special-link records with low flag bit `1` charge as type `0x16`
- the same low bit also controls route behavior: low-bit-`0` links are the local branch, and low-bit-`1` links are the express-only branch
- string and menu evidence confirms the player-facing labels separately: type `0x16` is `Stairs`, type `0x1b` is `Escalator`

Parking expense formula:

- periodic parking expense is `(right_tile_index - left_tile_index) * tier_rate / 10`
- `tier_rate` is selected from three startup tuning globals by current tower tier:
  - stars `< 3`: `0`
  - star `3`: `30`
  - stars `>= 4`: `100`
- these are `$100` units before the `/ 10` scaling step
- the resulting expense is recorded under expense ledger bucket `0x18`
- the charge is skipped for floor indices inside the excluded underground band `1 <= floor < lowest_floor_bound`

This naming-to-behavior inversion is strange, but it is no longer unresolved.

## Cashflow Activation

Cashflow is tied to family state transitions, not just to object existence.

Examples:

- hotel income is realized on checkout
- office income activates while open and deactivates when unpaired
- condo income is realized on sale and can later be reversed on refund
- commercial and entertainment families use derived records and attendance state

## Pricing Tiers

`rent_level` (placed-object offset `+0x16`) is the player-configurable pricing/rent
tier. The player sets it via the facility info dialog for priced families (3, 4, 5, 7,
9, 10). It indexes into the YEN #1001 payout resource table.

- `0`: highest price (tier 0) — readiness penalty `+30`
- `1`: default price (tier 1) — set at placement, no readiness modifier
- `2`: lower price (tier 2) — readiness bonus `-30`
- `3`: lowest price (tier 3) — forces readiness score to `0` (always passes)
- `4`: no payout / unpriced sentinel — set for all non-priced families

Condo (family 9) guard: rent level can only be changed while unsold (`unit_status >= 0x18`).
All other priced families allow changes at any time.

Changing rent level recomputes readiness and cashflow for the affected object.
