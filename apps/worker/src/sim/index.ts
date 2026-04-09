import { init_carrier_state, tick_all_carriers } from "./carriers";
import type { CellPatch, CommandResult, SimCommand } from "./commands";
import { handle_place_tile, handle_remove_tile } from "./commands";
import {
	advance_entity_refresh_stride,
	create_entity_state_records,
	on_carrier_arrival,
	populate_carrier_requests,
	rebuild_runtime_entities,
	reconcile_entity_transport,
} from "./entities";
import { createLedgerState, type LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import {
	rebuild_special_links,
	rebuild_transfer_group_cache,
	rebuild_walkability_flags,
} from "./routing";
import { run_checkpoints, type SimState } from "./scheduler";
import {
	createInitialSnapshot,
	normalizeSnapshot,
	type SimSnapshot,
} from "./snapshot";
import { advanceOneTick, type TimeState } from "./time";
import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_SPECIAL_LINKS,
	MAX_TRANSFER_GROUPS,
	type WorldState,
} from "./world";

export type { EntityStateRecord } from "./entities";
export type { SimSnapshot } from "./snapshot";
export type { CellPatch, CommandResult };

export interface CarrierCarStateRecord {
	carrierId: number;
	carIndex: number;
	carCount: number;
	column: number;
	carrierMode: 0 | 1 | 2;
	currentFloor: number;
	targetFloor: number;
	speedCounter: number;
	doorWaitCounter: number;
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
		return TowerSim.from_snapshot(
			createInitialSnapshot(towerId, name, STARTING_CASH),
		);
	}

	static from_snapshot(snap: SimSnapshot): TowerSim {
		const normalized = normalizeSnapshot(snap);

		// Migrate old saves that have a flat WorldState without placedObjects
		if (normalized.world.height < GRID_HEIGHT)
			normalized.world.height = GRID_HEIGHT;
		normalized.world.placedObjects ??= {};
		normalized.world.sidecars ??= [];
		normalized.world.entities ??= [];

		// Migrate old saves that stored cash in world instead of ledger
		if (!normalized.ledger) {
			const old = normalized.world as unknown as Record<string, unknown>;
			const cash = (old.cash as number) ?? STARTING_CASH;
			normalized.ledger = createLedgerState(cash);
			delete (normalized.world as unknown as Record<string, unknown>).cash;
		}

		// Migrate old saves without Phase 3 carrier/routing fields
		init_carrier_state(normalized.world);
		for (const carrier of normalized.world.carriers) {
			carrier.completedRouteIds ??= [];
			if (
				!Array.isArray(carrier.dwellMultiplierFlags) ||
				carrier.dwellMultiplierFlags.length !== 14
			) {
				carrier.dwellMultiplierFlags = new Array(14).fill(1);
			}
			for (const route of carrier.pendingRoutes ?? []) {
				route.assignedCarIndex ??= -1;
			}
			for (const car of carrier.cars ?? []) {
				car.active ??= true;
				car.pendingAssignmentCount ??= 0;
				car.homeFloor ??= car.currentFloor ?? carrier.bottomServedFloor;
				car.destinationCountByFloor ??= new Array(
					Math.max(0, carrier.topServedFloor - carrier.bottomServedFloor + 1),
				).fill(0);
				car.activeRouteSlots ??= [];
			}
		}
		normalized.world.specialLinks ??= Array.from(
			{ length: MAX_SPECIAL_LINKS },
			() => ({
				active: false,
				flags: 0,
				heightMetric: 0,
				entryFloor: 0,
				reservedByte: 0,
				descendingLoadCounter: 0,
				ascendingLoadCounter: 0,
			}),
		);
		normalized.world.specialLinkRecords ??= Array.from(
			{ length: MAX_SPECIAL_LINK_RECORDS },
			() => ({
				active: false,
				lowerFloor: 0,
				upperFloor: 0,
				reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
			}),
		);
		normalized.world.transferGroupEntries ??= Array.from(
			{ length: MAX_TRANSFER_GROUPS },
			() => ({
				active: false,
				taggedFloor: -1,
				carrierMask: 0,
			}),
		);
		// Migrate entity fields added after initial release
		for (const entity of normalized.world.entities) {
			entity.routeRetryDelay ??= 0;
		}

		// Recompute derived routing state from carriers
		rebuild_special_links(normalized.world);
		rebuild_walkability_flags(normalized.world);
		rebuild_transfer_group_cache(normalized.world);
		rebuild_runtime_entities(normalized.world);

		return new TowerSim(normalized.time, normalized.world, normalized.ledger);
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
		advance_entity_refresh_stride(this.world, this.ledger, this.time);
		populate_carrier_requests(this.world, this.time);
		tick_all_carriers(this.world, this.time, (routeId, arrivalFloor) => {
			on_carrier_arrival(
				this.world,
				this.ledger,
				this.time,
				routeId,
				arrivalFloor,
			);
		});
		reconcile_entity_transport(this.world, this.ledger, this.time);

		return {
			simTime: this.time.totalTicks,
			economyChanged: this.ledger.cashBalance !== balanceBefore,
		};
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	submit_command(cmd: SimCommand): CommandResult {
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
			entities: JSON.parse(
				JSON.stringify(this.world.entities),
			) as WorldState["entities"],
			carriers: JSON.parse(
				JSON.stringify(this.world.carriers),
			) as WorldState["carriers"],
			specialLinks: JSON.parse(
				JSON.stringify(this.world.specialLinks),
			) as WorldState["specialLinks"],
			specialLinkRecords: JSON.parse(
				JSON.stringify(this.world.specialLinkRecords),
			) as WorldState["specialLinkRecords"],
			floorWalkabilityFlags: [...this.world.floorWalkabilityFlags],
			transferGroupEntries: JSON.parse(
				JSON.stringify(this.world.transferGroupEntries),
			) as WorldState["transferGroupEntries"],
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

	entitiesToArray() {
		return create_entity_state_records(this.world);
	}

	carriersToArray(): CarrierCarStateRecord[] {
		return this.world.carriers.flatMap((carrier) =>
			carrier.cars.map((car, carIndex) => ({
				carrierId: carrier.carrierId,
				carIndex,
				carCount: carrier.cars.length,
				column: carrier.column,
				carrierMode: carrier.carrierMode,
				currentFloor: car.currentFloor,
				targetFloor: car.targetFloor,
				speedCounter: car.speedCounter,
				doorWaitCounter: car.doorWaitCounter,
			})),
		);
	}
}
