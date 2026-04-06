import { Hono } from "hono";
import { cors } from "hono/cors";
import { TowerRegistry } from "./durable-objects/TowerRegistry";
import { TowerRoom } from "./durable-objects/TowerRoom";
import { towersRouter } from "./routes/towers";

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
	const stub = c.env.TOWER_ROOM.get(c.env.TOWER_ROOM.idFromName(towerId));
	return stub.fetch(c.req.raw);
});

// Resolve an alias or tower ID to a tower ID
app.get("/api/resolve/:slug", async (c) => {
	const slug = c.req.param("slug");

	// Try as a direct tower ID first
	const roomStub = c.env.TOWER_ROOM.get(c.env.TOWER_ROOM.idFromName(slug));
	const infoRes = await roomStub.fetch("http://do/info");
	if (infoRes.ok) {
		return c.json({ towerId: slug });
	}

	// Try as an alias
	const registry = c.env.TOWER_REGISTRY.get(
		c.env.TOWER_REGISTRY.idFromName("global"),
	);
	const resolveUrl = new URL("http://do/resolve");
	resolveUrl.searchParams.set("alias", slug);
	const res = await registry.fetch(resolveUrl.toString());
	if (res.ok) {
		const data = (await res.json()) as { towerId: string };
		return c.json({ towerId: data.towerId });
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
			{ error: "Alias must be lowercase alphanumeric, hyphens, or underscores" },
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
	const roomStub = c.env.TOWER_ROOM.get(
		c.env.TOWER_ROOM.idFromName(towerId),
	);
	const infoRes = await roomStub.fetch("http://do/info");
	if (!infoRes.ok) {
		return c.json({ error: "Tower not found" }, 404);
	}

	// Register the alias
	const registry = c.env.TOWER_REGISTRY.get(
		c.env.TOWER_REGISTRY.idFromName("global"),
	);
	const setUrl = new URL("http://do/set-alias");
	setUrl.searchParams.set("alias", alias);
	setUrl.searchParams.set("towerId", towerId);
	const res = await registry.fetch(setUrl.toString(), { method: "PUT" });
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		return c.json({ error: err.error }, res.status as 409);
	}

	return c.json({ alias, towerId });
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", towersRouter);

export default app;
export { TowerRoom, TowerRegistry };
