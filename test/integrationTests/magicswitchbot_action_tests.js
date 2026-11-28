// @ts-check

const { createCipheriv, createDecipheriv } = require("node:crypto");
const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	NAMESPACE,
	buildAdvertisement,
	deliver,
	sendToAdapter,
	startAdapter,
	stopAdapter,
} = require("./helpers");

const address = "aa:bb:cc:11:22:33";
const suffix = "-0000-1000-8000-00805f9b34fb";
const key = Buffer.from("2a61395c405549513a5a4b621b6d3735", "hex");

const fixtureBlock = (hex, decrypt = false) => {
	const cipher = decrypt
		? createDecipheriv("aes-128-ecb", key, null)
		: createCipheriv("aes-128-ecb", key, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([
		cipher.update(Buffer.from(hex.padEnd(32, "0"), "hex")),
		cipher.final(),
	]).toString("hex");
};

class BotGateway extends FakeGattGateway {
	applyWrite(key, message, data) {
		const reply = this.writeHandler?.(
			message.address,
			message.handle,
			Buffer.from(data, "base64").toString("hex"),
		);
		if (!reply || !this.subscriptions.has(`${key}|32`)) {
			return;
		}
		for (const block of reply) {
			this.client.push(`system.adapter.${NAMESPACE}`, {
				command: "gateway:notification",
				message: {
					gatewayId: message.gatewayId,
					address: message.address,
					handle: 32,
					data: Buffer.from(block, "hex").toString("base64"),
				},
				from: this.client.from,
			});
		}
	}

	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: `0000fee7${suffix}`,
							handle: 28,
							characteristics: [
								{
									uuid: `000036f5${suffix}`,
									handle: 30,
									properties: 0x08,
									descriptors: [],
								},
								{
									uuid: `000036f6${suffix}`,
									handle: 32,
									properties: 0x10,
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
	suite("MagicSwitchBot control", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "magicswitchbot" });
		});
		after(() => stopAdapter(harness));

		it("authenticates using the supplied PIN and requires confirmation of the action", async function () {
			this.timeout(20000);
			const gateway = new BotGateway(harness);
			const requests = [];
			gateway.setWriteHandler((_, handle, data) => {
				expect(handle).to.equal(30);
				const plain = fixtureBlock(data, true);
				requests.push(plain);
				const response = plain.startsWith("060106313233343536")
					? "060209deadbeef0101020701"
					: plain.startsWith("05010102deadbeef")
						? "05020100"
						: "06030101";
				return [fixtureBlock(response)];
			});
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "magicswitchbot", connect: true }],
			});
			await deliver(harness, "magicswitchbot", [
				{
					address,
					data: buildAdvertisement([0x03, "e7fe"]),
				},
			]);
			const push = (pin) =>
				sendToAdapter(harness, "runMagicSwitchBotAction", {
					address,
					action: "push",
					pin,
				});
			expect((await push("bad")).error.code).to.equal("INVALID_PAYLOAD");
			expect(requests).to.have.length(0);
			expect((await push("123455")).error.code).to.equal("GATT_ERROR");
			expect(requests).to.have.length(1);
			expect(await push("123456")).to.deep.equal({
				error: null,
				result: { action: "push" },
			});
			expect(requests).to.have.length(3);
			expect(requests[2].slice(0, 16)).to.equal("05010102deadbeef");
		});
	});
};
