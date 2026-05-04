import { getInputDelayTicks } from "../../../worker/src/durable-objects/lockstep";
import type { SimCommand } from "../../../worker/src/sim/commands";
import {
	type CarrierPendingRoute,
	type CarrierRecord,
	type SimRecord,
	type SimSnapshot,
	simKey,
	TowerSim,
} from "../../../worker/src/sim/index";
import type {
	CarrierCarStateData,
	CellData,
	ResolvedInputBatch,
	SimStateData,
} from "../types";

export type QueueLocalBatchResult =
	| { ok: true; targetTick: number }
	| { ok: false; reason: string };

export type SimPendingRoute = {
	carrier: CarrierRecord;
	route: CarrierPendingRoute;
};
export type PendingBySimId = ReadonlyMap<string, SimPendingRoute>;

const EMPTY_SIMS: readonly SimRecord[] = [];
const EMPTY_CARRIERS: readonly CarrierRecord[] = [];
const EMPTY_PENDING: PendingBySimId = new Map();

const BASE_TICK_INTERVAL_MS = 50;
const REPLAY_CHUNK_TICKS = 32;

function cloneSnapshot(snapshot: SimSnapshot): SimSnapshot {
	return structuredClone(snapshot);
}

type RenderState = {
	simTime: number;
	cash: number;
	population: number;
	starCount: number;
	cells: CellData[];
};

type SessionSettings = {
	freeBuild: boolean;
	speedMultiplier: 1 | 3 | 10;
	paused: boolean;
};

type PendingLocalBatch = {
	clientSeq: number;
	inputs: SimCommand[];
	predictedTick: number;
};

type AuthoritativeFrame = {
	serverTick: number;
	batches: ResolvedInputBatch[];
};

type TickUpdate = Omit<RenderState, "cells"> & {
	cellPatches: CellData[];
	receivedAtMs: number;
	tickIntervalMs: number;
};

interface TowerLockstepSessionOptions {
	playerId: string;
	onReset: (state: RenderState, timing: { receivedAtMs: number }) => void;
	onTick: (state: TickUpdate) => void;
}

export class TowerLockstepSession {
	private readonly playerId: string;
	private readonly onReset: TowerLockstepSessionOptions["onReset"];
	private readonly onTick: TowerLockstepSessionOptions["onTick"];
	private sim: TowerSim | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private baseSnapshot: SimSnapshot | null = null;
	private baseTick = 0;
	private predictedTick = 0;
	private settings: SessionSettings = {
		freeBuild: false,
		speedMultiplier: 1,
		paused: false,
	};
	private readonly authoritativeFrames = new Map<number, AuthoritativeFrame>();
	private readonly pendingLocalBatches = new Map<number, PendingLocalBatch>();
	private pendingBySimIdCache: Map<string, SimPendingRoute> | null = null;
	private simStateCache: Map<string, SimStateData> | null = null;
	private flushHandle: ReturnType<typeof setTimeout> | null = null;
	private replayInProgress = false;
	private replayChunkHandle: ReturnType<typeof setTimeout> | null = null;

	constructor({ playerId, onReset, onTick }: TowerLockstepSessionOptions) {
		this.playerId = playerId;
		this.onReset = onReset;
		this.onTick = onTick;
	}

	initialize(snapshot: SimSnapshot, settings: SessionSettings): void {
		this.baseSnapshot = cloneSnapshot(snapshot);
		this.baseTick = this.baseSnapshot.time.totalTicks;
		this.predictedTick = this.baseTick;
		this.settings = settings;
		this.authoritativeFrames.clear();
		this.pendingLocalBatches.clear();
		this.sim = TowerSim.fromSnapshot(this.baseSnapshot);
		this.sim.freeBuild = settings.freeBuild;
		this.pendingBySimIdCache = null;
		this.simStateCache = null;
		this.emitReset();
		this.restartTimer();
	}

