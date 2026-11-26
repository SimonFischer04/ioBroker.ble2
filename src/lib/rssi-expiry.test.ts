import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import { RssiExpiry } from "./rssi-expiry";

describe("RSSI expiration", () => {
	let clock: ReturnType<typeof useFakeTimers>;
	const adapterMock = createGlobalMock({}).Global.adapter;
	const setStateAsync = stub();
	const adapter = { ...adapterMock, setStateAsync };
	const id = "ble2.0.device.rssi";

	beforeEach(() => {
		clock = useFakeTimers();
		setStateAsync.reset();
		setStateAsync.resolves();
	});
	afterEach(() => {
		clock.restore();
	});

	it("uses advertisement time even when RSSI writes are throttled", async () => {
		const expiry = new RssiExpiry(adapter, 1000);
		const skippedWrite = stub().resolves();
		await expiry.update(id, skippedWrite);
		await clock.tickAsync(750);
		await expiry.update(id, skippedWrite);
		await clock.tickAsync(999);
		expect(setStateAsync.callCount).to.equal(0);
		await clock.tickAsync(1);
		expect(setStateAsync.calledOnceWithExactly(id, 0, true)).to.be.true;
	});

	it("resets an already stale state restored on startup", async () => {
		const expiry = new RssiExpiry(adapter, 1000);
		expiry.restore(id, Date.now() - 2000);
		await clock.tickAsync(1);
		expect(setStateAsync.calledOnceWithExactly(id, 0, true)).to.be.true;
	});

	it("writes an arriving RSSI after a reset that is already in progress", async () => {
		const expiry = new RssiExpiry(adapter, 1000);
		let completeReset!: () => void;
		setStateAsync.onFirstCall().returns(
			new Promise<void>((resolve) => {
				completeReset = resolve;
			}),
		);
		expiry.restore(id, Date.now());
		await clock.tickAsync(1000);
		const next = expiry.update(id, async () => {
			await setStateAsync(id, -60, true);
		});
		expect(setStateAsync.callCount).to.equal(1);
		completeReset();
		await next;
		expect(
			setStateAsync.getCalls().map((call) => call.args[1]),
		).to.deep.equal([0, -60]);
	});

	it("cancels timers on deletion and shutdown", async () => {
		const expiry = new RssiExpiry(adapter, 1000);
		expiry.restore(id, Date.now());
		expiry.remove(id);
		expiry.restore(`${id}2`, Date.now());
		expiry.stop();
		await clock.tickAsync(2000);
		expect(setStateAsync.callCount).to.equal(0);
	});
});
