# queue/ — Route queue subsystem (binary segment 1218)

One binary function per file; each file header carries its `SEG:OFFSET name`.

## Files

### `route-record.ts`
`RouteRequestRing` — fixed-40-entry ring buffer backing `CarrierFloorQueue` up/down queues. Binary quirk: size-40 ring silently overwrites head on 41st enqueue.

### `encoding.ts`
`decodeRuntimeRouteTarget` (1218:1b96), `encodeRuntimeRouteTarget`, `decodeEncodedRouteTargetByte`. Byte encoding: `<0x40` special-link, `+0x40` carrier up, `+0x58` carrier down.

### `enqueue.ts`
`enqueueRequestIntoRouteQueue` (1218:1002). Appends to ring; triggers `assignCarToFloorRequest` on first-into-empty.

### `dequeue.ts`
`popUnitQueueRequest` (1218:1172). Pops the head of a direction ring.

### `scan.ts`
`removeRequestFromUnitQueue` (1218:142a), `removeRequestFromActiveRouteSlots` (1218:173a), `storeRequestInActiveRouteSlot` (1218:187b), `popActiveRouteSlotRequest` (1218:1905).

### `cancel.ts`
`cancelRuntimeRouteRequest` (1218:1a86), `dispatchQueuedRouteUntilRequest` (1218:1981, TODO stub), `decrementRouteQueueDirectionLoad` (1218:0fc4, TODO stub). Cancel now mirrors the binary's "active-slot first, floor-queue fallback" removal order.

### `dispatch-arrivals.ts`
`dispatchCarrierCarArrivals` (1218:07a6), `dispatchDestinationQueueEntries` (1218:0883). Gated on `dwellCounter == 5`. Phase 7: invokes `dispatchSimArrival` inline per unloaded slot, matching the binary's direct call into `dispatch_object_family_*_state_handler`.

### `process-travel.ts`
`processUnitTravelQueue` (1218:0351), `assignRequestToRuntimeRoute` (1218:0d4e). Phase 5b: transfer-floor failure at `clearSimRouteById` strips the 0x40 in-transit bit via `setSimInTransit(sim, false)` (gated to `dispatch_sim_behavior` families) so the sim's family refresh handler re-dispatches on the next stride. `assignRequestToRuntimeRoute` invokes `accumulateElapsedDelayIntoCurrentSim` for non-service carriers, matching the binary's assignment-time stress accumulation.

### `resolve.ts`
`resolveSimRouteBetweenFloors` (1218:0000). Return codes -1/0/1/2/3; same-floor returns 3. Applies binary long-distance feedback from route height metric to target height metric on segment/carrier success when the caller's `emitDistanceFeedback` flag is set. Phase 5b: every `sim.route = ...` write is paired with a state-bit update — `setSimInTransit(sim, true)` for segment/carrier, `setSimWaiting(sim, true)` for queue-full — gated to the `dispatch_sim_behavior` families (hotel / office / condo / restaurant / fast-food / retail).

### `route-record.test.ts`
Unit test for the size-40 silent wrap quirk.

### `index.ts`
Re-export barrel for the queue surface.
