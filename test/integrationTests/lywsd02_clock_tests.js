// @ts-check

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	deliver,
	getValue,
	PACKETS,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
} = require("./helpers");

const address = "aa:bb:cc:11:22:33";
const clock = "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6";

class ClockGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6",
							handle: 48,
							characteristics: [
								{
									uuid: clock,
									handle: 50,
									properties: 8,
									descriptors: [],
								},
							],
						},
					],
				},
			};
		}
		return super.handle(command, message);
	}
}

exports.runTests = function (suite) {
	suite("LYWSD02 clock", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(
				harness,
				{ plugins: "xiaomi" },
				{ TZ: "Etc/GMT+3" },
			);
		});
		after(() => stopAdapter(harness));

		it("writes current Unix time and the signed local offset, then updates the ioBroker state", async function () {
			this.timeout(20000);
			const gateway = new ClockGateway(harness);
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "clock", connect: true }],
			});
			await deliver(harness, "clock", [
				{ address, data: PACKETS.bthomeThermometer },
			]);

			const before = Math.floor(Date.now() / 1000);
			const { error, result } = await sendToAdapter(
				harness,
				"syncLywsd02Clock",
				{
					address,
				},
			);
			expect(error).to.be.null;
			const write = gateway.commands.find(
				({ command }) => command === "gatt:write",
			);
			expect(write.message).to.include({
				handle: 50,
				withResponse: true,
			});
			const payload = Buffer.from(write.message.data, "base64");
			expect(payload).to.have.length(5);
			expect(payload.readUInt32LE()).to.be.within(
				before,
				Math.floor(Date.now() / 1000),
			);
			expect(payload.readInt8(4)).to.equal(-3);
			expect(result.timestamp).to.equal(payload.readUInt32LE() * 1000);
			expect(
				await getValue(harness, `${address}.lywsd02LastTimeSync`),
			).to.equal(result.timestamp);
		});
	});

	suite("LYWSD02 automatic clock sync", (getHarness) => {
		const other = "aa:bb:cc:11:22:34";
		let harness;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(
				harness,
				{
					plugins: "xiaomi",
					lywsd02ClockDevices: address.toUpperCase(),
				},
				{ TZ: "Etc/GMT+3" },
			);
		});

		after(() => stopAdapter(harness));

		it("updates a configured clock when seen and leaves other devices alone", async function () {
			this.timeout(20000);
			const gateway = new ClockGateway(harness);
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "automatic-clock", connect: true }],
			});
			await deliver(
				harness,
				"automatic-clock",
				[other, address, address].map((device) => ({
					address: device,
					data: PACKETS.bthomeThermometer,
				})),
			);
			const timestamp = await waitFor(
				() => getValue(harness, `${address}.lywsd02LastTimeSync`),
				"automatic clock sync",
			);
			expect(await getValue(harness, `${other}.lywsd02LastTimeSync`)).to
				.be.undefined;
			const writes = gateway.commands.filter(
				({ command }) => command === "gatt:write",
			);
			expect(writes).to.have.length(1);
			const message = writes[0].message;
			expect(message).to.include({
				address,
				handle: 50,
				withResponse: true,
			});
			expect(
				Buffer.from(message.data, "base64").readUInt32LE() * 1000,
			).to.equal(timestamp);
		});
	});
};
