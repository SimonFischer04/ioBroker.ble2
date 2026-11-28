import { entries } from "alcalzone-shared/objects";
import type { DeviceRegistry } from "../devices/device-registry";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import { normalizeAddress, type PeripheralInfo } from "../lib/advertisement";
import type { DevicePresence } from "../lib/device-presence";
import { Global as _ } from "../lib/global";
import {
	extendChannel,
	extendDevice,
	extendState,
} from "../lib/iobroker-objects";
import { RssiExpiry } from "../lib/rssi-expiry";
import { RssiUpdates } from "../lib/rssi-updates";
import { ValueWriter } from "../lib/value-writer";
import type { Plugin } from "../plugins/plugin";

/** The configuration of the AdvertisementProcessor */
export interface AdvertisementProcessorOptions {
	/** The plugins that may handle advertisements, in the order they are asked */
	plugins: Plugin[];
	/** Whether devices without advertised data may be created */
	allowEmptyDevices: boolean;
	/** Addresses allowed when recording new devices; blank allows all */
	discoveryAllowlist?: string;
	/** How frequent the RSSI of devices should be updated, in ms */
	rssiUpdateInterval: number;
	/** After how many seconds without an advertisement the RSSI is set to 0, only used if between 1 and 86400 */
	rssiTimeoutSeconds: number;
	/** Is told about every device whose advertisement was handled */
	devicePresence?: DevicePresence;
}

/** After how many ms accepting new devices is disabled again */
const ALLOW_NEW_DEVICES_TIMEOUT = 5 * 60000;

/**
 * Turns advertisements into ioBroker objects and states: finds the plugin that handles
 * the device, lets it decode the advertisement and writes the result.
 */
export class AdvertisementProcessor {
	/**
	 * @param options The configuration
	 * @param devices Tells which gateway receives a device best and filters duplicate packets
	 * @param gateways Counts the duplicate packets per gateway
	 */
	public constructor(
		private readonly options: AdvertisementProcessorOptions,
		private readonly devices: DeviceRegistry,
		private readonly gateways: GatewayRegistry,
	) {
		const addresses = options.discoveryAllowlist?.trim();
		if (addresses) {
			this.discoveryAllowlist = new Set(
				addresses
					.split(/[\s,;]+/)
					.filter((address) =>
						/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i.test(
							address,
						),
					)
					.map(normalizeAddress)
					.filter(
						(address): address is string => address !== undefined,
					),
			);
			if (this.discoveryAllowlist.size === 0) {
				_.adapter.log.warn(
					"The new-device allowlist has no valid Bluetooth addresses. Discovery cannot add devices.",
				);
			}
		}
		this.rssiUpdates = new RssiUpdates(
			_.adapter,
			options.rssiUpdateInterval,
		);
		const timeout = options.rssiTimeoutSeconds;
		if (Number.isInteger(timeout) && timeout > 0 && timeout <= 86400) {
			this.rssiExpiry = new RssiExpiry(_.adapter, timeout * 1000, (id) =>
				this.rssiUpdates.remove(id),
			);
		}
	}

	private readonly rssiUpdates: RssiUpdates;
	private readonly discoveryAllowlist?: Set<string>;
	private readonly rssiExpiry?: RssiExpiry;
	private valueWriter?: ValueWriter;

	/** Restarts the RSSI timeouts for the RSSI states that are set, so they are reset after a restart, too */
	public async restoreRssiTimers(): Promise<void> {
		if (!this.rssiExpiry) {
			return;
		}
		const { adapter } = _;
		const states = await adapter
			.getStatesAsync("*.rssi")
			.catch((error: unknown) => {
				adapter.log.warn(
					`Could not restore RSSI timers: ${String(error)}`,
				);
				return {};
			});
		const prefix = `${adapter.namespace}.`;
		for (const [id, state] of Object.entries(states)) {
			if (
				id.startsWith(prefix) &&
				/^[^.]+\.rssi$/.test(id.slice(prefix.length)) &&
				typeof state?.val === "number" &&
				state.val !== 0 &&
				Number.isFinite(state.ts)
			) {
				this.rssiExpiry.restore(id, state.ts);
			}
		}
	}

