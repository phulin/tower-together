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

// ─── Snake_case → camelCase migration (pre-rename saves) ────────────────────

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function renameKeysShallow(obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	const o = obj as Record<string, unknown>;
	for (const k of Object.keys(o)) {
		if (k.includes("_")) {
			const camel = snakeToCamel(k);
			if (!(camel in o)) o[camel] = o[k];
			delete o[k];
		}
	}
}

function renameKeysDeep(obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (const item of obj) renameKeysDeep(item);
		return;
	}
	const o = obj as Record<string, unknown>;
	for (const k of Object.keys(o)) {
		if (k.includes("_")) {
			const camel = snakeToCamel(k);
			if (!(camel in o)) o[camel] = o[k];
			delete o[k];
		}
	}
	for (const v of Object.values(o)) renameKeysDeep(v);
}

function migrate_snake_to_camel(snap: SimSnapshot): void {
	if (snap.time) renameKeysShallow(snap.time);
	if (snap.ledger) renameKeysShallow(snap.ledger);
	if (snap.world) {
		// Don't recurse into cells/overlays/cellToAnchor — those are
		// Record<"x,y", string> and rewriting their keys would corrupt them.
		const w = snap.world as unknown as Record<string, unknown>;
		const skipKeys = new Set([
			"cells",
			"overlays",
			"cellToAnchor",
			"overlayToAnchor",
		]);
		renameKeysShallow(w);
		for (const [k, v] of Object.entries(w)) {
			if (!skipKeys.has(k)) renameKeysDeep(v);
		}
	}
}

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
			gateFlags: createGateFlags(),
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
			placedObjects: {},
			sidecars: [],
			carriers: [],
			specialLinks: Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
				active: false,
				flags: 0,
				startFloor: 0,
				heightMetric: 0,
				carrierId: -1,
			})),
			floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
			transferGroupCache: new Array(GRID_HEIGHT).fill(0),
		};
		const ledger = createLedgerState(STARTING_CASH);
		return new TowerSim(time, world, ledger);
	}

	static from_snapshot(snap: SimSnapshot): TowerSim {
		// Migrate snake_case → camelCase field names from pre-rename saves.
		migrate_snake_to_camel(snap);

		// Migrate old saves that have a flat WorldState without placedObjects
		if (snap.world.height < GRID_HEIGHT) snap.world.height = GRID_HEIGHT;
		snap.world.placedObjects ??= {};
		snap.world.sidecars ??= [];
		snap.world.gateFlags ??= createGateFlags();

		// Migrate old saves that stored cash in world instead of ledger
		if (!snap.ledger) {
			const old = snap.world as unknown as Record<string, unknown>;
			const cash = (old.cash as number) ?? STARTING_CASH;
			snap.ledger = createLedgerState(cash);
			delete (snap.world as unknown as Record<string, unknown>).cash;
		}

		// Migrate old saves without Phase 3 carrier/routing fields
		init_carrier_state(snap.world);
		snap.world.specialLinks ??= Array.from(
			{ length: MAX_SPECIAL_LINKS },
			() => ({
				active: false,
				flags: 0,
				startFloor: 0,
				heightMetric: 0,
				carrierId: -1,
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
		const prevTick = this.time.dayTick;
		const balanceBefore = this.ledger.cashBalance;

		const { time } = advanceOneTick(this.time);
		this.time = time;
		const currTick = this.time.dayTick;

		const state: SimState = {
			time: this.time,
			world: this.world,
			ledger: this.ledger,
		};
		run_checkpoints(state, prevTick, currTick);
		tick_all_carriers(this.world);

		return {
			simTime: this.time.totalTicks,
			economyChanged: this.ledger.cashBalance !== balanceBefore,
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
			gateFlags: { ...this.world.gateFlags },
			cells: { ...this.world.cells },
			cellToAnchor: { ...this.world.cellToAnchor },
			overlays: { ...this.world.overlays },
			overlayToAnchor: { ...this.world.overlayToAnchor },
			placedObjects: JSON.parse(
				JSON.stringify(this.world.placedObjects),
			) as WorldState["placedObjects"],
			sidecars: JSON.parse(
				JSON.stringify(this.world.sidecars),
			) as WorldState["sidecars"],
			carriers: JSON.parse(
				JSON.stringify(this.world.carriers),
			) as WorldState["carriers"],
			specialLinks: JSON.parse(
				JSON.stringify(this.world.specialLinks),
			) as WorldState["specialLinks"],
			floorWalkabilityFlags: [...this.world.floorWalkabilityFlags],
			transferGroupCache: [...this.world.transferGroupCache],
		};
	}

	private cloneLedger(): LedgerState {
		return {
			cashBalance: this.ledger.cashBalance,
			primaryLedger: [...this.ledger.primaryLedger],
			secondaryLedger: [...this.ledger.secondaryLedger],
			tertiaryLedger: [...this.ledger.tertiaryLedger],
			cashBalanceCycleBase: this.ledger.cashBalanceCycleBase,
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
		return this.time.totalTicks;
	}
	get cash(): number {
		return this.ledger.cashBalance;
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
