import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import { DevicePresence } from "./device-presence";

describe("BLE presence", () => {
	let clock: ReturnType<typeof useFakeTimers>;
	const adapter = createGlobalMock({}).Global.adapter;
	const address = "aa:bb:cc:dd:ee:ff";
	const otherAddress = "11:22:33:44:55:66";
	const settings = [
		{ address: "AABBCCDDEEFF", packets: 3, absenceSeconds: 60 },
		{ address: otherAddress, packets: 1, absenceSeconds: 10 },
	];
	beforeEach(() => {
		clock = useFakeTimers();
	});
	afterEach(() => {
		clock.restore();
	});

	it("fills and drains the score for each configured device", async () => {
		const write = stub().resolves();
		const presence = new DevicePresence(adapter, settings, write);
		presence.restore(address);
		await clock.tickAsync(0);
		expect(write.calledOnceWithExactly(address, false)).to.be.true;
		presence.observe(address);
		await clock.tickAsync(21000);
		presence.observe(address);
		await clock.tickAsync(1000);
		presence.observe(address);
		await clock.tickAsync(1000);
		expect(write.callCount).to.equal(1);
		presence.observe(address);
		presence.observe(otherAddress);
		await clock.tickAsync(10000);
		expect(write.getCalls().map((call) => call.args)).to.deep.equal([
			[address, false],
			[address, true],
			[otherAddress, true],
			[otherAddress, false],
		]);
		await clock.tickAsync(50000);
		expect(write.lastCall.args).to.deep.equal([address, false]);
	});

	it("ignores unconfigured devices and cancels writes after deletion or shutdown", async () => {
		const write = stub().resolves();
		const presence = new DevicePresence(adapter, settings, write);
		presence.observe("22:22:22:22:22:22");
		presence.observe(otherAddress);
		presence.remove(otherAddress);
		await clock.tickAsync(10000);
		expect(write.callCount).to.equal(0);
		presence.observe(otherAddress);
		await clock.tickAsync(1);
		presence.stop();
		await clock.tickAsync(60000);
		expect(write.calledOnceWithExactly(otherAddress, true)).to.be.true;
	});
});
