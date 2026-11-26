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

const sensor = "c1:b2:4e:74:8f:91";
const gatewayId = "trainer";

class PowerGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "00001818-0000-1000-8000-00805f9b34fb",
							handle: 48,
							characteristics: [
								{
									uuid: "00002a63-0000-1000-8000-00805f9b34fb",
									handle: 56,
									properties: 16,
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
	suite("Cycling Power GATT measurements", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { cyclingPowerDevices: sensor });
		});
		after(() => stopAdapter(harness));

		it("subscribes, publishes signed watts and releases an idle connection", async function () {
			this.timeout(25000);
			const gateway = new PowerGateway(harness);
			expect(
				await sendToAdapter(harness, "gateway:announce", {
					protocol: "ble-gateway/1",
					gateways: [{ gatewayId, connect: true, freeSlots: 1 }],
				}),
			).to.have.property("error", null);
			await deliver(harness, gatewayId, [
				{
					address: sensor,
					addressType: "random",
					data: PACKETS.bthomeThermometer,
				},
			]);
			await waitFor(
				() => gateway.subscriptions.size === 1,
				"the power subscription",
			);

			for (const [hex, watts] of [
				["0000fa00", 250],
				["0000fbff", -5],
			]) {
				await sendToAdapter(harness, "gateway:notification", {
					gatewayId,
					address: sensor,
					handle: 56,
					data: Buffer.from(hex, "hex").toString("base64"),
				});
				await waitForValue(harness, `${sensor}.cyclingPower`, watts);
			}

			await waitFor(
				() =>
					gateway.commands.some(
						({ command }) => command === "gatt:disconnect",
					),
				"the power session to disconnect",
			);
			expect(
				gateway.commands.filter(
					({ command }) => command === "gatt:connect",
				),
			).to.have.length(1);
		});
	});
};
