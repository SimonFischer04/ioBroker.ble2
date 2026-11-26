import { expect } from "chai";
import { XiaomiAdvertisement } from "./xiaomi_protocol";

type OperationModes =
	"mi-flora-normal" | "mi-flora-uninitialized" | "temp-sensor-normal";
function assertFlags(
	operationMode: OperationModes,
	parsed: XiaomiAdvertisement,
) {
	if (operationMode === "mi-flora-normal") {
		parsed.isNewFactory.should.be.true;
		parsed.isConnected.should.be.false;
		parsed.isCentral.should.be.false;
		parsed.isEncrypted.should.be.false;
		parsed.hasMacAddress.should.be.true;
		parsed.hasCapabilities.should.be.true;
		parsed.hasEvent.should.be.true;
		parsed.hasCustomData.should.be.false;
		parsed.hasSubtitle.should.be.false;
		parsed.isBindingFrame.should.be.false;
	} else if (operationMode === "mi-flora-uninitialized") {
		parsed.isNewFactory.should.be.true;
		parsed.isConnected.should.be.false;
		parsed.isCentral.should.be.false;
		parsed.isEncrypted.should.be.false;
		parsed.hasMacAddress.should.be.true;
		parsed.hasCapabilities.should.be.true;
		parsed.hasEvent.should.be.false;
		parsed.hasCustomData.should.be.false;
		parsed.hasSubtitle.should.be.false;
		parsed.isBindingFrame.should.be.true;
	} else if (operationMode === "temp-sensor-normal") {
		parsed.isNewFactory.should.be.false;
		parsed.isConnected.should.be.false;
		parsed.isCentral.should.be.false;
		parsed.isEncrypted.should.be.false;
		parsed.hasMacAddress.should.be.true;
		parsed.hasCapabilities.should.be.false;
		parsed.hasEvent.should.be.true;
		parsed.hasCustomData.should.be.false;
		parsed.hasSubtitle.should.be.false;
		parsed.isBindingFrame.should.be.false;
	}
}

function assertVersion(actual: number, expected: number | undefined) {
	expect(actual).to.equal(expected, "the version was wrong");
}
function assertProductID(actual: number, expected: number | undefined) {
	expect(actual).to.equal(expected, "the product id was wrong");
}
function assertFrameCounter(actual: number, expected: number | undefined) {
	expect(actual).to.equal(expected, "the frame counter was wrong");
}
function assertMacAddress(actual: string, expected: string | undefined) {
	expect(actual).to.equal(expected, "the mac address was wrong");
}
function assertCapabilities(actual: number, expected: number | undefined) {
	expect(actual).to.equal(expected, "the capabilities were wrong");
}

