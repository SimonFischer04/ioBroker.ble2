import { expect } from "chai";
import { MAX_ADVERTISEMENTS_PER_MESSAGE } from "../lib/gateway-protocol";
import {
	parseAnnounceMessage,
	parseGatewayMessage,
	type ParsedGatewayMessage,
} from "./remote-gateway";

// BTHome v2: battery 100 %, 25 °C, 50.55 %
const BTHOME = "AgEGDhbS/EAApQFkAsQJA78T";

function parse(payload: unknown): ParsedGatewayMessage {
	const result = parseGatewayMessage("esphome.0", payload);
	if ("error" in result) {
		throw new Error(`unexpected error: ${result.error!.message}`);
	}
	return result;
}

function expectInvalid(payload: unknown, message: RegExp): void {
	const result = parseGatewayMessage("esphome.0", payload) as any;
	expect(result.error?.code).to.equal("INVALID_PAYLOAD");
	expect(result.error.message).to.match(message);
}

describe("transports/remote-gateway => parseGatewayMessage()", () => {
	it("converts the advertisements into what the plugins work with", () => {
		const result = parse({
			gatewayId: "proxy-og",
			items: [
				{
					address: "A4:C1:38:12:34:56",
					addressType: "public",
					rssi: -67,
					data: BTHOME,
					connectable: true,
				},
			],
		});

		expect(result.gatewayId).to.equal("esphome.0:proxy-og");
		expect(result.rejected).to.equal(0);
		expect(result.peripherals).to.deep.equal([
			{
				id: "a4c138123456",
				uuid: "a4c138123456",
				// The form the device IDs have always had
				address: "a4:c1:38:12:34:56",
				addressType: "public",
				connectable: true,
				rssi: -67,
				gatewayId: "esphome.0:proxy-og",
				advertisement: {
					serviceUuids: [],
					serviceData: [
						{
							uuid: "fcd2",
							data: Buffer.from("4000a5016402c40903bf13", "hex"),
						},
					],
				},
			},
		]);
	});

	it("only needs address, rssi and data", () => {
		const [peripheral] = parse({
			gatewayId: "p1",
			items: [{ address: "a4:c1:38:12:34:56", rssi: -67, data: BTHOME }],
		}).peripherals;
		expect(peripheral.addressType).to.equal("unknown");
		expect(peripheral.connectable).to.be.undefined;
	});

	it("accepts an empty batch", () => {
		expect(parse({ gatewayId: "p1", items: [] }).peripherals).to.be.empty;
	});

	it("skips invalid items without discarding the batch", () => {
		const valid = { address: "a4:c1:38:12:34:56", rssi: -67, data: BTHOME };
		const result = parse({
			gatewayId: "p1",
			items: [
				valid,
				{ ...valid, address: "not a mac" },
				{ ...valid, rssi: "-67" },
				{ ...valid, rssi: NaN },
				{ ...valid, data: "not base64!" },
				{ ...valid, data: undefined },
				{ ...valid, data: "A".repeat(4000) },
				null,
				"a4:c1:38:12:34:56",
			],
		});
		expect(result.peripherals).to.have.length(1);
		expect(result.rejected).to.equal(8);
	});

	it("rejects messages that are not understood at all", () => {
		expectInvalid(undefined, /object/);
		expectInvalid("advertisement", /object/);
		expectInvalid({ items: [] }, /gatewayId/);
		expectInvalid({ gatewayId: "", items: [] }, /gatewayId/);
		expectInvalid({ gatewayId: "proxy og", items: [] }, /gatewayId/);
		expectInvalid({ gatewayId: "a".repeat(65), items: [] }, /gatewayId/);
		expectInvalid({ gatewayId: "p1" }, /items/);
		expectInvalid({ gatewayId: "p1", items: {} }, /items/);
		expectInvalid(
			{
				gatewayId: "p1",
				items: new Array(MAX_ADVERTISEMENTS_PER_MESSAGE + 1).fill({}),
			},
			/more than/,
		);
	});
});

