# Entertainment

Families `0x12` and `0x1d` are entertainment facilities.

## Role

Entertainment facilities use linked sidecar records and attendance tracking rather than simple per-object cashflow.

## Shared Behavior

- attendees are runtime actors
- attendance is counted across a cycle
- income is derived from attendance and phase
- the entertainment family ledger is rebuilt rather than purely incremented
- records track separate forward and reverse half-cycle budgets
- paired and single-link variants share the same checkpoint-driven phase machine

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

## Paired vs Single-Link

- one entertainment family uses paired structures
- the other uses a single-link structure

Both participate in the same broad phase-driven attendance and payout cycle.

Recovered link roles:

- family `0x12`: paired-link entertainment, with forward and reverse halves both active each day
- family `0x1d`: single-link entertainment, with a fixed reverse-half budget of `50`

## Cycle

1. runtime actors are activated in half-runtime passes
2. attendees route to the venue
3. attendance accumulates
4. facility phases advance during scheduled checkpoints
5. income rate is recomputed from the cycle state

Checkpoint-driven flow:

- `0x0f0`: rebuild family ledger, reset attendance counters, seed forward/reverse phase budgets, increment link age
- `0x03e8`: activate paired-link forward-half entities
- `0x04b0`: promote paired links to ready phase and activate single-link reverse-half entities
- `0x0578`: activate paired-link reverse-half entities that are still in phase `1`
- `0x05dc`: advance paired-link forward phase
- `0x0640`: advance reverse phase for both families, accrue cash income, then reset the link phase back to `0`

Phase budget rules:

- paired links use `link_age_counter / 3` to choose a budget tier
- selector `0..6` budgets: `40`, `40`, `40`, then `20`
- selector `7..13` budgets: `60`, `60`, `40`, then `20`
- single-link records always rebuild to `forward = 0`, `reverse = 50`

Runtime-state consequences:

- first arrival increments both `active_runtime_count` and `attendance_counter`
- link phase promotes from `1` to `2` on first arrival, then to `3` on the scheduled ready-phase checkpoint
- phase advance decrements the active-runtime count and routes attendees either back to the lobby or onward to commercial support depending on daypart and family
