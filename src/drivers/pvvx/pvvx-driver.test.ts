import { expect } from "chai";
import type { GattSession } from "../../connections/gatt-session";
import { GatewayError } from "../../lib/gateway-error";
import { createFakeSession, FakePvvxDevice } from "./fake-pvvx-device";
import { localClockValue } from "./protocol";
import {
	FALLBACK_INTERVAL_MS,
	parseDeviceList,
	PvvxDriver,
	type PvvxDriverContext,
	RETRY_DELAYS_MS,
	START_DELAY_MS,
	TICK_INTERVAL_MS,
} from "./pvvx-driver";

const FIRST = "a4:c1:38:12:34:56";
const SECOND = "a4:c1:38:65:43:21";
const HOUR = 3600000;
const MINUTE = 60000;

class FakeAdapter {
	public readonly namespace = "ble.0";
	public readonly objects = new Map<string, ioBroker.SettableObject>();
	public readonly states = new Map<
		string,
		{ val: ioBroker.StateValue; ack: boolean }
	>();
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
		if (!this.objects.has(id)) this.objects.set(id, obj);
		return Promise.resolve({ id });
	}

	public setStateAsync(
		id: string,
		val: ioBroker.StateValue,
		ack: boolean,
	): Promise<string> {
		this.states.set(this.relative(id), { val, ack });
		return Promise.resolve(id);
	}

	public val(id: string): ioBroker.StateValue | undefined {
		return this.states.get(id)?.val;
	}

	public get warnings(): string[] {
		return this.logs
			.filter((l) => l.level === "warn")
			.map((l) => l.message);
	}
}

/** What withSession does for one address */
type Behavior =
	| FakePvvxDevice
	| GatewayError
	| { device: FakePvvxDevice; gate: Promise<void> };

class FakeConnections {
	public readonly behaviors = new Map<string, Behavior>();
	/** Addresses in the order withSession was called */
	public readonly calls: string[] = [];
	public readonly finished: string[] = [];

