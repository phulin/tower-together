# Hotel

Families `3`, `4`, and `5` are hotel rooms.

## Identity

- `3`: single room, population 1
- `4`: twin room, population 2
- `5`: suite, population 3

Income is realized on checkout, not continuously.

## Stay Payouts

Stay payout is determined by room family and `rent_level`:

| Family | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---|---:|---:|---:|---:|
| `3` single room | `$3,000` | `$2,000` | `$1,500` | `$500` |
| `4` twin room | `$4,500` | `$3,000` | `$2,000` | `$800` |
| `5` suite | `$9,000` | `$6,000` | `$4,000` | `$1,500` |

Default placement tier is `1`.

## Core Loop

1. assign a room to a guest actor
2. if the room was previously vacant, activate it
3. route the guest to the room
4. perform zero or more commercial trips from the room
5. synchronize sibling occupants when needed
6. route back to the lobby for checkout
7. realize income and return the room to a vacant band

## Key States

- routing to room
- resting in room
- routing to commercial venue
- at commercial venue
- sibling-sync wait
- checkout-ready
- routing to lobby
- pre-night preparation

Runtime-state bands:

- `0x20` / `0x60`: route to room
- `0x01` / `0x41`: rest in room, then route to commercial support
- `0x22` / `0x62`: at commercial venue, then route back
- `0x04`: sibling-sync wait
- `0x10`: checkout-ready
- `0x05` / `0x45`: checkout trip to lobby
- `0x26`: pre-night preparation / deferred re-entry

## `unit_status`

Hotel `unit_status` meanings:

- `0x00` / `0x08`: active occupied band, morning vs evening start
- `0x01..0x0f`: trip countdown
- `0x10`: sibling-sync sentinel
- `0x18..0x27`: vacant / available
- `0x28` / `0x30`: checked out, morning vs evening

## Activation And Checkout

Newly assigned guests initialize the room trip counter to `rand() % 13 + 2`, giving range `2..14` inclusive on both ends.

### Occupancy Flag

The room's occupancy latch is `pairing_pending_flag`. It is set to `1` by the housekeeping helper (family 0x0f) claimant at successful claim promotion and cleared at checkout by the deactivation path.

If the room is in a vacant band (`unit_status > 0x17`) when routing begins:

- activation resets `unit_status` to `0x00` in morning periods or `0x08` in evening periods
- the room is marked dirty
- the room contributes back into the population ledger
- the room remains active until checkout finishes

When the sync sentinel is consumed at state `0x10`:

- single room resets to `1`
- twin room resets to `2`
- suite resets to `2`

Checkout occurs when the countdown reaches zero.

Morning/evening behavior:

- newly assigned rooms start with a randomized trip counter in the active band
- morning check-in resets into the `0x00` band
- evening check-in resets into the `0x08` band
- successful outbound trips decrement the counter
- failures and bounces increment it
- checkout does **not** fire directly from the initial `0x00` / `0x08` activation values
- instead, the room first reaches the sibling-sync sentinel `0x10`; the checkout-counter dispatch then rewrites that sentinel to `1` for family `3` or `2` for families `4` and `5`
- the checkout-route handler decrements from that rewritten countdown, so the final checkout trigger is reached from `1 -> 0` (single room) or `2 -> 1 -> 0` (twin/suite)
- therefore the `unit_status & 7 == 0` test is consistent: it is checked only after the sync-sentinel rewrite has put the room into the explicit final countdown

## Sibling Sync

Multi-occupant rooms do not check out independently. They synchronize before the final checkout phase so a single room object yields one coherent stay lifecycle.

The sibling sync check fires `unit_status = 0x10` (sync sentinel) when:
- `unit_status & 7 == 1` (one-round shortcut — no sibling scan needed), OR
- all sibling entities are in entity state `0x10`

The one-round shortcut means: when the trip countdown reaches `1` in the low 3 bits, the sync sentinel is written immediately without checking other occupants. This is the fast path for the last trip.

### Sibling Reset Values

When the sync sentinel `0x10` is consumed by the checkout-counter dispatch:
- family `3` (single room): `unit_status = 1`
- family `4` (twin room): `unit_status = 2`
- family `5` (suite): `unit_status = 2`

These are the new trip countdown values for the next checkout cycle, not a separate field.

## Checkout Timing

Checkout-ready sync:

- sibling-sync wait dispatches only after late-day thresholds
- the object enters the `0x10` sync sentinel when all siblings are ready, with a one-round shortcut when `unit_status & 7 == 1`
- checkout routing decrements the shared trip counter and triggers payout as soon as the low three bits reach `0`
- the check-in band values `0x00` / `0x08` are not the values consumed by this final trigger; the checkout path always passes through the `0x10 -> 1/2` rewrite first

Detailed dispatch windows:

- room-rest state dispatches on a `1/6` cadence in daypart `4`, then always in later dayparts
- sibling-sync wait dispatches only when `daypart > 4` and either `day_tick > 2400` or the `12`-day reset condition is active
- checkout-ready dispatches while `daypart < 5`, or after `day_tick > 2566` on the `12`-day reset cadence
- pre-night preparation only resolves after `day_tick > 2300`

Lobby routing window:

- in daypart `0`, checkout dispatch is only allowed on 12-day-cycle reset days
- in daypart `6`, checkout routing is suppressed
- otherwise checkout routing is allowed normally

Checkout effects:

- payout is realized exactly once by the room object, using the family payout table and `rent_level`
- the checkout income handler increments `family345_sale_count` once per completed checkout
- that counter is cumulative only within the current day: checkpoint 1200 resets it to `0`
- checkout milestones set `newspaper_trigger = 1` on every 2nd checkout while `family345_sale_count < 20`, then on every 8th checkout thereafter
- morning checkout moves the room to `0x28`
- evening checkout moves the room to `0x30`
- the occupancy latch and activation counter are cleared so the room can be reassigned on a later cycle
