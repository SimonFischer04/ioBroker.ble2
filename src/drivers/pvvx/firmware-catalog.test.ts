import { expect } from "chai";
import {
	createHttpFirmwareSource,
	FirmwareCatalog,
	type FirmwareIndex,
	type FirmwareSource,
	INDEX_MAX_AGE_MS,
	parseFirmwareIndex,
	selectImage,
} from "./firmware-catalog";
import { buildTestImage } from "./test-image";
import { PvvxUpdateError } from "./update-error";

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

async function rejects(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (e) {
		return e as Error;
	}
	throw new Error("the promise did not reject");
}

/** An excerpt of the real firmware.json */
const REAL_INDEX = {
	version: 89,
	custom: [
		"bin/ATC_v59.bin",
		"bin/MHO_C401_v59.bin",
		"bin/CGG1_v59.bin",
		"bin/ATC_v59.bin",
		"bin/ATC_v59.bin",
		"bin/ATC_v59.bin",
		"bin/CGDK2_v59.bin",
		"bin/CGG1M_v59.bin",
		"bin/MHO_C401N_v59.bin",
		"bin/BTH_v59.bin",
		"bin/ATC_v59.bin",
		"bin/MHO_C122_v59.bin",
		"bin/BTE_v59.bin",
		"bin/MJ6_v59.bin",
		"bin/ATC_v59.bin",
		"?",
	],
	original: ["x.bin"],
};

