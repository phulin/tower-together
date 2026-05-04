# families/ — Per-family sim state handlers

Binary-aligned family dispatchers (segment 1228, §3.5 in ROUTING-BINARY-MAP.md). Phase 5b makes the refresh/gate/dispatch entry points the real implementations — they wrap the in-sims state-machine bodies with the binary's two-tier "state_code < 0x40 → dispatch; state_code >= 0x40 → maybe_dispatch_queued_route_after_wait" structure. **Phase 6: demand origination now happens inside each family dispatch handler** — when the state machine decides to move a sim between floors it calls `resolveSimRouteBetweenFloors` inline (matching the binary's `dispatch_object_family_*_state_handler` path). The TS-invented `populateCarrierRequests` idle-scan is gone; return codes -1/0/1/2/3 drive the family state machine transitions inside `processHotelSim` / `processOfficeSim` / `processCondoSim` / `processCommercialSim` / `processHousekeepingSim` / `processCathedralSim` / `tryStartMedicalTrip`.

## Files

### `hotel.ts`
Family 3/4/5: real `refreshObjectFamilyHotelStateHandler` (1228:2aec) + `dispatchObjectFamilyHotelStateHandler` (1228:2dae). Refresh routes in-transit sims through `maybeDispatchQueuedRouteAfterWait`; dispatch delegates arrivals to `handleHotelSimArrival`.

### `office.ts`
Family 7: real `refreshObjectFamilyOfficeStateHandler` (1228:1cb5) + `dispatchObjectFamilyOfficeStateHandler` (1228:2031). Refresh is the two-tier entry; dispatch uses `simBaseState` to document the 0x00↔0x40 / 0x20↔0x60 aliasing.

### `condo.ts`
Family 9: real `refreshObjectFamilyCondoStateHandler` (1228:3548) + `dispatchObjectFamilyCondoStateHandler` (1228:3870).

### `retail.ts`
Family 10: real `gateObjectFamilyRetailStateHandler` (1228:3ed9) + `dispatchObjectFamilyRetailStateHandler` (1228:40c0). The gate validates familyCode and delegates to the shared commercial processor; retail-specific quirks (DORMANT+occupiedFlag early exit, binary +0x14) live inside `processCommercialSim`.

### `restaurant.ts`
Family 6/12: real `gateObjectFamilyRestaurantFastFoodStateHandler` (1228:466d) + `dispatchObjectFamilyRestaurantFastFoodStateHandler` (1228:4851). Same pattern as retail.

### `recycling.ts`
Family 33: real `gateObjectFamilyRecyclingCenterLowerStateHandler` (1228:4d5b) + `dispatchObjectFamilyRecyclingCenterLowerStateHandler` (1228:4ea0). Gate applies daypart/tick/RNG filters; dispatch delegates to the entertainment guest machine.

### `parking.ts`
Family 36: gate (1228:5b5a) + dispatch (1228:5cd2). Re-exports the demand-log helpers; state-machine gate/dispatch are TODO stubs.

### `entertainment.ts`
Family 18/29 guest: real `gateEntertainmentGuestState` (1228:5231) + `dispatchEntertainmentGuestState` (1228:53ad) + four inner helper functions (phase consumption, linked-half routing, service acquisition, release/return). Resolver calls pass the entertainment link anchor as the target height metric so split sub-records match binary distance-feedback thresholds.

### `housekeeping.ts`
Family 15: real `gateHousekeepingRoomClaimState` (1228:5f39) + `updateObjectFamilyHousekeepingConnectionState` (1228:602b) + `activateObjectFamilyHousekeepingConnectionState` (1228:6480). Delegates to `processHousekeepingSim` / `handleHousekeepingSimArrival`. HK uses low-valued states (0..4) that don't overlap the 0x20/0x40 bits.

### `medical.ts`
Medical-center helpers. No direct binary counterpart mapped yet; re-exports from `sims/medical.ts`.

### `dispatch-sim-behavior.ts`
1228:186c `dispatchSimBehavior` — real body. Two-tier switch on family_code (via cs:1c71 FAMILY_PROLOGUE_TABLE gate) and state_code bits (isSimInTransit). In-transit sims route through `maybeDispatchQueuedRouteAfterWait`; others enter their family refresh handler.

### `force-dispatch.ts`
1228:1614 `forceDispatchSimStateByFamily` — real body. Strips the 0x40 in-transit bit and re-enters the family refresh handler. Note: does NOT strip 0x20 because TS state constants (MORNING_GATE=0x20, NIGHT_B=0x26) encode phase information in that bit.

### `maybe-dispatch-after-wait.ts`
1228:15a0 `maybeDispatchQueuedRouteAfterWait` — real body. Office-specific wait-timeout: when a family-7 sim has waited on a carrier queue for > 300 ticks, force-transition to NIGHT_B and clear its carrier slot.

### `shared-dispatch.ts`
1228:650e shared tail dispatch — TODO stub.

### `finalize.ts`
1228:1481 `finalizeRuntimeRouteState` — real body. Advances trip counters (if the sim was on a route), clears sim.route, and strips the 0x40 in-transit bit. Callers include the queue cancel path and `finalizeRuntimeRouteState` is exposed for future arrival-path integration.

### `reset.ts`
1228:0000 `resetSimRuntimeState` — re-exports from `sims/population.ts`.

### `tile-spans.ts`
1228:0fc2 / 1228:1018 — TODO stubs.

## State-bit invariant (Phase 5b)

`SimRecord.stateCode` bit layout (world.ts, ROUTING-BINARY-MAP.md §4.1):
  - bits 0..3: phase
  - bit 5 (0x20): waiting
  - bit 6 (0x40): in-transit

TS quirk: some state-code constants in `sims/states.ts` (STATE_MORNING_GATE=0x20, STATE_AT_WORK=0x21, STATE_VENUE_TRIP=0x22, STATE_NIGHT_B=0x26) ENCODE the waiting bit as part of the phase byte, not as a separate flag. So `clearSimRouteBits` is only safe for transitions out of in-transit states whose phase byte does not overlap 0x20. The `setSimInTransit(sim, false)` helper (strip 0x40 only) is the portable helper for Phase 5b call sites.

The authoritative source for routing-mode branching is `isSimInTransit(sim.stateCode)` / `isSimWaiting(sim.stateCode)` — callers consulting `sim.route.mode` for routing decisions are migration candidates; `sim.route` remains as auxiliary storage for carrier/segment ids + direction + transitTicksRemaining.

## Subpackages

### `state-tables/`
Binary CS-relative jump tables preserved as `ReadonlyMap<number, string>` constants (state_code → binary handler address). Phase 5b keeps these as documentation; the dispatch bodies still live in the family `refresh*` functions which delegate to the corresponding TS `process*Sim` body. The aliasing `0x00↔0x40`, `0x20↔0x60` is visible in the tables (same address mapped twice).
