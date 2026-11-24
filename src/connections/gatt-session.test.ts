import { expect } from "chai";
import { GatewayError } from "../lib/gateway-error";
import { GattSession } from "./gatt-session";
import { FakeLink } from "./test-fakes";

const SERVICE = "00001f10-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC = "00001f1f-0000-1000-8000-00805f9b34fb";

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
	try {
		await promise;
	} catch (e) {
		expect(e).to.be.instanceOf(GatewayError);
		return e as GatewayError;
	}
	throw new Error("the promise did not reject");
}

describe("connections/gatt-session => GattSession", () => {
	let link: FakeLink;
	let session: GattSession;

	beforeEach(() => {
		link = new FakeLink("esphome.0:proxy-og", "a4:c1:38:12:34:56", 185);
		link.values.set(32, Buffer.from("2301020304", "hex"));
		session = new GattSession(link);
	});

	it("tells the device, gateway and MTU of the link", () => {
		expect(session).to.include({
			address: "a4:c1:38:12:34:56",
			gatewayId: "esphome.0:proxy-og",
			mtu: 185,
			closed: false,
		});
	});

	it("resolves short and long UUIDs to the same handle", async () => {
		expect((await session.read("1f10", "0x1F1F")).toString("hex")).to.equal(
			"2301020304",
		);
		expect(
			(
				await session.read(SERVICE.toUpperCase(), CHARACTERISTIC)
			).toString("hex"),
		).to.equal("2301020304");
		expect(link.calls.filter((c) => c.startsWith("read"))).to.deep.equal([
			"read 32",
			"read 32",
		]);
	});

	it("fetches the services only once", async () => {
		await session.read("1f10", "1f1f");
		await session.write("1f10", "1f1f", Buffer.from([1]));
		await session.getServices();
		expect(link.calls.filter((c) => c === "getServices")).to.have.length(1);
	});

	it("rejects an unknown characteristic without touching the device", async () => {
		const error = await rejection(session.read("1f10", "2a00"));
		expect(error.code).to.equal("GATT_ERROR");
		expect(error.message).to.equal(
			"Characteristic 00002a00-0000-1000-8000-00805f9b34fb of service 00001f10-0000-1000-8000-00805f9b34fb not found",
		);
		expect(link.calls).to.deep.equal(["getServices"]);
	});

	it("rejects invalid UUIDs", async () => {
		expect((await rejection(session.read("xyz", "1f1f"))).code).to.equal(
			"INVALID_PAYLOAD",
		);
		expect((await rejection(session.read("1f10", "1f1"))).code).to.equal(
			"INVALID_PAYLOAD",
		);
		expect(link.calls).to.deep.equal([]);
	});

	it("passes data and withResponse on, with response by default", async () => {
		await session.write("1f10", "1f1f", Buffer.from("0102", "hex"));
		await session.write("1f10", "1f1f", Buffer.from("03", "hex"), false);
		expect(link.calls.filter((c) => c.startsWith("write"))).to.deep.equal([
			"write 32 0102 true",
			"write 32 03 false",
		]);
	});

	it("passes notifications to the listener", async () => {
		const received: string[] = [];
		await session.subscribe("1f10", "1f1f", (data) =>
			received.push(data.toString("hex")),
		);
		link.notify(32, Buffer.from("55", "hex"));
		link.notify(32, Buffer.from("23", "hex"));
		expect(received).to.deep.equal(["55", "23"]);
	});

	it("rejects everything after close() and disconnects once", async () => {
		await session.close();
		await session.close();
		expect(session.closed).to.be.true;
		expect(link.disconnects).to.equal(1);
		for (const operation of [
			session.getServices(),
			session.read("1f10", "1f1f"),
			session.write("1f10", "1f1f", Buffer.from([1])),
			session.subscribe("1f10", "1f1f", () => {}),
		]) {
			const error = await rejection(operation);
			expect(error.code).to.equal("NOT_CONNECTED");
			expect(error.message).to.equal(
				"The connection to a4:c1:38:12:34:56 is closed",
			);
		}
	});

	it("rejects everything after the connection ended", async () => {
		link.simulateDisconnect();
		expect(session.closed).to.be.true;
		for (const operation of [
			session.read("1f10", "1f1f"),
			session.write("1f10", "1f1f", Buffer.from([1])),
			session.subscribe("1f10", "1f1f", () => {}),
		]) {
			expect((await rejection(operation)).code).to.equal("NOT_CONNECTED");
		}
		expect(link.calls).to.deep.equal([]);
	});
});
