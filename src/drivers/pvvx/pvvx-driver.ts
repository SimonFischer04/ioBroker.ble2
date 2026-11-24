import { normalizeAddress } from "../../lib/advertisement";

/** Parses the setting pvvxDevices. Invalid entries are returned separately, duplicates are removed. */
export function parseDeviceList(setting: unknown): {
	addresses: string[];
	invalid: string[];
} {
	const addresses: string[] = [];
	const invalid: string[] = [];
	if (typeof setting !== "string") return { addresses, invalid };
	for (const entry of setting.split(/[\s,;]+/)) {
		if (!entry) continue;
		const address = normalizeAddress(entry);
		if (!address) invalid.push(entry);
		else if (!addresses.includes(address)) addresses.push(address);
	}
	return { addresses, invalid };
}
