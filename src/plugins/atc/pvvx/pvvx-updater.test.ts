import { expect } from "chai";
import type { GattSession } from "../../../connections/gatt-session";
import type {
	GatewayCandidate,
	SessionOptions,
} from "../../../connections/connection-manager";
import { GatewayError } from "../../../lib/gateway-error";
import { createFakeSession, FakePvvxDevice } from "./fake-pvvx-device";
import { FirmwareCatalog, type FirmwareSource } from "./firmware-catalog";
import {
	CHECK_INTERVAL_MS,
	CHECK_START_DELAY_MS,
	OTA_SESSION_TIMEOUT_MS,
	PvvxUpdater,
	type PvvxUpdaterContext,
	VERIFY_DELAY_MS,
	VERIFY_RETRY_MS,
} from "./pvvx-updater";
import { buildTestImage } from "./test-image";

const FIRST = "a4:c1:38:12:34:56";
const SECOND = "a4:c1:38:65:43:21";
const NOW = 1_800_000_000_000;

interface StoredState {
	val: ioBroker.StateValue;
	ack: boolean;
	ts: number;
}

class FakeAdapter {
	public readonly namespace = "ble.0";
	public readonly objects = new Map<string, ioBroker.SettableObject>();
	public readonly states = new Map<string, StoredState>();
	/** Every state write in order: "<id>=<value>" */
	public readonly writes: string[] = [];
	public readonly logs: { level: string; message: string }[] = [];
	public readonly log = {
		silly: (): void => {},
		debug: (): void => {},
		info: (message: string): void => {
			this.logs.push({ level: "info", message });
		},
		warn: (message: string): void => {
			this.logs.push({ level: "warn", message });
		},
		error: (message: string): void => {
			this.logs.push({ level: "error", message });
		},
		level: "info",
	};

	private relative(id: string): string {
		return id.startsWith(`${this.namespace}.`)
			? id.slice(this.namespace.length + 1)
			: id;
	}

	public setObjectNotExistsAsync(
		id: string,
		obj: ioBroker.SettableObject,
	): Promise<{ id: string }> {
		if (!this.objects.has(id)) {
			this.objects.set(id, obj);
		}
		return Promise.resolve({ id });
	}

	public setStateAsync(
		id: string,
		val: ioBroker.StateValue,
		ack: boolean,
	): Promise<string> {
		const relative = this.relative(id);
		this.states.set(relative, { val, ack, ts: NOW });
		this.writes.push(`${relative}=${String(val)}`);
		return Promise.resolve(id);
	}

	public getStateAsync(id: string): Promise<StoredState | null> {
		return Promise.resolve(this.states.get(this.relative(id)) ?? null);
	}

	/**
	 * Sets a state without recording it, like the rest of the adapter would
	 *
	 * @param id ID relative to the adapter namespace
	 * @param val Value of the state
	 * @param ts Time stamp of the state
	 */
	public preset(id: string, val: ioBroker.StateValue, ts = NOW): void {
		this.states.set(id, { val, ack: true, ts });
	}

	public val(id: string): ioBroker.StateValue | undefined {
		return this.states.get(id)?.val;
	}

	/**
	 * The values a state was set to, in order
	 *
	 * @param id ID relative to the adapter namespace
	 */
	public history(id: string): string[] {
		return this.writes
			.filter((w) => w.startsWith(`${id}=`))
			.map((w) => w.slice(id.length + 1));
	}

	public get warnings(): string[] {
		return this.logs
			.filter((l) => l.level === "warn")
			.map((l) => l.message);
	}
}

class FakeConnections {
	public readonly devices = new Map<string, FakePvvxDevice>();
	/** Errors withSession fails with, per address */
	public readonly failures = new Map<string, GatewayError>();
	public readonly sessions: { address: string; options: SessionOptions }[] =
		[];
	public best: GatewayCandidate | undefined = {
		gatewayId: "esphome.0:proxy-og",
		rssi: -60,
		features: ["writeSequence"],
	};
	/** When set, the next session waits for it */
	public gate: Promise<void> | undefined;

	public async withSession<T>(
		address: string,
		job: (session: GattSession) => Promise<T>,
		options: SessionOptions = {},
	): Promise<T> {
		this.sessions.push({ address, options });
		const gate = this.gate;
		this.gate = undefined;
		if (gate) {
			await gate;
		}
		const failure = this.failures.get(address);
		if (failure) {
			throw failure;
		}
		const device = this.devices.get(address);
		if (!device) {
			throw new GatewayError("NO_GATEWAY", "unknown device");
		}
		return job(createFakeSession(device));
	}

