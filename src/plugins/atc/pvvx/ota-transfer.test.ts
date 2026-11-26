import { expect } from "chai";
import { GatewayError } from "../../../lib/gateway-error";
import {
	createFakeSession,
	FakePvvxDevice,
	OTA_HANDLE,
} from "./fake-pvvx-device";
import { OTA_WRITE_WITH_RESPONSE } from "./ota-protocol";
import { transferImage } from "./ota-transfer";
import { buildTestImage } from "./test-image";
import { PvvxUpdateError } from "./update-error";

describe("plugins/atc/pvvx/ota-transfer => transferImage()", () => {
	let device: FakePvvxDevice;
	let progress: number[];
	let sleeps: number[];
	/** Every call on the link in order: "write <hex>", "sequence <count> <readAfter>", "sleep <ms>" */
	let calls: string[];

	beforeEach(() => {
		device = new FakePvvxDevice();
		progress = [];
		sleeps = [];
		calls = [];
		const write = device.write.bind(device);
		device.write = (handle, data, withResponse) => {
			if (handle === OTA_HANDLE && data.length !== 20) {
				calls.push(`write ${data.toString("hex")}`);
			}
			return write(handle, data, withResponse);
		};
		const writeSequence = device.writeSequence.bind(device);
		device.writeSequence = (handle, data, withResponse, readAfter) => {
			calls.push(`sequence ${data.length} ${readAfter}`);
			return writeSequence(handle, data, withResponse, readAfter);
		};
	});

	function transfer(image: Buffer): Promise<void> {
		return transferImage(
			createFakeSession(device),
			image,
			image.readUInt32LE(0x18),
			{
				onProgress: (f) => progress.push(f),
				sleep: (ms) => {
					sleeps.push(ms);
					calls.push(`sleep ${ms}`);
					return Promise.resolve();
				},
			},
		);
	}

	async function updateError(
		promise: Promise<unknown>,
	): Promise<PvvxUpdateError> {
		try {
			await promise;
		} catch (e) {
			expect(e).to.be.instanceOf(PvvxUpdateError);
			return e as PvvxUpdateError;
		}
		throw new Error("the promise did not reject");
	}

	it("transfers the whole image in order", async () => {
		const image = buildTestImage(4100);

		await transfer(image);

		expect(calls.slice(0, 3)).to.deep.equal([
			"write 00ff",
			"write 01ff",
			"sleep 300",
		]);
		const sequences = calls.filter((c) => c.startsWith("sequence"));
		expect(sequences).to.have.lengthOf(33);
		expect(sequences.slice(0, 32)).to.deep.equal(
			new Array(32).fill("sequence 8 true"),
		);
		expect(sequences[32]).to.equal("sequence 1 false");
		expect(calls[calls.length - 1]).to.equal("write 02ff0001fffe");

		expect(device.ota.started).to.equal(true);
		expect(device.ota.dataPackets).to.equal(257);
		expect(
			Buffer.concat(device.ota.received).subarray(0, 4100).equals(image),
		).to.equal(true);
		expect(device.ota.finished).to.equal(true);
	});

	it("writes the packets as configured and the end packet without response", async () => {
		await transfer(buildTestImage(4100));
		const writes = device.ota.writes;
		expect(
			writes
				.slice(0, -1)
				.every((w) => w.withResponse === OTA_WRITE_WITH_RESPONSE),
		).to.equal(true);
		expect(writes[writes.length - 1].withResponse).to.equal(false);
	});

	it("reports a rising progress that ends at 1", async () => {
		await transfer(buildTestImage(4100));
		expect(progress.length).to.be.greaterThan(30);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i]).to.be.at.least(progress[i - 1]);
		}
		expect(progress[progress.length - 1]).to.equal(1);
	});

	it("stops when the device reports an error", async () => {
		device.ota.failStatusAfterPackets = { after: 20, status: 2 };

		const error = await updateError(transfer(buildTestImage(4100)));

		expect(error.code).to.equal("OTA_STATUS_2");
		expect(error.message).to.equal("packet CRC error");
		// The status is read after packet 24, nothing is written after that
		expect(device.ota.dataPackets).to.equal(24);
		expect(device.ota.finished).to.equal(false);
	});

	it("stops when the connection is lost", async () => {
		device.ota.dropAfterPackets = 40;

		let error: unknown;
		try {
			await transfer(buildTestImage(4100));
		} catch (e) {
			error = e;
		}

		expect((error as GatewayError).code).to.equal("NOT_CONNECTED");
		expect(calls.filter((c) => c.startsWith("write 02ff"))).to.deep.equal(
			[],
		);
	});

	it("succeeds when the end packet fails because the device restarts", async () => {
		const write = device.write.bind(device);
		device.write = (handle, data, withResponse) =>
			data[0] === 0x02 && data.length === 6
				? Promise.reject(
						new GatewayError("NOT_CONNECTED", "restarting"),
					)
				: write(handle, data, withResponse);

		await transfer(buildTestImage(4100));

		expect(progress[progress.length - 1]).to.equal(1);
	});

	it("an image with a last group of one packet", async () => {
		await transfer(buildTestImage(1028));
		const sequences = calls.filter((c) => c.startsWith("sequence"));
		expect(sequences).to.have.lengthOf(9);
		expect(sequences[8]).to.equal("sequence 1 false");
		expect(device.ota.finished).to.equal(true);
	});
});
