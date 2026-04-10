import { tick_all_carriers } from "./carriers";
import type { CellPatch, CommandResult, SimCommand } from "./commands";
import {
	handle_add_elevator_car,
	handle_place_tile,
	handle_remove_elevator_car,
	handle_remove_tile,
	handle_set_rent_level,
} from "./commands";
import {
	advance_entity_refresh_stride,
	create_entity_state_records,
	on_carrier_arrival,
	populate_carrier_requests,
	reconcile_entity_transport,
} from "./entities";
import {
	handlePromptResponse,
	tickBombEvent,
	tickFireEvent,
	tickVipSpecialVisitor,
	triggerRandomNewsEvent,
} from "./events";
import type { LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import { run_checkpoints, type SimState } from "./scheduler";
import {
	createInitialSnapshot,
	hydrateSnapshot,
	type SimSnapshot,
	serializeSimState,
} from "./snapshot";
import { advanceOneTick, type TimeState } from "./time";
import type { WorldState } from "./world";

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
	notifications: Array<{ kind: string; message: string }>;
	prompts: Array<{
		promptId: string;
		promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
		message: string;
		cost?: number;
	}>;
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
		const hydrated = hydrateSnapshot(snap);
		return new TowerSim(hydrated.time, hydrated.world, hydrated.ledger);
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
		triggerRandomNewsEvent(this.world, this.time);
		tickVipSpecialVisitor(this.world, this.time);
		run_checkpoints(state, prevTick, currTick);

		// Per-tick event processing
		tickBombEvent(this.world, this.ledger, this.time);
		tickFireEvent(this.world, this.ledger, this.time);

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

		// Drain pending notifications and prompts
		const notifications = this.world.pendingNotifications.splice(0);
		const prompts = this.world.pendingPrompts.splice(0);

		return {
			simTime: this.time.totalTicks,
			economyChanged: this.ledger.cashBalance !== balanceBefore,
			notifications: notifications.map((n) => ({
				kind: n.kind,
				message: n.message ?? "",
			})),
			prompts,
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
			case "prompt_response": {
				handlePromptResponse(
					this.world,
					this.ledger,
					this.time,
					cmd.promptId,
					cmd.accepted,
				);
				return {
					accepted: true,
					patch: [],
					economyChanged: true,
				};
			}
			case "set_rent_level":
				return handle_set_rent_level(
					cmd.x,
					cmd.y,
					cmd.rentLevel,
					this.world,
					this.time,
				);
			case "add_elevator_car":
				return handle_add_elevator_car(cmd.x, this.world);
			case "remove_elevator_car":
				return handle_remove_elevator_car(cmd.x, this.world);
		}
	}

	// ── Cell inspection ──────────────────────────────────────────────────────────

	query_cell(
		x: number,
		y: number,
	): {
		tileType: string;
		objectInfo?: {
			objectTypeCode: number;
			rentLevel: number;
			evalLevel: number;
			unitStatus: number;
			activationTickCount: number;
		};
		carrierInfo?: {
			carrierId: number;
			carrierMode: 0 | 1 | 2;
			topServedFloor: number;
			bottomServedFloor: number;
			carCount: number;
			maxCars: number;
			servedFloors: number[];
		};
	} {
		const key = `${x},${y}`;
		const anchorKey = this.world.cellToAnchor[key] ?? key;
		const tileType = this.world.cells[anchorKey] ?? "empty";

		const record = this.world.placedObjects[anchorKey];
		const objectInfo = record
			? {
					objectTypeCode: record.objectTypeCode,
					rentLevel: record.rentLevel,
					evalLevel: record.evalLevel,
					unitStatus: record.unitStatus,
					activationTickCount: record.activationTickCount,
				}
			: undefined;

		// Check for carrier at this column (elevator overlays)
		const overlayKey =
			this.world.overlayToAnchor[key] ??
			(this.world.overlays[key] ? key : null);
		let carrierInfo:
			| {
					carrierId: number;
					carrierMode: 0 | 1 | 2;
					topServedFloor: number;
					bottomServedFloor: number;
					carCount: number;
					maxCars: number;
					servedFloors: number[];
			  }
			| undefined;

		if (overlayKey) {
			const [anchorXStr] = overlayKey.split(",");
			const col = Number(anchorXStr);
			const carrier = this.world.carriers.find((c) => c.column === col);
			if (carrier) {
				const servedFloors: number[] = [];
				for (
					let f = carrier.bottomServedFloor;
					f <= carrier.topServedFloor;
					f++
				) {
					servedFloors.push(f);
				}
				carrierInfo = {
					carrierId: carrier.carrierId,
					carrierMode: carrier.carrierMode,
					topServedFloor: carrier.topServedFloor,
					bottomServedFloor: carrier.bottomServedFloor,
					carCount: carrier.cars.filter((c) => c.active).length,
					maxCars: 8,
					servedFloors,
				};
			}
		}

		return { tileType, objectInfo, carrierInfo };
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	save_state(): SimSnapshot {
		return serializeSimState(this.time, this.world, this.ledger);
	}

	drainNotifications(): Array<{ kind: string; message: string }> {
		return this.world.pendingNotifications
			.splice(0)
			.map((n) => ({ kind: n.kind, message: n.message ?? "" }));
	}

	drainPrompts(): Array<{
		promptId: string;
		promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
		message: string;
		cost?: number;
	}> {
		return this.world.pendingPrompts.splice(0);
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
