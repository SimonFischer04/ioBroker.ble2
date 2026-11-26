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

const plant = "c4:7c:8d:11:22:33";
const otherPlant = "c4:7c:8d:11:22:44";

class PlantGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "00001204-0000-1000-8000-00805f9b34fb",
							handle: 48,
							characteristics: [
								{
									uuid: "00001a02-0000-1000-8000-00805f9b34fb",
									handle: 56,
									properties: 2,
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
	suite("Mi Flora battery polling", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { miFloraBatteryDevices: plant });
		});
		after(() => stopAdapter(harness));

		it("reads configured plants once and closes the GATT session", async function () {
			this.timeout(20000);
			const gateway = new PlantGateway(harness);
			gateway.values.set(
				56,
				Buffer.concat([
					Buffer.from([74, 0]),
					Buffer.from("3.2.1"),
				]).toString("hex"),
			);
			expect(
				await sendToAdapter(harness, "gateway:announce", {
					protocol: "ble-gateway/1",
					gateways: [
						{ gatewayId: "plants", connect: true, freeSlots: 1 },
					],
				}),
			).to.have.property("error", null);

			const nearby = [otherPlant, plant].map((address) => ({
				address,
				data: PACKETS.bthomeThermometer,
			}));
			await deliver(harness, "plants", nearby);
			await waitForValue(harness, `${plant}.battery`, 74);
			await waitFor(
				() =>
					gateway.commands.some(
						({ command }) => command === "gatt:disconnect",
					),
				"the battery session to disconnect",
			);
			await deliver(harness, "plants", nearby);

			const connections = gateway.commands.filter(
				({ command }) => command === "gatt:connect",
			);
			expect(
				connections.map(({ message }) => message.address),
			).to.deep.equal([plant]);
		});
	});
};
