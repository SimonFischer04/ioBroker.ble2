import type { PeripheralInfo } from "../lib/advertisement";
import { matchesScanFilter } from "../lib/scan-filter";

/**
 * Brings a configured service name into the form used in advertisements
 *
 * @param name The service name from the configuration
 */
export function fixServiceName(name: string | null | undefined): string {
	if (name == null) {
		return "";
	}
	name = name.trim();
	// No whitespace
	for (const char of ["\r", "\n", "\t", " "]) {
		name = name.replace(char, "");
	}
	// No leading 0x
	name = name.replace(/^0x/, "");
	// lowerCase
	return name.toLowerCase();
}

/**
 * Apply the same scan filters to advertisements from other gateways.
 *
 * @param peripheral The advertising device
 * @param services The allowed service UUIDs, an empty list allows all
 * @param manufacturerIds The allowed manufacturer IDs
 */
export function matchesServiceFilter(
	peripheral: PeripheralInfo,
	services: readonly string[],
	manufacturerIds: readonly number[] = [],
): boolean {
	return matchesScanFilter(peripheral, services, manufacturerIds);
}
