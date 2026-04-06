import { DurableObject } from "cloudflare:workers";

interface Env {
	TOWER_REGISTRY: DurableObjectNamespace;
}

export class TowerRegistry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS aliases (
        alias TEXT PRIMARY KEY,
        tower_id TEXT NOT NULL
      )
    `);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// PUT /set-alias?alias=foo&towerId=abc123
		if (request.method === "PUT" && path === "/set-alias") {
			const alias = url.searchParams.get("alias");
			const towerId = url.searchParams.get("towerId");
			if (!alias || !towerId) {
				return Response.json(
					{ error: "Missing alias or towerId" },
					{ status: 400 },
				);
			}

			// Check if alias is taken by a different tower
			const existing = this.ctx.storage.sql
				.exec("SELECT tower_id FROM aliases WHERE alias = ?", alias)
				.toArray()[0] as { tower_id: string } | undefined;
			if (existing && existing.tower_id !== towerId) {
				return Response.json({ error: "Alias already taken" }, { status: 409 });
			}

			// Remove any previous alias for this tower
			this.ctx.storage.sql.exec(
				"DELETE FROM aliases WHERE tower_id = ?",
				towerId,
			);
			// Set the new alias
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO aliases VALUES (?, ?)",
				alias,
				towerId,
			);
			return Response.json({ alias, towerId });
		}

		// GET /resolve?alias=foo
		if (request.method === "GET" && path === "/resolve") {
			const alias = url.searchParams.get("alias");
			if (!alias) {
				return Response.json({ error: "Missing alias" }, { status: 400 });
			}
			const row = this.ctx.storage.sql
				.exec("SELECT tower_id FROM aliases WHERE alias = ?", alias)
				.toArray()[0] as { tower_id: string } | undefined;
			if (!row) {
				return Response.json({ error: "Not found" }, { status: 404 });
			}
			return Response.json({ towerId: row.tower_id });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}
}
