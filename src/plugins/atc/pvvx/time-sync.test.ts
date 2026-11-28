import { expect } from "chai";
import { PvvxCommandChannel } from "./command-channel";
import { createFakeSession, FakePvvxDevice } from "./fake-pvvx-device";
import { localClockValue } from "./protocol";
import { type Clock, PvvxProtocolError, syncTime } from "./time-sync";

const NOW = Date.parse("2026-07-01T10:00:00.250Z");

const timers = {
	setTimeout: (callback: () => void, ms: number): unknown =>
		setTimeout(callback, ms),
	clearTimeout: (timer: any): void => clearTimeout(timer),
};

function fakeClock(offset: number): Clock {
	return { now: () => NOW, timezoneOffset: () => offset };
}

describe("plugins/atc/pvvx/time-sync => syncTime()", () => {
	let device: FakePvvxDevice;
	let channel: PvvxCommandChannel;
	const expected = localClockValue(NOW, -120);

	beforeEach(async () => {
		device = new FakePvvxDevice();
		device.clock = expected;
		channel = new PvvxCommandChannel(createFakeSession(device), timers);
		await channel.open();
	});

	async function protocolError(promise: Promise<unknown>): Promise<void> {
		try {
			await promise;
		} catch (e) {
			expect(e).to.be.instanceOf(PvvxProtocolError);
			expect((e as PvvxProtocolError).code).to.equal("UNEXPECTED_ANSWER");
			return;
		}
		throw new Error("the promise did not reject");
	}

	it("reads the configuration and the clock, then sets the local time", async () => {
		device.clock = 1000;

		const result = await syncTime(channel, fakeClock(-120));

		const value = Buffer.alloc(4);
		value.writeUInt32LE(expected);
		expect(device.writes.map((w) => w.data.toString("hex"))).to.deep.equal([
			"55",
			"23",
			`23${value.toString("hex")}`,
		]);
		expect(device.clock).to.equal(expected);
		expect(result).to.include({
			version: 0x59,
			hardwareId: 0,
			value: expected,
		});
	});

	it("reports how far the clock was off", async () => {
		device.clock = expected - 3600;
		expect((await syncTime(channel, fakeClock(-120))).deviation).to.equal(
			-3600,
		);

		device.clock = expected + 5;
		expect((await syncTime(channel, fakeClock(-120))).deviation).to.equal(
			5,
		);
	});

	it("stops when the configuration is not one of a pvvx firmware", async () => {
		device.configResponse = Buffer.from("555900", "hex");

		await protocolError(syncTime(channel, fakeClock(-120)));

		expect(device.writes.map((w) => w.data.toString("hex"))).to.deep.equal([
			"55",
		]);
	});

	it("works with devices that report when the clock was set last", async () => {
		device.timeAdjust = true;
		device.clock = expected - 10;

		const result = await syncTime(channel, fakeClock(-120));

		expect(result.deviation).to.equal(-10);
		expect(device.clock).to.equal(expected);
	});

	it("fails when the device does not take the time", async () => {
		device.ignoreSetTime = true;
		device.clock = expected - 86400;

		await protocolError(syncTime(channel, fakeClock(-120)));
	});

	it("takes the UTC offset from the clock", async () => {
		const summer = await syncTime(channel, fakeClock(-120));
		const winter = await syncTime(channel, fakeClock(-60));
		expect(summer.value - winter.value).to.equal(3600);
	});
});
