# Routing / Elevator Subsystem: Binary Map and TS Restructuring Plan

Combined analysis of the SimTower binary's routing + elevator code, the current
TypeScript implementation, and a proposed function-for-function restructuring.

Sources:
- Static analysis of `SIMTOWER.EX_` via pyghidra (project `2825a3c53f`).
- The specs under `specs/` (notably `ROUTING.md`, `ELEVATORS.md`,
  `DATA-MODEL.md`, `PEOPLE.md`).
- Current TS code under `apps/worker/src/sim/`.

---

## 1. Top-level tick flow into routing/elevator subsystems

Windows 3.1 main message loop drops into an idle-pass that drives the sim:

```
1268:0013  run_main_message_loop                    // Win16 PEEKMESSAGE/DISPATCHMESSAGE
 └─ 1268:01a6  service_idle_tasks                   // between messages
     ├─ 1208:0196  run_simulation_day_scheduler     // advances g_day_tick, fires checkpoints
     │   └─ checkpoint dispatch on g_day_tick:
     │        0x000  start-of-day
     │        0x020  recycling reset
     │        0x0f0  facility ledger rebuild, fire/bomb random rolls
     │        0x3e8  entertainment half-1
     │        0x4b0  hotel sale reset, cathedral midday dispatch
     │        0x578  entertainment half-2
     │        0x640  restaurants/hotel/unit-status midday
     │        0x6a4  afternoon notification
     │        0x708  (noop)
     │        0x76c  (reserved paired link)
     │        0x7d0  close retail/fast-food
     │        0x898  close restaurants
     │        0x8fc  day counter ++
     │        0x9c4  rebuild_all_sim_tile_spans, reset_sim_runtime_state,
     │                dispatch_active_requests_by_family
     │        0x9e5  ledger rollover
     │        0x9f6  end-of-day (clears carrier queues etc.)
     │        0xa06  recycling final
     └─ 1098:03ab  carrier_tick                     // the elevator + sim driver
         ├─ FUN_11f8_0211                           // pending-object rebuild pass
         ├─ check_and_advance_star_rating
         ├─ if !(g_star_rating_flags & 9):
         │     1228:0d64  refresh_runtime_entities_for_tick_stride
         │         └─ for i = g_day_tick%16; i < g_sim_count; i += 16:
         │             dispatch by sim_table[i].family_code
         │                (hotel/office/condo/retail/restaurant/fast-food/
         │                 housekeeping/entertainment/recycling/parking)
         ├─ if (g_day_tick % 16 == 0): FUN_1088_0a07  // cashflow
         ├─ for carrier=0..23:
         │     for car=0..7 if active:
         │       1098:06fb  advance_carrier_car_state(carrier, car)
         │     for each active car:
         │       1218:07a6  dispatch_carrier_car_arrivals
         │       1218:0351  process_unit_travel_queue     // queue drain
         ├─ FUN_10c8_002e                              // special-link refresh
         ├─ if dirty: 1098:0cb3 FUN_1098_0cb3          // dirty-car post-pass
         ├─ render bomb/fire/helper overlays
         ├─ per-carrier: 1098:0b10 decrement_car_pending_assignment_count
         └─ render clock widget + UI refresh
```

Key invariant: **sim-entity refresh (`refresh_runtime_entities_for_tick_stride`)
runs BEFORE per-car physics every tick**, all inside `carrier_tick`.
Checkpoint-driven work in `run_simulation_day_scheduler` runs first, ahead of
both.

There is also an accelerated tick path at `10f8:0318` (sandbox / fast-forward)
that reruns the three per-car functions in a loop, inflating `g_day_tick` by
`2 * *(int *)0xe5ec`, then snapshot-restores the carrier record.

---

## 2. Global data structures

All globals live in DGROUP (`1288:...`).

### 2.1 `CarrierRouteRecordHeader` — 914 bytes × 24 carriers @ `1288:c05a`

```
+0x00    byte     is_active
+0x01    byte     carrier_mode             // 0=express, 1=standard, 2=service
+0x02    byte     assignment_capacity      // 0x2a (express=42) or 0x15 (21)
+0x03    byte     unit_record_count        // # cars (1..8)
+0x04..0x3b       per-daypart dispatch parameters (indexed daypart*7 + weekend)
                  relevant slots:
                    [-0x14] dwell multiplier (should_car_depart)
                    [-0x22] ??? priority weight (advance_carrier_car_state)
                    [-0x30] moving-vs-idle tiebreaker
                  byte at 0x12 = moving_vs_idle_cost_threshold
+0x3c    ushort   reserved_height_bound
+0x3e    ushort   height_metric            // pixels / distance metric
+0x40    byte     top_served_floor
+0x41    byte     bottom_served_floor
+0x42    byte[120] served_floor_flags
+0xc2    dword[120] reachability_masks_by_floor   // transfer-group mask
+0x2a2   byte[120] primary_route_status_by_floor  // up-call assignment (car+1)
+0x31a   byte[120] secondary_route_status_by_floor // down-call assignment
(total 0x392 = 914)
```

After the header, `carrier[0xb]` indexes per-car records (stride `0x15a = 346`,
see §2.3). `carrier[1]` indexes per-floor route queues (stride `0x144 = 324`,
see §2.2).

### 2.2 `TowerRouteQueueRecord` — 324 bytes per floor-slot

```
+0x00    byte      up_queue_count           // 0..40; resolver rejects enqueue at 40
+0x01    byte      up_queue_head_index
+0x02    byte      down_queue_count
+0x03    byte      down_queue_head_index
+0x04    dword[40] up_queue_request_refs    // 160 bytes
+0xa4    dword[40] down_queue_request_refs  // 160 bytes
```

Enqueue writes to `(head+count)%40`. The enqueue function itself has no
capacity guard — if called at `count==40`, `(head+40)%40==head` and it would
clobber the head entry, then increment count to 41. In practice this never
happens: `resolve_sim_route_between_floors` checks `count==40` upstream and
returns 0 (queue-full) without invoking enqueue.

