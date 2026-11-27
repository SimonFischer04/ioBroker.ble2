// @ts-check

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	deliver,
	PACKETS,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
	waitForValue,
} = require("./helpers");
const plant = "aa:bb:cc:11:22:33";
const gatewayId = "flower";

class FlowerGateway extends FakeGattGateway {
	handle(command, message) {
		if (command !== "gatt:getServices") {
			return super.handle(command, message);
		}
		const liveCharacteristics = [9, 10, 11].map((id) => ({
			uuid: `39e1fa${id.toString(16).padStart(2, "0")}-84a8-11e2-afba-0002a5d5c51b`,
			handle: 50 + id,
			properties: 2,
			descriptors: [],
		}));
		return {
			error: null,
			result: {
				services: [
					{
						uuid: "39e1fa00-84a8-11e2-afba-0002a5d5c51b",
						handle: 50,
						characteristics: liveCharacteristics,
					},
					{
						uuid: "0000180f-0000-1000-8000-00805f9b34fb",
						handle: 70,
						characteristics: [
							{
								uuid: "00002a19-0000-1000-8000-00805f9b34fb",
								handle: 72,
								properties: 2,
								descriptors: [],
							},
						],
					},
				],
			},
		};
	}
}

exports.runTests = function (suite) {
	suite("Parrot Flower Power readings", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, {
				plugins: "parrot",
				flowerPowerDevices: plant,
			});
		});
		after(() => stopAdapter(harness));

		it("polls the calibrated measurements and the battery over one connection", async function () {
			this.timeout(25000);
			const gateway = new FlowerGateway(harness);
			for (const [handle, value] of [
				[59, 42.25],
				[60, -2.5],
				[61, 12.125],
			]) {
				const data = Buffer.alloc(4);
				data.writeFloatLE(value);
				gateway.values.set(handle, data.toString("hex"));
			}
			gateway.values.set(72, "4a");
			expect(
				await sendToAdapter(harness, "gateway:announce", {
					protocol: "ble-gateway/1",
					gateways: [{ gatewayId, connect: true, freeSlots: 1 }],
				}),
			).to.have.property("error", null);
			await deliver(harness, gatewayId, [
				{ address: plant, data: PACKETS.bthomeThermometer },
			]);

			for (const [id, reading] of [
				["moisture", 42.25],
				["temperature", -2.5],
				["sunlight", 12.13],
				["battery", 74],
			]) {
				await waitForValue(harness, `${plant}.${id}`, reading);
			}
			await waitFor(
				() =>
					gateway.commands.some(
						({ command }) => command === "gatt:disconnect",
					),
				"the Flower Power session to disconnect",
			);
			expect(
				gateway.commands.filter(
					({ command }) => command === "gatt:connect",
				),
			).to.have.length(1);
		});
	});
};