	public async withSession<T>(
		address: string,
		job: (session: GattSession) => Promise<T>,
	): Promise<T> {
		this.calls.push(address);
		const behavior = this.behaviors.get(address);
		try {
			if (behavior instanceof GatewayError) throw behavior;
			if (behavior instanceof FakePvvxDevice) {
				return await job(createFakeSession(behavior));
			}
			if (behavior) {
				await behavior.gate;
				return await job(createFakeSession(behavior.device));
			}
			throw new GatewayError("NO_GATEWAY", "no behavior");
		} finally {
			this.finished.push(address);
		}
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe("drivers/pvvx/pvvx-driver", () => {
	describe("parseDeviceList()", () => {
		it("accepts commas, semicolons, spaces and line breaks in any case", () => {
			expect(
				parseDeviceList(
					"A4:C1:38:12:34:56, a4:c1:38:65:43:21;a4:c1:38:00:00:01\na4:c1:38:00:00:02  a4:c1:38:00:00:03",
				),
			).to.deep.equal({
				addresses: [
					"a4:c1:38:12:34:56",
					"a4:c1:38:65:43:21",
					"a4:c1:38:00:00:01",
					"a4:c1:38:00:00:02",
					"a4:c1:38:00:00:03",
				],
				invalid: [],
			});
		});

		it("accepts dashes as separators of the address", () => {
			expect(
				parseDeviceList("A4-C1-38-12-34-56").addresses,
			).to.deep.equal(["a4:c1:38:12:34:56"]);
		});

		it("removes duplicates and keeps the order of the first mention", () => {
			expect(
				parseDeviceList(
					"a4:c1:38:65:43:21, a4:c1:38:12:34:56, A4:C1:38:65:43:21",
				).addresses,
			).to.deep.equal(["a4:c1:38:65:43:21", "a4:c1:38:12:34:56"]);
		});

		it("returns invalid entries separately", () => {
			expect(
				parseDeviceList("a4:c1:38:12:34:56, not-a-mac"),
			).to.deep.equal({
				addresses: ["a4:c1:38:12:34:56"],
				invalid: ["not-a-mac"],
			});
		});

		it("an empty or missing setting is an empty list", () => {
			const empty = { addresses: [], invalid: [] };
			expect(parseDeviceList(undefined)).to.deep.equal(empty);
			expect(parseDeviceList("")).to.deep.equal(empty);
			expect(parseDeviceList(" , ")).to.deep.equal(empty);
		});
	});

	describe("PvvxDriver", () => {
		let adapter: FakeAdapter;
		let connections: FakeConnections;
		let clock: {
			nowMs: number;
			offset: number;
			now(): number;
			timezoneOffset(): number;
		};
		let intervals: { callback: () => void; ms: number }[];
		let cleared: unknown[];
		let driver: PvvxDriver;
		let first: FakePvvxDevice;
		let second: FakePvvxDevice;

		function createDriver(
			addresses: string[],
			syncIntervalHours = 24,
		): PvvxDriver {
			const ctx: PvvxDriverContext = {
				adapter: adapter as unknown as PvvxDriverContext["adapter"],
				connections,
				clock,
				setTimeout: (callback, ms) => setTimeout(callback, ms),
				clearTimeout: (timer) => clearTimeout(timer),
				setInterval: (callback, ms) => {
					intervals.push({ callback, ms });
					return intervals.length;
				},
				clearInterval: (timer) => {
					cleared.push(timer);
				},
			};
			driver = new PvvxDriver(ctx, { addresses, syncIntervalHours });
			return driver;
		}

		/** Lets time pass and runs a tick */
		async function advance(ms: number): Promise<void> {
			clock.nowMs += ms;
			await driver.tick();
		}

		/** The device clock as the driver sets it now */
		function expectedValue(): number {
			return localClockValue(clock.nowMs, clock.offset);
		}

		beforeEach(() => {
			adapter = new FakeAdapter();
			connections = new FakeConnections();
			clock = {
				nowMs: Date.parse("2026-07-01T10:00:00Z"),
				offset: -120,
				now() {
					return this.nowMs;
				},
				timezoneOffset() {
					return this.offset;
				},
			};
			intervals = [];
			cleared = [];
			first = new FakePvvxDevice(FIRST);
			second = new FakePvvxDevice(SECOND);
			connections.behaviors.set(FIRST, first);
			connections.behaviors.set(SECOND, second);
		});

		afterEach(() => {
			driver?.dispose();
		});

		it("does nothing without devices", async () => {
			await createDriver([]).start();
			expect(adapter.objects.size).to.equal(0);
			expect(intervals).to.have.lengthOf(0);
		});

		it("creates the device, the channel and the states", async () => {
			await createDriver([FIRST]).start();

			expect(adapter.objects.get(FIRST)).to.deep.include({
				type: "device",
				common: { name: FIRST },
				native: { address: FIRST },
			});
			expect(adapter.objects.get(`${FIRST}.pvvx`)).to.deep.include({
				type: "channel",
				common: { name: "pvvx firmware" },
			});
			const states = [
				"syncTime",
				"lastTimeSync",
				"timeDeviation",
				"firmwareVersion",
				"hardwareId",
				"lastError",
			];
			for (const id of states) {
				expect(
					adapter.objects.get(`${FIRST}.pvvx.${id}`)?.type,
				).to.equal("state");
			}
			expect(adapter.objects.size).to.equal(2 + states.length);
			expect(
				adapter.objects.get(`${FIRST}.pvvx.syncTime`)?.common,
			).to.include({ role: "button", write: true, read: false });
			expect(
				adapter.objects.get(`${FIRST}.pvvx.timeDeviation`)?.common,
			).to.include({ unit: "s", read: true, write: false });
			expect(intervals).to.deep.equal([
				{ callback: intervals[0].callback, ms: TICK_INTERVAL_MS },
			]);
		});

		it("waits for the start delay before the first sync", async () => {
			await createDriver([FIRST]).start();

			await advance(START_DELAY_MS - 1);
			expect(connections.calls).to.deep.equal([]);

			await advance(1);
			expect(connections.calls).to.deep.equal([FIRST]);
		});

		it("writes the result into the states", async () => {
			await createDriver([FIRST]).start();
			clock.nowMs += START_DELAY_MS;
			first.clock = expectedValue() - 3600;

			await driver.tick();

			expect(first.clock).to.equal(expectedValue());
			expect(adapter.val(`${FIRST}.pvvx.lastTimeSync`)).to.equal(
				clock.nowMs,
			);
			expect(adapter.val(`${FIRST}.pvvx.timeDeviation`)).to.equal(-3600);
			expect(adapter.val(`${FIRST}.pvvx.firmwareVersion`)).to.equal(
				"5.9",
			);
			expect(adapter.val(`${FIRST}.pvvx.hardwareId`)).to.equal(0);
			expect(adapter.states.get(`${FIRST}.pvvx.lastError`)).to.deep.equal(
				{
					val: "",
					ack: true,
				},
			);
		});

		it("syncs again after the interval", async () => {
			await createDriver([FIRST], 24).start();
			await advance(START_DELAY_MS);

			await advance(24 * HOUR - 1);
			expect(connections.calls).to.have.lengthOf(1);
			await advance(1);
			expect(connections.calls).to.have.lengthOf(2);
		});

		it("never syncs again with the interval 0", async () => {
			await createDriver([FIRST], 0).start();
			await advance(START_DELAY_MS);

			await advance(365 * 24 * HOUR);
			expect(connections.calls).to.have.lengthOf(1);
		});

		it("retries after 5, 15 and 60 minutes, then in the interval", async () => {
			connections.behaviors.set(
				FIRST,
				new GatewayError("NO_GATEWAY", "No gateway can connect"),
			);
			await createDriver([FIRST], 24).start();
			await advance(START_DELAY_MS);
			expect(connections.calls).to.have.lengthOf(1);
			expect(adapter.val(`${FIRST}.pvvx.lastError`)).to.equal(
				"NO_GATEWAY: No gateway can connect",
			);

			for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
				await advance(delay - 1);
				expect(connections.calls).to.have.lengthOf(i + 1);
				await advance(1);
				expect(connections.calls).to.have.lengthOf(i + 2);
				// Warned once, at the third error in a row
				expect(adapter.warnings).to.have.lengthOf(i + 2 >= 3 ? 1 : 0);
			}

			await advance(24 * HOUR - 1);
			expect(connections.calls).to.have.lengthOf(4);
			await advance(1);
			expect(connections.calls).to.have.lengthOf(5);
			expect(adapter.warnings).to.have.lengthOf(1);
			// The next round starts with the retries again
			await advance(RETRY_DELAYS_MS[0]);
			expect(connections.calls).to.have.lengthOf(6);
		});

		it("tries again after 24 hours when the retries failed and there is no interval", async () => {
			connections.behaviors.set(
				FIRST,
				new GatewayError("NO_GATEWAY", "No gateway can connect"),
			);
			await createDriver([FIRST], 0).start();
			await advance(START_DELAY_MS);
			for (const delay of RETRY_DELAYS_MS) await advance(delay);
			expect(connections.calls).to.have.lengthOf(4);

			await advance(FALLBACK_INTERVAL_MS - 1);
			expect(connections.calls).to.have.lengthOf(4);
			await advance(1);
			expect(connections.calls).to.have.lengthOf(5);
		});

		it("sets all clocks when the UTC offset changes", async () => {
			connections.behaviors.set(
				SECOND,
				new GatewayError("NO_GATEWAY", "No gateway can connect"),
			);
			await createDriver([FIRST, SECOND], 24).start();
			await advance(START_DELAY_MS);
			// FIRST is due in 24 h, SECOND retries in 5 minutes
			connections.behaviors.set(SECOND, second);
			const calls = connections.calls.length;

			clock.offset = -60;
			await advance(MINUTE);

			expect(connections.calls.slice(calls)).to.have.members([
				FIRST,
				SECOND,
			]);
			expect(first.clock).to.equal(expectedValue());
			expect(second.clock).to.equal(expectedValue());
			expect(adapter.logs.map((l) => l.message)).to.include(
				"The UTC offset changed, setting the clock of all pvvx devices",
			);
		});

		it("syncs one device after the other", async () => {
			const gate = deferred();
			connections.behaviors.set(FIRST, {
				device: first,
				gate: gate.promise,
			});
			await createDriver([FIRST, SECOND]).start();
			clock.nowMs += START_DELAY_MS;

			const tick = driver.tick();
			await new Promise((resolve) => setImmediate(resolve));
			expect(connections.calls).to.deep.equal([FIRST]);

			gate.resolve();
			await tick;
			expect(connections.calls).to.deep.equal([FIRST, SECOND]);
			expect(connections.finished).to.deep.equal([FIRST, SECOND]);
		});

		it("an error at one device does not stop the others", async () => {
			connections.behaviors.set(
				FIRST,
				new GatewayError("TIMEOUT", "slow"),
			);
			await createDriver([FIRST, SECOND]).start();

			await advance(START_DELAY_MS);

			expect(connections.calls).to.deep.equal([FIRST, SECOND]);
			expect(adapter.val(`${FIRST}.pvvx.lastError`)).to.equal(
				"TIMEOUT: slow",
			);
			expect(adapter.val(`${SECOND}.pvvx.lastError`)).to.equal("");
		});

		it("sets the clock when the button is pressed", async () => {
			await createDriver([FIRST]).start();
			const id = `ble.0.${FIRST}.pvvx.syncTime`;

			expect(
				driver.handleStateChange(id, {
					val: true,
					ack: false,
				} as ioBroker.State),
			).to.equal(true);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(connections.calls).to.deep.equal([FIRST]);
			expect(adapter.states.get(`${FIRST}.pvvx.syncTime`)).to.deep.equal({
				val: false,
				ack: true,
			});
			expect(adapter.val(`${FIRST}.pvvx.lastError`)).to.equal("");
		});

		it("ignores confirmed button states and foreign states", async () => {
			await createDriver([FIRST]).start();

			expect(
				driver.handleStateChange(`ble.0.${FIRST}.pvvx.syncTime`, {
					val: true,
					ack: true,
				} as ioBroker.State),
			).to.equal(true);
			expect(
				driver.handleStateChange(`ble.0.${SECOND}.pvvx.syncTime`, {
					val: true,
					ack: false,
				} as ioBroker.State),
			).to.equal(false);
			expect(
				driver.handleStateChange("ble.0.options.allowNewDevices", {
					val: true,
					ack: false,
				} as ioBroker.State),
			).to.equal(false);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(connections.calls).to.deep.equal([]);
		});

		it("a second tick does nothing while one is running", async () => {
			const gate = deferred();
			connections.behaviors.set(FIRST, {
				device: first,
				gate: gate.promise,
			});
			await createDriver([FIRST]).start();
			clock.nowMs += START_DELAY_MS;

			const tick = driver.tick();
			await driver.tick();
			expect(connections.calls).to.deep.equal([FIRST]);

			gate.resolve();
			await tick;
			expect(connections.calls).to.deep.equal([FIRST]);
		});

		it("writes no states after dispose()", async () => {
			const gate = deferred();
			connections.behaviors.set(FIRST, {
				device: first,
				gate: gate.promise,
			});
			await createDriver([FIRST]).start();
			clock.nowMs += START_DELAY_MS;

			const tick = driver.tick();
			driver.dispose();
			gate.resolve();
			await tick;

			expect(adapter.states.size).to.equal(0);
			expect(cleared).to.deep.equal([1]);
		});

		it("requestSync() sets the clock right away", async () => {
			await createDriver([FIRST]).start();

			driver.requestSync(FIRST);
			driver.requestSync("a4:c1:38:00:00:99");
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(connections.calls).to.deep.equal([FIRST]);
			expect(adapter.val(`${FIRST}.pvvx.lastError`)).to.equal("");
		});

		it("skips a device during a firmware update and tries again later", async () => {
			let busy = true;
			driver = new PvvxDriver(
				{
					adapter: adapter as unknown as PvvxDriverContext["adapter"],
					connections,
					clock,
					setTimeout: (callback, ms) => setTimeout(callback, ms),
					clearTimeout: (timer) => clearTimeout(timer),
					setInterval: () => 1,
					clearInterval: () => {},
					isBusy: (address) => busy && address === FIRST,
				},
				{ addresses: [FIRST, SECOND], syncIntervalHours: 24 },
			);
			await driver.start();

			await advance(START_DELAY_MS);
			expect(connections.calls).to.deep.equal([SECOND]);

			busy = false;
			await advance(RETRY_DELAYS_MS[0] - 1);
			expect(connections.calls).to.deep.equal([SECOND]);
			await advance(1);
			expect(connections.calls).to.deep.equal([SECOND, FIRST]);
			// Not counted as an error
			expect(adapter.warnings).to.deep.equal([]);
			expect(adapter.val(`${FIRST}.pvvx.lastError`)).to.equal("");
		});
	});
});
