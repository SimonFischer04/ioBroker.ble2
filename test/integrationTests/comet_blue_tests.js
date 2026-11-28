// @ts-check

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	deliver,
	PACKETS,
	sendToAdapter,
	startAdapter,
	stopAdapter,
} = require("./helpers");
const address = "aa:bb:cc:11:22:33";
const uuid = (part) => `47e9ee${part}-47e9-11e4-8939-164230d1df67`;

class CometGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: uuid("00"),
							handle: 48,
							characteristics: [
								{
									uuid: uuid("30"),
									handle: 50,
									properties: 8,
									descriptors: [],
								},
								{
									uuid: uuid("2b"),
									handle: 52,
									properties: 10,
									descriptors: [],
								},
								{
									uuid: uuid("2c"),
									handle: 54,
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
	suite("Comet Blue status", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "comet-blue" });
		});
		after(() => stopAdapter(harness));

		it("authenticates with the configured PIN and reads the thermostat status", async function () {
			this.timeout(20000);
			const gateway = new CometGateway(harness);
			gateway.values.set(52, "29261a2c000000");
			gateway.values.set(54, "4a");
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "comet", connect: true }],
			});
			await deliver(harness, "comet", [
				{ address, data: PACKETS.bthomeThermometer },
			]);
			expect(
				(
					await sendToAdapter(harness, "readCometBlue", {
						address,
						pin: "bad",
					})
				).error.code,
			).to.equal("INVALID_PAYLOAD");
			expect(gateway.commands).to.have.length(0);

			const response = await sendToAdapter(harness, "readCometBlue", {
				address,
				pin: "1234",
			});
			expect(response).to.deep.equal({
				error: null,
				result: {
					temperature: 20.5,
					manualSetpoint: 19,
					ecoSetpoint: 13,
					comfortSetpoint: 22,
					battery: 74,
				},
			});
			const data = gateway.commands.find(
				({ command }) => command === "gatt:write",
			).message.data;
			expect(Buffer.from(data, "base64").toString("hex")).to.equal(
				"d2040000",
			);
		});

		it("writes only requested setpoints and preserves the calibration offset", async function () {
			this.timeout(20000);
			const gateway = new CometGateway(harness);
			gateway.values.set(52, "29261a2cfd0000");
			const base = { address, pin: "1234" };
			const command = "setCometBlueSetpoints";
			for (const invalid of [
				{},
				{ ecoSetpoint: 7.5 },
				{ comfortSetpoint: 22.2 },
			]) {
				const response = await sendToAdapter(harness, command, {
					...base,
					...invalid,
				});
				expect(response.error.code).to.equal("INVALID_PAYLOAD");
			}
			expect(gateway.commands).to.have.length(0);

			const response = await sendToAdapter(harness, command, {
				...base,
				manualSetpoint: 21.5,
				comfortSetpoint: 23,
			});
			expect(response).to.deep.equal({ error: null, result: {} });

			const writes = gateway.commands
				.filter(({ command }) => command === "gatt:write")
				.map(({ message }) => [
					message.handle,
					Buffer.from(message.data, "base64").toString("hex"),
				]);
			expect(writes).to.deep.equal([
				[50, "d2040000"],
				[52, "802b802efd8080"],
			]);
		});

		it("leaves the thermostat untouched if its calibration offset is unavailable", async function () {
			this.timeout(20000);
			const gateway = new CometGateway(harness);
			gateway.values.set(52, "29261a2c800000");
			const response = await sendToAdapter(
				harness,
				"setCometBlueSetpoints",
				{
					address,
					pin: "1234",
					ecoSetpoint: 18,
				},
			);
			expect(response.error.code).to.equal("GATT_ERROR");
			const writes = gateway.commands.filter(
				({ command }) => command === "gatt:write",
			);
			expect(writes.map(({ message }) => message.handle)).to.deep.equal([
				50,
			]);
		});
	});
};
