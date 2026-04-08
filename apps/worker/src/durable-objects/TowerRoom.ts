import { DurableObject } from "cloudflare:workers";
import { runMigrations } from "../db/migrations";
import { type SimSnapshot, TowerSim } from "../sim/index";
import { createLedgerState } from "../sim/ledger";
import type { ClientMessage, ServerMessage } from "../types";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
}

export class TowerRoom extends DurableObject<Env> {
	private sim: TowerSim | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;
	private sockets: Set<WebSocket> = new Set();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		runMigrations(this.ctx.storage.sql);
	}

	// ─── Persistence ────────────────────────────────────────────────────────────

	private async initializeTower(towerId: string, name: string): Promise<void> {
		this.sim = TowerSim.create(towerId, name);
		this.persistSim();
	}

	private loadSim(): TowerSim | null {
		const cursor = this.ctx.storage.sql.exec(
			"SELECT value FROM tower WHERE key = ?",
			"state",
		);
		const row = cursor.toArray()[0] as { value: string } | undefined;
		if (!row) return null;
		const snap = JSON.parse(row.value) as SimSnapshot;
		// Back-compat: old saves were a flat TowerState, not { time, world }
		const old = snap as unknown as Record<string, unknown>;
		if (!snap.world) {
			snap.world = {
				towerId: old.towerId as string,
				name: old.name as string,
				width: (old.width as number) ?? 64,
				height: (old.height as number) ?? 120,
				cells: (old.cells as Record<string, string>) ?? {},
				cellToAnchor: (old.cellToAnchor as Record<string, string>) ?? {},
				overlays: (old.overlays as Record<string, string>) ?? {},
				overlayToAnchor: (old.overlayToAnchor as Record<string, string>) ?? {},
				placed_objects: {},
				sidecars: [],
			};
			// cash lived at the flat root in the oldest save format; migrate to ledger
			if (!snap.ledger) {
				snap.ledger = createLedgerState((old.cash as number) ?? 2_000_000);
			}
		}
		if (!snap.time) {
			snap.time = {
				day_tick: 0,
				daypart_index: 0,
				day_counter: 0,
				calendar_phase_flag: 0,
				star_count: 1,
				total_ticks: (old.simTime as number) ?? 0,
			};
		}
		return TowerSim.from_snapshot(snap);
	}

	private persistSim(): void {
		if (!this.sim) return;
		const snap = this.sim.save_state();
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO tower VALUES (?, ?)",
			"state",
			JSON.stringify(snap),
		);
	}

	// ─── HTTP fetch handler ──────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();
			this.sockets.add(server);

			server.addEventListener("message", (evt: MessageEvent) => {
				this.handleMessage(server, evt.data as string | ArrayBuffer);
			});
			server.addEventListener("close", () => {
				this.sockets.delete(server);
				this.handleClose();
			});
			server.addEventListener("error", () => {
				this.sockets.delete(server);
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
				playerCount: this.sockets.size,
			});
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}

	// ─── WebSocket message handling ──────────────────────────────────────────────

	private handleMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(
				typeof raw === "string" ? raw : new TextDecoder().decode(raw),
			) as ClientMessage;
		} catch {
			return;
		}

		if (!this.sim) this.sim = this.loadSim();
		if (!this.sim) {
			this.sendTo(ws, {
				type: "command_result",
				accepted: false,
				reason: "Tower not initialized",
			});
			return;
		}

		if (msg.type === "join_tower") {
			this.sendTo(ws, {
				type: "init_state",
				towerId: this.sim.towerId,
				name: this.sim.name,
				simTime: this.sim.simTime,
				cash: this.sim.cash,
				width: this.sim.width,
				height: this.sim.height,
				cells: this.sim.cellsToArray(),
			});
			this.broadcast({
				type: "presence_update",
				playerCount: this.sockets.size,
			});
			if (!this.isRunning) {
				this.isRunning = true;
				this.startTick();
			}
			return;
		}

		if (msg.type === "ping") {
			this.sendTo(ws, { type: "pong" });
			return;
		}

		// Command (place_tile / remove_tile)
		const result = this.sim.submit_command(msg);
		if (!result.accepted) {
			this.sendTo(ws, {
				type: "command_result",
				accepted: false,
				reason: result.reason,
			});
			return;
		}

		const patch = result.patch ?? [];
		this.broadcast({ type: "state_patch", cells: patch });
		this.sendTo(ws, {
			type: "command_result",
			accepted: true,
			patch: { cells: patch },
		});
		if (result.economyChanged) {
			this.broadcast({ type: "economy_update", cash: this.sim.cash });
		}
		this.persistSim();
	}

	private handleClose(): void {
		if (this.sockets.size === 0) {
			this.isRunning = false;
			this.stopTick();
			this.persistSim();
		} else {
			this.broadcast({
				type: "presence_update",
				playerCount: this.sockets.size,
			});
		}
	}

	// ─── Sim tick ────────────────────────────────────────────────────────────────

	private startTick(): void {
		if (this.tickTimer !== null) return;
		this.tickTimer = setInterval(() => this.tick(), 1000);
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
		if (result.economyChanged) {
			this.broadcast({ type: "economy_update", cash: this.sim.cash });
		}

		// Persist every 30 ticks
		if (result.simTime % 30 === 0) this.persistSim();
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
		for (const ws of this.sockets) {
			if (ws !== exclude) this.sendTo(ws, msg);
		}
	}

	private sendTo(ws: WebSocket, msg: ServerMessage): void {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket already closed */
		}
	}
}