	/**
	 * Passes a state change on, so the RSSI throttling knows when each RSSI was last written
	 *
	 * @param id Full ID of the state
	 * @param state The new state, null or undefined if it was deleted
	 */
	public observeState(
		id: string,
		state: ioBroker.State | null | undefined,
	): void {
		this.rssiUpdates.observe(id, state);
	}

	/**
	 * Forgets everything remembered about a state that was deleted
	 *
	 * @param id Full ID of the state
	 */
	public removeState(id: string): void {
		this.rssiUpdates.remove(id);
		this.rssiExpiry?.remove(id);
	}

	/** Whether new devices may be recorded */
	private allowNewDevices = false;
	private resetAllowNewDevicesTimeout: ioBroker.Timeout | undefined;
	/** Cache of new devices we already ignored */
	private readonly ignoredNewDeviceIDs = new Set<string>();

	/**
	 * Forget an ignored device when its RSSI object is created.
	 *
	 * @param id Full object ID
	 */
	public observeObject(id: string): void {
		const prefix = `${_.adapter.namespace}.`;
		if (id.startsWith(prefix) && id.endsWith(".rssi")) {
			this.ignoredNewDeviceIDs.delete(id.slice(prefix.length, -5));
		}
	}

	/** Stops all timers. To be called when the adapter stops. */
	public dispose(): void {
		this.rssiExpiry?.stop();
		if (this.resetAllowNewDevicesTimeout) {
			_.adapter.clearTimeout(this.resetAllowNewDevicesTimeout);
		}
	}

	/**
	 * Enables or disables recording new devices
	 *
	 * @param allow Whether new devices may be recorded
	 */
	public setAllowNewDevices(allow: boolean): void {
		if (allow === this.allowNewDevices) {
			return;
		}
		this.allowNewDevices = allow;
		_.adapter.log.info(
			allow
				? "Now accepting new devices"
				: "No longer accepting new devices",
		);

		if (allow) {
			// Whenever allowNewDevices is set to true,
			// forget all devices we previously ignored
			this.ignoredNewDeviceIDs.clear();
			// Clear or restart the auto-reset timer
			this.autoResetAllowNewDevices();
		}
	}

	private autoResetAllowNewDevices(): void {
		if (this.resetAllowNewDevicesTimeout) {
			_.adapter.clearTimeout(this.resetAllowNewDevicesTimeout);
		}

		// After 5 minutes, reset it to false
		this.resetAllowNewDevicesTimeout = _.adapter.setTimeout(() => {
			this.allowNewDevices = false;
			_.adapter
				.setState("options.allowNewDevices", false, true)
				.catch((error: unknown) => {
					_.adapter.log.warn(
						`Could not reset options.allowNewDevices: ${String(error)}`,
					);
				});
			this.resetAllowNewDevicesTimeout = undefined;

			_.adapter.log.info(
				"No longer accepting new devices (automatic timeout)",
			);
		}, ALLOW_NEW_DEVICES_TIMEOUT);
	}

