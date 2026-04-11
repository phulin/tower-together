# Office

Family `7` is the office family.

## Identity

- population: 6 workers
- recurring positive cashflow while operational
- workers generate fast-food demand during their trip cycle

## Rent Payouts

Office payout per activation is determined by `rent_level`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$15,000` | `$10,000` | `$5,000` | `$2,000` |

Default placement tier is `1`.

## Readiness Scoring

Office readiness is computed from:

- per-tile activity average across the office span
- rent-tier modifier
- support-search penalty when nearby support is missing

The result maps into the shared readiness grades `2`, `1`, or `0`.

## Activation And Deactivation

Open offices:

- contribute to the population ledger
- realize cashflow on the 3-day activation sweep and again on worker-arrival reopen paths
- increment `activation_tick_count`

Deactivated offices:

- move into a deactivated `unit_status` band
- clear readiness latch state
- clear activation tick count
- stop contributing recurring cashflow

Operational status and pairing:

- office readiness is recomputed by the shared `recompute_object_operational_status` path used by families `7`, `9`, and `10`
- the recomputed `pairing_state` byte is a 3-level operational grade, not just a boolean paired/unpaired flag:
  - `0`: unpaired / failed readiness
  - `1`: operational but only in the lower passing band
  - `2`: strong readiness, waiting to pair with another same-family unit on the floor
- the companion `pairing_active_flag` latches whether the office has entered a successful operational pairing and is used by the vacancy-expiry path
- the score thresholds feeding `pairing_state` are star-rating dependent shared thresholds, so office operational grade tightens as the tower star rating rises

Exact open/closed bands:

- `0x00..0x0f`: open / active
- `0x10`: deactivated in early-day regime
- `0x18`: deactivated in late-day regime

Activation cadence:

- `recompute_object_operational_status` runs every day
- office activation and deactivation cashflow changes only run on the `day_counter % 3 == 0` cadence at the daily sweep. Because the sweep runs after the day-counter increment, a fresh game first hits this cadence at `day_counter == 3`, not day 0.
- activation increments `activation_tick_count` up to a cap of 120. This is cumulative, not per-day — it saturates at 120 and resets to 0 only on deactivation. It feeds into readiness scoring but is not consumed by any discrete trigger.
- fresh reopen after a close resets `unit_status` to `0`, adds `+6` to the population ledger, and refreshes the 6-tile span

Deactivation trigger:

- if `eval_level == 0` and the office is still in the active band, deactivation clears `eval_active_flag`
- deactivation resets `activation_tick_count`
- deactivation subtracts the office's recurring contribution from cash and removes `6` from the population ledger
- after a deactivation, the same-floor scan (`attempt_pairing_with_floor_neighbor`) may immediately re-pair it with a same-floor, same-family slot whose `pairing_state == 2`
- a successful match promotes both offices to `pairing_state == 1`, sets `pairing_active_flag`, and refreshes the office span
- if `pairing_state >= 1` when the pairing helper runs, the helper does not search; it just asserts `pairing_active_flag` and refreshes
- this pairing logic is shared with families `9` and `10`, but for offices it affects the recurring activation/deactivation economy path, not the worker trip-state routing

## Worker Loop

Workers alternate between:

- idle/working in the office
- routing to a venue
- dwelling at the venue
- routing back

Workers are staggered by `occupant_index`, which is the worker's zero-based slot index within the 6-worker office runtime group (values `0..5`).

Worker-cycle timing:

- idle state dispatches probabilistically in early dayparts, then more aggressively through the workday
- support-trip states stop dispatching once late-day cutoff handling begins
- venue dwell uses a fixed 16-tick hold before the return leg can start
- workers use the shared route queue / commercial-slot pipeline, with `0x4x` as in-transit aliases and `0x6x` as at-work aliases

Gate table:

- `0x00`: dayparts `1..3` dispatch; daypart `0` dispatches on a `1/12` chance; daypart `>= 4` gives up and switches to `0x05`
- `0x01` and `0x02`: dayparts `2..3` dispatch; daypart `1` dispatches on a `1/12` chance; daypart `0` waits; daypart `>= 4` switches to `0x05`
- `0x05`: daypart `4` dispatches on a `1/6` chance; later dayparts always dispatch
- `0x20`: blocked when `calendar_phase_flag != 0`; otherwise requires `eval_active_flag != 0`; daypart `0` dispatches on a `1/12` chance, dayparts `1..2` dispatch, and daypart `>= 3` also dispatches
- `0x21`: daypart `3` dispatches on a `1/12` chance; daypart `>= 4` dispatches; earlier dayparts wait
- `0x22` and `0x23`: dayparts `2..3` dispatch; daypart `>= 4` forces `0x27` and releases the service request
- `0x25`, `0x26`, and `0x27`: remain parked until `day_tick > 2300`, then return to `0x20`

Dispatch table:

- `0x00` / `0x40`: route from lobby floor `0` to the assigned office floor; queued or en-route results stay in `0x40`, same-floor arrival becomes `0x21`, and failure becomes `0x26`
- `0x01` / `0x41`: route from office to a commercial venue; failure returns to `0x26` and releases the service request
- `0x02` / `0x42`: continue commercial transit toward the saved floor-zone index; same-floor arrival tries to claim the office slot and either enters `0x23` or keeps waiting
- `0x05` / `0x45`: route from the office floor back to lobby floor `0`; queued and en-route results stay in `0x45`, failure becomes `0x26`
- `0x20` / `0x60`: assign a service request destination on first entry, then route to the assigned floor; queued or en-route results continue through `0x40`, same-floor arrival becomes `0x21`
- `0x21` / `0x61`: route either to lobby or the saved floor, then advance the worker trip counter on same-floor arrival
- `0x22` / `0x62`: release the commercial slot, route home, and advance the trip counter on same-floor arrival
- `0x23` / `0x63`: enforce the 16-tick dwell, then route to the saved target; on same-floor arrival the next state is `0x00` for `occupant_index == 1`, otherwise `0x05`

The office workers use the same shared service-request entry mechanism as hotel guests.
