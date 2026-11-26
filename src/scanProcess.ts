/** noble-Treiber-Instanz */
import type * as Noble from "@stoprocent/noble";
import {
	createServer,
	type AddressInfo,
	type Server,
	type Socket,
} from "node:net";
import { pick } from "./lib/misc";
import { ScanCycle } from "./lib/scan-cycle";
import { matchesScanFilter } from "./lib/scan-filter";
import {
	ScanExitCodes,
	type InboundMessage,
	type PeripheralInfo,
	type ScanMessage,
} from "./lib/scanProcessInterface";
import yargs = require("yargs");

/** Define command line arguments */
const argv = yargs
	.env("IOB_BLE2")
	.strict()
	.usage("ioBroker.ble2 scanner process\n\nUsage: $0 [options]")
	.options({
		hciDevice: {
			alias: "-d",
			type: "number",
			desc: "Index of the HCI device to use for scanning",
			default: 0,
		},
		services: {
			alias: "-s",
			type: "string",
			array: true,
			desc: "Which BLE services to scan for",
			default: [],
		},
		manufacturerIds: {
			type: "number",
			array: true,
			desc: "Bluetooth company identifiers to scan for in addition to services",
			default: [],
		},
		scanInterval: {
			type: "number",
			desc: "Seconds between scan starts (0 for continuous scanning)",
			default: 0,
		},
		scanDuration: {
			type: "number",
			desc: "Seconds spent scanning during each interval",
			default: 10,
		},
		listenInterface: {
			alias: "-i",
			type: "string",
			desc: "If not spawned as a child process, the interface to listen for TCP connections. Default: all interfaces.",
		},
		listenPort: {
			alias: "-p",
			type: "number",
			desc: "If not spawned as a child process, the port to listen on.",
			default: 8734,
		},
	})
	.check(({ scanInterval, scanDuration }) => {
		if (
			!Number.isInteger(scanInterval) ||
			scanInterval < 0 ||
			scanInterval > 86400 ||
			!Number.isInteger(scanDuration) ||
			scanDuration <= 0 ||
			scanDuration > 3600 ||
			(scanInterval > 0 && scanDuration >= scanInterval)
		) {
			throw new Error(
				"Scan interval must be 0–86400 seconds and a scan window of 1–3600 seconds must be shorter than a nonzero interval.",
			);
		}
		return true;
	})
	.parseSync();

let noble: typeof Noble;
let server: Server | undefined;
const clients: Set<Socket> = new Set();

