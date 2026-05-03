# Evaluation

This document specifies the cathedral evaluation path that awards Tower rank.
Addresses are from the recovered Windows binary.

## Building

The build menu uses a cathedral anchor (`0x21`) that dispatches to
`place_cathedral_stack` at `1200:2347`. The stack helper places five object
slices with type codes `0x24..0x28`; these slices are the sim-visible
cathedral objects.

Placement is singleton-gated by `g_eval_entity_index >= 0`. Once the type
`0x28` slice is rebuilt, `recompute_object_runtime_links_by_type`
(`1230:0103`) writes `g_eval_entity_index`. This global is a placed-object
lookup/index, not a runtime sim index.

The recovered slice width is 28 tiles. The construction cost is YEN-family
`0x24` = `30000` cash units = `$3,000,000`.

## Runtime Sims

Each cathedral slice has span size 8, for 40 evaluation visitors total. The
object types remain `0x24..0x28`, but the runtime sim family byte initialized
by `initialize_runtime_entities_for_type_parking` is `0x24` for every
visitor. Initial state is `0x27` parked.

Day-start activation runs from `activate_cathedral_evaluation_entities`
(`1048:0000`) at scheduler checkpoint `day_tick == 0`. It gates only on
`g_eval_entity_index >= 0`, flushes pending object rebuilds, sweeps raw floors
`0x6d..0x77`, finds object types `0x24..0x28`, and forces each slice's 8 sims
to state `0x20`. There is no `star_count > 2` activation gate in the binary.

## State Machine

Cathedral visitors use `gate_object_family_parking_state_handler`
(`1228:5b5a`) and `dispatch_object_family_parking_state_handler`
(`1228:5cd2`). The dispatch jump table at `1228:5f29` has four state entries:
`0x20`, `0x60`, `0x05`, and `0x45`.

State `0x20` requires `g_weekend_flag == 1`. During daypart 0, ticks
`> 0x50` consume RNG and dispatch on `rand % 12 == 0`; ticks `> 0xf0` then
dispatch unconditionally as a second check in the same invocation. If daypart
has advanced to `>= 1`, the sim parks to `0x27`.

Outbound route handler `1228:5ddd` routes fresh `0x20` sims from raw floor
`10` to raw floor `0x6d` (109). Retry/in-transit state `0x60` routes from the
sim's stored origin floor to `0x6d`. Results `0/1/2` set `0x60`, result `3`
sets `0x03` and runs arrival processing, and failure sets `0x27`.

Midday return is `dispatch_evaluation_sim_midday_return` (`1048:0179`) at
checkpoint `0x04b0` (1200). It sweeps the cathedral object range, clears each
slice aux field to `0`, marks it dirty, and changes sims in state `0x03` to
`0x05`.

Return route handler `1228:5e7e` routes fresh `0x05` sims from raw floor
`0x6d` to raw floor `10`. Retry/in-transit state `0x45` routes from the sim's
stored origin floor to raw floor `10`. Results `0/1/2` set `0x45`; result `3`
or failure parks to `0x27`.

## Award Check

Arrival processing is `process_family_parking_destination_arrival`
(`1048:00f0`). It runs only when `g_eval_entity_index >= 0` and
`g_day_tick < 800`.

`check_all_evaluation_entities_arrived` (`1048:03bb`) first requires
`compute_tower_tier_from_ledger() > g_star_count`. It then recounts the
cathedral sweep fresh: object types `0x24..0x28` on raw floors `0x6d..0x77`,
8 sims per object, counting only state `0x03`. It returns true only when the
count is exactly `40`.

If not all visitors have arrived, arrival processing writes aux value `3` to
the `g_eval_entity_index` object and marks it dirty. If all 40 have arrived,
`award_star_rating_upgrade` (`1048:02b5`) sets Tower rank unless
`g_star_count == 6`, plays popup/sound `0x2718`, and marks all cathedral
objects aux `2`, dirty `1`.

Normal star advancement cannot award Tower rank: `check_star_advancement_conditions`
returns false at `star_count == 5`; rank 6 is reached through this path only.
