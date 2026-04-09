# Routing / Transport Open Questions

Questions for the original `SIMTOWER.EX_` binary (Ghidra project `analysis-2825a3c53f`) that need answers to push the clean-room transport simulation past its current ~70% behavioral parity. Each question is meant to be answerable from a single Ghidra session.

Companion to `ROUTING.md` (which captures what we already know) and `SPEC.md` (the full reverse-engineered behavior spec).

## A. Carrier scoring constants

1. In `find_best_available_car_for_floor`, what is the exact cost formula for the **moving / same-direction** bucket? We're guessing `distance + pendingAssignments*8 + (sameDirection ? 0 : 8)`. What are the real weights?
2. What is the exact tie-break threshold value at `carrier_header[+0x12]` (the "waiting car response" byte)? Is it a constant per carrier mode, or set from save data?
3. For the **idle-home** bucket, is the score literally `|currentFloor − requestFloor|`, or does it include any other terms (e.g. penalties for crossing transfer floors)?
4. When two cars tie *within* the same bucket, what is the secondary tie-break? Lowest car index? Closest to home?

## B. Route-segment scoring

5. In `score_local_route_segment`, what is the actual cost formula? We use `delta*8` for stairs and `delta*8 + 0x280` for escalators. What are the real per-floor cost and the escalator surcharge?
6. Same question for `score_express_route_segment` — what does the binary's express scorer add on top of `delta * something`?
7. In `score_carrier_direct_route` / `score_carrier_transfer_route`, what are the real "queue full" penalty (we use `1000` / `6000`) and the base carrier-route surcharge (we use `0x280` / `3000`)?
8. Is there a "no available car" extra penalty, or does the route just become unreachable when all cars are saturated?

## C. Tick budgets / motion timing

9. In `advance_carrier_car_state` (the per-tick speed counter), what value is the speed counter reset to after each step for **mode 0/1 (local)** carriers? We use `8`.
10. Same question for **mode 2 (express)** carriers. We use `4`.
11. In `compute_car_motion_mode`, the modes returned (0/1/2/3) are correct per ROUTING.md. But what does the binary then load into `door_wait_counter` for **motion mode 2**? We currently leave it at 0 and just step normally — is that right, or is there a small wait?
12. For motion mode 3 (the "long-hop" 3-floor jump), is the jump literally 3 floors per step, or is it modulated by anything (e.g. clamped at the next transfer floor)?
13. What is the exact `DEPARTURE_SEQUENCE_TICKS` value? We use `5`. Is this what gets stamped into `door_wait_counter` after arrival, and is it the same value used for the initial post-pickup launch?

## D. Dwell multiplier and schedule-enable byte arrays

14. The `dwell_multiplier` array at `carrier_header[+0x20 + phase*7 + daypart]` — where in the binary's init / save-load path do these 14 bytes get populated? Are they read from the save file, computed from carrier mode, or hardcoded per shaft?
15. Same question for the schedule-enable array at `+0x2e + phase*7 + daypart`.
16. Is there a separate "served floor" array (`servedFloorFlags` in our `world.ts`, currently 14 entries defaulting to 1)? Or is that the same as one of the above?
17. What's the actual lookup that turns `(calendar_phase, daypart)` into the array index — is it literally `phase * 7 + daypart`, or does the binary do something with the rest day / calendar wrap?

## E. Custom family selectors

18. What is the exact behavior of `assign_request_to_runtime_route` for family `0x0f`? (And what placed-object types map to family `0x0f`?)
19. Same for family `0x12`.
20. Same for family `0x1d`.
21. Same for family `0x21`.
22. Same for family `0x24`.
23. Do any of the custom selectors filter out certain carriers (e.g. service-only, mode 2 only) or certain segment types (e.g. escalator-only)?

## F. Entity in-transit state machine

24. After `resolve_entity_route_between_floors` returns `1` (direct special-link leg) and stamps `entity[+7] = post-link-floor` and `entity[+8] = segment_index`, what is the family handler's per-tick behavior **during** the leg? Does it count down a per-tick walk timer, or jump to the destination on the next family tick?
25. If yes to a walk timer: where is it stored on the entity? How many ticks per floor for stairs vs escalator?
26. After the leg completes, who clears `entity[+7]` and `[+8]`, and what state code does the entity transition to?
27. For carrier-queued entities (return code `2`), the entity's `[+7]` is the source floor. While waiting in the queue, what state code is the entity in? Does the family handler do anything per-tick during that wait, or is it purely passive until the carrier picks up?
28. When the carrier arrives at the entity's destination and `dispatch_destination_queue_entries` rewrites `entity[+7] = destination_floor`, exactly which family-handler entry point does it call, and with what arguments?

## G. Reachability mask rebuild

29. The 4-step rebuild in ROUTING.md §"Exact rebuild of one derived record's `reachability_masks_by_floor[120]`" — can you confirm step 4's outside-span branch is exactly "set carrier bit `n` if carrier `n` serves this floor; set peer special-link bit `24+m` if record `m` spans this floor", with no additional masking by the original aggregate?
30. Inside-span: is `transfer_group_index + 1` *always* preferred over the projected mask when both apply to the same floor, or only when the floor is exactly the `tagged_floor`?

## H. Multi-leg routing

31. If the best route from A→B requires two carriers chained at a transfer floor, does `assign_request_to_runtime_route` queue **both** legs upfront, or does it queue only the first leg and re-resolve when the entity arrives at the transfer floor?
32. If chained, where is the second leg's destination stored on the entity during the first leg?
33. Does the binary ever route a single trip through two *segments* (e.g. stairs A → walk → stairs B)? Or is segment routing always a single segment per leg?

## I. Queue / slot edge cases

34. When `0x28` (queue-full sentinel) is written into a per-floor assignment byte, what wakes it back up? Is there a sweep that resets it on dequeue, or does it stay `0x28` until the next `sync_assignment_status`-equivalent rebuild?
35. For the per-car active slot table (42 physical / 21 logical for non-express): what triggers the express-mode `0x2a` capacity to be used? Is `assignment_capacity` literally `mode == 0 ? 0x2a : 0x15`, or does it depend on something else (e.g. the express overlay flag on the segment, or a header byte)?
36. When an entity is sitting in a per-floor queue and the carrier serving that floor gets demolished, what happens to the entity? Does the binary have a cleanup pass, or does the entity just leak?

## J. Special-link load counters

37. Where exactly are `descending_load_counter` and `ascending_load_counter` (segment bytes `+6..+9`) incremented? Are they per-entity-pass, per-tick, or only per departure?
38. Do they get cleared at end-of-day, or do they monotonically increase?
39. Does any other system (scoring, reporting, AI) actually *read* these counters, or are they purely a stat?

---

## Suggested attack order

1. **C — tick budgets.** Concrete numbers, unlocks visible-correctness of carrier motion.
2. **A / B — scoring constants.** Concrete numbers, unblocks correct car/route selection.
3. **D — schedule arrays.** Per-daypart behavior is currently flat; this fixes that.
4. **F — in-transit state machine.** Pins down the multi-tick semantics of segment legs and queue waits.
5. **E — custom selectors.** Biggest unknown, but only matters once we add the relevant entity families.

G, H, I, and J can be addressed opportunistically; none of them block current sim behavior.