### 2.3 `TowerUnitRouteRecord` — 346 bytes per car

```
+0x00    byte      source_floor                 ([-0x5e] current_floor window)
+0x01    byte      door_wait_countdown           // settle: stop=5, slow=2
+0x02    byte      boarding_countdown            // dwell: 5=arrived, 1=boarding
+0x03    byte      assigned_count                // on-board rider count
+0x04    byte      direction_flag                // 0=down, 1=up
+0x05    byte      target_floor
+0x06    byte      previous_stop_floor
+0x07    byte      first_stop_after_idle_flag
+0x08    dword     departure_timestamp           // day_tick at departure start
+0x0a    dword     pending_assignment_count      // pending floor-calls
+0x0e    byte      pending_destination_count     // # floors with queued riders
+0x0f    byte      nearest_work_floor            // fallback idle target
+0x10    byte      scheduling_flag               // 0=bidir 1=up 2=down
+0x11    byte      is_active                     // slot occupied
+0x12    dword[42] active_request_refs           // 168 bytes
+0xba    byte[42]  slot_destination_floors       // 0xff = free
+0xe2    byte[120] destination_request_counts    // per-floor count
(total 0x15a = 346)
```

### 2.4 `SpecialLinkRouteRecord` — 484 bytes × 8 @ `1288:???`

```
+0x01    byte      is_active
+0x02    byte      top_floor
+0x03    byte      bottom_floor
+0x04    dword[120] reachability_masks_by_floor  // bits 0..23=carriers, 24..31=peer links
```

### 2.5 `SpecialLinkSegmentEntry` — 10 bytes × 64 @ `1288:c5e4`

```
+0x00    byte      mode_and_span   // bit 0 = stairs-cost parity, bits 7:1 = span
+0x02    ushort    height_metric
...
```

Walked floor delta = `((mode_and_span >> 1) + 1)`. Bit 0: escalator(0) vs
stairs(1). Stairs adds 640 to escalator base cost.

### 2.6 `SimRecord` — 16 bytes @ `g_sim_table` (`1288:c04e`)

```
+0x00    byte      object_floor_index
+0x01    byte      object_subtype_index
+0x02    ushort    object_base_offset
+0x04    byte      family_code              // 3..36
+0x05    byte      state_code               // bit6=0x40 in-transit, bit5=0x20 waiting
+0x06    byte      selected_floor / facility slot
+0x07    byte      origin_floor / selector
+0x08    byte      encoded_route_target     // <0x40 special-link idx,
                                            //  +0x40 carrier idx (up),
                                            //  +0x58 carrier idx (down)
+0x09    byte      aux_state_byte
+0x0a    ushort    route_enqueue_tick       // day_tick at enqueue
+0x0c    ushort    accumulated_delay (elapsed packed)
+0x0e    ushort    aux_counter_word
```

Sim index `i` → entry at `g_sim_table + (i << 4)`.

### 2.7 Clock / scalars

| Addr         | Name                          |
|--------------|-------------------------------|
| `1288:bc52`  | `g_day_tick` (word, 0..0xa27) |
| `1288:bb8b`  | `g_daypart_index` (byte)      |
| `1288:bc54`  | `g_day_counter` (long)        |
| `1288:bb8a`  | `g_weekend_flag` (byte)       |
| `1288:39a4`  | dirty/repaint flag            |
| `1288:bc76`  | `g_active_request_count`      |
| `1288:e558`  | `g_active_request_table`      |
| `1288:d784`  | `g_floor_walkability_flags`   |

### 2.8 Route parameter table (`1288:e5ee`)

| Addr        | Name                               | Value |
|-------------|------------------------------------|-------|
| `1288:e5f0` | `g_waiting_state_delay`            | 5     |
| `1288:e5f2` | `g_requeue_failure_delay`          | 0     |
| `1288:e5f4` | `g_route_failure_delay`            | 300   |
| `1288:e5f6` | `g_venue_unavailable_delay`        |       |
| `1288:e62c` | `g_per_stop_even_parity_delay`     |       |
| `1288:e62e` | `g_per_stop_odd_parity_delay`      |       |

---

## 3. Per-function map

Addresses use the segmented `SEG:OFFSET` form.

### 3.1 Tick driver

| Addr          | Name                                   | Summary                                                    |
|---------------|----------------------------------------|------------------------------------------------------------|
| `1208:0196`   | `run_simulation_day_scheduler`         | Advances `g_day_tick`, fires checkpoint handlers.          |
| `1268:01a6`   | `service_idle_tasks`                   | Win16 idle pass: scheduler + `carrier_tick`.               |
| `1098:03ab`   | `carrier_tick`                         | Per-tick driver: stride refresh + per-car loop + UI.       |
| `10f8:0318`   | `fast_carrier_tick`                    | Snapshot/restore fast-forward loop over carriers.          |
| `1228:0d64`   | `refresh_runtime_entities_for_tick_stride` | 1/16 stride over `g_sim_table`, dispatch by family.    |
| `1190:0977`   | `dispatch_active_requests_by_family`   | Fires once/day at checkpoint 0x9c4 to drain stuck reqs.    |

### 3.2 Elevator car state machine

