# Implementation Review Report

_Updated 2026-04-10 after the latest spec clarification pass._

## Summary

The codebase is still strongest in the structural simulation layers: placement, time,
carrier routing, checkpoint scheduling, and the general entity/runtime scaffolding are in
place. The latest spec diff mostly clarified naming and behavior inside Phase 4, and it
also resolved several review questions that should no longer be treated as open research.

This review updates the implementation status against those clarified specs.

## Newly Resolved Spec Questions

These items were open in the previous review but are now answered by the updated specs:

- Bomb deadline semantics: the event stores an absolute day tick (`1200`) on trigger, then
  reuses the same field for post-resolution cleanup timing.
- Fire tuning defaults: spread, vertical delay, helicopter sweep, rescue countdown, and
  rescue cost now have concrete recovered values.
- Queue-full elevator retry behavior: there is no retry cap; entities wait and then
  re-dispatch through normal route selection.
- Office-service evaluation: the 3-star gate now has documented trigger, state fields,
  and resolution flow.
- Cathedral evaluation targeting: the arrival recount behavior and return flow are now
  explicit.
- Commercial capacity override timing: the A/B/override slot selection is now specified.

## Implemented Or Updated

- Sim object/ledger terminology has been aligned with the newer spec naming in the worker
  and client inspection surfaces:
  `unitStatus`, `evalActiveFlag`, `evalLevel`, `rentLevel`,
  `populationLedger`, `incomeLedger`, `expenseLedger`.
- Snapshot normalization now migrates legacy saves that still serialize the older field
  names.
- Rent changes now reject sold condos, matching the clarified condo restriction.
- Shared support matching and support radii were updated toward the clarified facility
  evaluation model.
- Shared operational scoring now includes hotel families and the corrected suite divisor.
- The review no longer treats the resolved RE questions above as unresolved blockers.

## Remaining High-Priority Gaps

| Area | Status | Notes |
|---|---|---|
| Event prompts and player decisions | Partial | Prompt transport exists, but bomb/fire flows still do not fully match the clarified event behavior. |
| Office-service evaluation runtime | Partial | The gate is documented in spec, but the implementation still uses a simplified pass/fail sweep rather than the recovered target-entity lifecycle. |
| Cathedral evaluation | Partial | Entity scaffolding exists, but floor targeting and ledger/tier checks remain simplified versus the clarified spec. |
| Commercial venue model | Partial | Capacity seeds, zone-bucket selection, override lifecycle, and retail recurring cashflow are still not spec-faithful. |
| Parking demand/coverage lifecycle | Partial | Demand table lifecycle and delayed tombstone cleanup are not fully modeled. |
| Notification ordering and suppression | Minimal | Basic notifications exist, but the spec’s ordering and filtering rules are still largely absent. |

## Medium-Priority Gaps

| Area | Status | Notes |
|---|---|---|
| Security/fire integration | Partial | Fire rescue exists in outline, but the exact helicopter sweep timing and security countdown behavior still need validation against the new defaults. |
| Bomb/security patrol integration | Partial | Security patrol resolution is still simplified. |
| Hotel helper / claimant logic | Partial | Family `0x0f` behavior remains under-modeled. |
| Commercial-family readiness details | Partial | The separate commercial readiness thresholds and rent modifiers are not yet fully represented. |
| Population-ledger fidelity | Approximate | The code now uses the new ledger names, but contribution timing/counting is still simplified in several families. |

## Recommended Next Steps

1. Replace the simplified office-service evaluation with the documented target-entity
   workflow.
2. Bring bomb/fire timing and prompt handling in line with the clarified event fields and
   recovered defaults.
3. Finish the commercial venue subsystem using the now-documented bucket, override, and
   closure rules.
4. Tighten population-ledger contribution rules so star/security logic stops relying on
   approximations.
