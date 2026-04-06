import { Hono } from "hono";
import { cors } from "hono/cors";
import { TowerRoom } from "./durable-objects/TowerRoom";
import { towersRouter } from "./routes/towers";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
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

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", towersRouter);

export default app;
export { TowerRoom };