| Addr          | Name                                   | Summary                                                    |
|---------------|----------------------------------------|------------------------------------------------------------|
| `1098:06fb`   | `advance_carrier_car_state`            | Per-tick car step; three-way branch on settle/dwell.       |
| `1098:10e4`   | `advance_car_position_one_step`        | Steps ±1 or ±3 floors; seeds settle per mode.              |
| `1098:0bcf`   | `recompute_car_target_and_direction`   | Chooses next target via `select_next_target_floor`.        |
| `1098:1553`   | `select_next_target_floor`             | Bidirectional sweep with schedule_flag bias.               |
| `1098:1d2f`   | `update_car_direction_flag`            | Flips/updates direction at endpoints.                      |
| `1098:1f4c`   | `find_nearest_work_floor`              | Fallback target when no pending assignments.               |
| `1098:209f`   | `compute_car_motion_mode`              | 0=stop,1=slow,2=normal,3=fast (express only).              |
| `1098:23a5`   | `should_car_depart`                    | Capacity/schedule/dwell-timeout gate.                      |
| `1098:0a4c`   | `assign_car_to_floor_request`          | Writes `primary/secondary_route_status_by_floor[f]=car+1`. |
| `1098:0dfc`   | `find_best_available_car_for_floor`    | 4-class car selector (idle-home/forward/wrap/degenerate).  |
| `1098:0b10`   | `decrement_car_pending_assignment_count` | Post-arrival decrement + hooks.                          |
| `1098:13cc`   | `clear_floor_requests_on_arrival`      | Clears up+down status bytes for current floor.             |
| `1098:12c9`   | `cancel_stale_floor_assignment`        | Clears request on floor car no longer serves.              |
| `1098:0192`   | `reset_out_of_range_car`               | Forces car home when target out of bounds.                 |

### 3.3 Route queue + arrival dispatch

| Addr          | Name                                   | Summary                                                    |
|---------------|----------------------------------------|------------------------------------------------------------|
| `1218:0000`   | `resolve_sim_route_between_floors`     | Returns: -1 no route, 0 queue-full, 1 direct, 2 enqueue, 3 same-floor. |
| `1218:0351`   | `process_unit_travel_queue`            | Per-car queue drain from floor rings.                      |
| `1218:0883`   | `dispatch_destination_queue_entries`   | Arrival scanner: writes new floor, dispatches by family.   |
| `1218:07a6`   | `dispatch_carrier_car_arrivals`        | Gate on `dwell==5` then call `dispatch_destination_queue_entries`. |
| `1218:1002`   | `enqueue_request_into_route_queue`     | Writes ref to ring; first enqueue triggers `assign_car_to_floor_request`. |
| `1218:1172`   | `pop_unit_queue_request`               | Pops ring head, `reduce_elapsed_for_lobby_boarding`.       |
| `1218:0d4e`   | `assign_request_to_runtime_route`      | Moves popped req from ring into car's active slot.         |
| `1218:142a`   | `remove_request_from_unit_queue`       | Scans ring for matching ref.                               |
| `1218:173a`   | `remove_request_from_active_route_slots` | Clears slot and recomputes target.                       |
| `1218:187b`   | `store_request_in_active_route_slot`   | Writes into first free slot.                               |
| `1218:1905`   | `pop_active_route_slot_request`        | Slot consumer at arrival.                                  |
| `1218:0fc4`   | `decrement_route_queue_direction_load` | Called on state transition out of queued/waiting.          |
| `1218:1981`   | `dispatch_queued_route_until_request`  | Drains queue until a specific ref.                         |
| `1218:1a86`   | `cancel_runtime_route_request`         | Full cancel: ring + slots + timestamps.                    |
| `1218:1b96`   | `decode_runtime_route_target`          | Decodes `encoded_route_target` → (slot, direction).        |

### 3.4 Reachability + route scoring (segment 11b8)

| Addr          | Name                                   | Summary                                                    |
|---------------|----------------------------------------|------------------------------------------------------------|
| `11b8:00f2`   | `rebuild_route_reachability_tables`    | Rebuilds per-floor transfer-group bits.                    |
| `11b8:049f`   | `rebuild_transfer_group_cache`         | Flood-fill across carrier + special-link graph.            |
| `11b8:0000`   | `clear_route_reachability_tables`      | Zero reachability.                                         |
| `11b8:006d`   | `clear_transfer_group_cache`           | Zero group cache.                                          |
| `11b8:06a4`   | `rebuild_special_link_route_records`   | Rebuild 8 special-link records on stairs/escalator edit.   |
| `11b8:0763`   | `scan_special_link_span_bound`         | Walks span to find top/bottom floor.                       |
| `11b8:1484`   | `select_best_route_candidate`          | Main scorer: local/express/carrier/special-link.           |
| `11b8:0be2`   | `score_special_link_route`             | Cost for stairs/escalator link.                            |
| `11b8:168e`   | `score_carrier_transfer_route`         | Cost for elevator with transfer stop.                      |
| `11b8:18fb`   | `score_local_route_segment`            | Cost for same-segment walk.                                |
| `11b8:19a8`   | `score_housekeeping_route_segment`     | Cost for stairs-only segment (housekeeping path).          |
| `11b8:12d2`   | `is_floor_span_walkable_for_local_route`       | Geometric gate (escalator-tolerant).               |
| `11b8:1392`   | `is_floor_span_walkable_for_housekeeping_route`| Geometric gate (continuous stairs).                |
| `11b8:0ccf`   | `is_floor_within_special_link_span`    | Membership test.                                           |
| `11b8:0f33`   | `test_carrier_transfer_reachability`   | Bit test on reachability mask.                             |
| `11b8:0fe6`   | `test_special_link_transfer_reachability` | Same, for peer link records.                           |
| `11b8:0e41`   | `choose_transfer_floor_from_carrier_reachability` | Picks intermediate transfer floor.              |
| `11b8:1422`   | `get_current_sim_route_mode`           | Passenger/cargo/service enum.                              |
| `10b0:1ad3`   | `emit_route_failure_notification_once_per_source_floor` | Debounced popup.                          |
| `10a8:17ee`   | `floor_to_carrier_slot_index`          | (carrier, floor) → queue slot idx or -1.                   |

### 3.5 Sim-level dispatch (segment 1228)

Shared prologue: `decrement_route_queue_direction_load` (when leaving queued
state), then indexed jump via CS-relative jump table.

