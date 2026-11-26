import type { AdminConnection } from "@iobroker/socket-client";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	BluetoothMapGraph,
	SCANNER_NODE_ID,
	type BluetoothMapGraphHandle,
	type GraphDevice,
	type MapPalette,
	type SignalQuality,
} from "./BluetoothMapGraph";
import {
	useBluetoothDevices,
	type BluetoothDevice,
} from "./useBluetoothDevices";
import de from "../i18n/de/translations.json";
import en from "../i18n/en/translations.json";
import es from "../i18n/es/translations.json";
import fr from "../i18n/fr/translations.json";
import it from "../i18n/it/translations.json";
import nl from "../i18n/nl/translations.json";
import pl from "../i18n/pl/translations.json";
import pt from "../i18n/pt/translations.json";
import ru from "../i18n/ru/translations.json";
import uk from "../i18n/uk/translations.json";
import zhCn from "../i18n/zh-cn/translations.json";
import "./bluetooth-map.css";

// Only use the JSONConfig props available in both the Admin 7 and 8 hosts.
interface BluetoothMapProps {
	oContext: {
		adapterName: string;
		instance: number;
		socket: AdminConnection;
		systemConfig: Pick<ioBroker.SystemConfigCommon, "language">;
		theme: { palette: MapPalette };
		themeType: "light" | "dark";
		imagePrefix?: string;
	};
	originalData: Pick<ioBroker.AdapterConfig, "server" | "hciDevice">;
}

const translations: Record<ioBroker.Languages, Record<string, string>> = {
	de,
	en,
	es,
	fr,
	it,
	nl,
	pl,
	pt,
	ru,
	uk,
	"zh-cn": zhCn,
};

const STRONG_RSSI = -70;
const MEDIUM_RSSI = -85;
const STALE_AFTER_MS = 15 * 60 * 1000;
const NO_DEVICES: BluetoothDevice[] = [];
const SIGNAL_COLORS = {
	light: {
		strong: "#087b65",
		medium: "#9d5304",
		weak: "#bd3951",
		unknown: "#68778e",
	},
	dark: {
		strong: "#55d4b1",
		medium: "#ffbb73",
		weak: "#ff899a",
		unknown: "#9caac2",
	},
};

/**
 * Convert an RSSI reading to the quality shown in the legend.
 *
 * @param rssi Signal strength in dBm.
 */
function getSignalQuality(rssi: number | null): SignalQuality {
	if (rssi === null) {
		return "unknown";
	}
	if (rssi >= STRONG_RSSI) {
		return "strong";
	}
	return rssi >= MEDIUM_RSSI ? "medium" : "weak";
}

/**
 * Prefer a localised ioBroker name, falling back to the Bluetooth address.
 *
 * @param name The device object's name.
 * @param language The current Admin language.
 * @param address The device's Bluetooth address.
 */
function getDeviceName(
	name: ioBroker.StringOrTranslated | undefined,
	language: ioBroker.Languages,
	address: string,
): string {
	const translated =
		typeof name === "string" ? name : name?.[language] || name?.en;
	return translated?.trim() || address;
}

/**
 * Show the scanner and live RSSI readings for devices of the current instance.
 *
 * @param props The JSONConfig host context and the saved settings.
 * @param props.oContext The context supplied by Admin.
 * @param props.originalData The saved instance settings.
 */