	dispose(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.flushHandle !== null) {
			clearTimeout(this.flushHandle);
			this.flushHandle = null;
		}
		if (this.replayChunkHandle !== null) {
			clearTimeout(this.replayChunkHandle);
			this.replayChunkHandle = null;
		}
		this.replayInProgress = false;
	}

	updateSettings(settings: Partial<SessionSettings>): void {
		this.settings = {
			...this.settings,
			...settings,
		};
		if (this.sim) {
			this.sim.freeBuild = this.settings.freeBuild;
		}
		if (
			settings.speedMultiplier !== undefined ||
			settings.paused !== undefined
		) {
			this.restartTimer();
		}
	}

	applyCheckpoint(snapshot: SimSnapshot, settings: SessionSettings): void {
		this.baseSnapshot = cloneSnapshot(snapshot);
		this.baseTick = this.baseSnapshot.time.totalTicks;
		this.settings = settings;
		for (const tick of [...this.authoritativeFrames.keys()]) {
			if (tick <= this.baseTick) {
				this.authoritativeFrames.delete(tick);
			}
		}
		for (const [clientSeq, batch] of this.pendingLocalBatches) {
			if (batch.predictedTick <= this.baseTick) {
				this.pendingLocalBatches.delete(clientSeq);
			}
		}
		this.scheduleFlush();
	}

	applyAuthoritativeBatch(frame: AuthoritativeFrame): void {
		if (frame.serverTick <= this.baseTick) {
			return;
		}
		this.authoritativeFrames.set(frame.serverTick, frame);
		for (const batch of frame.batches) {
			if (batch.playerId === this.playerId) {
				this.pendingLocalBatches.delete(batch.clientSeq);
			}
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushHandle !== null) {
			return;
		}
		this.flushHandle = setTimeout(() => {
			this.flushHandle = null;
			this.flushPendingFrames();
		}, 0);
	}

	private flushPendingFrames(): void {
		if (!this.baseSnapshot) {
			return;
		}
		if (this.replayInProgress) {
			// A replay is already running; it will pick up new frames when it
			// completes via the trailing scheduleFlush().
			return;
		}
		let target = Math.max(this.predictedTick, this.baseTick);
		for (const tick of this.authoritativeFrames.keys()) {
			if (tick > target) {
				target = tick;
			}
		}
		this.startReplay(target);
	}

	private startReplay(initialTarget: number): void {
		if (!this.baseSnapshot) {
			return;
		}
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.replayInProgress = true;
		const sim = TowerSim.fromSnapshot(this.baseSnapshot);
		sim.freeBuild = this.settings.freeBuild;
		const baseTickAtStart = this.baseTick;
		let cursor = baseTickAtStart;
		let target = initialTarget;

		const finish = () => {
			this.sim = sim;
			this.predictedTick = Math.max(cursor, this.baseTick);
			this.pendingBySimIdCache = null;
			this.simStateCache = null;
			this.replayInProgress = false;
			this.replayChunkHandle = null;
			this.emitReset();
			this.restartTimer();
			// Pick up any frames that arrived during the replay.
			if (this.shouldFlushAfterReplay(cursor)) {
				this.scheduleFlush();
			}
		};

		const runChunk = () => {
			this.replayChunkHandle = null;
			if (this.baseTick !== baseTickAtStart || !this.baseSnapshot) {
				// A checkpoint landed mid-replay — abandon this run; the
				// trailing scheduleFlush from applyCheckpoint will start fresh.
				this.replayInProgress = false;
				this.scheduleFlush();
				return;
			}
			// Authoritative frames may have advanced the target while we were
			// yielding back to the event loop.
			for (const tick of this.authoritativeFrames.keys()) {
				if (tick > target) {
					target = tick;
				}
			}
			const chunkEnd = Math.min(cursor + REPLAY_CHUNK_TICKS, target);
			for (let tick = cursor + 1; tick <= chunkEnd; tick += 1) {
				this.applyInputsForTick(
					null,
					this.authoritativeFrames.get(tick)?.batches ?? [],
					(batch) => batch.inputs,
					sim,
				);
				this.applyInputsForTick(
					null,
					[...this.pendingLocalBatches.values()],
					(batch) => (batch.predictedTick === tick ? batch.inputs : []),
					sim,
				);
				sim.step();
			}
			cursor = chunkEnd;
			if (cursor >= target) {
				finish();
				return;
			}
			this.replayChunkHandle = setTimeout(runChunk, 0);
		};

		runChunk();
	}

	private shouldFlushAfterReplay(cursor: number): boolean {
		for (const tick of this.authoritativeFrames.keys()) {
			if (tick > cursor) {
				return true;
			}
		}
		return false;
	}

	queueLocalBatch(
		clientSeq: number,
		inputs: SimCommand[],
	): QueueLocalBatchResult {
		if (inputs.length === 0 || !this.sim) {
			return { ok: false, reason: "Empty batch" };
		}
		const preview = TowerSim.fromSnapshot(this.sim.saveState());
		preview.freeBuild = this.settings.freeBuild;
		const targetTick =
			this.predictedTick + getInputDelayTicks(this.settings.speedMultiplier);
		const queuedForTick = [...this.pendingLocalBatches.values()]
			.filter((batch) => batch.predictedTick === targetTick)
			.sort((left, right) => left.clientSeq - right.clientSeq);
		for (const batch of queuedForTick) {
			for (const command of batch.inputs) {
				preview.submitCommand(command);
			}
		}
		for (const command of inputs) {
			const result = preview.submitCommand(command);
			if (!result.accepted) {
				return { ok: false, reason: result.reason ?? "Command rejected" };
			}
		}
		this.pendingLocalBatches.set(clientSeq, {
			clientSeq,
			inputs,
			predictedTick: targetTick,
		});
		return { ok: true, targetTick };
	}

	setStarCount(starCount: 1 | 2 | 3 | 4 | 5 | 6): void {
		if (!this.sim) {
			return;
		}
		this.sim.setStarCount(starCount);
		this.emitReset();
	}

	private restartTimer(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (!this.sim) {
			return;
		}
		if (this.settings.paused) {
			return;
		}
		const interval = Math.max(
			1,
			Math.round(BASE_TICK_INTERVAL_MS / this.settings.speedMultiplier),
		);
		this.timer = setInterval(() => {
			this.advanceOneTick();
		}, interval);
	}

	private advanceOneTick(): void {
		if (!this.sim) {
			return;
		}
		this.predictedTick += 1;
		const cellPatches: CellData[] = [];
		this.applyInputsForTick(
			cellPatches,
			this.authoritativeFrames.get(this.predictedTick)?.batches ?? [],
			(batch) => batch.inputs,
		);
		this.applyInputsForTick(
			cellPatches,
			[...this.pendingLocalBatches.values()],
			(batch) =>
				batch.predictedTick === this.predictedTick ? batch.inputs : [],
		);
		const stepResult = this.sim.step();
		cellPatches.push(...stepResult.cellPatches);
		this.pendingBySimIdCache = null;
		this.simStateCache = null;
		this.emitTick(cellPatches);
	}

	private applyInputsForTick<TBatch>(
		cellPatches: CellData[] | null,
		batches: TBatch[],
		getInputs: (batch: TBatch) => SimCommand[],
		sim = this.sim,
	): void {
		if (!sim) {
			return;
		}
		for (const batch of batches) {
			for (const command of getInputs(batch)) {
				const result = sim.submitCommand(command);
				if (!result.accepted || !cellPatches) {
					continue;
				}
				cellPatches.push(...(result.patch ?? []));
			}
		}
	}

	private emitReset(): void {
		if (!this.sim) {
			return;
		}
		this.onReset(this.captureState(), {
			receivedAtMs: performance.now(),
		});
	}

	private emitTick(cellPatches: CellData[]): void {
		if (!this.sim) {
			return;
		}
		this.onTick({
			simTime: this.sim.simTime,
			cash: this.sim.cash,
			population: this.sim.currentPopulation,
			starCount: this.sim.starCount,
			cellPatches,
			receivedAtMs: performance.now(),
			tickIntervalMs: BASE_TICK_INTERVAL_MS / this.settings.speedMultiplier,
		});
	}

	private captureState(): RenderState {
		if (!this.sim) {
			throw new Error("Lockstep session not initialized");
		}
		return {
			simTime: this.sim.simTime,
			cash: this.sim.cash,
			population: this.sim.currentPopulation,
			starCount: this.sim.starCount,
			cells: this.sim.cellsToArray(),
		};
	}

	simsSnapshot(): SimStateData[] {
		return this.sim?.simsToArray() ?? [];
	}

	carriersSnapshot(): CarrierCarStateData[] {
		return this.sim?.carriersToArray() ?? [];
	}

	peekSims(): readonly SimRecord[] {
		return this.sim?.liveSims ?? EMPTY_SIMS;
	}

	peekCarriers(): readonly CarrierRecord[] {
		return this.sim?.liveCarriers ?? EMPTY_CARRIERS;
	}

	peekFireFronts(): {
		fireLeftPos: readonly number[];
		fireRightPos: readonly number[];
	} | null {
		return this.sim?.fireFronts ?? null;
	}

	materializeSim(sim: SimRecord): SimStateData | null {
		if (!this.sim) return null;
		if (!this.simStateCache) {
			this.simStateCache = new Map(
				this.sim.simsToArray().map((record) => [record.id, record]),
			);
		}
		return this.simStateCache.get(simKey(sim)) ?? null;
	}

	peekPendingBySimId(): PendingBySimId {
		if (!this.sim) return EMPTY_PENDING;
		if (!this.pendingBySimIdCache) {
			const map = new Map<string, SimPendingRoute>();
			for (const carrier of this.sim.liveCarriers) {
				for (const route of carrier.pendingRoutes) {
					map.set(route.simId, { carrier, route });
				}
			}
			this.pendingBySimIdCache = map;
		}
		return this.pendingBySimIdCache;
	}
}