| Addr          | Name                                         | Family   | Size   |
|---------------|----------------------------------------------|----------|--------|
| `1228:186c`   | `dispatch_sim_behavior`                      | multi    | 569    |
| `1228:1614`   | `force_dispatch_sim_state_by_family`         | multi    | 532    |
| `1228:15a0`   | `maybe_dispatch_queued_route_after_wait`     | multi    | 116    |
| `1228:1cb5`   | `refresh_object_family_office_state_handler` | 7        | 247    |
| `1228:2031`   | `dispatch_object_family_office_state_handler`| 7        | 2623   |
| `1228:2aec`   | `refresh_object_family_hotel_state_handler`  | 3        | 247    |
| `1228:2dae`   | `dispatch_object_family_hotel_state_handler` | 3        | 276    |
| `1228:3548`   | `refresh_object_family_condo_state_handler`  | 9        | 247    |
| `1228:3870`   | `dispatch_object_family_condo_state_handler` | 9        | 276    |
| `1228:3ed9`   | `gate_object_family_retail_state_handler`    | 10       | 487    |
| `1228:40c0`   | `dispatch_object_family_retail_state_handler`| 10       | 276    |
| `1228:466d`   | `gate_object_family_restaurant_fast_food_state_handler` | 6/12 | 484 |
| `1228:4851`   | `dispatch_object_family_restaurant_fast_food_state_handler` | 6/12 | 276 |
| `1228:4d5b`   | `gate_object_family_recycling_center_lower_state_handler` | 33 | 325 |
| `1228:4ea0`   | `dispatch_object_family_recycling_center_lower_state_handler` | 33 | 381 |
| `1228:5b5a`   | `gate_object_family_parking_state_handler`   | 36       | 376    |
| `1228:5cd2`   | `dispatch_object_family_parking_state_handler`| 36      | 267    |
| `1228:5231`   | `gate_entertainment_guest_state`             | 18/29    | 217    |
| `1228:53ad`   | `dispatch_entertainment_guest_state`         | 18/29    | 267    |
| `1228:5f39`   | `gate_housekeeping_room_claim_state`         | 15       | 242    |
| `1228:602b`   | `update_object_family_housekeeping_connection_state` | 15 | 957    |
| `1228:6480`   | `activate_object_family_housekeeping_connection_state` | 14 | 142 |
| `1228:650e`   | `dispatch_object_family_hotel_restaurant_office_condo_retail_fast_food_state_handler` | shared | 92 |
| `1228:1481`   | `finalize_runtime_route_state`               | multi    | 287    |
| `1228:1018`   | `update_sim_tile_span`                       | multi    | 1053   |
| `1228:0fc2`   | `rebuild_all_sim_tile_spans`                 | multi    | 86     |
| `1228:0000`   | `reset_sim_runtime_state`                    | multi    | 1035   |

Phase-specific route handlers:

- `1228:4fab handle_hotel_guest_venue_acquisition`
- `1228:50ef handle_hotel_guest_venue_release_return`
- `1228:54b8 handle_entertainment_phase_consumption`
- `1228:5746 handle_entertainment_linked_half_routing`
- `1228:57e2 handle_entertainment_service_acquisition`
- `1228:5a23 handle_entertainment_service_release_return`
- `1228:5ddd handle_family_parking_outbound_route`
- `1228:5e7e handle_family_parking_return_route`
- `1238:0000 route_sim_to_commercial_venue`
- `1238:0244 route_sim_back_from_commercial_venue`

### 3.6 Selectors / stress accessors

| Addr          | Name                                            |
|---------------|-------------------------------------------------|
| `1228:681d`   | `get_current_sim_type`                          |
| `1228:6854`   | `get_current_sim_variant`                       |
| `1228:688c`   | `get_current_sim_state_word`                    |
| `1228:6700`   | `resolve_family_parking_selector_value`         |
| `1228:65c1`   | `resolve_family_recycling_center_lower_selector_value` |
| `1228:6757`   | `get_housekeeping_room_claim_selector`          |
| `1228:662a`   | `dispatch_entertainment_guest_substate`         |
| `1228:640c`   | `maybe_start_housekeeping_room_claim`           |
| `1228:67d7`   | `compute_object_occupant_runtime_index`         |
| `11e0:0000`   | `advance_sim_trip_counters`                     |
| `11e0:00fc`   | `rebase_sim_elapsed_from_clock`                 |
| `11e0:01f1`   | `accumulate_elapsed_delay_into_current_sim`     |
| `11e0:02f7`   | `add_delay_to_current_sim`                      |
| `11e0:0423`   | `reduce_elapsed_for_lobby_boarding`             |

---

## 4. State machines & jump tables

### 4.1 Sim state-code bit layout (family-independent)

| Bits    | Meaning                                |
|---------|----------------------------------------|
| 0..3    | phase (0..7)                           |
| bit 5 (0x20) | currently waiting                 |
| bit 6 (0x40) | route queued / in transit         |

So state `0x45` = "phase 5, in transit", `0x62` = "phase 2, waiting + in transit".
Aliased pairs like `0x00 ↔ 0x40` and `0x20 ↔ 0x60` route to the same handler in
`dispatch_object_family_office_state_handler`; difference is whether
`decrement_route_queue_direction_load` ran as prologue.

### 4.2 `dispatch_sim_behavior` (1228:186c) — two-tier switch

First on `sim.family_code`, then on `sim.state_code`.

**Family 3/4/5** (hotel/restaurant/fast-food), table at cs:1c41:

| state | handler      |
|-------|--------------|
| 0x41  | 1228:1a4f    |
| 0x45  | 1228:19f4    |
| 0x60  | 1228:1a4f    |
| 0x62  | 1228:1a4f    |
| else  | 1228:1c24    |

**Family 7** (office), table at cs:1c51:

| state               | handler    |
|---------------------|------------|
| 0x40, 0x41, 0x42    | 1228:1989  |
| 0x45, 0x60..0x63    | 1228:193d  |

**Family 9** (condo), table at cs:1c2d:

