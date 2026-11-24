import type { AdminConnection } from "@iobroker/socket-client";
import { useEffect, useState } from "react";

/** A device registered in ioBroker and the most recent scanner reading. */
export interface BluetoothDevice {
	/** The existing ioBroker device object. */
	object: ioBroker.DeviceObject;
	/** Signal strength in dBm, if available. */
	rssi: number | null;
	/** Timestamp of the RSSI state, including repeated readings. */
	lastSeen: number | null;
}

type DeviceMapData =
	| { status: "loading" | "error" }
	| { status: "ready"; devices: BluetoothDevice[]; scannerActive: boolean };

/**
 * Merge an acknowledged scanner state, including deletions and late snapshots.
 *
 * @param states State cache to update.
 * @param id ID of the state.
 * @param state The state value or a deletion.
 * @returns Whether the update should be applied to the current snapshot.
 */
function updateState(
	states: Map<string, ioBroker.State>,
	id: string,
	state: ioBroker.State | null | undefined,
): boolean {
	if (state == null) {
		states.delete(id);
	} else if (state.ack && state.ts >= (states.get(id)?.ts ?? 0)) {
		states.set(id, state);
	} else {
		return false;
	}
	return true;
}

/**
 * Read the instance's known devices and keep their measurements up to date.
 *
 * @param connection The Admin connection supplied by JSONConfig.
 * @param namespace The configured adapter instance.
 */
export function useBluetoothDevices(
	connection: AdminConnection,
	namespace: string,
): {
	data: DeviceMapData;
	retry: () => void;
} {
	const [data, setData] = useState<DeviceMapData>({ status: "loading" });
	const [reload, setReload] = useState(0);

	useEffect(() => {
		const prefix = `${namespace}.`;
		const objectPattern = `${prefix}*`;
		const rssiPattern = `${prefix}*.rssi`;
		const scannerStateIds = [
			`system.adapter.${namespace}.alive`,
			`${prefix}info.connection`,
		];
		const statePatterns = [rssiPattern, ...scannerStateIds];
		let objects = new Map<string, ioBroker.DeviceObject>();
		let states = new Map<string, ioBroker.State>();
		let ready = false;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let changes:
			| {
					objects: Map<string, ioBroker.DeviceObject | null>;
					states: Map<string, ioBroker.State | null>;
			  }
			| undefined;

		const publish = (): void => {
			if (!ready || disposed) {
				return;
			}
			const devices = Array.from(objects.values(), (object) => {
				const state = states.get(`${object._id}.rssi`);
				const value = state?.val;
				return {
					object,
					// 127 is the Bluetooth HCI sentinel for unavailable RSSI.
					rssi:
						typeof value === "number" &&
						Number.isFinite(value) &&
						value !== 127
							? value
							: null,
					lastSeen: state?.ts ?? null,
				};
			});
			setData({
				status: "ready",
				devices,
				scannerActive: scannerStateIds.every(
					(id) => states.get(id)?.val === true,
				),
			});
		};

		const schedulePublish = (): void => {
			// RSSI can update for every advertisement when throttling is disabled.
			if (ready && timer === undefined) {
				timer = setTimeout(() => {
					timer = undefined;
					publish();
				}, 250);
			}
		};

		const onObject = (
			id: string,
			object: ioBroker.Object | null | undefined,
		): void => {
			if (object?.type === "device") {
				objects.set(id, object);
				changes?.objects.set(id, object);
				schedulePublish();
			} else if (!id.includes(".", prefix.length) || objects.has(id)) {
				changes?.objects.set(id, null);
				if (objects.delete(id)) {
					schedulePublish();
				}
			}
		};

		const onState = (
			id: string,
			state: ioBroker.State | null | undefined,
		): void => {
			if (!disposed && updateState(states, id, state)) {
				changes?.states.set(id, state ?? null);
				schedulePublish();
			}
		};

		const load = async (): Promise<void> => {
			const pending = {
				objects: new Map<string, ioBroker.DeviceObject | null>(),
				states: new Map<string, ioBroker.State | null>(),
			};
			changes = pending;
			try {
				const [deviceObjects, rssiStates, ...scannerStates] =
					await Promise.all([
						connection.getObjectViewSystem(
							"device",
							prefix,
							`${prefix}\u9999`,
						),
						connection.getForeignStates(rssiPattern),
						...scannerStateIds.map((id) =>
							connection.getState(id).catch(() => null),
						),
					]);
				if (disposed || changes !== pending) {
					return;
				}
				objects = new Map(Object.entries(deviceObjects));
				states = new Map();
				for (const [id, state] of Object.entries<ioBroker.State>(
					rssiStates,
				)) {
					updateState(states, id, state);
				}
				scannerStateIds.forEach((id, index) =>
					updateState(states, id, scannerStates[index]),
				);
				for (const [id, object] of pending.objects) {
					if (object === null) {
						objects.delete(id);
					} else {
						objects.set(id, object);
					}
				}
				for (const [id, state] of pending.states) {
					updateState(states, id, state);
				}
				ready = true;
				publish();
			} catch {
				if (!disposed && changes === pending) {
					ready = false;
					setData({ status: "error" });
				}
			} finally {
				if (changes === pending) {
					changes = undefined;
				}
			}
		};

		const onConnection = (connected: boolean): void => {
			if (connected) {
				void load();
			} else {
				changes = undefined;
				ready = false;
				setData({ status: "error" });
			}
		};

		void connection.subscribeObject(objectPattern, onObject);
		for (const pattern of statePatterns) {
			void connection.subscribeState(pattern, onState);
		}
		connection.registerConnectionHandler(onConnection);
		void load();
		return () => {
			disposed = true;
			clearTimeout(timer);
			connection.unregisterConnectionHandler(onConnection);
			for (const pattern of statePatterns) {
				connection.unsubscribeState(pattern, onState);
			}
			void connection.unsubscribeObject(objectPattern, onObject);
		};
	}, [connection, namespace, reload]);

	return {
		data,
		retry: () => {
			setData({ status: "loading" });
			setReload((value) => value + 1);
		},
	};
}
