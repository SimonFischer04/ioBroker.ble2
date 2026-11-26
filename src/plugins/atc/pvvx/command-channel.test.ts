import { expect } from "chai";
import { GatewayError } from "../../../lib/gateway-error";
import { PvvxCommandChannel } from "./command-channel";
import { createFakeSession, FakePvvxDevice } from "./fake-pvvx-device";
import { PVVX_WRITE_WITH_RESPONSE } from "./protocol";

const realTimers = {
	setTimeout: (callback: () => void, ms: number): unknown =>
		setTimeout(callback, ms),
	clearTimeout: (timer: any): void => clearTimeout(timer),
};

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
	try {
		await promise;
	} catch (e) {
		expect(e).to.be.instanceOf(GatewayError);
		return e as GatewayError;
	}
	throw new Error("the promise did not reject");
}

describe("plugins/atc/pvvx/command-channel => PvvxCommandChannel", () => {
	let device: FakePvvxDevice;

	async function openChannel(
		timers: typeof realTimers = realTimers,
	): Promise<PvvxCommandChannel> {
		const channel = new PvvxCommandChannel(
			createFakeSession(device),
			timers,
		);
		await channel.open();
		return channel;
	}

	beforeEach(() => {
		device = new FakePvvxDevice();
	});

	it("resolves with the answer to 0x55", async () => {
		const channel = await openChannel();
		const answer = await channel.request(Buffer.from([0x55]));
		expect(answer.toString("hex")).to.equal("5559000000000a048b003700");
	});

	it("skips other notifications, e.g. measurements", async () => {
		device.beforeEachAnswer = [Buffer.from("330b0c2e09f41364", "hex")];
		const channel = await openChannel();
		const answer = await channel.request(Buffer.from([0x55]));
		expect(answer[0]).to.equal(0x55);
	});

	it("rejects with TIMEOUT when the device does not answer", async () => {
		device.silentCommands = [0x55];
		const channel = await openChannel();
		const error = await rejection(channel.request(Buffer.from([0x55]), 50));
		expect(error.code).to.equal("TIMEOUT");
		expect(error.message).to.equal(
			"No answer to command 0x55 within 50 ms",
		);
	});

	it("writes as the firmware expects", async () => {
		const channel = await openChannel();
		await channel.request(Buffer.from([0x23]));
		expect(device.writes).to.have.lengthOf(1);
		expect(device.writes[0].withResponse).to.equal(
			PVVX_WRITE_WITH_RESPONSE,
		);
	});

	it("runs one request at a time", async () => {
		const channel = await openChannel();
		const first = channel.request(Buffer.from([0x55]));
		const error = await rejection(channel.request(Buffer.from([0x23])));
		expect(error.code).to.equal("GATT_ERROR");
		expect((await first)[0]).to.equal(0x55);
		expect(device.writes).to.have.lengthOf(1);
	});

	it("passes a failed write on and clears its timer", async () => {
		const failure = new GatewayError("NOT_CONNECTED", "gone");
		const cleared: unknown[] = [];
		const fakeTimers = {
			setTimeout: (): unknown => "timer-1",
			clearTimeout: (timer: any): void => {
				cleared.push(timer);
			},
		};
		const channel = await openChannel(fakeTimers);
		device.failWrite = failure;

		const error = await rejection(channel.request(Buffer.from([0x55])));

		expect(error).to.equal(failure);
		expect(cleared).to.deep.equal(["timer-1"]);
		// The channel can be used again
		device.failWrite = undefined;
		expect((await channel.request(Buffer.from([0x55])))[0]).to.equal(0x55);
	});
});