| state                              | handler    |
|------------------------------------|------------|
| 0x40, 0x41, 0x60, 0x61, 0x62       | 1228:1aba  |

**Family-relative prologue switch**, 0x22-entry jump table at `1228:1c71`
(`family_code - 3`):

| family | index | offset     | role                              |
|--------|-------|------------|-----------------------------------|
| 3/4/5  | 0..2  | 1228:19d4  | hotel/restaurant/fast-food        |
| 6      | 3     | 1228:1b05  | restaurant                        |
| 7      | 4     | 1228:191d  | office                            |
| 9      | 6     | 1228:1a9a  | condo                             |
| 10     | 7     | 1228:1b05  | retail                            |
| 12     | 9     | 1228:1b05  | fast food                         |
| 15     | 12    | 1228:1bd8  | housekeeping                      |
| 18     | 15    | 1228:1bb0  | entertainment guest               |
| 29     | 26    | 1228:1bb0  | entertainment variant             |
| 33     | 30    | 1228:1bb0  | recycling center                  |

### 4.3 `refresh_object_family_office_state_handler` (1228:1cb5)

Table at cs:2005:

| state | handler    |
|-------|------------|
| 0x00  | 1228:1e45  |
| 0x01  | 1228:1ed5  |
| 0x02  | 1228:1ed5  |
| 0x05  | 1228:1fac  |
| 0x20  | 1228:1dc1  |
| 0x21  | 1228:1f33  |
| 0x22  | 1228:1f62  |
| 0x23  | 1228:1f62  |
| 0x25, 0x26, 0x27 | 1228:1d8e |

If state ≥ 0x40 and no table hit: if `encoded_route_target < 0x40`, call
`dispatch_object_family_office_state_handler`; else
`maybe_dispatch_queued_route_after_wait`.

### 4.4 `dispatch_object_family_office_state_handler` (1228:2031)

16-entry table at cs:2aac:

| state | handler     | category                            |
|-------|-------------|-------------------------------------|
| 0x00  | 1228:2644   | base: arrive-at-office              |
| 0x01  | 1228:2717   | base: leave-for-lunch               |
| 0x02  | 1228:2775   | base: medical-visit                 |
| 0x05  | 1228:2980   | base: end-of-day                    |
| 0x20  | 1228:213c   | wait: at-desk                       |
| 0x21  | 1228:2429   | wait: lunch-return                  |
| 0x22  | 1228:24cd   | wait: medical-return                |
| 0x23  | 1228:2505   | wait: post-medical                  |
| 0x40  | 1228:2644   | continuation of 0x00                |
| 0x41  | 1228:2717   | continuation of 0x01                |
| 0x42  | 1228:2775   | continuation of 0x02                |
| 0x45  | 1228:2980   | continuation of 0x05                |
| 0x60  | 1228:213c   | wait-continuation of 0x20           |
| 0x61  | 1228:2429   | wait-continuation of 0x21           |
| 0x62  | 1228:24cd   | wait-continuation of 0x22           |
| 0x63  | 1228:2505   | wait-continuation of 0x23           |

### 4.5 Carrier-car state machine (`advance_carrier_car_state`)

Branch tree on two countdowns (door_wait at `car[-0x5d]`, boarding at `car[-0x5c]`):

```
car[-0x5d] (settle) ?
  != 0: compute_car_motion_mode
          == 0: --car[-0x5d]
          != 0:  car[-0x5d] = 0
  == 0: car[-0x5c] (dwell) ?
          != 0: --car[-0x5c]
                 if reached 0:
                   car[-0x58] = current_floor          (prev_floor snapshot)
                   recompute_car_target_and_direction
                   should_car_depart?
                     yes: proceed
                     no: car[-0x5c] = 1                (one-tick retry loop)
          == 0: target reached ?
                  yes: clear_floor_requests_on_arrival
                       car[-0x5c] = 5                   (start unload dwell)
                  no:  cancel_stale_floor_assignment
                       advance_car_position_one_step
```

Motion modes from `compute_car_motion_mode`:

| carrier | condition                                        | mode | step         | settle |
|---------|--------------------------------------------------|------|--------------|--------|
| express | `dist < 2`                                       | 0    | ±1           | 5      |
| express | `dist > 4` both sides                            | 3    | ±3           | none   |
| express | else                                             | 2    | ±1           | none   |
| std/svc | `dist < 2`                                       | 0    | ±1           | 5      |
| std/svc | `dist < 4`                                       | 1    | ±1           | 2      |
| std/svc | else                                             | 2    | ±1           | none   |

---

## 5. Non-obvious binary behaviors worth preserving

1. **State-code aliasing.** `0x00↔0x40` and `0x20↔0x60` alias to the same
   handler; the sole difference is whether the queue-drain prologue ran.

2. **Two pending counts per car.** `pending_assignment_count` (floor-calls
   dispatched) vs `assigned_count` (riders on-board) are distinct; both must
   reach zero for idle-home reset.

3. **Degenerate fallback in `find_best_available_car_for_floor`.** When no
   forward/wrap candidate exists the code writes car index 0, not the tracked
   best idle-home candidate. Quirk must be preserved.

4. **Equality breaks toward idle-home.** `(moving − idle) < threshold` is
   strict; equal cost picks the idle-home car.

5. **Queue ring is size-40, gated by the resolver.**
   `enqueue_request_into_route_queue` uses `(head+count)%40` with no full
   flag, so calling it at `count==40` would clobber `refs[head]` and push
   count to 41. The guard lives upstream in
   `resolve_sim_route_between_floors`: on `count==40` it returns 0
   (queue-full) and skips enqueue entirely. TS must mirror this — pushing
   onto a full ring is never observable in binary behavior.

6. **Parity-dependent per-stop delay.** `resolve_sim_route_between_floors`
   picks `g_per_stop_even_parity_delay` vs `..odd..` on
   `segment.mode_and_span & 1`.

