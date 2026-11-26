import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import { RssiUpdates } from "./rssi-updates";

describe("RSSI update cache", () => {
	const id = "ble2.0.device.rssi";
	const getStateAsync = stub();
	const setStateAsync = stub();
	const adapter = {
		...createGlobalMock({}).Global.adapter,
		getStateAsync,
		setStateAsync,
	};
	let clock: ReturnType<typeof useFakeTimers>;

	beforeEach(() => {
		clock = useFakeTimers({ now: 10_000 });
		getStateAsync.reset();
		setStateAsync.reset();
		getStateAsync.resolves({ ts: 9_000 });
		setStateAsync.resolves();
	});
	afterEach(() => {
		clock.restore();
	});

	it("reads the stored timestamp once and serializes simultaneous packets", async () => {
		const updater = new RssiUpdates(adapter, 100);
		await Promise.all([updater.update(id, -50), updater.update(id, -51)]);
		expect(getStateAsync.calledOnceWithExactly(id)).to.be.true;
		expect(setStateAsync.calledOnceWithExactly(id, -50, true)).to.be.true;
		clock.tick(101);
		await updater.update(id, -50);
		expect(getStateAsync.callCount).to.equal(1);
		expect(setStateAsync.callCount).to.equal(2);
	});

	it("honors state notifications and re-reads after deletion", async () => {
		const updater = new RssiUpdates(adapter, 100);
		await updater.update(id, -50);
		clock.tick(101);
		updater.observe(id, { ts: Date.now() } as ioBroker.State);
		await updater.update(id, -51);
		expect(setStateAsync.callCount).to.equal(1);
		updater.observe(id, null);
		getStateAsync.resolves(null);
		await updater.update(id, -51);
		expect(getStateAsync.callCount).to.equal(2);
		expect(setStateAsync.lastCall.args).to.deep.equal([id, -51, true]);
	});

	it("retries after a failed write without advancing the throttle timestamp", async () => {
		const updater = new RssiUpdates(adapter, 100);
		setStateAsync.onFirstCall().rejects(new Error("Database unavailable"));
		await expect(updater.update(id, -50)).to.be.rejectedWith(
			"Database unavailable",
		);
		await updater.update(id, -51);
		expect(getStateAsync.callCount).to.equal(1);
		expect(setStateAsync.callCount).to.equal(2);
	});
});
