import { tickAllCarriers } from "./carriers";
import type { CellPatch, CommandResult, SimCommand } from "./commands";
import {
	handleAddElevatorCar,
	handlePlaceTile,
	handleRemoveElevatorCar,
	handleRemoveTile,
	handleSetRentLevel,
} from "./commands";
import {
	handlePromptResponse,
	tickBombEvent,
	tickFireEvent,
	tickVipSpecialVisitor,
	triggerRandomNewsEvent,
} from "./events";
import type { LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import { runCheckpoints, type SimState } from "./scheduler";
import {
	advanceSimRefreshStride,
	createSimStateRecords,
	onCarrierArrival,
	populateCarrierRequests,
	reconcileSimTransport,
} from "./sims";
import {
	createInitialSnapshot,
	hydrateSnapshot,
	type SimSnapshot,
	serializeSimState,
} from "./snapshot";
import { advanceOneTick, type TimeState } from "./time";
import type { WorldState } from "./world";

export type { SimStateRecord } from "./sims";
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
	cellPatches: CellPatch[];
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
	freeBuild = false;

	private constructor(time: TimeState, world: WorldState, ledger: LedgerState) {
		this.time = time;
		this.world = world;
		this.ledger = ledger;
	}

	// ── Factory methods ────────────────────────────────────────────────────────

	static create(towerId: string, name: string): TowerSim {
		return TowerSim.fromSnapshot(
			createInitialSnapshot(towerId, name, STARTING_CASH),
		);
	}

	static fromSnapshot(snap: SimSnapshot): TowerSim {
		const hydrated = hydrateSnapshot(snap);
		return new TowerSim(hydrated.time, hydrated.world, hydrated.ledger);
	}

	// ── Tick ──────────────────────────────────────────────────────────────────

	step(): StepResult {
		const prevTick = this.time.dayTick;
		const balanceBefore = this.ledger.cashBalance;

		// Snapshot display-facing room fields before tick to detect changes.
		const evalBefore = new Map<string, number>();
		const unitStatusBefore = new Map<string, number>();
		const evalLevelBefore = new Map<string, number>();
		const evalScoreBefore = new Map<string, number>();
		for (const [key, record] of Object.entries(this.world.placedObjects)) {
			evalBefore.set(key, record.evalActiveFlag);
			unitStatusBefore.set(key, record.unitStatus);
			evalLevelBefore.set(key, record.evalLevel);
			evalScoreBefore.set(key, record.evalScore);
		}

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
		runCheckpoints(state, prevTick, currTick);

		// Per-tick event processing
		tickBombEvent(this.world, this.ledger, this.time);
		tickFireEvent(this.world, this.ledger, this.time);

		advanceSimRefreshStride(this.world, this.ledger, this.time);
		populateCarrierRequests(this.world, this.time);
		tickAllCarriers(this.world, this.time, (routeId, arrivalFloor) => {
			onCarrierArrival(
				this.world,
				this.ledger,
				this.time,
				routeId,
				arrivalFloor,
			);
		});
		reconcileSimTransport(this.world, this.ledger, this.time);

		// Emit cell patches for display-facing room state changes.
		const cellPatches: CellPatch[] = [];
		for (const [key, record] of Object.entries(this.world.placedObjects)) {
			const prev = evalBefore.get(key);
			const prevUnitStatus = unitStatusBefore.get(key);
			const prevEvalLevel = evalLevelBefore.get(key);
			const prevEvalScore = evalScoreBefore.get(key);
			if (
				(prev !== undefined && prev !== record.evalActiveFlag) ||
				(prevUnitStatus !== undefined &&
					prevUnitStatus !== record.unitStatus) ||
				(prevEvalLevel !== undefined && prevEvalLevel !== record.evalLevel) ||
				(prevEvalScore !== undefined && prevEvalScore !== record.evalScore)
			) {
				const [x, y] = key.split(",").map(Number);
				cellPatches.push({
					x,
					y,
					tileType: this.world.cells[key] ?? "",
					isAnchor: true,
					evalActiveFlag: record.evalActiveFlag,
					unitStatus: record.unitStatus,
					evalLevel: record.evalLevel,
					evalScore: record.evalScore,
				});
			}
		}

		// Drain pending notifications and prompts
		const notifications = this.world.pendingNotifications.splice(0);
		const prompts = this.world.pendingPrompts.splice(0);

		return {
			simTime: this.time.totalTicks,
			economyChanged: this.ledger.cashBalance !== balanceBefore,
			cellPatches,
			notifications: notifications.map((n) => ({
				kind: n.kind,
				message: n.message ?? "",
			})),
			prompts,
		};
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	submitCommand(cmd: SimCommand): CommandResult {
		switch (cmd.type) {
			case "place_tile":
				return handlePlaceTile(
					cmd.x,
					cmd.y,
					cmd.tileType,
					this.world,
					this.ledger,
					this.freeBuild,
					this.time,
				);
			case "remove_tile":
				return handleRemoveTile(cmd.x, cmd.y, this.world, this.ledger);
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
				return handleSetRentLevel(
					cmd.x,
					cmd.y,
					cmd.rentLevel,
					this.world,
					this.time,
				);
			case "add_elevator_car":
				return handleAddElevatorCar(cmd.x, this.world);
			case "remove_elevator_car":
				return handleRemoveElevatorCar(cmd.x, this.world);
		}
	}

	// ── Cell inspection ──────────────────────────────────────────────────────────

	queryCell(
		x: number,
		y: number,
	): {
		anchorX: number;
		tileType: string;
		objectInfo?: {
			objectTypeCode: number;
			rentLevel: number;
			evalLevel: number;
			unitStatus: number;
			activationTickCount: number;
			venueAvailability?: number;
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
		let venueAvailability: number | undefined;
		if (record && record.linkedRecordIndex >= 0) {
			const sidecar = this.world.sidecars[record.linkedRecordIndex];
			if (sidecar?.kind === "commercial_venue") {
				venueAvailability = sidecar.availabilityState;
			}
		}
		const objectInfo = record
			? {
					objectTypeCode: record.objectTypeCode,
					rentLevel: record.rentLevel,
					evalLevel: record.evalLevel,
					unitStatus: record.unitStatus,
					activationTickCount: record.activationTickCount,
					venueAvailability,
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

		const [anchorXStr] = anchorKey.split(",");
		return { anchorX: Number(anchorXStr), tileType, objectInfo, carrierInfo };
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	saveState(): SimSnapshot {
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
			const isAnchor = !this.world.cellToAnchor[key];
			const record = isAnchor ? this.world.placedObjects[key] : undefined;
			result.push({
				x,
				y,
				tileType,
				isAnchor,
				...(record
					? {
							evalActiveFlag: record.evalActiveFlag,
							unitStatus: record.unitStatus,
							evalLevel: record.evalLevel,
							evalScore: record.evalScore,
						}
					: {}),
			});
		}
		for (const [key, tileType] of Object.entries(this.world.overlays)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: true, isOverlay: true });
		}
		return result;
	}

	simsToArray() {
		return createSimStateRecords(this.world);
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
