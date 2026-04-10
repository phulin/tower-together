/**
 * Fixed-capacity ring buffer backed by a pre-allocated array.
 *
 * Serializes as plain JSON (`{items, head, count}`) and can be
 * reconstituted from that shape via `RingBuffer.from()`.
 */
export class RingBuffer<T> {
	items: T[];
	head: number;
	count: number;

	constructor(
		readonly capacity: number,
		fill: T,
	) {
		this.items = new Array(capacity).fill(fill);
		this.head = 0;
		this.count = 0;
	}

	/** Reconstitute a RingBuffer from a plain-object snapshot. */
	static from<T>(data: {
		items: T[];
		head: number;
		count: number;
	}): RingBuffer<T> {
		const buf = Object.create(RingBuffer.prototype) as RingBuffer<T>;
		buf.items = data.items;
		buf.head = data.head;
		buf.count = data.count;
		(buf as { capacity: number }).capacity = data.items.length;
		return buf;
	}

	get size(): number {
		return this.count;
	}

	get isFull(): boolean {
		return this.count >= this.capacity;
	}

	get isEmpty(): boolean {
		return this.count === 0;
	}

	/** Append an item. Returns false if the buffer is full. */
	push(item: T): boolean {
		if (this.count >= this.capacity) return false;
		const writeIndex = (this.head + this.count) % this.capacity;
		this.items[writeIndex] = item;
		this.count += 1;
		return true;
	}

	/** Remove and return the oldest item, or undefined if empty. */
	pop(): T | undefined {
		if (this.count <= 0) return undefined;
		const item = this.items[this.head];
		this.head = (this.head + 1) % this.capacity;
		this.count -= 1;
		return item;
	}

	/** Return all items in queue order without removing them. */
	peekAll(): T[] {
		return Array.from(
			{ length: this.count },
			(_, i) => this.items[(this.head + i) % this.capacity],
		);
	}
}