	public candidates(): GatewayCandidate[] {
		return this.best ? [this.best] : [];
	}

	/** Sessions that wrote firmware, not the ones that only read the version */
	public get updateSessions(): string[] {
		return this.sessions
			.filter((s) => s.options.gateways !== undefined)
			.map((s) => s.address);
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe("plugins/atc/pvvx/pvvx-updater => PvvxUpdater", () => {
	let adapter: FakeAdapter;
	let connections: FakeConnections;
	let index: unknown;
	let image: Buffer;
	let source: FirmwareSource & { indexLoads: number };
	/** Timers that are not sleeps of the updater: they never fire by themselves */
	let timers: { callback: () => void; ms: number }[];
	let intervals: { callback: () => void; ms: number }[];
	let sleeps: number[];
	let timeSyncs: string[];
	let busyAtTimeSync: boolean[];
	let first: FakePvvxDevice;
	let second: FakePvvxDevice;
	let updater: PvvxUpdater;

	function createUpdater(
		addresses: string[] = [FIRST, SECOND],
		dailyCheck = true,
	): PvvxUpdater {
		const ctx: PvvxUpdaterContext = {
			adapter: adapter as unknown as PvvxUpdaterContext["adapter"],
			connections,
			catalog: new FirmwareCatalog(source, {
				now: () => NOW,
				timezoneOffset: () => 0,
			}),
			clock: { now: () => NOW, timezoneOffset: () => 0 },
			setTimeout: (callback, ms) => {
				// The waits of the update pass right away
				if ([300, VERIFY_DELAY_MS, VERIFY_RETRY_MS].includes(ms)) {
					sleeps.push(ms);
					setImmediate(callback);
					return 0;
				}
				timers.push({ callback, ms });
				return timers.length;
			},
			clearTimeout: () => {},
			setInterval: (callback, ms) => {
				intervals.push({ callback, ms });
				return intervals.length;
			},
			clearInterval: () => {},
			requestTimeSync: (address) => {
				// The time sync skips busy devices, so the device must be free by then
				busyAtTimeSync.push(updater.isBusy(address));
				timeSyncs.push(address);
			},
		};
		updater = new PvvxUpdater(ctx, { addresses, dailyCheck });
		return updater;
	}

	/** Lets queued promises and immediates run */
	const settle = (): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, 20));

	beforeEach(() => {
		adapter = new FakeAdapter();
		connections = new FakeConnections();
		index = { version: 0x60, custom: ["bin/test.bin", "?"] };
		image = buildTestImage(4100);
		source = {
			indexLoads: 0,
			getIndex() {
				this.indexLoads++;
				return Promise.resolve(index);
			},
			getImage: () => Promise.resolve(image),
		};
		timers = [];
		intervals = [];
		sleeps = [];
		timeSyncs = [];
		busyAtTimeSync = [];
		first = new FakePvvxDevice(FIRST);
		second = new FakePvvxDevice(SECOND);
		connections.devices.set(FIRST, first);
		connections.devices.set(SECOND, second);
		for (const address of [FIRST, SECOND]) {
			adapter.preset(`${address}.battery`, 100);
		}
	});

	afterEach(() => updater?.dispose());

	describe("start()", () => {
		it("does nothing without devices", async () => {
			await createUpdater([]).start();
			expect(adapter.objects.size).to.equal(0);
			expect(timers.length + intervals.length).to.equal(0);
		});

		it("creates the objects of the instance and of every device", async () => {
			await createUpdater().start();

			expect(adapter.objects.get("pvvx")?.type).to.equal("channel");
			for (const id of ["pvvx.checkFirmware", "pvvx.updateAll"]) {
				expect(adapter.objects.get(id)?.common).to.include({
					role: "button",
					write: true,
				});
			}
			for (const address of [FIRST, SECOND]) {
				for (const id of [
					"firmwareAvailable",
					"firmwareUpdate",
					"firmwareProgress",
					"firmwareStatus",
					"firmwareError",
				]) {
					expect(
						adapter.objects.get(`${address}.pvvx.${id}`)?.type,
						id,
					).to.equal("state");
				}
				expect(adapter.val(`${address}.pvvx.firmwareStatus`)).to.equal(
					"idle",
				);
			}
			expect(
				(
					adapter.objects.get(`${FIRST}.pvvx.firmwareStatus`)
						?.common as any
				).states,
			).to.include({ transferring: "transferring", failed: "failed" });
		});

		it("resets an update the adapter stopped in", async () => {
			adapter.preset(`${FIRST}.pvvx.firmwareStatus`, "transferring");
			adapter.preset(`${SECOND}.pvvx.firmwareStatus`, "done");

			await createUpdater().start();

			expect(adapter.val(`${FIRST}.pvvx.firmwareStatus`)).to.equal(
				"idle",
			);
			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"NOT_CONNECTED: The adapter was restarted during the update",
			);
			expect(adapter.val(`${SECOND}.pvvx.firmwareStatus`)).to.equal(
				"done",
			);
		});

		it("schedules the daily check only when it is enabled", async () => {
			await createUpdater([FIRST], false).start();
			expect(timers.length + intervals.length).to.equal(0);
			updater.dispose();

			await createUpdater([FIRST], true).start();
			expect(timers.map((t) => t.ms)).to.deep.equal([
				CHECK_START_DELAY_MS,
			]);
			expect(intervals.map((i) => i.ms)).to.deep.equal([
				CHECK_INTERVAL_MS,
			]);
		});
	});

