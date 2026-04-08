import type { ClientMessage } from "../types";
import type { CellPatch, CommandResult } from "./commands";
import { handle_place_tile, handle_remove_tile } from "./commands";
import { createLedgerState, type LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import { run_checkpoints, type SimState } from "./scheduler";
import { advanceOneTick, createTimeState, type TimeState } from "./time";
import { GRID_HEIGHT, GRID_WIDTH, type WorldState } from "./world";

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
		const time = createTimeState();
		const world: WorldState = {
			towerId,
			name,
			width: GRID_WIDTH,
			height: GRID_HEIGHT,
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
			placed_objects: {},
			sidecars: [],
		};
		const ledger = createLedgerState(STARTING_CASH);
		return new TowerSim(time, world, ledger);
	}

	static from_snapshot(snap: SimSnapshot): TowerSim {
		// Migrate old saves that have a flat WorldState without placed_objects
		if (snap.world.height < GRID_HEIGHT) snap.world.height = GRID_HEIGHT;
		snap.world.placed_objects ??= {};
		snap.world.sidecars ??= [];

		// Migrate old saves that stored cash in world instead of ledger
		if (!snap.ledger) {
			const old = snap.world as unknown as Record<string, unknown>;
			const cash = (old.cash as number) ?? STARTING_CASH;
			snap.ledger = createLedgerState(cash);
			delete (snap.world as unknown as Record<string, unknown>).cash;
		}

		return new TowerSim(snap.time, snap.world, snap.ledger);
	}

	// ── Tick ──────────────────────────────────────────────────────────────────

	step(): StepResult {
		const prev_tick = this.time.day_tick;
		const balanceBefore = this.ledger.cash_balance;

		const { time } = advanceOneTick(this.time);
		this.time = time;
		const curr_tick = this.time.day_tick;

		const state: SimState = {
			time: this.time,
			world: this.world,
			ledger: this.ledger,
		};
		run_checkpoints(state, prev_tick, curr_tick);

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
