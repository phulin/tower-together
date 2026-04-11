# Entertainment

Party hall (`0x12`) and cinema (`0x1d`) are the entertainment families.

## High-Level Summary

Entertainment runs as a checkpoint-driven venue-cycle system built on a 16-slot sidecar table.

- Each entertainment placement allocates one venue record that points at one or two placed-object halves.
- At the daily checkpoint 240 rebuild, the game reseeds each record's per-half runtime budgets, increments venue age, and clears the active/attendance counters.
- Midday checkpoints activate one half of each venue by pushing the linked runtime actors into the entertainment family state machine.
- Successful arrivals increment both the active-attendee count and the total attendance count for that venue.
- Later checkpoints promote the venue into a ready phase, then drain the currently active attendees back out of the venue.
- When the reverse half completes, the game converts attendance into cash income, records the ledger effect, and resets the venue back to idle for the next day.

The two entertainment families share that same loop but differ in how they seed budgets and pay income:

- party hall (`0x12`) uses paired venues with age- and selector-based runtime budgets and attendance-tiered payouts
- cinema (`0x1d`) uses a single-venue record with a fixed runtime budget and a fixed nonzero-attendance payout

## Role

Entertainment facilities use a 16-slot sidecar table of entertainment venue records rather than simple per-object cashflow.

Venue records represent either a paired venue with forward/reverse halves, or a single-venue entry with only the reverse half populated.

## Shared Behavior

- attendees are runtime actors
- attendance is counted per venue record across a cycle
- paired and single-link variants share the same checkpoint-driven phase machine
- the sidecar record stores:
  - two anchor floors and subtype slots
  - two half-cycle runtime budgets
  - a shared `link_phase_state`
  - a random selector bucket for paired venues
  - an age counter, active-runtime counter, and attendance counter

## Cash Payouts

Movie-theater-family payout is attendance-tiered at phase completion:

| Attendance | Cash payout |
|---|---:|
| `< 40` | `$0` |
| `40..79` | `$2,000` |
| `80..99` | `$10,000` |
| `>= 100` | `$15,000` |

Single-link entertainment uses a fixed payout of `$20,000` per completed phase.

Population-ledger contribution is tracked separately from realized cash payout.

## Paired vs Single-Venue

- one entertainment family uses paired venue records
- the other uses a single-venue record

Both participate in the same broad phase-driven attendance and payout cycle.

Link roles:

- party hall (`0x12`): paired venue records, with forward and reverse halves both active each day
- cinema (`0x1d`): single-venue records, with `forward_runtime_phase = 0` and `reverse_runtime_phase = 50`

## Cycle

1. runtime actors are activated in half-runtime passes
2. attendees route to the venue
3. attendance accumulates
4. facility phases advance during scheduled checkpoints
5. income rate is recomputed from the cycle state

Checkpoint-driven flow:

- checkpoint 240: rebuild family ledger, reseed forward/reverse runtime budgets, increment venue age, clear pending/active/attendance counters
- checkpoint 1000: activate paired-link forward-half entities
- checkpoint 1200: promote paired links to ready phase and activate single-link reverse-half entities
- checkpoint 1400: activate paired-link reverse-half entities that are still in phase `1`
- checkpoint 1500: advance paired-link forward phase
- checkpoint 1600: advance reverse phase for both families, accrue cash income, then reset the link phase back to `0`

## Record Initialization

Fresh allocation zeroes the live cycle fields:

- `link_phase_state = 0`
- `forward_runtime_phase = 0`
- `reverse_runtime_phase = 0`
- `pending_transition_flag = 0`
- `link_age_counter = 0`
- `active_runtime_count = 0`
- `attendance_counter = 0`

Paired venues also roll a selector bucket at placement:

- if the placed object subtype is family `0x22` or `0x23`, `venue_selector = rand() % 14`
- otherwise `venue_selector` is set to a sentinel value treated as negative at runtime

Single-venue records store `venue_selector` as that same sentinel, which the runtime treats as negative.

## Runtime Budget Rules

Party hall (`0x12`) does not use a 14-step age table. The runtime applies two selectors:

- first, the paired-venue selector bucket:
  - `venue_selector < 7`: use the low-selector table `40, 40, 40, 20`
  - `venue_selector >= 7`: use the high-selector table `60, 60, 40, 20`
- second, the age tier:
  - `link_age_counter / 3 == 0`: use tier 0
  - `link_age_counter / 3 == 1`: use tier 1
  - `link_age_counter / 3 == 2`: use tier 2
  - `link_age_counter / 3 >= 3`: clamp to tier 3

This yields:

- ages `0..2`: tier 0
- ages `3..5`: tier 1
- ages `6..8`: tier 2
- ages `>= 9`: tier 3

Cinema (`0x1d`) always rebuilds to:

- `forward_runtime_phase = 0`
- `reverse_runtime_phase = 50`

`link_age_counter` starts at `0` on allocation and increments once per checkpoint 240 rebuild while `< 127`. It saturates at 127; it does not wrap.

`link_phase_state` meanings:

- `0`: idle
- `1`: half activated, no arrival yet
- `2`: at least one attendee arrived or the departure pass still has active attendees
- `3`: ready/completion phase

## Attendance And Income

Attendance is tracked directly on the venue record:

- each successful arrival into the entertainment destination increments both `active_runtime_count` and `attendance_counter`
- the first arrival also promotes `link_phase_state` from `1` to `2`
- the daily checkpoint 240 rebuild clears both counters back to `0`

Party hall (`0x12`) cash income uses attendance thresholds:

| Attendance | Income rate | Cash payout |
|---|---:|---:|
| `< 40` | `0` | `$0` |
| `40..79` | `20` | `$2,000` |
| `80..99` | `100` | `$10,000` |
| `>= 100` | `150` | `$15,000` |

Cinema (`0x1d`) ignores the attendance threshold table for actual payout:

- if `attendance_counter == 0`, payout is `$0`
- otherwise payout is fixed at `200` units = `$20,000`

The selected-object inspector still renders the party hall (`0x12`) attendance-derived rate via the shared threshold table.

## Phase Consequences

- first arrival increments both `active_runtime_count` and `attendance_counter`
- link phase promotes from `1` to `2` on first arrival, then to `3` on the scheduled ready-phase checkpoint
- the departure pass decrements `active_runtime_count` once per departing attendee whose runtime state is still `3`
- forward-half completion leaves `link_phase_state = 1` if all active attendees drained, otherwise `2`
- reverse-half completion resets `link_phase_state = 0`, accrues income for the family, and marks both halves dirty
