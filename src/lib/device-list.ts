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

/**
 * Reads a setting with a list of devices and reports the invalid entries
 *
 * @param adapter Where the invalid entries are reported
 * @param setting Value of the setting
 * @param label What the devices are, e.g. "Mi Flora sensor"
 * @returns The valid addresses
 */
export function readDeviceList(
	adapter: Pick<ioBroker.Adapter, "log">,
	setting: unknown,
	label: string,
): string[] {
	const { addresses, invalid } = parseDeviceList(setting);
	for (const entry of invalid) {
		adapter.log.warn(`Ignoring the invalid ${label} address "${entry}"`);
	}
	return addresses;
}
