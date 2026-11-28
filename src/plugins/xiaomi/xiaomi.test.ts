import type XiaomiModule = require(".");
import { expect } from "chai";
import * as proxyquireModule from "proxyquire";
import { createGlobalMock } from "../../../test/mocks/global";
import type { PeripheralInfo } from "../../lib/scanProcessInterface";

const xiaomiPlugin = proxyquireModule.noPreserveCache()<typeof XiaomiModule>(
	"./index",
	{ "../../lib/global": createGlobalMock({}) },
);

describe("xiaomi plugin => ", () => {
	describe("correctly detects which peripherals should be handled => ", () => {
		it("yes: Valid advertisement data", () => {
			const peripheral = {
				advertisement: {
					serviceData: [
						{
							uuid: "fe95",
							data: Buffer.from(
								"70205b04d4281061c8593f090610023002",
								"hex",
							),
						},
					],
				},
				address: "the:address:no:longer:matters",
			};
			expect(xiaomiPlugin.isHandling(peripheral as any)).to.be.true;
		});

		it("yes: The service data is not tested again after a successful check", () => {
			const peripheral = {
				advertisement: {
					serviceData: [{ uuid: "fe95", data: Buffer.from([]) }],
				},
				address: "the:address:no:longer:matters",
			};
			expect(xiaomiPlugin.isHandling(peripheral as any)).to.be.true;
		});

		it("no: Valid advertisement data, but wrong UUID", () => {
			const peripheral = {
				advertisement: {
					serviceData: [
						{
							uuid: "fe96",
							data: Buffer.from(
								"70205b04d4281061c8593f090610023002",
								"hex",
							),
						},
					],
				},
				address: "the:address:no:longer:matters",
			};
			expect(xiaomiPlugin.isHandling(peripheral as any)).to.be.false;
		});

		it("no: invalid advertisement data", () => {
			const peripheral = {
				advertisement: {
					serviceData: [
						{
							uuid: "fe96",
							data: Buffer.from(
								"71205b04d4281061c8593f090610023002",
								"hex",
							),
						},
					],
				},
				address: "the:address:no:longer:matters",
			};
			expect(xiaomiPlugin.isHandling(peripheral as any)).to.be.false;
		});

		it("no: no service data", () => {
			const peripheral = {
				advertisement: {},
				address: "the:address:no:longer:matters",
			};
			expect(xiaomiPlugin.isHandling(peripheral as any)).to.be.false;
		});

		it("handles a pvvx event after a status-only frame from the same device", () => {
			const service = {
				uuid: "fe95",
				data: Buffer.from("10306f0601d36e14342d58", "hex"),
			};
			const peripheral = {
				advertisement: { serviceData: [service] },
				address: "58:2d:34:14:6e:d3",
			} as PeripheralInfo;
			expect(xiaomiPlugin.isHandling(peripheral)).to.be.false;
			// Captured in issue #48. This packet carries a battery event.
			service.data = Buffer.from(
				"50306f0602d36e14342d580a10016401a801",
				"hex",
			);
			expect(xiaomiPlugin.isHandling(peripheral)).to.be.true;
			expect(
				xiaomiPlugin.getValues(xiaomiPlugin.createContext(peripheral)),
			).to.deep.equal({ battery: 100 });
		});
	});

	describe("mosquito repellent measurements", () => {
		const cases = [
			{
				frame: "50200a040166554433221112100100",
				id: "powerState",
				value: 0,
				metadata: { states: { 0: "Off", 1: "On" } },
			},
			{
				frame: "50200a040266554433221112100101",
				id: "powerState",
				value: 1,
				metadata: { states: { 0: "Off", 1: "On" } },
			},
			{
				frame: "50200a04036655443322111310014b",
				id: "consumableRemaining",
				value: 75,
				metadata: { unit: "%" },
			},
		];
		for (const { frame, id, value, metadata } of cases) {
			it(`publishes ${id} = ${value} from a MiBeacon advertisement`, () => {
				const peripheral = {
					address: "11:22:33:44:55:66",
					advertisement: {
						serviceData: [
							{ uuid: "fe95", data: Buffer.from(frame, "hex") },
						],
					},
				} as PeripheralInfo;

				expect(xiaomiPlugin.isHandling(peripheral)).to.be.true;
				const context = xiaomiPlugin.createContext(peripheral);
				expect(xiaomiPlugin.getValues(context)).to.deep.equal({
					[id]: value,
				});
				const states = xiaomiPlugin.defineObjects(context)!.states;
				expect(states.map((state) => state.id)).to.deep.equal([id]);
				expect(states[0].common).to.deep.include({
					type: "number",
					read: true,
					write: false,
					...metadata,
				});
			});
		}
	});
});

describe("Xiaomi Door and Window Sensor 2", () => {
	const address = "e4:aa:ec:81:21:ae";
	const mock = createGlobalMock({});
	mock.Global.adapter.config = {
		xiaomiBindkeys: JSON.stringify([
			{ address, key: "017e52d2684779298709b117c0a75a7b" },
		]),
	} as ioBroker.AdapterConfig;
	const plugin = proxyquireModule.noPreserveCache()<typeof XiaomiModule>(
		"./index",
		{ "../../lib/global": mock },
	);

	function advertisement(hex: string): PeripheralInfo {
		return {
			address,
			advertisement: {
				serviceData: [{ uuid: "fe95", data: Buffer.from(hex, "hex") }],
			},
		} as PeripheralInfo;
	}

	it("authenticates a captured MiBeacon v5 packet and publishes boolean contact states", () => {
		const packet = advertisement(
			"58588b09a3ae2181ecaae40e2c553c040000d28a500c",
		);
		expect(plugin.isHandling(packet)).to.be.true;
		const context = plugin.createContext(packet);

		expect(plugin.getValues(context)).to.deep.equal({
			contactOpen: true,
			doorLeftOpen: true,
		});
		expect(
			plugin
				.defineObjects(context)
				?.states.map(({ id, common }) => [
					id,
					common?.type,
					common?.role,
				]),
		).to.deep.equal([
			["contactOpen", "boolean", "sensor.door"],
			["doorLeftOpen", "boolean", "indicator.alarm"],
		]);
	});

	it("updates the open state on close and leaves unsupported status codes alone", () => {
		const closed = advertisement("50508b09a4ae2181ecaae419100101");
		expect(plugin.getValues(plugin.createContext(closed))).to.deep.equal({
			contactOpen: false,
			doorLeftOpen: false,
		});
		const reset = advertisement("50508b09a5ae2181ecaae419100103");
		expect(plugin.getValues(plugin.createContext(reset))).to.deep.equal({});
		const malformed = advertisement("50508b09a6ae2181ecaae4191000");
		expect(plugin.getValues(plugin.createContext(malformed))).to.deep.equal(
			{},
		);
	});
});
