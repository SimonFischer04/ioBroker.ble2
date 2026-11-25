import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { StaleDeviceCleanup } from "./stale-device-cleanup";

const dayMs = 86_400_000;
const prefix = "ble2.0.";

function fixture() {
	const old = Date.now() - 90 * dayMs;
	const objects: Record<string, object> = Object.fromEntries(
		["stale", "recent", "protected", "history", "noRssi", "revived"].map(
			(name) => [
				`${prefix}${name}`,
				{ type: "device", native: { id: name, address: name } },
			],
		),
	);
	objects[`${prefix}history.temperature`] = {
		type: "state",
		common: { custom: { "history.0": { enabled: true } } },
	};
	objects[`${prefix}manual`] = { type: "device", native: {} };
	objects["ble2.1.foreign"] = {
		type: "device",
		native: { id: "foreign", address: "foreign" },
	};
	const states = Object.fromEntries(
		["stale", "protected", "history", "revived", "manual"].map((name) => [
			`${prefix}${name}.rssi`,
			{ val: -60, ts: old },
		]),
	);
	states[`${prefix}recent.rssi`] = { val: -60, ts: Date.now() };
	states["ble2.1.foreign.rssi"] = { val: -60, ts: old };
	const deleteObject = stub().resolves();
	const adapter = {
		namespace: "ble2.0",
		getAdapterObjectsAsync: stub().resolves(objects),
		getStatesAsync: stub().resolves(states),
		getEnumsAsync: stub().resolves({
			"enum.rooms": {
				"enum.rooms.office": {
					common: { members: [`${prefix}protected.rssi`] },
				},
			},
		}),
		getObjectAsync: (id: string): Promise<unknown> =>
			Promise.resolve(objects[id]),
		getStateAsync: (id: string): Promise<unknown> =>
			Promise.resolve(states[id]),
		delObjectAsync: deleteObject,
		log: { info: stub(), warn: stub() },
	} as unknown as ioBroker.Adapter;
	return { cleanup: new StaleDeviceCleanup(adapter), deleteObject, states };
}

describe("Stale device cleanup", () => {
	let clock: ReturnType<typeof useFakeTimers>;
	beforeEach(() => {
		clock = useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
	});
	afterEach(() => {
		clock.restore();
	});

	it("deletes only previewed stale BLE devices, skipping newer or protected data", async () => {
		const { cleanup, deleteObject, states } = fixture();
		const preview = await cleanup.prepare("admin", 56);
		expect(preview.count).to.equal(2);
		expect(deleteObject.callCount).to.equal(0);
		states[`${prefix}revived.rssi`].ts = Date.now();
		cleanup.start("admin", preview.token, 56);
		await clock.tickAsync(1);
		expect(
			deleteObject.calledOnceWithExactly(`${prefix}stale`, {
				recursive: true,
			}),
		).to.be.true;
	});

	it("skips devices that advertise during cleanup", async () => {
		const { cleanup, deleteObject } = fixture();
		const preview = await cleanup.prepare("admin", 56);
		cleanup.start("admin", preview.token, 56);
		cleanup.recordActivity("revived");
		await clock.tickAsync(1);
		expect(
			deleteObject.calledOnceWithExactly(`${prefix}stale`, {
				recursive: true,
			}),
		).to.be.true;
	});

	it("requires a fresh token for the same sender and age", async () => {
		const { cleanup, deleteObject } = fixture();
		await expect(cleanup.prepare("admin", 0)).to.be.rejectedWith(
			"Enter an age",
		);
		const preview = await cleanup.prepare("admin", 56);
		expect(() => cleanup.start("other", preview.token, 56)).to.throw(
			"fresh cleanup preview",
		);
		expect(() => cleanup.start("admin", preview.token, 57)).to.throw(
			"fresh cleanup preview",
		);
		await clock.tickAsync(5 * 60_000);
		expect(() => cleanup.start("admin", preview.token, 56)).to.throw(
			"fresh cleanup preview",
		);
		expect(deleteObject.callCount).to.equal(0);
	});
});
