import * as utils from "@iobroker/adapter-core";
import { entries } from "alcalzone-shared/objects";
import { execFile, fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { DevicePresence } from "./lib/device-presence";
import { Global as _ } from "./lib/global";
import { getHciOptions, parseHciIndex, parseHciPorts } from "./lib/hci-ports";
import {
	extendChannel,
	extendDevice,
	extendState,
} from "./lib/iobroker-objects";
import { ObjectCache } from "./lib/object-cache";
import { RssiExpiry } from "./lib/rssi-expiry";
import { RssiUpdates } from "./lib/rssi-updates";
import {
	ScanExitCodes,
	getMessageReviver,
	type PeripheralInfo,
	type ScanMessage,
} from "./lib/scanProcessInterface";
// Load all registered plugins
import { Socket } from "node:net";
import plugins from "./plugins";
import type { Plugin } from "./plugins/plugin";

let enabledPlugins: Plugin[];
let services: string[] = [];
let devicePresence: DevicePresence | undefined;

/** Whether new devices may be recorded */
let allowNewDevices = false;
let resetAllowNewDevicesTimeout: ioBroker.Timeout | undefined;

function autoResetAllowNewDevices(): void {
	if (resetAllowNewDevicesTimeout) {
		_.adapter.clearTimeout(resetAllowNewDevicesTimeout);
	}

	// After 5 minutes, reset it to false
	resetAllowNewDevicesTimeout = _.adapter.setTimeout(() => {
		allowNewDevices = false;
		_.adapter.setState("options.allowNewDevices", false, true);
		resetAllowNewDevicesTimeout = undefined;

		_.adapter.log.info(
			"No longer accepting new devices (automatic timeout)",
		);
	}, 5000 * 60);
}

/** Cache of new devices we already ignored */
const ignoredNewDeviceIDs = new Set<string>();

// /** MAC addresses of known devices */
// let knownDevices: string[] = [];

let rssiUpdates: RssiUpdates | undefined;
let rssiExpiry: RssiExpiry | undefined;

/** A reference to the scanning process */
let scanProcess: ChildProcess | undefined;
let localScanPaused = false;
let stoppingLocalScan = false;
let unloading = false;
const pauseState = "options.pauseLocalScan";
let socket: Socket | undefined;

// Adapter-Objekt erstellen
const adapter = utils.adapter({
	name: "ble2",
	// is called when databases are connected and adapter received configuration.
	// start here!
	ready: async () => {
		// Adapter-Instanz global machen
		_.adapter = adapter;

		// Cache objects for 1 minute
		_.objectCache = new ObjectCache(60000);

		// Workaround für fehlende InstanceObjects nach update
		await _.ensureInstanceObjects();

		// Plugins laden
		_.adapter.log.info(
			`loaded plugins: ${plugins.map((p) => p.name).join(", ")}`,
		);
		const enabledPluginNames: string[] = (adapter.config.plugins || "")
			.split(",")
			.map((p: string) => p.trim().toLowerCase())
			.concat("_default");
		enabledPlugins = plugins.filter(
			(p) => enabledPluginNames.indexOf(p.name.toLowerCase()) > -1,
		);
		for (const plugin of enabledPlugins) {
			plugin.initialize?.();
		}
		_.adapter.log.info(
			`enabled plugins: ${enabledPlugins.map((p) => p.name).join(", ")}`,
		);

		// Bring the monitored service names into the correct form
		if (adapter.config.services === "*") {
			services = [];
			_.adapter.log.info(`monitoring all services`);
		} else {
			services = adapter.config.services
				.split(",") // get manually defined services
				.concat(...enabledPlugins.map((p) => p.advertisedServices)) // concat with plugin-defined ones
				.reduce((acc, s) => acc.concat(s), [] as string[]) // flatten the arrays
				.map((s) => fixServiceName(s)) // cleanup the names
				.filter((s) => s !== "")
				.reduce((acc: any[], s) => {
					// filter out duplicates
					if (acc.indexOf(s) === -1) {
						acc.push(s);
					}
					return acc;
				}, []);
			_.adapter.log.info(`monitored services: ${services.join(", ")}`);
		}

		rssiUpdates = new RssiUpdates(
			adapter,
			Math.max(0, Math.min(10000, adapter.config.rssiThrottle ?? 0)),
		);
		// monitor our own states and objects
		adapter.subscribeStates("*");
		adapter.subscribeObjects("*");

		// Beim Start des Adapters sicher stellen, dass keine neuen Geräte erfasst werden,
		// bis der User es explizit erlaubt.
		await adapter.setStateAsync("options.allowNewDevices", false, true);
		await adapter.setStateAsync(pauseState, false, true);
		const timeoutSeconds = adapter.config.rssiTimeoutSeconds ?? 0;
		if (
			Number.isInteger(timeoutSeconds) &&
			timeoutSeconds > 0 &&
			timeoutSeconds <= 86400
		) {
			rssiExpiry = new RssiExpiry(adapter, timeoutSeconds * 1000, (id) =>
				rssiUpdates?.remove(id),
			);
			const states = await adapter
				.getStatesAsync("*.rssi")
				.catch((error: unknown) => {
					adapter.log.warn(
						`Could not restore RSSI timers: ${String(error)}`,
					);
					return {};
				});
			const statePrefix = `${adapter.namespace}.`;
			for (const [id, state] of Object.entries(states)) {
				if (
					id.startsWith(statePrefix) &&
					/^[^.]+\.rssi$/.test(id.slice(statePrefix.length)) &&
					typeof state?.val === "number" &&
					state.val !== 0 &&
					Number.isFinite(state.ts)
				) {
					rssiExpiry.restore(id, state.ts);
				}
			}
		}
		if (
			Array.isArray(adapter.config.presenceDevices) &&
			adapter.config.presenceDevices.length > 0
		) {
			devicePresence = new DevicePresence(
				adapter,
				adapter.config.presenceDevices,
				async (deviceId, present): Promise<void> => {
					const stateId = `${deviceId}.present`;
					await extendState(stateId, {
						id: "present",
						common: {
							name: "Present",
							type: "boolean",
							role: "indicator",
							read: true,
							write: false,
						},
					});
					await adapter.setStateChangedAsync(stateId, present, true);
				},
			);
			try {
				const objects = await adapter.getAdapterObjectsAsync();
				const prefix = `${adapter.namespace}.`;
				for (const [id, object] of Object.entries(objects)) {
					if (object.type === "device" && id.startsWith(prefix)) {
						devicePresence.restore(id.slice(prefix.length));
					}
				}
			} catch (error) {
				adapter.log.warn(
					`Could not restore presence states: ${String(error)}`,
				);
			}
		}

		// And start scanning
		if (!process.env.TESTING) {
			if (adapter.config.server) {
				connectToBLEServer();
			} else {
				startScanProcess();
			}
		}
	},

	// is called when adapter shuts down - callback has to be called under any circumstances!
	unload: (callback) => {
		unloading = true;
		try {
			rssiExpiry?.stop();
			devicePresence?.stop();
			_.objectCache?.dispose();
			scanProcess?.kill();
		} catch {
			// Shutdown must continue even when the scanner has already exited.
		}
		callback();
	},

	// is called if a subscribed object changes
	objectChange: (id, obj) => {
		if (obj) {
			// it has just been changed, so update the cached object
			_.objectCache.updateObject(obj);
		} else {
			// it has been deleted, so delete it from the cache
			_.objectCache.invalidateObject(id);
			rssiUpdates?.remove(id);
			rssiExpiry?.remove(id);
			if (devicePresence && id.startsWith(`${adapter.namespace}.`)) {
				devicePresence.remove(
					id
						.slice(adapter.namespace.length + 1)
						.replace(/\.present$/, ""),
				);
			}
		}
	},

	// is called if a subscribed state changes
	stateChange: (id, state) => {
		if (
			id === `${adapter.namespace}.${pauseState}` &&
			state &&
			!state.ack &&
			typeof state.val === "boolean"
		) {
			localScanPaused = state.val;
			if (localScanPaused && scanProcess && !stoppingLocalScan) {
				stoppingLocalScan = true;
				scanProcess.kill();
			}
			if (!stoppingLocalScan) {
				if (
					!localScanPaused &&
					!adapter.config.server &&
					!process.env.TESTING
				) {
					startScanProcess();
				}
				adapter.setState(pauseState, localScanPaused, true);
			}
			return;
		}
		rssiUpdates?.observe(id, state);
		if (
			/options\.allowNewDevices$/.test(id) &&
			state != undefined &&
			!state.ack
		) {
			if (
				typeof state.val === "boolean" &&
				state.val !== allowNewDevices
			) {
				allowNewDevices = state.val;
				// ACK the state change
				_.adapter.setState(id, state.val, true);
				_.adapter.log.info(
					allowNewDevices
						? "Now accepting new devices"
						: "No longer accepting new devices",
				);

				if (allowNewDevices) {
					// Whenever allowNewDevices is set to true,
					// forget all devices we previously ignored
					ignoredNewDeviceIDs.clear();
					// Clear or restart the auto-reset timer
					autoResetAllowNewDevices();
				}
			}
		}
	},

	// Keep the adapter callback promise-based even when no command awaits work.
	// eslint-disable-next-line @typescript-eslint/require-await
	message: async (obj) => {
		// responds to the adapter that sent the original message
		function respond(response: any): void {
			if (obj.callback) {
				adapter.sendTo(obj.from, obj.command, response, obj.callback);
			}
		}
		// some predefined responses so we only have to define them once
		const predefinedResponses = {
			ACK: { error: null },
			OK: { error: null, result: "ok" },
			ERROR_UNKNOWN_COMMAND: { error: "Unknown command!" },
			MISSING_PARAMETER: (paramName: string) => {
				return { error: `missing parameter "${paramName}"!` };
			},
			COMMAND_RUNNING: { error: "command running" },
		};
		// make required parameters easier
		// function requireParams(params: string[]) {
		// 	if (!(params && params.length)) return true;
		// 	for (const param of params) {
		// 		if (!(obj.message && obj.message.hasOwnProperty(param))) {
		// 			respond(predefinedResponses.MISSING_PARAMETER(param));
		// 			return false;
		// 		}
		// 	}
		// 	return true;
		// }

		// handle the message
		if (obj) {
			switch (obj.command) {
				case "getHCIOptions":
				case "getHCIPorts":
					if (!obj.callback) {
						return;
					}
					execFile(
						"hciconfig",
						{ timeout: 3000 },
						(error, stdout) => {
							const wantsOptions =
								obj.command === "getHCIOptions";
							if (error != null) {
								respond(wantsOptions ? [] : { error });
								return;
							}
							const ports = parseHciPorts(stdout);
							respond(
								wantsOptions
									? getHciOptions(
											ports,
											adapter.config.hciDevice,
										)
									: { error: null, result: ports },
							);
						},
					);
					return;
				default:
					respond(predefinedResponses.ERROR_UNKNOWN_COMMAND);
					return;
			}
		}
	},
});

function startScanProcess(): void {
	if (scanProcess || localScanPaused || unloading) {
		return;
	}
	const args: string[] = ["-s", ...services];
	const manufacturerIds = [
		...new Set(enabledPlugins.flatMap((p) => p.manufacturerIds ?? [])),
	];
	if (manufacturerIds.length > 0) {
		args.push("--manufacturerIds", ...manufacturerIds.map(String));
	}
	const hciIndex = parseHciIndex(adapter.config.hciDevice);
	if (hciIndex) {
		args.push("-d", hciIndex.toString());
	}
	const interval = adapter.config.scanIntervalMinutes ?? 0;
	const duration = adapter.config.scanWindowSeconds ?? 10;
	if (Number.isInteger(interval) && interval > 0 && interval <= 1440) {
		if (
			Number.isInteger(duration) &&
			duration > 0 &&
			duration <= 3600 &&
			duration < interval * 60
		) {
			args.push(
				"--scanInterval",
				String(interval * 60),
				"--scanDuration",
				String(duration),
			);
		} else {
			adapter.log.warn(
				"The BLE scan window must be shorter than the scan interval. Scanning continuously.",
			);
		}
	}
	adapter.log.info("starting scanner process...");
	const child = fork(path.join(__dirname, "scanProcess"), args, {
		stdio: ["pipe", "pipe", "pipe", "ipc"],
	});
	scanProcess = child;
	child.once("exit", (code, signal) => {
		const wasPaused = stoppingLocalScan;
		scanProcess = undefined;
		stoppingLocalScan = false;
		if (unloading) {
			return;
		}
		adapter.setState("info.connection", false, true);
		if (wasPaused) {
			if (!localScanPaused) {
				startScanProcess();
			}
			// Acknowledge only after the child released the local Bluetooth controller.
			adapter.setState(pauseState, localScanPaused, true);
		} else if (
			!signal &&
			code !== 0 &&
			code !== ScanExitCodes.RequireNobleFailed
		) {
			adapter.log.warn("scanner process crashed, restarting...");
			setImmediate(startScanProcess);
		}
	});
	child.on(
		"message",
		getMessageReviver<ScanMessage>((message) => {
			if (!unloading && !stoppingLocalScan && scanProcess === child) {
				handleMessage(message);
			}
		}),
	);
}

function connectToBLEServer(): void {
	socket = new Socket();

	const reviver = getMessageReviver(handleMessage);
	let receiveBuffer = "";

	socket
		.on("close", () => {
			adapter.log.info("Disconnected from BLE server");
			adapter.setState("info.connection", false, true);
		})
		.on("connect", () => {
			adapter.log.info("Connected to BLE server");
			adapter.setState("info.connection", true, true);
		})
		.on("data", (data) => {
			// Each message ends with a newline. We might receive multiple messages at once,
			// and we might also receive incomplete messages.
			receiveBuffer += data.toString();
			let newlineIndex: number;
			while ((newlineIndex = receiveBuffer.indexOf("\n")) > -1) {
				const line = receiveBuffer.slice(0, newlineIndex);
				receiveBuffer = receiveBuffer.slice(newlineIndex + 1);
				try {
					const msg = JSON.parse(line);
					reviver(msg);
				} catch (e) {
					console.error(e);
					console.error(`data was: ${line}`);
				}
			}
		});

	const [host, port] = adapter.config.server.split(":", 2);

	adapter.log.info("connecting to BLE server...");
	socket.connect({
		host,
		port: +port,
	});
}

function handleMessage(message: ScanMessage): void {
	switch (message.type) {
		case "connected":
			adapter.setState("info.connection", true, true);
			break;
		case "disconnected":
			adapter.setState("info.connection", false, true);
			break;
		case "discover":
			onDiscover(message.peripheral);
			break;
		case "driverState":
			adapter.setState("info.driverState", message.driverState, true);
			break;
		case "fatal":
			adapter.setState("info.connection", false, true);
		// fall through
		case "error":
			handleScanProcessError(message.error);
			break;
		case "log":
			adapter.log[message.level ?? "info"](message.message);
			break;
	}
}

function fixServiceName(name: string | null | undefined): string {
	if (name == null) {
		return "";
	}
	name = name.trim();
	// No whitespace
	for (const char of ["\r", "\n", "\t", " "]) {
		name = name.replace(char, "");
	}
	// No leading 0x
	name = name.replace(/^0x/, "");
	// lowerCase
	return name.toLowerCase();
}

async function onDiscover(peripheral: PeripheralInfo): Promise<void> {
	if (peripheral == null) {
		return;
	}

	const { log } = adapter;
	const debugTraffic = log.level === "debug" || log.level === "silly";
	const { advertisement } = peripheral;
	if (debugTraffic) {
		log.debug(`discovered peripheral ${peripheral.address}`);
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
	if (
		!adapter.config.allowEmptyDevices &&
		!serviceData?.length &&
		!manufacturerData?.length
	) {
		return;
	}

	const deviceId = peripheral.address;

	// Test if we may record this device
	if (!allowNewDevices) {
		// We may not. First test if we already ignored this device
		if (ignoredNewDeviceIDs.has(deviceId)) {
			return;
		}
		// If not, check if the RSSI object exists, as that exists for every one
		if (
			!(await _.objectCache.objectExists(
				`${_.adapter.namespace}.${deviceId}.rssi`,
			))
		) {
			// This is a new device. Remember that we need to ignore it
			ignoredNewDeviceIDs.add(deviceId);
			return;
		}
		// This is a known device
	}

	// find out which plugin is handling this
	let plugin: Plugin | undefined;
	for (const p of enabledPlugins) {
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
	const stateId = `${adapter.namespace}.${deviceId}.rssi`;
	if (rssiExpiry) {
		await rssiExpiry.update(stateId, async () => {
			await rssiUpdates?.update(stateId, peripheral.rssi, true);
		});
	} else {
		await rssiUpdates?.update(stateId, peripheral.rssi);
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
	devicePresence?.observe(deviceId);
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
			log.debug(`${deviceId} > got values: ${JSON.stringify(values)}`);
		}
		// eslint-disable-next-line prefer-const
		for (let [stateId, value] of entries(values)) {
			// Fix special chars
			stateId = stateId.replace(/[()]+/g, "").replace(" ", "_");
			// set the value if there's an object for the state
			const iobStateId = `${adapter.namespace}.${deviceId}.${stateId}`;
			if ((await _.objectCache.getObject(iobStateId)) != null) {
				if (debugTraffic) {
					log.debug(`setting state ${iobStateId}`);
				}
				await adapter.setStateChangedAsync(
					iobStateId,
					value ?? null,
					true,
				);
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

function handleScanProcessError(err: Error): void {
	if (
		/compatible USB Bluetooth/.test(err.message) ||
		/LIBUSB_ERROR_NOT_SUPPORTED/.test(err.message)
	) {
		terminate("No compatible BLE 4.0 hardware found!");
	} else if (
		/NODE_MODULE_VERSION/.test(err.message) &&
		adapter.supportsFeature?.("CONTROLLER_NPM_AUTO_REBUILD")
	) {
		terminate("A dependency requires a rebuild.", 13);
	} else if (err.message.includes(`The value of "offset" is out of range`)) {
		// ignore, this happens in noble sometimes
		(adapter?.log ?? console).error(err.message);
	} else if (err.message.includes("EAFNOSUPPORT")) {
		terminate(
			"Unsupported Address Family (EAFNOSUPPORT). If ioBroker is running in a Docker container, make sure that the container uses host mode networking.",
		);
	} else {
		// This is something unexpected. We don't want to bring down the main process, so just log it
		(adapter?.log ?? console).error(err.message);
	}
}

function terminate(
	reason: string = "no reason given",
	exitCode: number = 11,
): never {
	if (adapter) {
		adapter.log.error(`Terminating because ${reason}`);
		adapter.terminate?.(reason, exitCode);
	}
	return process.exit(exitCode);
}
