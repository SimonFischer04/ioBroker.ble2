// A valid firmware image for the unit and integration tests. Not used by the adapter itself.

import { crc32Telink } from "./ota-protocol";

/**
 * A valid image for the tests. size >= 1024 and (size & 0x0f) === 4.
 *
 * @param size Length of the image in bytes
 */
export function buildTestImage(size: number): Buffer {
	if (!Number.isInteger(size) || size < 1024 || (size & 0x0f) !== 4) {
		throw new Error(`${size} is not a valid image size`);
	}
	const image = Buffer.alloc(size);
	for (let i = 0; i < size; i++) {
		image[i] = (i * 7 + 3) & 0xff;
	}
	image.write("KNLT", 8, "ascii");
	image.writeUInt32LE(size, 0x18);
	image.writeUInt32LE(crc32Telink(image.subarray(0, size - 4)), size - 4);
	return image;
}
