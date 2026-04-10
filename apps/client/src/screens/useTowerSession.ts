import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import type { TowerSocket } from "../lib/socket";
import type {
	CarrierCarStateData,
	ConnectionStatus,
	EntityStateData,
	ServerMessage,
} from "../types";
import type { ActivePrompt, CellInfoData } from "./gameScreenTypes";

interface UseTowerSessionOptions {
	playerId: string;
	displayName: string;
	socket: TowerSocket;
	sceneRef: React.MutableRefObject<GameScene | null>;
	addToast: (message: string, variant?: "error" | "info") => void;
}

interface UseTowerSessionResult {
	connectionStatus: ConnectionStatus;
	simTime: number;
	cash: number;
	playerCount: number;
	towerName: string;
	setTowerName: (value: string) => void;
	entities: EntityStateData[];
	carriers: CarrierCarStateData[];
	speedMultiplier: 1 | 3 | 10;
	activePrompt: ActivePrompt | null;
	inspectedCell: CellInfoData | null;
	setInspectedCell: React.Dispatch<React.SetStateAction<CellInfoData | null>>;
	sendTileCommand: (
		x: number,
		y: number,
		tileType: string,
		shift: boolean,
	) => void;
	inspectCell: (x: number, y: number) => void;
	respondToPrompt: (accepted: boolean) => void;
	setSpeedMultiplier: (multiplier: 1 | 3 | 10) => void;
	setRentLevel: (x: number, y: number, rentLevel: number) => void;
	addElevatorCar: (x: number) => void;
	removeElevatorCar: (x: number) => void;
	reconnect: () => void;
}

const DEFAULT_TICK_INTERVAL_MS = 50;

