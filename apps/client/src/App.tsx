import { useEffect, useState } from "react";
import * as socket from "./lib/socket";
import { getDisplayName, getPlayerId } from "./lib/storage";
import { GameScreen } from "./screens/GameScreen";
import { GuestScreen } from "./screens/GuestScreen";
import { LobbyScreen } from "./screens/LobbyScreen";

type Screen = "guest" | "lobby" | "game";

function getSlugFromPath(): string {
	const path = window.location.pathname;
	const match = path.match(/^\/([a-zA-Z0-9_-]+)$/);
	return match ? match[1] : "";
}

async function resolveSlug(slug: string): Promise<string | null> {
	try {
		const res = await fetch(`/api/resolve/${encodeURIComponent(slug)}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { towerId: string };
		return data.towerId;
	} catch {
		return null;
	}
}

export function App() {
	const [screen, setScreen] = useState<Screen>("guest");
	const [playerId, setPlayerId] = useState<string>("");
	const [displayName, setDisplayName] = useState<string>("");
	const [towerId, setTowerId] = useState<string>("");

	// On mount, check stored player and URL path
	useEffect(() => {
		const storedId = getPlayerId();
		const storedName = getDisplayName();
		if (storedId && storedName) {
			setPlayerId(storedId);
			setDisplayName(storedName);
			const slug = getSlugFromPath();
			if (slug) {
				resolveSlug(slug).then((id) => {
					if (id) {
						socket.connect(id);
						setTowerId(id);
						setScreen("game");
					} else {
						setScreen("lobby");
					}
				});
			} else {
				setScreen("lobby");
			}
		}
	}, []);

	// Handle browser back/forward
	useEffect(() => {
		function onPopState() {
			const slug = getSlugFromPath();
			if (slug && playerId) {
				resolveSlug(slug).then((id) => {
					if (id) {
						socket.connect(id);
						setTowerId(id);
						setScreen("game");
					} else {
						socket.disconnect();
						setTowerId("");
						setScreen("lobby");
					}
				});
			} else {
				socket.disconnect();
				setTowerId("");
				setScreen(playerId ? "lobby" : "guest");
			}
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [playerId]);

	function handleGuestEnter(id: string, name: string) {
		setPlayerId(id);
		setDisplayName(name);
		const slug = getSlugFromPath();
		if (slug) {
			resolveSlug(slug).then((resolved) => {
				if (resolved) {
					socket.connect(resolved);
					setTowerId(resolved);
					setScreen("game");
				} else {
					setScreen("lobby");
				}
			});
		} else {
			setScreen("lobby");
		}
	}

	function handleJoinTower(id: string) {
		socket.connect(id);
		setTowerId(id);
		setScreen("game");
		window.history.pushState(null, "", `/${id}`);
	}

	function handleLeaveGame() {
		socket.disconnect();
		setTowerId("");
		setScreen("lobby");
		window.history.pushState(null, "", "/");
	}

	function handleLogout() {
		socket.disconnect();
		setPlayerId("");
		setDisplayName("");
		setTowerId("");
		setScreen("guest");
		window.history.pushState(null, "", "/");
	}

	switch (screen) {
		case "guest":
			return <GuestScreen onEnter={handleGuestEnter} />;
		case "lobby":
			return (
				<LobbyScreen
					displayName={displayName}
					onJoinTower={handleJoinTower}
					onLogout={handleLogout}
				/>
			);
		case "game":
			return (
				<GameScreen
					playerId={playerId}
					displayName={displayName}
					towerId={towerId}
					onLeave={handleLeaveGame}
				/>
			);
	}
}