describe("xiaomi protocol => ", () => {
	describe("authenticated MiBeacon advertisements", () => {
		const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
		const mac = "112233445566";
		const readKey = (address: string): Buffer | undefined =>
			address === mac ? key : undefined;
		// Fixtures generated with Python cryptography's AESCCM and a synthetic key.
		const frames = [
			"58506f06016655443322114ddf680bb3cc4f2e444a51325175010203f1251ef9",
			"48406f06014ddf680bb3cc4f2e444a51325175010203f1251ef9",
			"78506f060166554433221120aa4ddf680bb3cc4f2e444a51325175010203f1251ef9",
		];

		it("reads multiple events in v4 and v5 frames", () => {
			for (const frame of frames) {
				const advertisement = new XiaomiAdvertisement(
					Buffer.from(frame, "hex"),
					"11:22:33:44:55:66",
					readKey,
				);
				expect(advertisement.isEncrypted).to.be.true;
				expect(advertisement.event).to.deep.equal({
					temperature: 22.8,
					humidity: 44,
					battery: 77,
				});
			}
		});

		it("requires the right device address, key, and authentication tag", () => {
			const frame = Buffer.from(frames[0], "hex");
			expect(() => new XiaomiAdvertisement(frame)).to.throw("bindkey");
			expect(
				() =>
					new XiaomiAdvertisement(
						frame,
						"11:22:33:44:55:00",
						readKey,
					),
			).to.throw("MAC address");
			expect(
				() =>
					new XiaomiAdvertisement(frame, mac, () => Buffer.alloc(16)),
			).to.throw();
			frame[frame.length - 1] ^= 1;
			expect(
				() => new XiaomiAdvertisement(frame, mac, readKey),
			).to.throw();
		});
	});

	describe("packets should be parsed correctly => ", () => {
		it("incomplete packet", () => {
			function create(hex: string) {
				return new XiaomiAdvertisement(Buffer.from(hex, "hex"));
			}
			expect(() => create("00")).to.throw("5 bytes");
			expect(() => create("0011")).to.throw("5 bytes");
			expect(() => create("001122")).to.throw("5 bytes");
			expect(() => create("00112233")).to.throw("5 bytes");
			expect(() => create("")).to.throw("5 bytes");
		});

		it("Mi-Flora: Temperature", () => {
			const frame = Buffer.from(
				"71209800da795d658d7cc40d0410021201",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0xda);
			assertMacAddress(parsed.macAddress!, "c47c8d655d79");
			assertCapabilities(parsed.capabilities!, 0x0d);
			parsed.event!.should.deep.equal({
				temperature: 0x112 / 10,
			});
		});

		it("Mi-Flora: negative temperature", () => {
			const frame = Buffer.from(
				"71209800da795d658d7cc40d041002e7ff",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0xda);
			assertMacAddress(parsed.macAddress!, "c47c8d655d79");
			assertCapabilities(parsed.capabilities!, 0x0d);
			parsed.event!.should.deep.equal({
				temperature: -2.5,
			});
		});

		it("Mi-Flora: Fertility", () => {
			const frame = Buffer.from(
				"71209800d9795d658d7cc40d0910022e00",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0xd9);
			assertMacAddress(parsed.macAddress!, "c47c8d655d79");
			assertCapabilities(parsed.capabilities!, 0x0d);
			parsed.event!.should.deep.equal({
				fertility: 0x2e,
			});
		});

		it("Mi-Flora: Moisture", () => {
			const frame = Buffer.from(
				"71209800d8795d658d7cc40d0810010d",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0xd8);
			assertMacAddress(parsed.macAddress!, "c47c8d655d79");
			assertCapabilities(parsed.capabilities!, 0x0d);
			parsed.event!.should.deep.equal({
				moisture: 0x0d,
			});
		});

		it("Mi-Flora: ignores invalid moisture percentages", () => {
			for (const moisture of [101, 160, 255]) {
				const frame = Buffer.from(
					"71209800d8795d658d7cc40d08100100",
					"hex",
				);
				frame[frame.length - 1] = moisture;
				expect(new XiaomiAdvertisement(frame).event).to.deep.equal({});
			}
		});

		it("Mi-Flora: keeps valid moisture percentages including the boundaries", () => {
			for (const moisture of [0, 13, 100]) {
				const frame = Buffer.from(
					"71209800d8795d658d7cc40d08100100",
					"hex",
				);
				frame[frame.length - 1] = moisture;
				expect(new XiaomiAdvertisement(frame).event).to.deep.equal({
					moisture,
				});
			}
		});

		it("Mi-Flora: Illuminance", () => {
			const frame = Buffer.from(
				"71209800ef795d658d7cc40d071003fe4c00",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0xef);
			assertMacAddress(parsed.macAddress!, "c47c8d655d79");
			assertCapabilities(parsed.capabilities!, 0x0d);
			parsed.event!.should.deep.equal({
				illuminance: 0x4cfe,
			});
		});

		it("Mi-Flora: un-initialized", () => {
			const frame = Buffer.from("3102980006dab4618d7cc40d", "hex");
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("mi-flora-uninitialized", parsed);
			assertVersion(parsed.version, 0);
			assertProductID(parsed.productID, 0x0098);
			assertFrameCounter(parsed.frameCounter, 0x06);
			assertMacAddress(parsed.macAddress!, "c47c8d61b4da");
			assertCapabilities(parsed.capabilities!, 0x0d);
			expect(parsed.event).to.be.undefined;
		});

		it("Temperature sensor: temperature and humidity", () => {
			const frame = Buffer.from(
				"5020aa01cae802d2a8654c0d1004b5ff3602",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("temp-sensor-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x01aa);
			assertFrameCounter(parsed.frameCounter, 0xca);
			assertMacAddress(parsed.macAddress!, "4c65a8d202e8");
			assertCapabilities(parsed.capabilities!, undefined);
			parsed.event!.should.deep.equal({
				temperature: -7.5,
				humidity: 56.6,
			});
		});

		it("Temperature sensor: temperature (negative) and humidity", () => {
			const frame = Buffer.from(
				"5020aa01cae802d2a8654c0d1004c3003602",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("temp-sensor-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x01aa);
			assertFrameCounter(parsed.frameCounter, 0xca);
			assertMacAddress(parsed.macAddress!, "4c65a8d202e8");
			assertCapabilities(parsed.capabilities!, undefined);
			parsed.event!.should.deep.equal({
				temperature: 19.5,
				humidity: 56.6,
			});
		});

		it("Temperature sensor: battery", () => {
			const frame = Buffer.from("5020aa01c8e802d2a8654c0a100164", "hex");
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("temp-sensor-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x01aa);
			assertFrameCounter(parsed.frameCounter, 0xc8);
			assertMacAddress(parsed.macAddress!, "4c65a8d202e8");
			assertCapabilities(parsed.capabilities!, undefined);
			parsed.event!.should.deep.equal({
				battery: 100,
			});
		});

		it("Temperature sensor: humidity", () => {
			const frame = Buffer.from(
				"5020aa01c7e802d2a8654c0610023602",
				"hex",
			);
			const parsed = new XiaomiAdvertisement(frame);

			assertFlags("temp-sensor-normal", parsed);
			assertVersion(parsed.version, 2);
			assertProductID(parsed.productID, 0x01aa);
			assertFrameCounter(parsed.frameCounter, 0xc7);
			assertMacAddress(parsed.macAddress!, "4c65a8d202e8");
			assertCapabilities(parsed.capabilities!, undefined);
			parsed.event!.should.deep.equal({
				humidity: 56.6,
			});
		});
	});
});
