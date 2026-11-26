import { normalizeAddress } from "./advertisement";

/**
 * Parses a setting with a list of devices, e.g. of a plugin. Invalid entries are returned separately,
 * duplicates are removed.
 *
 * @param setting Value of the setting, MAC addresses separated by spaces, commas or semicolons
 */
export function parseDeviceList(setting: unknown): {
	addresses: string[];
	invalid: string[];
} {
	const addresses: string[] = [];
	const invalid: string[] = [];
	if (typeof setting !== "string") {
		return { addresses, invalid };
	}
	for (const entry of setting.split(/[\s,;]+/)) {
		if (!entry) {
			continue;
		}
		const address = normalizeAddress(entry);
		if (!address) {
			invalid.push(entry);
		} else if (!addresses.includes(address)) {
			addresses.push(address);
		}
	}
	return { addresses, invalid };
}