7. **Arrival dispatch runs AFTER move within the tick.**
   `advance_car_position_one_step` runs first, then
   `dispatch_carrier_car_arrivals` in the outer `carrier_tick` loop. Unload
   dwell is hard-coded to 5 ticks.

8. **`g_route_failure_delay = 300`; `g_waiting_state_delay = 5`.** Sims that
   fail routing wait 300 ticks; queue-full waits 5.

9. **Same-floor route returns 3.** `resolve_sim_route_between_floors` returns
   3 for source==dest (distinct from 2=enqueued).

10. **Active-request sweep runs once/day.** `dispatch_active_requests_by_family`
    is fired only at checkpoint `g_day_tick == 0x9c4`, not every tick.

11. **Fast-forward uses a separate carrier tick** at `10f8:0318` that inflates
    `g_day_tick` and snapshot-restores carrier bytes.

12. **Encoded route target encoding.** `sim[+8] < 0x40` → special-link idx;
    `+0x40` → carrier idx (up); `+0x58` → carrier idx (down).

---

## 6. Current TS layout

```
apps/worker/src/sim/
├── index.ts              // TowerSim.step() orchestration
├── world.ts              // World + all data structures (CarrierRecord, etc.)
├── routing.ts            // rebuild*, selectBestRouteCandidate, resolveTransferFloor
├── carriers.ts           // makeCarrier, tickAllCarriers, enqueueCarrierRoute, motion SM
├── scheduler.ts          // runCheckpoints
├── sims/
│   ├── index.ts          // advanceSimRefreshStride, populateCarrierRequests,
│   │                     // resolveSimRouteBetweenFloors, dispatchSimArrival
│   ├── hotel.ts, office.ts, condo.ts, commercial.ts, medical.ts,
│   │   housekeeping.ts, parking.ts, population.ts ...
│   └── states.ts
```

### 6.1 What maps cleanly already

| Binary                                         | Current TS                                           |
|------------------------------------------------|------------------------------------------------------|
| `carrier_tick` (1098:03ab)                     | `TowerSim.step` + `tickAllCarriers`                  |
| `advance_carrier_car_state` (1098:06fb)        | `advanceCarrierCarState` (carriers.ts:989)           |
| `advance_car_position_one_step` (1098:10e4)    | `advanceCarPositionOneStep` (carriers.ts:176)        |
| `recompute_car_target_and_direction` (1098:0bcf) | `recomputeCarTargetAndDirection`                   |
| `select_next_target_floor` (1098:1553)         | `selectNextTarget` (carriers.ts:726)                 |
| `update_car_direction_flag` (1098:1d2f)        | `updateCarDirectionFlag`                             |
| `compute_car_motion_mode` (1098:209f)          | `computeCarMotionMode`                               |
| `should_car_depart` (1098:23a5)                | `shouldCarDepart`                                    |
| `find_best_available_car_for_floor` (1098:0dfc) | `findBestAvailableCarForFloor`                      |
| `clear_floor_requests_on_arrival` (1098:13cc)  | `clearFloorRequestsOnArrival`                        |
| `process_unit_travel_queue` (1218:0351)        | inline in `dispatchAndBoardCar` via `processUnitTravelQueue` |
| `enqueue_request_into_route_queue` (1218:1002) | `enqueueCarrierRoute` (carriers.ts:1309)             |
| `pop_unit_queue_request` (1218:1172)           | internal to `drainDirection`                         |
| `resolve_sim_route_between_floors` (1218:0000) | `resolveSimRouteBetweenFloors` (sims/index.ts:683)   |
| `select_best_route_candidate` (11b8:1484)      | `selectBestRouteCandidate` (routing.ts:242)          |
| `score_*` family                               | `score*` helpers in routing.ts                       |
| `rebuild_route_reachability_tables` etc.       | `rebuild*` in routing.ts                             |
| `dispatch_destination_queue_entries` (1218:0883) | `onCarrierArrival` callback + `dispatchSimArrival` |
| `refresh_runtime_entities_for_tick_stride` (1228:0d64) | `advanceSimRefreshStride` (sims/index.ts)    |
| `advance_sim_trip_counters` (11e0:0000) etc.   | trip-counters / elapsed logic in sims/index.ts       |

### 6.2 Where TS diverges from the binary

1. **Queue-buffer layout.** TS uses two `RingBuffer<string>` objects per
   floor (generic class). Binary is a flat `TowerRouteQueueRecord` (324 B)
   per floor-slot, packed into the carrier struct. TS now rejects pushes
   onto a full ring so the resolver's queue-full return (code 0) fires,
   matching the binary.

2. **Demand seeding is sims-initiated, not family-refresh-initiated.**
   `populateCarrierRequests` is a TS-invented function that scans idle sims
   and calls `resolveSimRouteBetweenFloors`. The binary has **no such
   function** — route resolution is triggered inside each family's
   dispatch handler (e.g. `dispatch_object_family_office_state_handler`)
   when the state machine decides to leave the current floor. This is a
   structural mismatch.

3. **Arrival dispatch is callback-based.** TS fires `onArrival` /
   `onBoarding` callbacks; binary jumps directly into
   `dispatch_object_family_*_state_handler` inline inside
   `dispatch_destination_queue_entries`. Preserving the binary's ordering
   (move-first, unload-after) is easier with inline calls.

4. **`sim.route` discriminated union.** TS has a `{ mode: "idle" | "segment"
   | "carrier" | "queued", ... }` union. Binary stores a single byte
   `encoded_route_target` + separate state-byte bits (`0x20` waiting,
   `0x40` in-transit). Same information, different encoding — but the
   union-based TS code can get out of sync with `state_code` bits.

5. **Family handlers don't mirror binary structure.** TS has
   `hotel.ts`, `office.ts`, etc., but they don't each split into the
   binary's three layers (`refresh_*`, `dispatch_*`, `gate_*`). The
   state-machine jump tables are also inlined into switch statements
   rather than data tables.

