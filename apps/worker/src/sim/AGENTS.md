# sim/ — Pure simulation core

No I/O, no Cloudflare dependencies, no Phaser. Fully unit-testable in Node.

## Files

### `index.ts`
`TowerSim` class — the public façade. Exposes `create()`, `from_snapshot()`, `step()`, `submit_command()`, `save_state()`, and read-only accessors. `step()` advances the clock by one tick and fires all checkpoints via `scheduler.ts`. `submit_command()` delegates to `commands.ts`.

### `time.ts`
`TimeState` + `advanceOneTick()`. Tracks `day_tick` (0–2599), `daypart_index` (day_tick÷400), `day_counter`, `calendar_phase_flag`, `star_count`, and `total_ticks`. Constants: `DAY_TICK_MAX = 0x0a28`, `DAY_TICK_INCOME = 0x08fc`.

### `world.ts`
Grid constants (`GRID_WIDTH=64`, `GRID_HEIGHT=120`, lobby validation) and world data types: `PlacedObjectRecord` (per-object simulation record), sidecar record types (`CommercialVenueRecord`, `ServiceRequestEntry`, `EntertainmentLinkRecord`), and `WorldState` (cells, overlays, placed_objects, sidecars).

### `resources.ts`
All compile-time constants: `TILE_WIDTHS`, `TILE_COSTS`, `VALID_TILE_TYPES`, `FAMILY_CODE_TO_TILE` / `TILE_TO_FAMILY_CODE` (family ↔ tile-name mappings), `YEN_1001` (income payouts), `YEN_1002` (operating expenses), `OP_SCORE_THRESHOLDS`, `STAR_THRESHOLDS`, route delay constants.

### `ledger.ts`
Three-ledger money model. `LedgerState` holds `cash_balance`, `primary_ledger[]`, `secondary_ledger[]`, `tertiary_ledger[]`, `cash_balance_cycle_base`. Key functions: `add_cashflow_from_family_resource()` (Phase 4 income), `rebuild_facility_ledger()` (called at 0x00f0), `do_expense_sweep()` (YEN #1002 charges), `do_ledger_rollover()` (3-day reset at 0x09e5).

### `scheduler.ts`
`SimState` bundle (`time + world + ledger`) and `run_checkpoints(state, prev_tick, curr_tick)`. Fires all 18 checkpoint bodies at the correct `day_tick` values: 0x000, 0x020, 0x0f0, 0x3e8, 0x4b0, 0x578, 0x5dc, 0x640, 0x6a4, 0x708, 0x76c, 0x7d0, 0x898, 0x8fc, 0x9c4, 0x9e5, 0x9f6, 0x0a06. Most Phase 3/4 bodies are stubs.

### `commands.ts`
`handle_place_tile()` and `handle_remove_tile()` — validate, mutate `WorldState + LedgerState`, create/free `PlacedObjectRecord` and sidecar records, call `run_global_rebuilds()` (currently just `rebuild_facility_ledger`; Phase 3 adds routing rebuilds). Also exports `CellPatch`, `CommandResult`, `fill_row_gaps()`.
