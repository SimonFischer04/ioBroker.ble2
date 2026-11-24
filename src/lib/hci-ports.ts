interface HciPort {
	index: number;
	bus: string;
}

/**
 * Reads the interface index and bus from each adapter header.
 *
 * @param stdout Output of hciconfig.
 */
export function parseHciPorts(stdout: string): HciPort[] {
	return Array.from(
		stdout.matchAll(/^hci(\d+):[^\r\n]*\bBus:[ \t]+(\S+)/gm),
		([, index, bus]) => ({ index: Number(index), bus }),
	);
}

/**
 * Reads an HCI index from either a dropdown selection or manual input.
 *
 * @param value Saved HCI device setting.
 */
export function parseHciIndex(value: number | string): number | undefined {
	const index =
		typeof value === "string" && /^\d+$/.test(value.trim())
			? Number(value)
			: value;
	if (
		typeof index === "number" &&
		Number.isSafeInteger(index) &&
		index >= 0
	) {
		return index;
	}
}

/**
 * Builds the instance settings dropdown, keeping a saved device selectable.
 *
 * @param ports Detected local interfaces.
 * @param configuredDevice Saved HCI device setting.
 */
export function getHciOptions(
	ports: HciPort[],
	configuredDevice: number | string,
): { value: number | string; label: string }[] {
	// An empty list makes Admin display its manual input.
	if (!ports.length) {
		return [];
	}

	const configuredIndex = parseHciIndex(configuredDevice);
	const options = ports.map(({ index, bus }) => ({
		// Admin's manual input can save a string and matches options by value and type.
		value: index === configuredIndex ? configuredDevice : index,
		label: `hci${index} (${bus})`,
	}));
	if (
		configuredIndex != undefined &&
		!ports.some(({ index }) => index === configuredIndex)
	) {
		options.push({
			value: configuredDevice,
			label: `hci${configuredIndex}`,
		});
	}
	return options.sort((a, b) => Number(a.value) - Number(b.value));
}