6. **Daily request sweep missing.** `dispatch_active_requests_by_family`
   (the day-0x9c4 stuck-request drainer) has no TS counterpart.

7. **Schedule-flag load timing.** Binary reloads `scheduling_flag` at the
   exact moment a car hits a terminal floor (inside
   `advance_carrier_car_state`); TS does this in
   `loadScheduleFlag` called from `advanceCarrierCarState`, close but not
   identical in call order.

8. **Parity-dependent per-stop delay.** TS uses fixed 16 (escalator) / 35
   (stairs); binary uses the `g_per_stop_even_parity_delay` /
   `g_per_stop_odd_parity_delay` table.

9. **`pending_assignment_count` is a `dword`.** TS uses a plain `number`;
   binary uses it with 32-bit arithmetic, and its update ordering vs
   `assigned_count` is load-bearing for the idle-home reset.

---

## 7. Proposed restructuring: binary-faithful module layout

### 7.1 Target file tree

```
apps/worker/src/sim/
├── index.ts                         // TowerSim.step = serviceIdleTasks
├── world.ts                         // types only (match binary struct layout)
├── tick/
│   ├── service-idle-tasks.ts        // 1268:01a6  serviceIdleTasks
│   ├── day-scheduler.ts             // 1208:0196  runSimulationDayScheduler
│   ├── carrier-tick.ts              // 1098:03ab  carrierTick
│   └── fast-carrier-tick.ts         // 10f8:0318  fastCarrierTick
├── carriers/
│   ├── advance.ts                   // 1098:06fb  advanceCarrierCarState
│   ├── position.ts                  // 1098:10e4  advanceCarPositionOneStep
│   ├── target.ts                    // 1098:0bcf, 1553, 1d2f, 1f4c
│   ├── motion.ts                    // 1098:209f  computeCarMotionMode
│   ├── depart.ts                    // 1098:23a5  shouldCarDepart
│   ├── assign.ts                    // 1098:0a4c  assignCarToFloorRequest
│   │                                // 1098:0dfc  findBestAvailableCarForFloor
│   ├── arrival.ts                   // 1098:13cc  clearFloorRequestsOnArrival
│   │                                // 1098:12c9  cancelStaleFloorAssignment
│   │                                // 1098:0192  resetOutOfRangeCar
│   ├── pending.ts                   // 1098:0b10  decrementCarPendingAssignmentCount
│   └── record.ts                    // CarrierRouteRecordHeader accessors (byte-accurate)
├── queue/
│   ├── route-record.ts              // TowerRouteQueueRecord ops (324-byte packed)
│   ├── enqueue.ts                   // 1218:1002
│   ├── dequeue.ts                   // 1218:1172
│   ├── scan.ts                      // 1218:142a, 173a, 1905
│   ├── resolve.ts                   // 1218:0000  resolveSimRouteBetweenFloors
│   ├── process-travel.ts            // 1218:0351  processUnitTravelQueue
│   ├── dispatch-arrivals.ts         // 1218:0883, 07a6
│   ├── cancel.ts                    // 1218:1a86, 1981
│   └── encoding.ts                  // 1218:1b96  decodeRuntimeRouteTarget
├── reachability/
│   ├── rebuild-tables.ts            // 11b8:00f2, 049f, 0000, 006d
│   ├── special-link-records.ts      // 11b8:06a4, 0763
│   ├── span-checks.ts               // 11b8:12d2, 1392, 0ccf
│   └── mask-tests.ts                // 11b8:0f33, 0fe6, 0e41
├── route-scoring/
│   ├── select-candidate.ts          // 11b8:1484  selectBestRouteCandidate
│   ├── score-local.ts               // 11b8:18fb, 19a8
│   ├── score-carrier.ts             // 11b8:168e
│   ├── score-special-link.ts        // 11b8:0be2
│   └── route-mode.ts                // 11b8:1422
├── families/
│   ├── dispatch-sim-behavior.ts     // 1228:186c  dispatchSimBehavior
│   ├── force-dispatch.ts            // 1228:1614
│   ├── maybe-dispatch-after-wait.ts // 1228:15a0
│   ├── office.ts                    // refresh_ + dispatch_  (1cb5, 2031)
│   ├── hotel.ts                     // refresh_ + dispatch_  (2aec, 2dae)
│   ├── condo.ts                     // refresh_ + dispatch_  (3548, 3870)
│   ├── retail.ts                    // gate_ + dispatch_      (3ed9, 40c0)
│   ├── restaurant.ts                // gate_ + dispatch_      (466d, 4851)
│   ├── recycling.ts                 // gate_ + dispatch_      (4d5b, 4ea0)
│   ├── parking.ts                   // gate_ + dispatch_      (5b5a, 5cd2)
│   ├── entertainment.ts             // gate_ + dispatch_      (5231, 53ad)
│   ├── housekeeping.ts              // gate_ + dispatch_      (5f39, 602b, 6480)
│   ├── shared-dispatch.ts           // 1228:650e
│   ├── finalize.ts                  // 1228:1481  finalizeRuntimeRouteState
│   ├── reset.ts                     // 1228:0000  resetSimRuntimeState
│   └── tile-spans.ts                // 1228:0fc2, 1018
├── sim-access/
│   ├── selectors.ts                 // 1228:681d, 6854, 688c, 6700, 65c1, 6757
│   └── state-bits.ts                // state-code bit layout helpers
├── stress/
│   ├── trip-counters.ts             // 11e0:0000  advanceSimTripCounters
│   ├── rebase-elapsed.ts            // 11e0:00fc
│   ├── accumulate-elapsed.ts        // 11e0:01f1
│   ├── add-delay.ts                 // 11e0:02f7
│   └── lobby-reduction.ts           // 11e0:0423
├── sim-refresh/
│   └── refresh-stride.ts            // 1228:0d64  refreshRuntimeEntitiesForTickStride
├── daily/
│   └── drain-active-requests.ts     // 1190:0977  dispatchActiveRequestsByFamily
├── state-tables/                    // data-driven jump tables
│   ├── office.ts                    // tables at cs:2aac, cs:2005, cs:1c51
│   ├── hotel.ts, condo.ts, ...
│   └── family-prologue.ts           // cs:1c71 (0x22-entry table)
└── routing-legacy.ts                // TEMPORARILY houses anything not yet migrated
```

