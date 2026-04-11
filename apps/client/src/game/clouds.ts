import Phaser from "phaser";
import { GRID_HEIGHT, GRID_WIDTH, UNDERGROUND_Y } from "../types";
import { TILE_HEIGHT, TILE_WIDTH } from "./gameSceneConstants";

const CLOUD_COUNT = 12;
const CLOUD_TEXTURE_COUNT = 12;
/** Lowest floor index where clouds appear (inclusive). */
const CLOUD_MIN_FLOOR = 30;
/** Fixed horizontal drift speed in world pixels per second. */
const CLOUD_SPEED = 20;

/** World-pixel Y corresponding to the bottom of the cloud band. */
const CLOUD_BAND_BOTTOM_Y = (GRID_HEIGHT - 1 - CLOUD_MIN_FLOOR) * TILE_HEIGHT;
/** World-pixel Y corresponding to the top of the world. */
const CLOUD_BAND_TOP_Y = 0;

const SKY_WIDTH = GRID_WIDTH * TILE_WIDTH;
const SKY_HEIGHT = UNDERGROUND_Y * TILE_HEIGHT;

function textureKey(i: number): string {
	return `cloud${String(i).padStart(2, "0")}`;
}

export class CloudManager {
	private scene: Phaser.Scene;
	private depth: number;
	private container!: Phaser.GameObjects.Container;
	private sprites: Phaser.GameObjects.Sprite[] = [];
	private loaded = false;

	constructor(scene: Phaser.Scene, depth: number) {
		this.scene = scene;
		this.depth = depth;
	}

	/** Kick off async texture loading. Call once from Scene.create(). */
	loadTextures(): void {
		for (let i = 1; i <= CLOUD_TEXTURE_COUNT; i++) {
			const key = textureKey(i);
			this.scene.load.image(key, `/clouds/${key}.webp`);
		}
		this.scene.load.once("complete", () => {
			this.loaded = true;
			this.spawnInitial();
		});
		this.scene.load.start();
	}

	private spawnInitial(): void {
		// Container holds all cloud sprites; a geometry mask clips them to the sky rect.
		this.container = this.scene.add.container(0, 0);
		this.container.setDepth(this.depth);

		// Build a mask from a filled Graphics rectangle matching the sky area.
		const maskShape = this.scene.make.graphics({ add: false });
		maskShape.fillStyle(0xffffff);
		maskShape.fillRect(0, 0, SKY_WIDTH, SKY_HEIGHT);
		this.container.setMask(
			new Phaser.Display.Masks.GeometryMask(this.scene, maskShape),
		);

		for (let i = 0; i < CLOUD_COUNT; i++) {
			const sprite = this.createCloudSprite();
			// Distribute across the full world width so sky isn't empty on load.
			sprite.x =
				Math.random() * (SKY_WIDTH + sprite.displayWidth) - sprite.displayWidth;
			this.container.add(sprite);
			this.sprites.push(sprite);
		}
	}

	private createCloudSprite(): Phaser.GameObjects.Sprite {
		const texIdx = Phaser.Math.Between(1, CLOUD_TEXTURE_COUNT);
		const key = textureKey(texIdx);
		const scale = Phaser.Math.FloatBetween(0.3, 0.7);
		const alpha = Phaser.Math.FloatBetween(0.5, 0.9);
		const y = Phaser.Math.FloatBetween(CLOUD_BAND_TOP_Y, CLOUD_BAND_BOTTOM_Y);

		const sprite = this.scene.add.sprite(0, y, key);
		sprite.setScale(scale);
		sprite.setAlpha(alpha);
		sprite.setOrigin(0, 0.5);

		return sprite;
	}

	private recycleSprite(sprite: Phaser.GameObjects.Sprite): void {
		const texIdx = Phaser.Math.Between(1, CLOUD_TEXTURE_COUNT);
		const key = textureKey(texIdx);
		const scale = Phaser.Math.FloatBetween(0.3, 0.7);
		const alpha = Phaser.Math.FloatBetween(0.5, 0.9);
		const y = Phaser.Math.FloatBetween(CLOUD_BAND_TOP_Y, CLOUD_BAND_BOTTOM_Y);

		sprite.setTexture(key);
		sprite.setScale(scale);
		sprite.setAlpha(alpha);
		sprite.y = y;
		// Respawn just past the right edge.
		sprite.x = SKY_WIDTH;
	}

	/** Call every frame from Scene.update(). */
	update(delta: number): void {
		if (!this.loaded) return;

		const dx = CLOUD_SPEED * (delta / 1000);
		for (const sprite of this.sprites) {
			sprite.x -= dx;
			// When fully off the left edge, recycle to right.
			if (sprite.x + sprite.displayWidth < 0) {
				this.recycleSprite(sprite);
			}
		}
	}

	destroy(): void {
		this.container?.destroy(true);
		this.sprites = [];
	}
}
