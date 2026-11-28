// @ts-check

const { createHmac, hkdfSync } = require("node:crypto");
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

const ADDRESS = "aa:bb:cc:11:22:33";
const FIXTURE_TOKEN = "00112233445566778899aabbccddeeff";
const DEVICE_NONCE = Buffer.alloc(16, 0x42);
const CONTROL = 12;
const AUTH_DATA = 14;
const STATUS = 22;

function characteristic(uuid, handle, properties) {
	return { uuid, handle, properties, descriptors: [] };
}

class KettleGateway extends FakeGattGateway {
	nonceSent = false;
	proofRequested = false;
	clientNonce = null;
	clientProofPrefix = null;

	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "fe95",
							handle: 10,
							characteristics: [
								characteristic("0010", CONTROL, 0x14),
								characteristic("0019", AUTH_DATA, 0x14),
							],
						},
						{
							uuid: "01344736-0000-1000-8000-262837236156",
							handle: 20,
							characteristics: [
								characteristic("aa02", STATUS, 0x10),
							],
						},
					],
				},
			};
		}
		return super.handle(command, message);
	}

	notify(message, handle, payload) {
		expect(
			this.subscriptions.has(
				`${message.gatewayId}|${message.address}|${handle}`,
			),
		).to.equal(true);
		this.client.push(`system.adapter.${NAMESPACE}`, {
			command: "gateway:notification",
			message: {
				gatewayId: message.gatewayId,
				address: message.address,
				handle,
				data: payload.toString("base64"),
			},
			from: this.client.from,
		});
	}

	auth(message, hex) {
		this.notify(message, AUTH_DATA, Buffer.from(hex, "hex"));
	}

	applyWrite(_key, message, data) {
		const raw = Buffer.from(data, "base64");
		const hex = raw.toString("hex");
		expect(message.withResponse).to.equal(false);
		if (message.handle === CONTROL) {
			expect(["a4", "24000000"]).to.include(hex);
			return;
		}
		expect(message.handle).to.equal(AUTH_DATA);

		if (hex === "0000000b0100") {
			this.auth(message, "00000101");
			return;
		}
		if (!this.clientNonce) {
			expect(raw).to.have.length(18);
			expect(hex.slice(0, 4)).to.equal("0100");
			this.clientNonce = raw.subarray(2);
			this.auth(message, "00000100");
			this.auth(message, "0000000d0100");
			return;
		}

		const salt = Buffer.concat([this.clientNonce, DEVICE_NONCE]);
		const key = Buffer.from(
			hkdfSync(
				"sha256",
				Buffer.from(FIXTURE_TOKEN, "hex"),
				salt,
				"mible-login-info",
				64,
			),
		);
		if (hex === "00000101") {
			if (!this.nonceSent) {
				this.nonceSent = true;
				this.auth(message, `0100${DEVICE_NONCE.toString("hex")}`);
			} else {
				const proof = createHmac("sha256", key.subarray(0, 16))
					.update(Buffer.concat([DEVICE_NONCE, this.clientNonce]))
					.digest("hex");
				this.auth(message, `0100${proof.slice(0, 36)}`);
				this.auth(message, `0200${proof.slice(36)}`);
			}
			return;
		}
		if (hex === "00000100") {
			if (!this.deviceProofSent) {
				this.deviceProofSent = true;
				this.auth(message, "0000000c0200");
			}
			return;
		}
		if (hex === "0000000a0200") {
			this.proofRequested = true;
			this.auth(message, "00000101");
			return;
		}
		if (hex.startsWith("0100")) {
			expect(raw).to.have.length(20);
			this.clientProofPrefix = raw.subarray(2);
			return;
		}

		expect(hex.slice(0, 4)).to.equal("0200");
		expect(
			Buffer.concat([this.clientProofPrefix, raw.subarray(2)]).toString(
				"hex",
			),
		).to.equal(
			createHmac("sha256", key.subarray(16, 32))
				.update(salt)
				.digest("hex"),
		);
		this.auth(message, "00000100");
		this.notify(message, CONTROL, Buffer.from("21000000", "hex"));
		this.notify(
			message,
			STATUS,
			Buffer.from("0300000003400100000001", "hex"),
		);
	}
}

exports.runTests = function (suite) {
	suite("Xiaomi Mi Smart Kettle Pro v12", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "xiaomi" });
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "kettle", connect: true }],
			});
			await deliver(harness, "kettle", [
				{
					address: ADDRESS,
					data: buildAdvertisement([
						0x16,
						"95fe3058e00901332211ccbbaa280100",
					]),
				},
			]);
		});

		after(() => stopAdapter(harness));

		const read = (token) =>
			sendToAdapter(harness, "readXiaomiKettlePro", {
				address: ADDRESS,
				token,
			});

		it("authenticates the kettle before returning water temperature and status", async function () {
			this.timeout(20000);
			const gateway = new KettleGateway(harness);
			expect((await read("1234")).error.code).to.equal("INVALID_PAYLOAD");
			expect(gateway.commands).to.have.length(0);
			expect(await read(FIXTURE_TOKEN)).to.deep.equal({
				error: null,
				result: { temperature: 64, status: "keeping_warm" },
			});
			expect(gateway.open.size).to.equal(0);
		});

		it("stops authentication if the device proof cannot be verified", async function () {
			this.timeout(20000);
			const gateway = new KettleGateway(harness);
			expect((await read("ff".repeat(16))).error).to.deep.equal({
				code: "GATT_ERROR",
				message: "Xiaomi Kettle Pro authentication failed",
			});
			expect(gateway.proofRequested).to.equal(false);
			expect(gateway.open.size).to.equal(0);
		});
	});
};