Each file hosts one binary function, with a header comment recording its
address. Cross-file imports mirror the binary call graph.

### 7.2 Data-structure changes

1.. **Replace `RingBuffer<string>` with a typed view over a packed
   `Uint32Array`**, matching `TowerRouteQueueRecord`'s exact 324-byte
   layout (4 counters + 2×40 refs). Queue-full (`count==40`) must be
   handled by the resolver, not by `push()`.

2. **Store carrier header as a `Uint8Array`-backed view** (914 bytes)
   with typed accessors, so per-floor arrays
   (`served_floor_flags[120]`,
   `reachability_masks_by_floor[120]`,
   `primary_route_status_by_floor[120]`,
   `secondary_route_status_by_floor[120]`) have the exact offsets.

3. **Store per-car `TowerUnitRouteRecord` as 346-byte view.** Fields
   `active_request_refs[42]`, `slot_destination_floors[42]`, and
   `destination_request_counts[120]` land at binary offsets.

4. **`SimRecord` as 16-byte view.** Decode `state_code` bits (`0x20`
   waiting, `0x40` in-transit) through helpers instead of a discriminated
   union. Replace `sim.route` with the byte at `+8` (`encoded_route_target`)
   plus the bit mask on `state_code`.

5. **Flatten `specialLinks`, `specialLinkRecords`, and
   `transferGroupCache`** into fixed-size typed arrays matching binary
   cardinalities (64 segments, 8 records, 16 group entries).

### 7.3 Control-flow changes

1. **Split `tickAllCarriers` into `carrierTick`.** Currently
   `carrierTick` merges `refresh_runtime_entities_for_tick_stride` and
   the car loop into one function (`TowerSim.step`). Move the stride to
   its own module, called from `carrierTick` in the exact binary order:
   stride refresh → per-carrier per-car advance → arrivals pass →
   queue-drain pass.

2. **Remove `populateCarrierRequests`.** Demand must originate from
   family dispatchers (`dispatch_object_family_office_state_handler` etc.)
   calling `resolveSimRouteBetweenFloors` inline.

3. **Replace `onArrival` / `onBoarding` callbacks with direct calls**
   from `dispatchDestinationQueueEntries` into the family dispatch
   functions — mirroring the binary's inline jump.

4. **Re-thread `should_car_depart` to run after
   `recompute_car_target_and_direction`** inside
   `advanceCarrierCarState`'s dwell-expiry branch, matching the binary
   call order, with the `dwell=1` one-tick retry.

5. **Add `dispatchActiveRequestsByFamily`** wired into the 0x9c4 day
   checkpoint in `scheduler.ts`.

6. **Implement `fast_carrier_tick`** if fast-forward behavior is in scope.

7. **Parity-based per-stop delay.** Replace fixed 16/35 constants with
   table lookup on `segment.modeAndSpan & 1`.

8. **Preserve binary quirks explicitly**:
   - degenerate car-index-0 fallback in `findBestAvailableCarForFloor`
   - equality-breaks-to-idle-home
   - queue-full gate: resolver bails with code 0 when `count==40`; enqueue
     is never called on a full ring (if it were, it would clobber `refs[head]`)
   - same-floor result code 3, not 2
   - state-byte aliasing (`0x00 == 0x40`) with prologue-only difference

### 7.4 Phasing plan (smallest-to-largest)

1. **Phase 0 — Data layout.** Convert carrier / car / queue structures
   to byte-accurate views; keep existing functions working against the
   views via accessors.
2. **Phase 1 — Tick orchestration.** Split `carrierTick` into its binary
   sub-steps; reorder `advanceCarrierCarState` to match binary branch
   structure.
3. **Phase 2 — Queue/ring.** Replace `RingBuffer` with
   `TowerRouteQueueRecord` view; add wrap-at-40 quirk.
4. **Phase 3 — Route resolve/score split.** Break routing.ts into
   `reachability/` + `route-scoring/` + `queue/resolve.ts`, matching the
   binary 1:1.
5. **Phase 4 — Family dispatchers.** For each family (office, hotel,
   condo, retail, restaurant, recycling, parking, entertainment,
   housekeeping): extract refresh / dispatch / gate into
   binary-named functions and data-driven state tables.
6. **Phase 5 — Remove `populateCarrierRequests`.** Route all demand
   through family dispatchers. This is the most behavior-impacting step
   and should be backed by a fresh trace.
7. **Phase 6 — Callback removal.** Replace `onArrival`/`onBoarding`
   callbacks with inline family dispatch calls.
8. **Phase 7 — Daily active-request sweep.** Wire
   `dispatchActiveRequestsByFamily` into the 0x9c4 checkpoint.
9. **Phase 8 — Fast-forward path** (optional).

Run `trace.test.ts` after each phase; fix divergences in temporal order
before proceeding to the next.

---

## 8. Open questions / spec gaps

- Exact layout of `car` flags at offsets `+0x04..0x3b` of
  `CarrierRouteRecordHeader` (some slots identified by the decomp, others
  remain unlabeled).
- `reduce_elapsed_for_lobby_boarding` threshold source (`g_lobby_height`
  implied but not confirmed in the binary map).
- Calendar phase and daypart update cadence (spec assumes they're
  globally available; binary reads them from `g_daypart_index` /
  `g_weekend_flag` but the updaters weren't traced).
- Service-request entry linkage between housekeeping claims and hotel
  sims.
- Whether the binary's "active-request sweep" iterates all sims or only a
  specific subset at day 0x9c4.
