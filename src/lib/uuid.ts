/** Suffix of 16 and 32 bit UUIDs: they are short forms of xxxxxxxx-0000-1000-8000-00805f9b34fb */
const BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/**
 * The canonical form of a UUID: 128 bit, lowercase, with dashes, e.g.
 * "00001f10-0000-1000-8000-00805f9b34fb". undefined if the input is not a UUID.
 *
 * Accepts 16 bit ("1f10", "0x1F10"), 32 bit ("0000fcd2") and 128 bit UUIDs with or without dashes.
 */
export function normalizeUuid(uuid: unknown): string | undefined {
	if (typeof uuid !== "string") return undefined;
	const text = uuid.trim().toLowerCase().replace(/^0x/, "");

	if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}${BASE_UUID_SUFFIX}`;
	if (/^[0-9a-f]{8}$/.test(text)) return `${text}${BASE_UUID_SUFFIX}`;
	if (/^[0-9a-f]{32}$/.test(text)) {
		return [
			text.slice(0, 8),
			text.slice(8, 12),
			text.slice(12, 16),
			text.slice(16, 20),
			text.slice(20),
		].join("-");
	}
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			text,
		)
	) {
		return text;
	}
	return undefined;
}
