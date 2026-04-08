import type { ClientMessage } from "../types";
import { init_carrier_state, tick_all_carriers } from "./carriers";
import type { CellPatch, CommandResult } from "./commands";
import { handle_place_tile, handle_remove_tile } from "./commands";
import { createLedgerState, type LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import {
	rebuild_special_links,
	rebuild_transfer_group_cache,
	rebuild_walkability_flags,
} from "./routing";
import { run_checkpoints, type SimState } from "./scheduler";
import { advanceOneTick, createNewGameTimeState, type TimeState } from "./time";
import {
	createGateFlags,
	GRID_HEIGHT,
	GRID_WIDTH,
	MAX_SPECIAL_LINKS,
	type WorldState,
} from "./world";

export type { CellPatch, CommandResult };

// ─── Snapshot type ────────────────────────────────────────────────────────────

export interface SimSnapshot {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

// ─── Step result ──────────────────────────────────────────────────────────────

export interface StepResult {
	simTime: number;
	economyChanged?: boolean;
}

// ─── TowerSim ─────────────────────────────────────────────────────────────────

export class TowerSim {
	private time: TimeState;
	private world: WorldState;
	private ledger: LedgerState;

	private constructor(time: TimeState, world: WorldState, ledger: LedgerState) {
		this.time = time;
		this.world = world;
		this.ledger = ledger;
	}

	// ── Factory methods ────────────────────────────────────────────────────────

	static create(towerId: string, name: string): TowerSim {
		// New game starts at tick 0x9e5 (mid-day) per new_game_initializer spec.
		const time = createNewGameTimeState();
		const world: WorldState = {
			towerId,
			name,
			width: GRID_WIDTH,
			height: GRID_HEIGHT,
			gate_flags: createGateFlags(),
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
			placed_objects: {},
			sidecars: [],
			carriers: [],
			special_links: Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
				active: false,
				flags: 0,
				start_floor: 0,
				height_metric: 0,
				carrier_id: -1,
			})),
			floor_walkability_flags: new Array(GRID_HEIGHT).fill(0),
			transfer_group_cache: new Array(GRID_HEIGHT).fill(0),
		};
		const ledger = createLedgerState(STARTING_CASH);
		return new TowerSim(time, world, ledger);
	}

	static from_snapshot(snap: SimSnapshot): TowerSim {
		// Migrate old saves that have a flat WorldState without placed_objects
		if (snap.world.height < GRID_HEIGHT) snap.world.height = GRID_HEIGHT;
		snap.world.placed_objects ??= {};
		snap.world.sidecars ??= [];
		snap.world.gate_flags ??= createGateFlags();

		// Migrate old saves that stored cash in world instead of ledger
		if (!snap.ledger) {
			const old = snap.world as unknown as Record<string, unknown>;
			const cash = (old.cash as number) ?? STARTING_CASH;
			snap.ledger = createLedgerState(cash);
			delete (snap.world as unknown as Record<string, unknown>).cash;
		}

		// Migrate old saves without Phase 3 carrier/routing fields
		init_carrier_state(snap.world);
		snap.world.special_links ??= Array.from(
			{ length: MAX_SPECIAL_LINKS },
			() => ({
				active: false,
				flags: 0,
				start_floor: 0,
				height_metric: 0,
				carrier_id: -1,
			}),
		);
		// Recompute derived routing state from carriers
		rebuild_special_links(snap.world);
		rebuild_walkability_flags(snap.world);
		rebuild_transfer_group_cache(snap.world);

		return new TowerSim(snap.time, snap.world, snap.ledger);
	}

	// ── Tick ──────────────────────────────────────────────────────────────────

	step(): StepResult {
		const prevTick = this.time.day_tick;
		const balanceBefore = this.ledger.cash_balance;

		const { time } = advanceOneTick(this.time);
		this.time = time;
		const currTick = this.time.day_tick;

		const state: SimState = {
			time: this.time,
			world: this.world,
			ledger: this.ledger,
		};
		run_checkpoints(state, prevTick, currTick);
		tick_all_carriers(this.world);

		return {
			simTime: this.time.total_ticks,
			economyChanged: this.ledger.cash_balance !== balanceBefore,
		};
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	submit_command(cmd: ClientMessage): CommandResult {
		switch (cmd.type) {
			case "place_tile":
				return handle_place_tile(
					cmd.x,
					cmd.y,
					cmd.tileType,
					this.world,
					this.ledger,
				);
			case "remove_tile":
				return handle_remove_tile(cmd.x, cmd.y, this.world, this.ledger);
			case "join_tower":
			case "ping":
				return { accepted: true };
		}
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	save_state(): SimSnapshot {
		return {
			time: { ...this.time },
			world: this.cloneWorld(),
			ledger: this.cloneLedger(),
		};
	}

	private cloneWorld(): WorldState {
		return {
			towerId: this.world.towerId,
			name: this.world.name,
			width: this.world.width,
			height: this.world.height,
			gate_flags: { ...this.world.gate_flags },
			cells: { ...this.world.cells },
			cellToAnchor: { ...this.world.cellToAnchor },
			overlays: { ...this.world.overlays },
			overlayToAnchor: { ...this.world.overlayToAnchor },
			placed_objects: JSON.parse(
				JSON.stringify(this.world.placed_objects),
			) as WorldState["placed_objects"],
			sidecars: JSON.parse(
				JSON.stringify(this.world.sidecars),
			) as WorldState["sidecars"],
			carriers: JSON.parse(
				JSON.stringify(this.world.carriers),
			) as WorldState["carriers"],
			special_links: JSON.parse(
				JSON.stringify(this.world.special_links),
			) as WorldState["special_links"],
			floor_walkability_flags: [...this.world.floor_walkability_flags],
			transfer_group_cache: [...this.world.transfer_group_cache],
		};
	}

	private cloneLedger(): LedgerState {
		return {
			cash_balance: this.ledger.cash_balance,
			primary_ledger: [...this.ledger.primary_ledger],
			secondary_ledger: [...this.ledger.secondary_ledger],
			tertiary_ledger: [...this.ledger.tertiary_ledger],
			cash_balance_cycle_base: this.ledger.cash_balance_cycle_base,
		};
	}

	// ── Accessors for TowerRoom ────────────────────────────────────────────────

	get towerId(): string {
		return this.world.towerId;
	}
	get name(): string {
		return this.world.name;
	}
	get simTime(): number {
		return this.time.total_ticks;
	}
	get cash(): number {
		return this.ledger.cash_balance;
	}
	get width(): number {
		return this.world.width;
	}
	get height(): number {
		return this.world.height;
	}

	cellsToArray(): CellPatch[] {
		const result: CellPatch[] = [];
		for (const [key, tileType] of Object.entries(this.world.cells)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: !this.world.cellToAnchor[key] });
		}
		for (const [key, tileType] of Object.entries(this.world.overlays)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: true, isOverlay: true });
		}
		return result;
	}
}
