const visibilityWindow = 10 * 60_000;
const sightingGap = 10_000;
const minimumSightings = 3;
const maximumDevices = 256;
const bluetoothAddress =
	/^(?:[\da-f]{12}|(?:[\da-f]{2}:){5}[\da-f]{2}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i;

interface DeviceSightings {
	name: string;
	lastSeen: number;
	samples: number[];
}

/** Suggests unrecorded Bluetooth devices seen several times in a moving window. */
export class DiscoverySuggestions {
	private readonly devices = new Map<string, DeviceSightings>();

	public observe(
		address: string,
		name: string | undefined,
		now: number,
	): void {
		if (!bluetoothAddress.test(address)) {
			return;
		}

		const device = this.devices.get(address) ?? {
			name: "",
			lastSeen: now,
			samples: [],
		};
		device.name = name?.trim().slice(0, 80) || device.name;
		device.lastSeen = now;
		device.samples = device.samples.filter(
			(stamp) => now - stamp < visibilityWindow,
		);
		const latest = device.samples.at(-1);
		if (latest == null || now - latest >= sightingGap) {
			device.samples.push(now);
		}
		this.devices.delete(address);
		this.devices.set(address, device);
		if (this.devices.size > maximumDevices) {
			const oldest = this.devices.keys().next();
			if (!oldest.done) {
				this.devices.delete(oldest.value);
			}
		}
	}

	public remove(address: string): void {
		this.devices.delete(address);
	}

	public list(
		now: number,
	): { address: string; name: string; sightings: number }[] {
		const results: { address: string; name: string; sightings: number }[] =
			[];
		for (const [address, device] of this.devices) {
			if (now - device.lastSeen >= visibilityWindow) {
				this.devices.delete(address);
				continue;
			}
			const sightings = device.samples.filter(
				(stamp) => now - stamp < visibilityWindow,
			).length;
			if (sightings >= minimumSightings) {
				results.push({ address, name: device.name, sightings });
			}
		}
		return results.sort(
			(a, b) =>
				b.sightings - a.sightings || a.address.localeCompare(b.address),
		);
	}
}