describe("drivers/pvvx/firmware-catalog", () => {
	describe("parseFirmwareIndex()", () => {
		it("reads version and custom of the real file", () => {
			const index = parseFirmwareIndex(REAL_INDEX);
			expect(index?.version).to.equal(89);
			expect(index?.custom[0]).to.equal("bin/ATC_v59.bin");
			expect(index?.custom[15]).to.equal("?");
			expect(index).to.not.have.property("original");
		});

		it("rejects broken files", () => {
			for (const json of [
				undefined,
				"x",
				{ custom: [] },
				{ version: 0, custom: [] },
				{ version: 256, custom: [] },
				{ version: 5.9, custom: [] },
				{ version: 89 },
				{ version: 89, custom: [1] },
			]) {
				expect(parseFirmwareIndex(json), JSON.stringify(json)).to.equal(
					undefined,
				);
			}
		});
	});

	describe("selectImage()", () => {
		const index = parseFirmwareIndex(REAL_INDEX)!;

		it("selects the image of the hardware ID", () => {
			expect(selectImage(index, 0, 0x48)).to.deep.equal({
				path: "bin/ATC_v59.bin",
				version: 89,
			});
		});

		it("UNKNOWN_HARDWARE", () => {
			expect(selectImage(index, undefined, 0x48)).to.deep.equal({
				problem: "UNKNOWN_HARDWARE",
			});
			expect(selectImage(index, 16, 0x48)).to.deep.equal({
				problem: "UNKNOWN_HARDWARE",
			});
			expect(selectImage(index, -1, 0x48)).to.deep.equal({
				problem: "UNKNOWN_HARDWARE",
			});
		});

		it("NO_IMAGE", () => {
			expect(selectImage(index, 15, 0x48)).to.deep.equal({
				problem: "NO_IMAGE",
			});
		});

		it("UP_TO_DATE", () => {
			expect(selectImage(index, 0, 0x59)).to.deep.equal({
				problem: "UP_TO_DATE",
			});
			expect(selectImage(index, 0, 0x60)).to.deep.equal({
				problem: "UP_TO_DATE",
			});
		});
	});

	describe("FirmwareCatalog", () => {
		let now: number;
		let source: FirmwareSource & { indexLoads: number; imageLoads: number };
		let image: Buffer;
		let catalog: FirmwareCatalog;
		const index: FirmwareIndex = {
			version: 0x60,
			custom: ["bin/test.bin"],
		};

		beforeEach(() => {
			now = 1_800_000_000_000;
			image = buildTestImage(1028);
			source = {
				indexLoads: 0,
				imageLoads: 0,
				getIndex() {
					this.indexLoads++;
					return Promise.resolve(index);
				},
				getImage() {
					this.imageLoads++;
					return Promise.resolve(image);
				},
			};
			catalog = new FirmwareCatalog(source, {
				now: () => now,
				timezoneOffset: () => 0,
			});
		});

		it("keeps firmware.json for 6 hours", async () => {
			expect(await catalog.getIndex()).to.deep.equal(index);
			now += INDEX_MAX_AGE_MS - 1;
			await catalog.getIndex();
			expect(source.indexLoads).to.equal(1);
			now += 1;
			await catalog.getIndex();
			expect(source.indexLoads).to.equal(2);
		});

		it("loads firmware.json again when asked to", async () => {
			await catalog.getIndex();
			await catalog.getIndex(true);
			expect(source.indexLoads).to.equal(2);
		});

		it("DOWNLOAD_FAILED for a file that cannot be loaded or read", async () => {
			source.getIndex = () => Promise.reject(new Error("offline"));
			const error = await updateError(catalog.getIndex());
			expect(error.code).to.equal("DOWNLOAD_FAILED");
			expect(error.message).to.include("offline");

			source.getIndex = () => Promise.resolve({ version: "x" });
			expect((await updateError(catalog.getIndex())).code).to.equal(
				"DOWNLOAD_FAILED",
			);
		});

		it("loads an image once", async () => {
			expect(await catalog.getImage("bin/test.bin")).to.deep.equal({
				image,
				length: 1028,
			});
			await catalog.getImage("bin/test.bin");
			expect(source.imageLoads).to.equal(1);
		});

		it("INVALID_IMAGE for an image with a wrong checksum, not kept", async () => {
			image = Buffer.from(image);
			image[500] ^= 0xff;
			const error = await updateError(catalog.getImage("bin/test.bin"));
			expect(error.code).to.equal("INVALID_IMAGE");
			expect(error.message).to.equal("bin/test.bin: BAD_CHECKSUM");
			await updateError(catalog.getImage("bin/test.bin"));
			expect(source.imageLoads).to.equal(2);
		});
	});

	describe("createHttpFirmwareSource()", () => {
		const CHUNK = 16 * 1024;

		/** A fetch that answers every URL with the body, streamed in chunks of 16 KiB */
		function fakeFetch(
			status: number,
			body: Buffer,
			headers: Record<string, string> = {},
		): typeof fetch & {
			urls: string[];
			chunksRead: number;
			cancelled: boolean;
		} {
			const state = {
				urls: [] as string[],
				chunksRead: 0,
				cancelled: false,
			};
			const impl = (url: unknown): Promise<Response> => {
				state.urls.push(String(url));
				let offset = 0;
				const stream = new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							if (offset >= body.length) {
								controller.close();
								return;
							}
							state.chunksRead++;
							controller.enqueue(
								new Uint8Array(
									body.subarray(offset, offset + CHUNK),
								),
							);
							offset += CHUNK;
						},
						cancel() {
							state.cancelled = true;
						},
					},
					// No chunk is read ahead, so the test can count them
					{ highWaterMark: 0 },
				);
				return Promise.resolve({
					status,
					headers: new Headers(headers),
					body: stream,
				} as unknown as Response);
			};
			// Getters, so the test sees the current values
			return Object.defineProperties(impl, {
				urls: { get: () => state.urls },
				chunksRead: { get: () => state.chunksRead },
				cancelled: { get: () => state.cancelled },
			}) as typeof fetch & typeof state;
		}

		it("stops reading as soon as a download without Content-Length gets too large", async () => {
			const impl = fakeFetch(200, Buffer.alloc(4 * 1024 * 1024));
			const source = createHttpFirmwareSource("http://host/", impl);

			const error = await rejects(source.getImage("bin/a.bin"));

			expect(error.message).to.include("larger than");
			expect(impl.cancelled).to.equal(true);
			// 256 KiB are 16 chunks, the 17th is one too many: the rest is never read
			expect(impl.chunksRead).to.equal(17);
		});

		it("builds the URLs with and without a slash at the end", async () => {
			const json = Buffer.from(
				JSON.stringify({ version: 1, custom: [] }),
			);
			const withSlash = fakeFetch(200, json);
			await createHttpFirmwareSource(
				"http://host/x/",
				withSlash,
			).getIndex();
			const withoutSlash = fakeFetch(200, json);
			await createHttpFirmwareSource(
				"http://host/x",
				withoutSlash,
			).getIndex();
			expect(withSlash.urls).to.deep.equal([
				"http://host/x/firmware.json",
			]);
			expect(withoutSlash.urls).to.deep.equal([
				"http://host/x/firmware.json",
			]);
		});

		it("returns an image", async () => {
			const data = buildTestImage(1028);
			const source = createHttpFirmwareSource(
				"http://host/",
				fakeFetch(200, data),
			);
			expect((await source.getImage("bin/a.bin")).equals(data)).to.equal(
				true,
			);
		});

		it("fails on another status than 200", async () => {
			const source = createHttpFirmwareSource(
				"http://host/",
				fakeFetch(404, Buffer.alloc(0)),
			);
			expect(
				(await rejects(source.getImage("bin/a.bin"))).message,
			).to.include("404");
		});

		it("refuses files over 256 KiB", async () => {
			const big = Buffer.alloc(256 * 1024 + 1);
			const byLength = createHttpFirmwareSource(
				"http://host/",
				fakeFetch(200, Buffer.alloc(1), {
					"content-length": String(big.length),
				}),
			);
			await rejects(byLength.getImage("bin/a.bin"));
			const byBody = createHttpFirmwareSource(
				"http://host/",
				fakeFetch(200, big),
			);
			await rejects(byBody.getImage("bin/a.bin"));
		});

		it("refuses paths outside the base URL without loading them", async () => {
			const impl = fakeFetch(200, Buffer.alloc(0));
			const source = createHttpFirmwareSource("http://host/", impl);
			await rejects(source.getImage("../x.bin"));
			await rejects(source.getImage("bin/../../x.bin"));
			await rejects(source.getImage("/x.bin"));
			expect(impl.urls).to.deep.equal([]);
		});
	});
});
