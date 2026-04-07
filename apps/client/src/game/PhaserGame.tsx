import Phaser from "phaser";
import { useEffect, useRef } from "react";
import { GameScene } from "./GameScene";

interface Props {
	onCellClick: (x: number, y: number, shift: boolean) => void;
	selectedTool: string;
	sceneRef: React.MutableRefObject<GameScene | null>;
}

export function PhaserGame({ onCellClick, selectedTool, sceneRef }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const gameRef = useRef<Phaser.Game | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const scene = new GameScene();
		sceneRef.current = scene;

		const config: Phaser.Types.Core.GameConfig = {
			type: Phaser.AUTO,
			parent: containerRef.current,
			backgroundColor: "#1a3050",
			scale: {
				mode: Phaser.Scale.RESIZE,
				autoCenter: Phaser.Scale.CENTER_BOTH,
				width: "100%",
				height: "100%",
			},
			scene,
			disableContextMenu: false,
		};

		gameRef.current = new Phaser.Game(config);

		return () => {
			sceneRef.current = null;
			gameRef.current?.destroy(true);
			gameRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sceneRef]);

	useEffect(() => {
		sceneRef.current?.setOnCellClick(onCellClick);
	}, [onCellClick, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setSelectedTool(selectedTool);
	}, [selectedTool, sceneRef]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