	describe("checkAll()", () => {
		it("shows a newer firmware for the hardware of the device", async () => {
			await createUpdater().start();
			adapter.preset(`${FIRST}.pvvx.hardwareId`, 0);
			adapter.preset(`${FIRST}.pvvx.firmwareVersion`, "5.9");
			adapter.preset(`${SECOND}.pvvx.hardwareId`, 0);
			adapter.preset(`${SECOND}.pvvx.firmwareVersion`, "6.0");

			await updater.checkAll(false);

			expect(adapter.val(`${FIRST}.pvvx.firmwareAvailable`)).to.equal(
				"6.0",
			);
			expect(adapter.val(`${SECOND}.pvvx.firmwareAvailable`)).to.equal(
				"",
			);
			// Without connecting
			expect(connections.sessions).to.deep.equal([]);
		});

		it("leaves devices with unknown hardware alone", async () => {
			await createUpdater().start();
			adapter.preset(`${FIRST}.pvvx.firmwareVersion`, "5.9");

			await updater.checkAll(false);

			expect(
				adapter.history(`${FIRST}.pvvx.firmwareAvailable`),
			).to.deep.equal([]);
		});

		it("warns when firmware.json cannot be loaded", async () => {
			await createUpdater().start();
			adapter.preset(`${FIRST}.pvvx.hardwareId`, 0);
			adapter.preset(`${FIRST}.pvvx.firmwareVersion`, "5.9");
			source.getIndex = () => Promise.reject(new Error("offline"));

			await updater.checkAll(true);

			expect(adapter.warnings).to.have.lengthOf(1);
			expect(adapter.warnings[0]).to.include("offline");
			expect(
				adapter.history(`${FIRST}.pvvx.firmwareAvailable`),
			).to.deep.equal([]);
		});
	});