describe("transports/remote-gateway => parseAnnounceMessage()", () => {
	const valid = {
		protocol: "ble-gateway/1",
		gateways: [
			{
				gatewayId: "proxy-og",
				connect: true,
				freeSlots: 3,
				slotLimit: 3,
			},
			{ gatewayId: "proxy-eg", connect: false },
		],
	};

	function expectError(
		payload: unknown,
		code: string,
		message: RegExp,
	): void {
		const result = parseAnnounceMessage("esphome.0", payload) as any;
		expect(result.error?.code, JSON.stringify(payload)).to.equal(code);
		expect(result.error.message).to.match(message);
	}

	it("returns the gateways with their full IDs", () => {
		expect(parseAnnounceMessage("esphome.0", valid)).to.deep.equal({
			gateways: [
				{
					id: "esphome.0:proxy-og",
					connect: true,
					freeSlots: 3,
					slotLimit: 3,
					features: [],
				},
				{
					id: "esphome.0:proxy-eg",
					connect: false,
					freeSlots: undefined,
					slotLimit: undefined,
					features: [],
				},
			],
		});
	});

	it("takes the known features, without duplicates", () => {
		const result = parseAnnounceMessage("esphome.0", {
			protocol: "ble-gateway/1",
			gateways: [
				{
					gatewayId: "proxy-og",
					connect: true,
					features: ["writeSequence", "other", "writeSequence"],
				},
			],
		}) as any;
		expect(result.gateways[0].features).to.deep.equal(["writeSequence"]);
	});

	it("a gateway that cannot connect has no features", () => {
		const result = parseAnnounceMessage("esphome.0", {
			protocol: "ble-gateway/1",
			gateways: [
				{
					gatewayId: "proxy-og",
					connect: false,
					features: ["writeSequence"],
				},
			],
		}) as any;
		expect(result.gateways[0].features).to.deep.equal([]);
	});

	it("rejects features that are not a list of strings", () => {
		for (const features of ["writeSequence", [1], {}]) {
			expectError(
				{
					protocol: "ble-gateway/1",
					gateways: [
						{ gatewayId: "proxy-og", connect: true, features },
					],
				},
				"INVALID_PAYLOAD",
				/features/,
			);
		}
	});

	it("accepts an empty list", () => {
		expect(
			parseAnnounceMessage("esphome.0", { ...valid, gateways: [] }),
		).to.deep.equal({ gateways: [] });
	});

	it("rejects another protocol", () => {
		expectError(
			{ ...valid, protocol: "ble-gateway/2" },
			"UNSUPPORTED_PROTOCOL",
			/ble-gateway\/1/,
		);
		expectError({ gateways: [] }, "UNSUPPORTED_PROTOCOL", /ble-gateway\/1/);
	});

	it("rejects messages that are not understood", () => {
		expectError(undefined, "INVALID_PAYLOAD", /object/);
		expectError(
			{ protocol: "ble-gateway/1" },
			"INVALID_PAYLOAD",
			/gateways/,
		);
		expectError(
			{ protocol: "ble-gateway/1", gateways: {} },
			"INVALID_PAYLOAD",
			/gateways/,
		);
		expectError(
			{
				protocol: "ble-gateway/1",
				gateways: new Array(101).fill({
					gatewayId: "p",
					connect: true,
				}),
			},
			"INVALID_PAYLOAD",
			/more than 100/,
		);
	});

	it("rejects the whole message for one invalid gateway", () => {
		const withGateway = (gateway: unknown): unknown => ({
			protocol: "ble-gateway/1",
			gateways: [valid.gateways[0], gateway],
		});
		expectError(withGateway(null), "INVALID_PAYLOAD", /object/);
		expectError(
			withGateway({ connect: true }),
			"INVALID_PAYLOAD",
			/gatewayId/,
		);
		expectError(
			withGateway({ gatewayId: "proxy og", connect: true }),
			"INVALID_PAYLOAD",
			/gatewayId/,
		);
		expectError(
			withGateway({ gatewayId: "p", connect: "yes" }),
			"INVALID_PAYLOAD",
			/connect/,
		);
		expectError(
			withGateway({ gatewayId: "p", connect: true, freeSlots: -1 }),
			"INVALID_PAYLOAD",
			/freeSlots/,
		);
		expectError(
			withGateway({ gatewayId: "p", connect: true, slotLimit: 1.5 }),
			"INVALID_PAYLOAD",
			/slotLimit/,
		);
	});
});
