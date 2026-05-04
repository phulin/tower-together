# stress/ — Per-sim stress accessors

Binary segment 11e0: trip-elapsed accounting primitives. Each file hosts one binary function.

## Files

### `trip-counters.ts`
`advanceSimTripCounters` (11e0:0000). Captures a completed trip into `tripCount` + `accumulatedTicks`, clears the per-trip window.

### `rebase-elapsed.ts`
`rebaseSimElapsedFromClock` (11e0:00fc). Syncs per-trip elapsed with the day clock (`+= dayTick - lastDemandTick`, clamped to 300).

### `add-delay.ts`
`addDelayToCurrentSim` (11e0:02f7). Adds a fixed tick penalty to the current trip (clamped to 300).

### `accumulate-elapsed.ts`
`accumulateElapsedDelayIntoCurrentSim` (11e0:01f1). Composite of rebase + lobby reduction invoked from `assignRequestToRuntimeRoute` for non-service-carrier assignments.

### `lobby-reduction.ts`
`reduceElapsedForLobbyBoarding` (11e0:0423). Lobby-height-keyed discount: `<=1` none, `==2` −25, `>=3` −50. Service-carrier exclusion is enforced by the caller.