	/**
	 * Handles a received advertisement: creates the objects of the device and writes its values
	 *
	 * @param peripheral The received advertisement
	 */
	public async process(peripheral: PeripheralInfo): Promise<void> {
		if (peripheral == null) {
			return;
		}

		const { log } = _.adapter;
		const debugTraffic = log.level === "debug" || log.level === "silly";
		const { advertisement } = peripheral;
		if (debugTraffic) {
			log.debug(
				`discovered peripheral ${peripheral.address}${peripheral.gatewayId ? ` via ${peripheral.gatewayId}` : ""}`,
			);
			log.debug(`  has advertisement: ${advertisement != null}`);
		}
		if (!advertisement) {
			return;
		}

		const { serviceData, manufacturerData } = advertisement;
		if (debugTraffic) {
			log.debug(`  has serviceData: ${serviceData != null}`);
			if (serviceData != null) {
				log.debug(`  serviceData = ${JSON.stringify(serviceData)}`);
			}
			log.debug(`  has manufacturerData: ${manufacturerData != null}`);
			if (manufacturerData != null) {
				log.debug(
					`  manufacturerData = ${manufacturerData.toString("hex")}`,
				);
			}
		}

		// Remember which gateway receives the device how well. When several gateways
		// receive the same packet, only the first copy is handled.
		const observation = this.devices.observe(peripheral);
		if (observation.duplicate) {
			if (debugTraffic) {
				log.debug(
					"  skipped, another gateway already delivered this packet",
				);
			}
			if (peripheral.gatewayId) {
				this.gateways.recordDuplicate(peripheral.gatewayId);
			}
			return;
		}

		if (
			!this.options.allowEmptyDevices &&
			!serviceData?.length &&
			!manufacturerData?.length
		) {
			return;
		}

		const deviceId = peripheral.address;

		// Test if we may record this device
		if (
			!this.allowNewDevices ||
			(this.discoveryAllowlist && !this.discoveryAllowlist.has(deviceId))
		) {
			// We may not. First test if we already ignored this device
			if (this.ignoredNewDeviceIDs.has(deviceId)) {
				return;
			}
			// If not, check if the RSSI object exists, as that exists for every one
			if (
				!(await _.objectCache.objectExists(
					`${_.adapter.namespace}.${deviceId}.rssi`,
				))
			) {
				// This is a new device. Remember that we need to ignore it
				if (this.ignoredNewDeviceIDs.size < 4096) {
					this.ignoredNewDeviceIDs.add(deviceId);
				}
				return;
			}
			// This is a known device
		}

		// find out which plugin is handling this
		let plugin: Plugin | undefined;
		for (const p of this.options.plugins) {
			if (p.isHandling(peripheral)) {
				if (debugTraffic) {
					log.debug(`plugin ${p.name} is handling ${deviceId}`);
				}
				plugin = p;
				break;
			}
		}
		if (!plugin) {
			_.adapter.log.warn(
				`no handling plugin found for peripheral ${peripheral.id}`,
			);
			return;
		}

		// Always ensure the rssi state exists and gets a value
		await extendState(`${deviceId}.rssi`, {
			id: "rssi",
			common: {
				role: "value.rssi",
				name: "signal strength (RSSI)",
				desc: "Signal strength of the device",
				type: "number",
				read: true,
				write: false,
			},
			native: {},
		});
		// Use the signal strength of the gateway that receives the device best.
		const rssiId = `${_.adapter.namespace}.${deviceId}.rssi`;
		if (this.rssiExpiry) {
			await this.rssiExpiry.update(rssiId, () =>
				this.rssiUpdates.update(rssiId, observation.bestRssi, true),
			);
		} else {
			await this.rssiUpdates.update(rssiId, observation.bestRssi);
		}

		// Now update device-specific objects and states
		const context = plugin.createContext(peripheral);
		const objects = plugin.defineObjects(context);
		const values = plugin.getValues(context);

		// We can't do anything without objects
		if (objects == null) {
			return;
		}

		// Ensure the device object exists
		await extendDevice(deviceId, peripheral, objects.device);
		this.options.devicePresence?.observe(deviceId);
		// Ensure the channel objects exist (optional)
		if (objects.channels != null && objects.channels.length > 0) {
			await Promise.all(
				objects.channels.map((c) =>
					extendChannel(`${deviceId}.${c.id}`, c),
				),
			);
		}
		// Ensure the state objects exist. These might change in every advertisement frame
		await Promise.all(
			objects.states.map((s) => extendState(`${deviceId}.${s.id}`, s)),
		);

		// Now fill the states with values
		if (values != null) {
			if (debugTraffic) {
				log.debug(
					`${deviceId} > got values: ${JSON.stringify(values)}`,
				);
			}
			// eslint-disable-next-line prefer-const
			for (let [stateId, value] of entries(values)) {
				// Fix special chars
				stateId = stateId.replace(/[()]+/g, "").replace(" ", "_");
				// set the value if there's an object for the state
				const iobStateId = `${_.adapter.namespace}.${deviceId}.${stateId}`;
				if ((await _.objectCache.getObject(iobStateId)) != null) {
					if (debugTraffic) {
						log.debug(`setting state ${iobStateId}`);
					}
					this.valueWriter ??= new ValueWriter(_.adapter);
					await this.valueWriter.write(iobStateId, value ?? null);
				} else {
					_.adapter.log.warn(
						`skipping state ${iobStateId} because the object does not exist`,
					);
				}
			}
		} else if (debugTraffic) {
			log.debug(`${deviceId} > got no values`);
		}
	}
}
