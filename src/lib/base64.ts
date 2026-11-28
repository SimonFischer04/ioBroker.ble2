/** Canonical base64: groups of four characters, padded */
const BASE64_REGEX =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes base64 strictly. Buffer.from() alone would turn invalid input into a wrong value
 * without complaint.
 *
 * @param value The encoded value
 * @returns The bytes, undefined if the value is not a base64 string
 */
export function decodeBase64(value: unknown): Buffer | undefined {
	if (typeof value !== "string" || !BASE64_REGEX.test(value)) {
		return undefined;
	}
	return Buffer.from(value, "base64");
}