	describe("update()", () => {
		it("installs the firmware, checks it and sets the clock", async () => {
			await createUpdater().start();

			await updater.update(FIRST);

			expect(
				adapter.history(`${FIRST}.pvvx.firmwareStatus`),
			).to.deep.equal([
				"idle",
				"queued",
				"checking",
				"transferring",
				"verifying",
				"done",
			]);
			expect(first.ota.finished).to.equal(true);
			expect(adapter.val(`${FIRST}.pvvx.firmwareVersion`)).to.equal(
				"6.0",
			);
			expect(adapter.val(`${FIRST}.pvvx.firmwareAvailable`)).to.equal("");
			expect(adapter.val(`${FIRST}.pvvx.firmwareProgress`)).to.equal(100);
			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal("");
			expect(timeSyncs).to.deep.equal([FIRST]);
			expect(busyAtTimeSync).to.deep.equal([false]);
			expect(connections.sessions[0].options).to.deep.equal({
				priority: "high",
				timeoutMs: OTA_SESSION_TIMEOUT_MS,
				gateways: ["esphome.0:proxy-og"],
			});
			// The update session, then one to read the new version
			expect(connections.sessions).to.have.lengthOf(2);
			expect(sleeps).to.deep.equal([300, VERIFY_DELAY_MS]);
		});

		it("writes the progress at most 100 times, rising", async () => {
			await createUpdater().start();
			await updater.update(FIRST);

			const progress = adapter
				.history(`${FIRST}.pvvx.firmwareProgress`)
				.map(Number);
			expect(progress.length).to.be.at.most(102);
			for (let i = 2; i < progress.length; i++) {
				expect(progress[i]).to.be.at.least(progress[i - 1]);
			}
			expect(progress[progress.length - 1]).to.equal(100);
		});

		for (const [name, prepare, code] of [
			[
				"a low battery",
				(): void => adapter.preset(`${FIRST}.battery`, 39),
				"BATTERY_LOW",
			],
			[
				"no battery value",
				(): void => {
					adapter.states.delete(`${FIRST}.battery`);
				},
				"BATTERY_UNKNOWN",
			],
			[
				"a weak signal",
				(): void => {
					connections.best = {
						gatewayId: "esphome.0:x",
						rssi: -90,
						features: ["writeSequence"],
					};
				},
				"WEAK_SIGNAL",
			],
			[
				"only a gateway without writeSequence",
				(): void => {
					connections.best = {
						gatewayId: "esphome.0:old",
						rssi: -50,
						features: [],
					};
				},
				"NO_GATEWAY",
			],
			[
				"no gateway that can update",
				(): void => {
					connections.best = undefined;
				},
				"NO_GATEWAY",
			],
		] as const) {
			it(`refuses a device with ${name} without connecting`, async () => {
				await createUpdater().start();
				prepare();

				await updater.update(FIRST);

				expect(adapter.val(`${FIRST}.pvvx.firmwareStatus`)).to.equal(
					"failed",
				);
				expect(
					String(adapter.val(`${FIRST}.pvvx.firmwareError`)),
				).to.match(new RegExp(`^${code}: `));
				expect(connections.sessions).to.deep.equal([]);
			});
		}

		it("checks the signal again after loading firmware.json", async () => {
			await createUpdater().start();
			source.getIndex = () => {
				// The signal drops while firmware.json is loading
				connections.best = {
					gatewayId: "esphome.0:proxy-og",
					rssi: -91,
					features: ["writeSequence"],
				};
				return Promise.resolve(index);
			};

			await updater.update(FIRST);

			expect(String(adapter.val(`${FIRST}.pvvx.firmwareError`))).to.match(
				/^WEAK_SIGNAL: /,
			);
			expect(connections.sessions).to.deep.equal([]);
		});

		it("UP_TO_DATE, NO_IMAGE and UNKNOWN_HARDWARE write nothing to the update characteristic", async () => {
			await createUpdater().start();

			first.configResponse[1] = 0x60;
			await updater.update(FIRST);
			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"UP_TO_DATE: Version 6.0 is installed, 6.0 is the newest",
			);

			first.configResponse[1] = 0x59;
			first.configResponse[11] = 1;
			await updater.update(FIRST);
			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"NO_IMAGE: There is no BLE firmware for hardware ID 1",
			);

			first.configResponse[11] = 5;
			await updater.update(FIRST);
			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"UNKNOWN_HARDWARE: Hardware ID 5 is not in firmware.json",
			);

			expect(first.ota.writes).to.deep.equal([]);
		});

		it("INVALID_IMAGE writes nothing to the update characteristic", async () => {
			image = Buffer.from(image);
			image[500] ^= 0xff;
			await createUpdater().start();

			await updater.update(FIRST);

			expect(String(adapter.val(`${FIRST}.pvvx.firmwareError`))).to.match(
				/^INVALID_IMAGE: /,
			);
			expect(first.ota.writes).to.deep.equal([]);
		});

		it("keeps the old firmware when the connection is lost, a second attempt works", async () => {
			await createUpdater().start();
			first.ota.dropAfterPackets = 40;

			await updater.update(FIRST);

			expect(adapter.val(`${FIRST}.pvvx.firmwareStatus`)).to.equal(
				"failed",
			);
			expect(String(adapter.val(`${FIRST}.pvvx.firmwareError`))).to.match(
				/^NOT_CONNECTED: /,
			);
			expect(first.ota.finished).to.equal(false);
			expect(first.configResponse[1]).to.equal(0x59);
			expect(timeSyncs).to.deep.equal([]);

			first.ota.dropAfterPackets = undefined;
			await updater.update(FIRST);

			expect(adapter.val(`${FIRST}.pvvx.firmwareStatus`)).to.equal(
				"done",
			);
			expect(first.ota.finished).to.equal(true);
		});

		it("reports the status the device sends", async () => {
			await createUpdater().start();
			first.ota.failStatusAfterPackets = { after: 20, status: 2 };

			await updater.update(FIRST);

			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"OTA_STATUS_2: packet CRC error",
			);
			expect(adapter.warnings).to.deep.equal([
				`The firmware update of ${FIRST} failed: OTA_STATUS_2: packet CRC error`,
			]);
		});

		it("VERIFY_FAILED when the device reports another version afterwards", async () => {
			await createUpdater().start();
			first.ota.newVersion = 0x59;

			await updater.update(FIRST);

			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"VERIFY_FAILED: Version 5.9 after the update, expected 6.0",
			);
		});

		it("VERIFY_FAILED when the device cannot be reached afterwards", async () => {
			await createUpdater().start();
			const withSession = connections.withSession.bind(connections);
			let calls = 0;
			connections.withSession = (address, job, options) =>
				++calls === 1
					? withSession(address, job, options)
					: Promise.reject(
							new GatewayError("CONNECT_FAILED", "gone"),
						);

			await updater.update(FIRST);

			expect(adapter.val(`${FIRST}.pvvx.firmwareError`)).to.equal(
				"VERIFY_FAILED: The device could not be reached after the update: gone",
			);
			// The update session and three attempts
			expect(calls).to.equal(4);
			expect(sleeps).to.deep.equal([
				300,
				VERIFY_DELAY_MS,
				VERIFY_RETRY_MS,
				VERIFY_RETRY_MS,
			]);
		});

		it("runs one update at a time", async () => {
			await createUpdater().start();
			const gate = deferred();
			connections.gate = gate.promise;

			const a = updater.update(FIRST);
			const b = updater.update(SECOND);
			const again = updater.update(FIRST);
			await settle();

			expect(updater.isBusy(FIRST)).to.equal(true);
			expect(updater.isBusy(SECOND)).to.equal(true);
			expect(connections.updateSessions).to.deep.equal([FIRST]);
			expect(adapter.val(`${SECOND}.pvvx.firmwareStatus`)).to.equal(
				"queued",
			);

			gate.resolve();
			await Promise.all([a, b, again]);
			expect(connections.updateSessions).to.deep.equal([FIRST, SECOND]);
			expect(updater.isBusy(FIRST)).to.equal(false);
			expect(updater.isBusy(SECOND)).to.equal(false);
		});

		it("ignores devices that are not configured", async () => {
			await createUpdater([FIRST]).start();
			await updater.update(SECOND);
			expect(connections.sessions).to.deep.equal([]);
		});
	});

	describe("buttons", () => {
		const press = (id: string, ack = false): boolean =>
			updater.handleStateChange(`ble.0.${id}`, {
				val: true,
				ack,
			} as ioBroker.State);

		it("firmwareUpdate starts the update of the device", async () => {
			await createUpdater().start();

			expect(press(`${FIRST}.pvvx.firmwareUpdate`)).to.equal(true);
			await settle();
			await settle();

			expect(
				adapter.states.get(`${FIRST}.pvvx.firmwareUpdate`),
			).to.include({
				val: false,
				ack: true,
			});
			expect(adapter.val(`${FIRST}.pvvx.firmwareStatus`)).to.equal(
				"done",
			);
		});

		it("updateAll starts only devices with a newer firmware", async () => {
			await createUpdater().start();
			adapter.preset(`${SECOND}.pvvx.firmwareAvailable`, "6.0");
			adapter.preset(`${FIRST}.pvvx.firmwareAvailable`, "");

			expect(press("pvvx.updateAll")).to.equal(true);
			await settle();
			await settle();

			expect(connections.updateSessions).to.deep.equal([SECOND]);
		});

		it("checkFirmware loads firmware.json again", async () => {
			await createUpdater().start();
			adapter.preset(`${FIRST}.pvvx.hardwareId`, 0);
			adapter.preset(`${FIRST}.pvvx.firmwareVersion`, "5.9");
			await updater.checkAll(false);
			expect(source.indexLoads).to.equal(1);

			expect(press("pvvx.checkFirmware")).to.equal(true);
			await settle();

			expect(source.indexLoads).to.equal(2);
		});

		it("confirmed states and foreign IDs", async () => {
			await createUpdater([FIRST]).start();

			expect(press(`${FIRST}.pvvx.firmwareUpdate`, true)).to.equal(true);
			expect(press("pvvx.updateAll", true)).to.equal(true);
			expect(press(`${SECOND}.pvvx.firmwareUpdate`)).to.equal(false);
			expect(press(`${FIRST}.pvvx.syncTime`)).to.equal(false);
			expect(
				updater.handleStateChange("other.0.pvvx.updateAll", {
					val: true,
					ack: false,
				} as ioBroker.State),
			).to.equal(false);
			await settle();
			expect(connections.sessions).to.deep.equal([]);
		});
	});

	it("writes no states after dispose()", async () => {
		await createUpdater().start();
		const gate = deferred();
		connections.gate = gate.promise;
		const done = updater.update(FIRST);
		await settle();
		const writes = adapter.writes.length;

		updater.dispose();
		gate.resolve();
		await settle();

		expect(adapter.writes).to.have.lengthOf(writes);
		// The update never finishes, nothing goes on
		void done;
	});
});