export function useTowerSession({
	playerId,
	displayName,
	socket,
	sceneRef,
	addToast,
}: UseTowerSessionOptions): UseTowerSessionResult {
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [simTime, setSimTime] = useState(0);
	const [cash, setCash] = useState(0);
	const [playerCount, setPlayerCount] = useState(0);
	const [towerName, setTowerName] = useState("");
	const [entities, setEntities] = useState<EntityStateData[]>([]);
	const [carriers, setCarriers] = useState<CarrierCarStateData[]>([]);
	const [speedMultiplier, setSpeedMultiplierState] = useState<1 | 3 | 10>(1);
	const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
	const [inspectedCell, setInspectedCell] = useState<CellInfoData | null>(null);
	const clockSampleRef = useRef<{
		simTime: number;
		receivedAtMs: number;
		tickIntervalMs: number;
	} | null>(null);

	const updatePresentationClock = useCallback(
		(nextSimTime: number) => {
			const receivedAtMs = performance.now();
			const previous = clockSampleRef.current;
			let tickIntervalMs = previous?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
			if (previous && nextSimTime > previous.simTime) {
				tickIntervalMs =
					(receivedAtMs - previous.receivedAtMs) /
					(nextSimTime - previous.simTime);
			}
			if (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
				tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
			}
			clockSampleRef.current = {
				simTime: nextSimTime,
				receivedAtMs,
				tickIntervalMs,
			};
			sceneRef.current?.setPresentationClock(
				nextSimTime,
				receivedAtMs,
				tickIntervalMs,
			);
		},
		[sceneRef],
	);

	useEffect(() => {
		return socket.onMessage((msg: ServerMessage) => {
			switch (msg.type) {
				case "init_state":
					setSimTime(msg.simTime);
					updatePresentationClock(msg.simTime);
					setCash(msg.cash);
					setTowerName(msg.name || msg.towerId);
					setEntities(msg.entities);
					setCarriers(msg.carriers);
					sceneRef.current?.applyInitState(
						msg.cells,
						msg.simTime,
						msg.entities,
						msg.carriers,
					);
					break;
				case "state_patch":
					sceneRef.current?.applyPatch(msg.cells);
					break;
				case "entity_update":
					setEntities(msg.entities);
					sceneRef.current?.applyEntities(msg.simTime, msg.entities);
					break;
				case "carrier_update":
					setCarriers(msg.carriers);
					sceneRef.current?.applyCarriers(msg.simTime, msg.carriers);
					break;
				case "command_result":
					if (msg.accepted && msg.patch) {
						sceneRef.current?.applyPatch(msg.patch.cells);
					} else if (!msg.accepted && msg.reason) {
						addToast(msg.reason);
					}
					break;
				case "presence_update":
					setPlayerCount(msg.playerCount);
					break;
				case "time_update":
					setSimTime(msg.simTime);
					updatePresentationClock(msg.simTime);
					break;
				case "economy_update":
					setCash(msg.cash);
					break;
				case "notification":
					if (msg.message) addToast(msg.message, "info");
					break;
				case "prompt":
					setActivePrompt({
						promptId: msg.promptId,
						promptKind: msg.promptKind,
						message: msg.message,
						cost: msg.cost,
					});
					break;
				case "prompt_dismissed":
					setActivePrompt((prev) =>
						prev?.promptId === msg.promptId ? null : prev,
					);
					break;
				case "cell_info":
					setInspectedCell({
						x: msg.x,
						y: msg.y,
						tileType: msg.tileType,
						objectInfo: msg.objectInfo,
						carrierInfo: msg.carrierInfo,
					});
					break;
			}
		});
	}, [addToast, sceneRef, socket, updatePresentationClock]);

	useEffect(() => {
		return socket.onStatus((status: ConnectionStatus) => {
			setConnectionStatus(status);
			if (status === "connected") {
				socket.send({ type: "join_tower", playerId, displayName });
			}
		});
	}, [displayName, playerId, socket]);

	const sendTileCommand = useCallback(
		(x: number, y: number, tileType: string, shift: boolean) => {
			if (tileType === "empty") {
				socket.send({ type: "remove_tile", x, y });
				return;
			}

			if (shift) {
				const fills = sceneRef.current?.computeShiftFill(x, y) ?? [];
				for (const pos of fills) {
					socket.send({
						type: "place_tile",
						x: pos.x,
						y: pos.y,
						tileType,
					});
				}
				if (fills.length > 0) {
					const last = fills[fills.length - 1];
					sceneRef.current?.setLastPlaced(last.x, last.y, tileType);
				}
				return;
			}

			socket.send({ type: "place_tile", x, y, tileType });
			sceneRef.current?.setLastPlaced(x, y, tileType);
		},
		[sceneRef, socket],
	);

	const inspectCell = useCallback(
		(x: number, y: number) => {
			socket.send({ type: "query_cell", x, y });
		},
		[socket],
	);

	const respondToPrompt = useCallback(
		(accepted: boolean) => {
			if (!activePrompt) return;
			socket.send({
				type: "prompt_response",
				promptId: activePrompt.promptId,
				accepted,
			});
			setActivePrompt(null);
		},
		[activePrompt, socket],
	);

	const setSpeedMultiplier = useCallback(
		(multiplier: 1 | 3 | 10) => {
			setSpeedMultiplierState(multiplier);
			socket.send({
				type: "set_speed",
				multiplier,
			});
		},
		[socket],
	);

	const setRentLevel = useCallback(
		(x: number, y: number, rentLevel: number) => {
			socket.send({ type: "set_rent_level", x, y, rentLevel });
		},
		[socket],
	);

	const addElevatorCar = useCallback(
		(x: number) => {
			socket.send({ type: "add_elevator_car", x });
		},
		[socket],
	);

	const removeElevatorCar = useCallback(
		(x: number) => {
			socket.send({ type: "remove_elevator_car", x });
		},
		[socket],
	);

	const reconnect = useCallback(() => {
		socket.reconnect();
	}, [socket]);

	return {
		connectionStatus,
		simTime,
		cash,
		playerCount,
		towerName,
		setTowerName,
		entities,
		carriers,
		speedMultiplier,
		activePrompt,
		inspectedCell,
		setInspectedCell,
		sendTileCommand,
		inspectCell,
		respondToPrompt,
		setSpeedMultiplier,
		setRentLevel,
		addElevatorCar,
		removeElevatorCar,
		reconnect,
	};
}
