# sims/ — Runtime sim sims

Family-specific state machines and shared runtime helpers for the placed-object-derived sim population. No I/O, Cloudflare, or Phaser dependencies.

## Files

### `index.ts`
Runtime sim facade: refresh stride orchestration, venue visits, transport routing/arrival plumbing, compatibility aliases, and public re-exports for the split sim modules.

### `states.ts`
Shared runtime sim state codes, transit-bit helpers (`0x40` flag + base-code mask), family sets, floor sentinels, route idle value, population tables, and unit-status thresholds.

### `population.ts`
Population construction and cleanup for placed-object-derived sims, sim-key lookup helpers, route clearing, runtime reset, and legacy sim-named compatibility aliases.

### `trip-counters.ts`
Elapsed-time rebasing, trip counter advancement, current-trip delay accounting, and facility-wide counter reset helpers.

### `scoring.ts`
Operational scoring, nearby-noise checks, distance feedback, occupied flag refreshes, and wire-facing sim state projection records.

### `parking.ts`
Parking demand log rebuild and assignment of parking-service requests to eligible hotel and office sims.

### `facility-refunds.ts`
Commercial venue day-cycle reset/close handling, retail activation/deactivation, and unhappy condo/retail facility refunds.

### `hotel-facilities.ts`
Hotel/condo end-of-day unit status normalization, cockroach infestation spread, vacancy expiry, and hotel operational/occupancy refresh.

### `hotel.ts`
Hotel-family sim state machine: check-in routing, active-stay venue visits, checkout queues, sale accounting, and room turnover.

### `office.ts`
Office-family sim state machine: morning activation, worker commute/service-demand handling, presence counters, venue trips, evening departure, and office service evaluation entry points.

### `condo.ts`
Condo-family sim state machine: occupant activation, restaurant/fast-food venue selection, sale accounting, and operational refresh.
