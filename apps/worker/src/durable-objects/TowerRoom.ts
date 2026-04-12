import { DurableObject } from "cloudflare:workers";
import {
	isSessionMessage,
	parseClientMessage,
	toSimCommand,
} from "../protocol";
import { TowerSim } from "../sim/index";
import { STARTING_CASH } from "../sim/resources";
import { createInitialSnapshot } from "../sim/snapshot";
import type { ServerMessage } from "../types";
import { TowerRoomRepository } from "./TowerRoomRepository";
import { TowerRoomSessions } from "./TowerRoomSessions";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
}

export class TowerRoom extends DurableObject<Env> {
	private static readonly STATE_BROADCAST_INTERVAL_MS = 100;

	private sim: TowerSim | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private speedMultiplier: 1 | 3 | 10 = 1;
	private isRunning = false;
	private lastStateBroadcastAt = 0;
	private readonly repository: TowerRoomRepository;
	private readonly sessions = new TowerRoomSessions();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.repository = new TowerRoomRepository(this.ctx.storage);
	}

	// ─── Persistence ────────────────────────────────────────────────────────────

	private async initializeTower(towerId: string, name: string): Promise<void> {
		const snapshot = createInitialSnapshot(towerId, name, STARTING_CASH);
		this.repository.initialize(snapshot);
		this.sim = TowerSim.fromSnapshot(snapshot);
	}

	private loadSim(): TowerSim | null {
		const snapshot = this.repository.load();
		return snapshot ? TowerSim.fromSnapshot(snapshot) : null;
	}

	private persistSim(): void {
		if (!this.sim) return;
		this.repository.save(this.sim.saveState());
	}

	// ─── HTTP fetch handler ──────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();
			this.sessions.add(server);

			server.addEventListener("message", (evt: MessageEvent) => {
				this.handleMessage(server, evt.data as string | ArrayBuffer);
			});
			server.addEventListener("close", () => {
				this.sessions.remove(server);
				this.handleClose();
			});
			server.addEventListener("error", () => {
				this.sessions.remove(server);
				this.handleClose();
			});

			return new Response(null, { status: 101, webSocket: client });
		}

		const path = url.pathname;

		if (request.method === "POST" && path === "/init") {
			const towerId = url.searchParams.get("towerId");
			const name = url.searchParams.get("name");
			if (!towerId || !name) {
				return Response.json(
					{ error: "Missing towerId or name" },
					{ status: 400 },
				);
			}
			await this.initializeTower(towerId, name);
			return Response.json({ towerId, name });
		}

		if (request.method === "GET" && path === "/info") {
			const sim = this.sim ?? this.loadSim();
			if (!sim)
				return Response.json({ error: "Tower not found" }, { status: 404 });
			return Response.json({
				towerId: sim.towerId,
				name: sim.name,
				simTime: sim.simTime,
				cash: sim.cash,
				width: sim.width,
				height: sim.height,
				playerCount: this.sessions.size,
			});
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}

	// ─── WebSocket message handling ──────────────────────────────────────────────

	private handleMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		const msg = parseClientMessage(raw);
		if (!msg) return;

		if (!this.sim) this.sim = this.loadSim();
		if (!this.sim) {
			this.sessions.send(ws, {
				type: "command_result",
				accepted: false,
				reason: "Tower not initialized",
			});
			return;
		}

		if (isSessionMessage(msg) && msg.type === "join_tower") {
			this.sessions.send(ws, {
				type: "init_state",
				towerId: this.sim.towerId,
				name: this.sim.name,
				simTime: this.sim.simTime,
				cash: this.sim.cash,
				width: this.sim.width,
				height: this.sim.height,
				cells: this.sim.cellsToArray(),
				sims: this.sim.simsToArray(),
				carriers: this.sim.carriersToArray(),
			});
			this.broadcast({
				type: "presence_update",
				playerCount: this.sessions.size,
			});
			if (!this.isRunning) {
				this.isRunning = true;
				this.startTick();
			}
			return;
		}

		if (isSessionMessage(msg) && msg.type === "ping") {
			this.sessions.send(ws, { type: "pong" });
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_speed") {
			this.speedMultiplier = msg.multiplier;
			if (this.isRunning) this.restartTick();
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_free_build") {
			this.sim.freeBuild = msg.enabled;
			return;
		}

		if (msg.type === "query_cell") {
			const info = this.sim.queryCell(msg.x, msg.y);
			this.sessions.send(ws, {
				type: "cell_info",
				x: msg.x,
				y: msg.y,
				anchorX: info.anchorX,
				tileType: info.tileType,
				objectInfo: info.objectInfo,
				carrierInfo: info.carrierInfo,
			});
			return;
		}

		const command = toSimCommand(msg);
		if (!command) return;

		const result = this.sim.submitCommand(command);
		if (!result.accepted) {
			this.sessions.send(ws, {
				type: "command_result",
				accepted: false,
				reason: result.reason,
			});
			return;
		}

		const patch = result.patch ?? [];
		this.broadcast({ type: "state_patch", cells: patch });
		this.broadcastDynamicState();
		this.sessions.send(ws, {
			type: "command_result",
			accepted: true,
			patch: { cells: patch },
		});
		if (result.economyChanged) {
			this.broadcast({ type: "economy_update", cash: this.sim.cash });
		}
		this.broadcastEffects({
			notifications: this.sim.drainNotifications(),
			prompts: this.sim.drainPrompts(),
		});
		this.persistSim();
	}

	private handleClose(): void {
		if (this.sessions.size === 0) {
			this.isRunning = false;
			this.stopTick();
			this.persistSim();
		} else {
			this.broadcast({
				type: "presence_update",
				playerCount: this.sessions.size,
			});
		}
	}

	// ─── Sim tick ────────────────────────────────────────────────────────────────

	private startTick(): void {
		if (this.tickTimer !== null) return;
		const interval = Math.round(50 / this.speedMultiplier);
		this.tickTimer = setInterval(() => this.tick(), interval);
	}

	private restartTick(): void {
		this.stopTick();
		this.startTick();
	}

	private stopTick(): void {
		if (this.tickTimer !== null) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	private tick(): void {
		if (!this.isRunning || !this.sim) return;

		const result = this.sim.step();
		this.broadcast({ type: "time_update", simTime: result.simTime });
		if (result.cellPatches.length > 0) {
			this.broadcast({ type: "state_patch", cells: result.cellPatches });
		}
		const now = Date.now();
		if (
			now - this.lastStateBroadcastAt >=
			TowerRoom.STATE_BROADCAST_INTERVAL_MS
		) {
			this.broadcastDynamicState(now);
		}
		if (result.economyChanged) {
			this.broadcast({ type: "economy_update", cash: this.sim.cash });
		}
		this.broadcastEffects(result);

		// Persist every 30 ticks
		if (result.simTime % 30 === 0) this.persistSim();
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
		this.sessions.broadcast(msg, exclude);
	}

	private broadcastEffects(result: {
		notifications: Array<{ kind: string; message: string }>;
		prompts: Array<{
			promptId: string;
			promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
			message: string;
			cost?: number;
		}>;
	}): void {
		for (const n of result.notifications) {
			this.broadcast({
				type: "notification",
				kind: n.kind,
				message: n.message,
			});
		}
		for (const p of result.prompts) {
			this.broadcast({
				type: "prompt",
				promptId: p.promptId,
				promptKind: p.promptKind,
				message: p.message,
				cost: p.cost,
			});
		}
	}

	private broadcastDynamicState(now = Date.now()): void {
		if (!this.sim) return;
		this.lastStateBroadcastAt = now;
		this.broadcast({
			type: "sim_update",
			simTime: this.sim.simTime,
			sims: this.sim.simsToArray(),
		});
		this.broadcast({
			type: "carrier_update",
			simTime: this.sim.simTime,
			carriers: this.sim.carriersToArray(),
		});
	}
}