function sendAsync(
	message: ScanMessage,
	sendHandle?: any,
	swallowErrors: boolean = true,
): Promise<void> {
	if (process.send) {
		return new Promise((resolve, reject) => {
			process.send!(message, sendHandle, undefined, (err) => {
				if (err && !swallowErrors) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}
	const promises = [...clients].map((client) => {
		return new Promise<void>((resolve, reject) => {
			client.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err && !swallowErrors) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	});
	return Promise.all(promises).then(() => undefined);
}

// @ts-expect-error We need this to serialize and deserialize Error objects
Error.prototype.toJSON = function (this: Error) {
	const ret: Record<string, any> = {
		type: "Error",
		name: this.name,
		message: this.message,
		stack: this.stack,
	};
	// Add any custom properties such as .code in file-system errors
	for (const key of Object.keys(this) as (keyof Error)[]) {
		if (!ret[key]) {
			ret[key] = this[key];
		}
	}
	return ret;
};

process.on("uncaughtException", (error) => {
	// Delegate the error to the parent process and let it decide whether to shut down the scanning process
	sendAsync({ type: "error", error });
});
process.on("unhandledRejection", (error) => {
	// Delegate the error to the parent process and let it decide whether to shut down the scanning process
	sendAsync({
		type: "error",
		error:
			// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
			error instanceof Error ? error : new Error(`${error}`),
	});
});

function serializePeripheral(peripheral: Noble.Peripheral): PeripheralInfo {
	return pick(peripheral, [
		"id",
		"uuid",
		"address",
		"addressType",
		"connectable",
		"advertisement",
		"rssi",
	]) as PeripheralInfo;
}

function onDiscover(peripheral?: Noble.Peripheral): void {
	if (peripheral == undefined) {
		return;
	}
	if (!matchesScanFilter(peripheral, argv.services, argv.manufacturerIds)) {
		return;
	}
	sendAsync({
		type: "discover",
		peripheral: serializePeripheral(peripheral),
	});
}

let isScanning = false;
async function startScanning(): Promise<void> {
	if (isScanning) {
		return;
	}
	await sendAsync({ type: "connected" });
	await sendAsync({
		type: "log",
		message: `starting scan for services ${JSON.stringify(argv.services)}`,
	});
	// We must allow duplicates in order to support
	noble.on("discover", onDiscover);
	// Noble's service filter drops manufacturer-only advertisements. Apply the
	// combined filter in onDiscover when a plugin needs manufacturer data.
	try {
		await noble.startScanningAsync(
			argv.manufacturerIds.length > 0 ? [] : argv.services,
			true,
		);
	} catch (error) {
		noble.removeListener("discover", onDiscover);
		await sendAsync({ type: "disconnected" });
		throw error;
	}
	isScanning = true;
}

async function stopScanning(): Promise<void> {
	if (!isScanning) {
		return;
	}
	noble.removeListener("discover", onDiscover);
	await sendAsync({
		type: "log",
		message: `stopping scan`,
	});
	isScanning = false;
	try {
		await noble.stopScanningAsync();
	} finally {
		await sendAsync({ type: "disconnected" });
	}
}

function reportScanError(error: unknown): void {
	void sendAsync({
		type: "error",
		error: error instanceof Error ? error : new Error(String(error)),
	});
}

const scanCycle = new ScanCycle(
	argv.scanInterval * 1000,
	argv.scanDuration * 1000,
	startScanning,
	stopScanning,
	reportScanError,
);

// This will be called when an IPC channel exists
process.on("message", (msg) => {
	handleMessage(msg as InboundMessage);
});

function handleMessage(msg: InboundMessage): void {
	switch (msg.type) {
		case "startScanning":
			void scanCycle.start().catch(reportScanError);
			break;
		case "stopScanning":
			void scanCycle.stop().catch(reportScanError);
			break;
	}
}

function maybeStartServer(): Promise<void> {
	// This is a child process, we have an IPC channel
	if (process.send) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		// Start a TCP server, listen for connections, and forward them to the serial port
		server = createServer((socket) => {
			console.log("Client connected");
			clients.add(socket);
			// A new client needs to know whether the server is scanning right now, the messages
			// "connected" and "disconnected" are only sent when that changes
			const snapshot: ScanMessage[] = [
				{ type: isScanning ? "connected" : "disconnected" },
			];
			if (noble) {
				snapshot.push({
					type: "driverState",
					driverState: noble.state,
				});
			}
			for (const message of snapshot) {
				socket.write(`${JSON.stringify(message)}\n`);
			}

			// when the connection is closed, unpipe the streams
			socket.on("close", () => {
				console.log("Client disconnected");
				clients.delete(socket);
			});
		});

		// Do not allow more than one client to connect
		server.maxConnections = 1;

		server.on("error", (err) => {
			if ((err as any).code === "EADDRINUSE") {
				reject(err);
			}
		});
		server.listen(
			{
				host: argv.listenInterface,
				port: argv.listenPort,
			},
			() => {
				const address: AddressInfo = server!.address() as any;
				console.log(
					`Server listening on tcp://${address.address}:${address.port}`,
				);
				resolve();
			},
		);
	});
}

async function loadNoble(): Promise<void> {
	// load noble driver with the correct device selected
	process.env.NOBLE_HCI_DEVICE_ID = argv.hciDevice.toString();
	try {
		// Noble must load after NOBLE_HCI_DEVICE_ID is set.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		noble = require("@stoprocent/noble");
		if (typeof noble.on !== "function") {
			// The following commit broke the default exported instance of noble:
			// https://github.com/stoprocent/noble/commit/b67eea246f719947fc45b1b52b856e61637a8a8e
			noble = (noble as any)({ extended: false });
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown error";
		const diagnostic = new Error(
			`Could not load the Bluetooth scanner on Node.js ${process.version} (${process.platform}/${process.arch}): ${reason}`,
		);
		if (process.send) {
			await sendAsync({
				type: "driverState",
				driverState: "driverError",
			});
			await sendAsync({ type: "fatal", error: diagnostic });
		} else {
			// The TCP server has not started, so there is no client to notify.
			console.error(diagnostic.message);
		}
		process.exit(ScanExitCodes.RequireNobleFailed);
	}
}

// Keep the scanner lifecycle API promise-based.
// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
	// prepare scanning for beacons
	noble.on("stateChange", (state) => {
		switch (state) {
			case "poweredOn":
				void scanCycle.start().catch(reportScanError);
				break;
			case "poweredOff":
				void scanCycle.stop().catch(reportScanError);
				break;
		}
		console.log(`driver state is ${state}`);
		sendAsync({ type: "driverState", driverState: state });
	});
	if (noble.state === "poweredOn") {
		void scanCycle.start().catch(reportScanError);
	}
	sendAsync({ type: "driverState", driverState: noble.state });
}

(async () => {
	await loadNoble();
	await maybeStartServer();
	if (server) {
		// wait for connection
		server.once("connection", () => {
			main();
		});
	} else {
		// child process, start scanning immediately
		main();
	}
})();
