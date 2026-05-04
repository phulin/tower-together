# reachability/ — Route reachability tables (binary segment 11b8)

One binary function per file; each file header carries its `SEG:OFFSET name`.

## Files

### `rebuild-tables.ts`
`rebuildRouteReachabilityTables` (11b8:00f2), `rebuildTransferGroupCache` (11b8:049f), `clearRouteReachabilityTables` (11b8:0000), `clearTransferGroupCache` (11b8:006d).

### `special-link-records.ts`
`rebuildSpecialLinkRouteRecords` (11b8:06a4), `scanSpecialLinkSpanBound` (11b8:0763).

### `span-checks.ts`
`isFloorSpanWalkableForLocalRoute` (11b8:12d2), `isFloorSpanWalkableForHousekeepingRoute` (11b8:1392), `isFloorWithinSpecialLinkSpan` (11b8:0ccf).

### `mask-tests.ts`
`testCarrierTransferReachability` (11b8:0f33), `testSpecialLinkTransferReachability` (11b8:0fe6), `chooseTransferFloorFromCarrierReachability` (11b8:0e41).
