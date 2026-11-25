import { randomUUID } from "node:crypto";

const dayMs = 86_400_000;
const previewLifetimeMs = 5 * 60_000;

interface Preview {
	owner: string;
	token: string;
	days: number;
	cutoff: number;
	expires: number;
	ids: string[];
}

/** Previews and removes stale devices from a single adapter instance. */
export class StaleDeviceCleanup {
	private preview: Preview | undefined;
	private previewRevision = 0;
	private readonly activeDevices = new Set<string>();
	private running = false;
	private stopped = false;
	private readonly prefix: string;

	/** @param adapter Adapter instance owning the eligible objects. */
	constructor(private readonly adapter: ioBroker.Adapter) {
		this.prefix = `${adapter.namespace}.`;
	}

	/**
	 * Captures eligible device IDs and returns a short-lived confirmation token.
	 *
	 * @param owner Message sender.
	 * @param days Minimum age of a device's last RSSI update.
	 */
	public async prepare(
		owner: string,
		days: unknown,
	): Promise<{ token: string; count: number }> {
		if (
			typeof days !== "number" ||
			!Number.isInteger(days) ||
			days < 1 ||
			days > 3650
		) {
			throw new Error("Enter an age between 1 and 3650 days.");
		}
		if (this.running || this.stopped) {
			throw new Error(
				"Device cleanup is unavailable while the adapter is busy.",
			);
		}
		this.preview = undefined;
		const revision = ++this.previewRevision;
		const cutoff = Date.now() - days * dayMs;
		const ids = await this.findCandidates(cutoff);
		if (this.stopped || revision !== this.previewRevision) {
			throw new Error(
				"Run a fresh cleanup preview before deleting devices.",
			);
		}
		const token = randomUUID();
		this.preview = {
			owner,
			token,
			days,
			cutoff,
			expires: Date.now() + previewLifetimeMs,
			ids,
		};
		return { token, count: ids.length };
	}

	/**
	 * Starts a cleanup from the preview. Progress and results go to the adapter log.
	 *
	 * @param owner Message sender.
	 * @param token Token returned by the preview for that sender.
	 * @param days Current age setting in the cleanup form.
	 */
	public start(owner: string, token: unknown, days: unknown): void {
		if (this.running || this.stopped) {
			throw new Error(
				"Device cleanup is unavailable while the adapter is busy.",
			);
		}
		const preview = this.preview;
		if (
			!preview ||
			preview.token !== token ||
			preview.owner !== owner ||
			preview.days !== days ||
			preview.expires <= Date.now()
		) {
			throw new Error(
				"Run a fresh cleanup preview before deleting devices.",
			);
		}
		this.preview = undefined;
		this.previewRevision++;
		this.running = true;
		this.adapter.log.info(
			`Starting cleanup of ${preview.ids.length} stale BLE devices.`,
		);
		void this.removeDevices(preview)
			.catch((error: unknown) => {
				this.adapter.log.warn(
					`BLE device cleanup stopped: ${String(error)}`,
				);
			})
			.finally(() => {
				this.activeDevices.clear();
				this.running = false;
			});
	}

	/** @param address Device address received in a BLE advertisement. */
	public recordActivity(address: string): void {
		if (this.running) {
			this.activeDevices.add(`${this.prefix}${address}`);
		}
	}

	/** Stops after the current deletion when the adapter unloads. */
	public stop(): void {
		this.stopped = true;
		this.preview = undefined;
	}

	private isDevice(
		id: string,
		object: ioBroker.Object | null | undefined,
	): boolean {
		const address = id.slice(this.prefix.length);
		return (
			id.startsWith(this.prefix) &&
			!!address &&
			!address.includes(".") &&
			object?.type === "device" &&
			object.native.address === address &&
			typeof object.native.id === "string"
		);
	}

	private isStale(
		state: ioBroker.State | null | undefined,
		cutoff: number,
	): boolean {
		return (
			typeof state?.val === "number" &&
			Number.isFinite(state.ts) &&
			state.ts > 0 &&
			state.ts < cutoff
		);
	}

	private async findCandidates(cutoff: number): Promise<string[]> {
		const [objects, states, enums] = await Promise.all([
			this.adapter.getAdapterObjectsAsync(),
			this.adapter.getStatesAsync("*.rssi"),
			this.adapter.getEnumsAsync(),
		]);
		const protectedDevices = new Set<string>();
		const protect = (id: string): void => {
			if (id.startsWith(this.prefix)) {
				protectedDevices.add(
					`${this.prefix}${id.slice(this.prefix.length).split(".", 1)[0]}`,
				);
			}
		};
		for (const group of Object.values(enums)) {
			for (const entry of Object.values(group)) {
				entry.common.members?.forEach(protect);
			}
		}
		for (const [id, object] of Object.entries(objects)) {
			if (
				object.type === "state" &&
				Object.keys(object.common.custom ?? {}).length > 0
			) {
				protect(id);
			}
		}
		return Object.entries(objects)
			.filter(
				([id, object]) =>
					this.isDevice(id, object) &&
					!protectedDevices.has(id) &&
					this.isStale(states[`${id}.rssi`], cutoff),
			)
			.map(([id]) => id);
	}

	private async removeDevices(preview: Preview): Promise<void> {
		const eligible = new Set(await this.findCandidates(preview.cutoff));
		let deleted = 0;
		let failed = 0;
		for (const id of preview.ids) {
			if (this.stopped) {
				break;
			}
			if (!eligible.has(id) || this.activeDevices.has(id)) {
				continue;
			}
			try {
				const [object, state] = await Promise.all([
					this.adapter.getObjectAsync(id),
					this.adapter.getStateAsync(`${id}.rssi`),
				]);
				if (
					!this.stopped &&
					!this.activeDevices.has(id) &&
					this.isDevice(id, object) &&
					this.isStale(state, preview.cutoff)
				) {
					await this.adapter.delObjectAsync(id, { recursive: true });
					deleted++;
				}
			} catch (error) {
				failed++;
				this.adapter.log.warn(
					`Could not delete ${id}: ${String(error)}`,
				);
			}
		}
		this.adapter.log.info(
			`BLE device cleanup finished. Deleted ${deleted}, skipped ${preview.ids.length - deleted - failed}, failed ${failed}.`,
		);
	}
}
