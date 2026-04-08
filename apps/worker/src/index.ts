import { Hono } from "hono";
import { cors } from "hono/cors";
import { TowerRegistry } from "./durable-objects/TowerRegistry";
import { TowerRoom } from "./durable-objects/TowerRoom";
import { towersRouter } from "./routes/towers";
import {
	assignTowerAlias,
	fetchTowerInfo,
	getTowerRoomStub,
	resolveTowerAlias,
} from "./tower-service";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
	TOWER_REGISTRY: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Skip CORS for WebSocket upgrades (101 responses are immutable)
app.use("*", async (c, next) => {
	if (c.req.header("Upgrade") === "websocket") return next();
	return cors({ origin: "*" })(c, next);
});

// WebSocket route — forward upgrade to Durable Object
app.get("/api/ws/:towerId", async (c) => {
	const towerId = c.req.param("towerId");
	return getTowerRoomStub(c.env, towerId).fetch(c.req.raw);
});

// Resolve an alias or tower ID to a tower ID
app.get("/api/resolve/:slug", async (c) => {
	const slug = c.req.param("slug");

	// Try alias lookup first.
	const aliasRes = await resolveTowerAlias(c.env, slug);
	if (aliasRes.ok) {
		const data = (await aliasRes.json()) as { towerId: string };
		return c.json({ towerId: data.towerId });
	}

	// Fall back to treating the slug as a raw tower ID.
	const towerRes = await fetchTowerInfo(c.env, slug);
	if (towerRes.ok) {
		return c.json({ towerId: slug });
	}

	return c.json({ error: "Not found" }, 404);
});

// Set alias for a tower
app.put("/api/towers/:id/alias", async (c) => {
	const towerId = c.req.param("id");
	const body = await c.req.json<{ alias: string }>();
	const alias = body.alias?.trim().toLowerCase();

	if (!alias || !/^[a-z0-9_-]+$/.test(alias)) {
		return c.json(
			{
				error: "Alias must be lowercase alphanumeric, hyphens, or underscores",
			},
			400,
		);
	}
	if (alias.length < 2 || alias.length > 32) {
		return c.json({ error: "Alias must be 2-32 characters" }, 400);
	}

	// Reserve "api" and "health" to avoid route conflicts
	if (alias === "api" || alias === "health") {
		return c.json({ error: "Reserved name" }, 400);
	}

	// Verify the tower exists
	const infoRes = await fetchTowerInfo(c.env, towerId);
	if (!infoRes.ok) {
		return c.json({ error: "Tower not found" }, 404);
	}

	// Register the alias
	const res = await assignTowerAlias(c.env, alias, towerId);
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		return c.json({ error: err.error }, res.status as 409);
	}

	return c.json({ alias, towerId });
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", towersRouter);

export default app;
export { TowerRegistry, TowerRoom };