function BluetoothMap({
	oContext,
	originalData,
}: BluetoothMapProps): React.ReactElement {
	const { adapterName, instance, socket, theme, themeType } = oContext;
	const namespace = `${adapterName}.${instance}`;
	const language = oContext.systemConfig?.language ?? "en";
	const translate = (key: string): string =>
		translations[language]?.[key] ?? key;
	const { data, retry } = useBluetoothDevices(socket, namespace);
	const [selected, setSelected] = useState(SCANNER_NODE_ID);
	const [showRssi, setShowRssi] = useState(false);
	const [now, setNow] = useState(Date.now);
	const graph = useRef<BluetoothMapGraphHandle>(null);
	const headingId = useId();
	const selectId = useId();
	const { palette } = theme;
	const dark = themeType === "dark";
	const colors = dark ? SIGNAL_COLORS.dark : SIGNAL_COLORS.light;

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	const devices = data.status === "ready" ? data.devices : NO_DEVICES;
	const items = useMemo(() => {
		return devices
			.map(({ object, rssi, lastSeen }) => {
				const address =
					typeof object.native?.address === "string" &&
					object.native.address
						? object.native.address
						: object._id.slice(namespace.length + 1);
				return {
					id: object._id,
					address,
					name: getDeviceName(object.common.name, language, address),
					rssi,
					lastSeen,
				};
			})
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name, language) ||
					a.address.localeCompare(b.address),
			);
	}, [devices, language, namespace]);
	const graphDevices = useMemo<GraphDevice[]>(() => {
		const counts = new Map<string, number>();
		for (const { name } of items) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return items.map(({ id, address, name, rssi, lastSeen }) => {
			const characters = Array.from(name);
			const shortName =
				characters.length > 21
					? `${characters.slice(0, 20).join("")}…`
					: name;
			return {
				id,
				label:
					(counts.get(name) ?? 0) > 1
						? `${shortName} · ${address.slice(-5)}`
						: shortName,
				rssi,
				quality: getSignalQuality(rssi),
				stale: lastSeen !== null && now - lastSeen >= STALE_AFTER_MS,
			};
		});
	}, [items, now]);

	const device = items.find(({ id }) => id === selected);
	const deviceChoice = device?.id ?? SCANNER_NODE_ID;
	const scannerActive = data.status === "ready" && data.scannerActive;
	const scannerLabel = translate("BLE scanner");
	const scannerIcon = `${(oContext.imagePrefix ?? "").replace(/\/$/, "")}/adapter/${adapterName}/ble2.png`;
	const mapBackground = dark ? "#171e2a" : "#f6f8fc";
	const themeVariables = {
		"--ble-map-border": palette.divider,
		"--ble-map-muted": palette.text.secondary,
		"--ble-map-paper": palette.background.paper,
		"--ble-map-text": palette.text.primary,
		"--ble-map-grid": dark ? "#394457" : "#d4ddeb",
		"--ble-map-background": mapBackground,
		"--ble-map-accent": dark ? "#aac4ff" : "#395db5",
		colorScheme: dark ? "dark" : "light",
	} as React.CSSProperties;
	const legend = [
		{
			color: colors.strong,
			label: `${translate("Strong")} · ≥ ${STRONG_RSSI} dBm`,
		},
		{
			color: colors.medium,
			label: `${translate("Medium")} · ${MEDIUM_RSSI} … < ${STRONG_RSSI} dBm`,
		},
		{
			color: colors.weak,
			label: `${translate("Weak")} · < ${MEDIUM_RSSI} dBm`,
		},
		{ color: colors.unknown, label: translate("Unknown signal") },
		{
			color: colors.unknown,
			label: translate("Last seen 15 min ago or more"),
			dashed: true,
		},
	];

	return (
		<section
			className="ble-map"
			style={themeVariables}
			aria-labelledby={headingId}
		>
			<header className="ble-map-toolbar">
				<div className="ble-map-overview">
					<h2 id={headingId}>
						{translate("Recorded BLE devices")}
						{data.status === "ready" && (
							<>
								{" "}
								<span className="ble-map-count">
									{devices.length}
								</span>
							</>
						)}
					</h2>
					{data.status === "ready" && (
						<span className="ble-map-status">
							<span
								aria-hidden="true"
								className="ble-map-status-dot"
								style={{
									backgroundColor: scannerActive
										? colors.strong
										: colors.unknown,
								}}
							/>
							{scannerActive
								? translate("Scanner active")
								: translate("Scanner inactive")}
						</span>
					)}
				</div>
				{items.length > 0 && (
					<div className="ble-map-controls">
						<label>
							<input
								type="checkbox"
								checked={showRssi}
								onChange={(event) =>
									setShowRssi(event.target.checked)
								}
							/>
							{translate("Show RSSI labels")}
						</label>
						<div
							className="ble-map-zoom"
							role="group"
							aria-label={translate("Map controls")}
						>
							<button
								type="button"
								aria-label={translate("Zoom out")}
								title={translate("Zoom out")}
								onClick={() => graph.current?.zoom(0.8)}
							>
								−
							</button>
							<button
								type="button"
								aria-label={translate("Zoom in")}
								title={translate("Zoom in")}
								onClick={() => graph.current?.zoom(1.25)}
							>
								+
							</button>
							<button
								type="button"
								onClick={() => graph.current?.fit()}
							>
								{translate("Fit map")}
							</button>
						</div>
					</div>
				)}
			</header>
			{data.status === "loading" && (
				<p className="ble-map-message" role="status">
					{translate("Loading Bluetooth devices")}
				</p>
			)}
			{data.status === "error" && (
				<div className="ble-map-message">
					<span role="alert">
						{translate("Could not load Bluetooth devices.")}
					</span>
					<button type="button" onClick={retry}>
						{translate("Retry")}
					</button>
				</div>
			)}
			{data.status === "ready" && !items.length && (
				<p className="ble-map-message">
					{translate("No BLE devices have been recorded yet.")}
				</p>
			)}
			{items.length > 0 && (
				<>
					<div className="ble-map-layout">
						<BluetoothMapGraph
							ref={graph}
							devices={graphDevices}
							scannerLabel={scannerLabel}
							scannerIcon={scannerIcon}
							showRssi={showRssi}
							selected={deviceChoice}
							onSelect={setSelected}
							colors={colors}
							dark={dark}
							palette={palette}
							background={mapBackground}
							label={translate("Bluetooth device map")}
						/>
						<aside className="ble-map-inspector">
							<label htmlFor={selectId}>
								{translate("Device details")}
							</label>
							<select
								id={selectId}
								value={deviceChoice}
								onChange={(event) => {
									setSelected(event.target.value);
									graph.current?.focus(event.target.value);
								}}
							>
								<option value={SCANNER_NODE_ID}>
									{scannerLabel}
								</option>
								{items.map(({ id, name, address }) => (
									<option key={id} value={id}>
										{name === address
											? name
											: `${name} · ${address}`}
									</option>
								))}
							</select>
							<dl className="ble-map-details">
								{device ? (
									<>
										<dt>
											{translate("Bluetooth address")}
										</dt>
										<dd>
											<code>{device.address}</code>
										</dd>
										<dt>{translate("Signal strength")}</dt>
										<dd
											style={{
												color: colors[
													getSignalQuality(
														device.rssi,
													)
												],
											}}
										>
											{device.rssi === null
												? translate("Unknown signal")
												: `${device.rssi} dBm`}
										</dd>
										<dt>{translate("Last seen")}</dt>
										<dd>
											{device.lastSeen === null
												? "—"
												: new Date(
														device.lastSeen,
													).toLocaleString(language)}
										</dd>
									</>
								) : (
									<>
										<dt>
											{originalData.server
												? translate("Remote BLE server")
												: translate(
														"Local Bluetooth adapter",
													)}
										</dt>
										<dd>
											<code>
												{originalData.server ||
													`hci${originalData.hciDevice ?? 0}`}
											</code>
										</dd>
										<dt>{translate("Instance")}</dt>
										<dd>
											<code>{namespace}</code>
										</dd>
									</>
								)}
							</dl>
						</aside>
					</div>
					<ul className="ble-map-legend">
						{legend.map(({ color, label, dashed }) => (
							<li key={label}>
								<span
									aria-hidden="true"
									style={{
										color,
										borderTopStyle: dashed
											? "dashed"
											: "solid",
									}}
								/>
								{label}
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

export default { BluetoothMap };
