import { expect } from "chai";
import {
	crc16Modbus,
	crc32Telink,
	encodeDataPacket,
	encodeEndPacket,
	otaStatusText,
	toBlocks,
	validateImage,
} from "./ota-protocol";
import { buildTestImage } from "./test-image";

const hex = (value: string): Buffer =>
	Buffer.from(value.replace(/ /g, ""), "hex");

describe("drivers/pvvx/ota-protocol", () => {
	it("crc16Modbus() of the check string", () => {
		expect(crc16Modbus(Buffer.from("123456789", "ascii"))).to.equal(0x4b37);
	});

	it("crc32Telink() of the check string", () => {
		expect(crc32Telink(Buffer.from("123456789", "ascii"))).to.equal(
			0x340bc6d9,
		);
	});

	describe("packets of bin/ATC_v59.bin, docs/pvvx-protocol.md 7.4", () => {
		const first32 = hex(
			"2680013099995d024b4e4c545b078800868041110a0200002451010000000000",
		);

		it("data packets 0 and 1", () => {
			expect(
				encodeDataPacket(0, first32.subarray(0, 16)).toString("hex"),
			).to.equal("00002680013099995d024b4e4c545b078800bdb5");
			expect(
				encodeDataPacket(1, first32.subarray(16, 32)).toString("hex"),
			).to.equal("0100868041110a02000024510100000000006e75");
		});

		it("the last data packet with checksum and padding", () => {
			expect(
				encodeDataPacket(
					5394,
					hex("58a04c6f ffffffff ffffffff ffffffff"),
				).toString("hex"),
			).to.equal("121558a04c6fffffffffffffffffffffffffdc2d");
		});

		it("the end packet", () => {
			expect(encodeEndPacket(5394).toString("hex")).to.equal(
				"02ff1215edea",
			);
		});
	});

	it("an image of 20 bytes, 7.5", () => {
		const blocks = toBlocks(Buffer.alloc(20, 0x01), 20);
		expect(blocks).to.have.lengthOf(2);
		expect(blocks[1].toString("hex")).to.equal(
			"01010101ffffffffffffffffffffffff",
		);
		expect(encodeEndPacket(1).toString("hex")).to.equal("02ff0100feff");
	});

	describe("buildTestImage()", () => {
		it("1028 bytes", () => {
			const image = buildTestImage(1028);
			expect(validateImage(image)).to.deep.equal({ length: 1028 });
			expect(image.readUInt32LE(1024)).to.equal(0x596b95f7);
			const blocks = toBlocks(image, 1028);
			expect(blocks).to.have.lengthOf(65);
			expect(encodeDataPacket(0, blocks[0]).toString("hex")).to.equal(
				"0000030a11181f262d344b4e4c54575e656c93b5",
			);
			expect(encodeDataPacket(64, blocks[64]).toString("hex")).to.equal(
				"4000f7956b59ffffffffffffffffffffffffd59a",
			);
			expect(encodeEndPacket(64).toString("hex")).to.equal(
				"02ff4000bfff",
			);
		});

		it("4100 bytes", () => {
			const image = buildTestImage(4100);
			expect(image.readUInt32LE(4096)).to.equal(0xd5fb91b1);
			const blocks = toBlocks(image, 4100);
			expect(blocks).to.have.lengthOf(257);
			expect(encodeDataPacket(256, blocks[256]).toString("hex")).to.equal(
				"0001b191fbd5ffffffffffffffffffffffff5912",
			);
			expect(encodeEndPacket(256).toString("hex")).to.equal(
				"02ff0001fffe",
			);
		});

		it("rejects sizes that cannot be valid", () => {
			expect(() => buildTestImage(1020)).to.throw();
			expect(() => buildTestImage(1029)).to.throw();
		});
	});

	describe("validateImage()", () => {
		/**
		 * A copy of a valid image with changes
		 *
		 * @param change Modifies the copy in place
		 */
		function changed(change: (image: Buffer) => void): Buffer {
			const image = Buffer.from(buildTestImage(1028));
			change(image);
			return image;
		}

		it("TOO_SMALL", () => {
			expect(validateImage(Buffer.alloc(1023))).to.deep.equal({
				problem: "TOO_SMALL",
			});
		});

		it("TOO_LARGE", () => {
			expect(validateImage(Buffer.alloc(0x20001))).to.deep.equal({
				problem: "TOO_LARGE",
			});
		});

		it("ZIGBEE", () => {
			expect(
				validateImage(changed((i) => hex("1ef1ee0b").copy(i, 0))),
			).to.deep.equal({ problem: "ZIGBEE" });
		});

		it("NO_SIGNATURE", () => {
			expect(
				validateImage(changed((i) => i.write("XNLT", 8, "ascii"))),
			).to.deep.equal({ problem: "NO_SIGNATURE" });
		});

		it("BAD_LENGTH", () => {
			// Longer than the file
			expect(
				validateImage(changed((i) => i.writeUInt32LE(1044, 0x18))),
			).to.deep.equal({ problem: "BAD_LENGTH" });
			// Not 4 modulo 16
			expect(
				validateImage(changed((i) => i.writeUInt32LE(1027, 0x18))),
			).to.deep.equal({ problem: "BAD_LENGTH" });
			// Too short
			expect(
				validateImage(changed((i) => i.writeUInt32LE(20, 0x18))),
			).to.deep.equal({ problem: "BAD_LENGTH" });
		});

		it("BAD_CHECKSUM", () => {
			expect(
				validateImage(changed((i) => (i[500] ^= 0xff))),
			).to.deep.equal({ problem: "BAD_CHECKSUM" });
		});

		it("accepts a file that is longer than the image", () => {
			const image = Buffer.concat([
				buildTestImage(1028),
				Buffer.alloc(16),
			]);
			expect(validateImage(image)).to.deep.equal({ length: 1028 });
			expect(toBlocks(image, 1028)).to.have.lengthOf(65);
		});
	});

	it("otaStatusText()", () => {
		expect(otaStatusText(1)).to.equal("packets lost");
		expect(otaStatusText(2)).to.equal("packet CRC error");
		expect(otaStatusText(6)).to.equal("image check failed");
		expect(otaStatusText(9)).to.equal("unknown status 9");
	});
});
