import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { DataSet } from "vis-data";
import { Network, type Edge, type Node } from "vis-network";

export const SCANNER_NODE_ID = "scanner";

export type SignalQuality = "strong" | "medium" | "weak" | "unknown";

/** Colors provided by both supported generations of the Admin theme. */
export interface MapPalette {
	/** Border color of controls and panels. */
	divider: string;
	/** Text colors for labels and captions. */
	text: Record<"primary" | "secondary", string>;
	/** Background color of the Admin panel. */
	background: Record<"paper", string>;
	/** Theme color for interactive controls. */
	primary: Record<"main", string>;
}

/** A device node and its connection to the scanner. */
export interface GraphDevice {
	/** The full ioBroker device ID. */
	id: string;
	/** The display name shortened to fit the canvas. */
	label: string;
	/** The most recent signal strength in dBm. */
	rssi: number | null;
	/** The signal range used to color the edge. */
	quality: SignalQuality;
	/** Draw an older reading with a dashed edge. */
	stale: boolean;
}

interface GraphProps {
	devices: GraphDevice[];
	scannerLabel: string;
	showRssi: boolean;
	selected: string;
	onSelect: (id: string) => void;
	colors: Record<SignalQuality, string>;
	palette: MapPalette;
	dark: boolean;
	scannerIcon: string;
	background: string;
	label: string;
}

/** Viewport controls for the map toolbar and device selector. */
export interface BluetoothMapGraphHandle {
	/** Bring all nodes into view. */
	fit: () => void;
	/** Multiply the current zoom level by the given factor. */
	zoom: (factor: number) => void;
	/** Center the view on the given node. */
	focus: (id: string) => void;
}

const animation = { duration: 220, easingFunction: "easeInOutQuad" } as const;

/**
 * Place devices in rings that stay stable as their signal strengths change.
 *
 * @param devices The devices to place around the scanner.
 */
function deviceNodes(devices: GraphDevice[]): Node[] {
	const byId = [...devices].sort((a, b) => a.id.localeCompare(b.id));
	const nodes: Node[] = [];
	const labelSpacing = 124;
	let radius = 154;

	while (nodes.length < byId.length) {
		const start = nodes.length;
		const count = Math.min(
			byId.length - start,
			Math.floor((2 * Math.PI * radius) / labelSpacing),
		);
		for (let i = 0; i < count; i++) {
			const device = byId[start + i];
			const angle = (i * 2 * Math.PI) / count - Math.PI / 2;
			nodes.push({
				id: device.id,
				label: device.label,
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
			});
		}
		radius += labelSpacing;
	}
	return nodes;
}

export const BluetoothMapGraph = React.forwardRef<
	BluetoothMapGraphHandle,
	GraphProps
>(function BluetoothMapGraph(
	{
		devices,
		scannerLabel,
		showRssi,
		selected,
		onSelect,
		colors,
		palette,
		dark,
		scannerIcon,
		background,
		label,
	},
	ref,
): React.ReactElement {
	const canvas = useRef<HTMLDivElement>(null);
	const network = useRef<Network | undefined>(undefined);
	const didFit = useRef(false);
	const [graph] = useState(() => ({
		nodes: new DataSet<Node>(),
		edges: new DataSet<Edge>(),
	}));

	useImperativeHandle(
		ref,
		() => ({
			fit: () => network.current?.fit({ animation }),
			zoom: (factor) => {
				const view = network.current;
				if (view) {
					view.moveTo({
						scale: Math.min(
							3,
							Math.max(0.02, view.getScale() * factor),
						),
						animation,
					});
				}
			},
			focus: (id) =>
				network.current?.focus(id, { locked: false, animation }),
		}),
		[],
	);

	useEffect(() => {
		if (!canvas.current) {
			return;
		}
		const view = new Network(canvas.current, graph, {
			physics: false,
			layout: { improvedLayout: false },
			interaction: {
				dragNodes: false,
				hover: true,
				keyboard: { enabled: true, bindToWindow: false },
			},
			nodes: {
				shape: "dot",
				size: 12,
				borderWidth: 2,
				borderWidthSelected: 3,
			},
			edges: { smooth: false },
		});
		view.on(
			"click",
			(event: {
				/** IDs of the nodes selected by the pointer. */
				nodes: string[];
			}) => {
				onSelect(event.nodes[0] ?? SCANNER_NODE_ID);
			},
		);
		network.current = view;
		didFit.current = false;

		return () => {
			view.destroy();
			network.current = undefined;
		};
	}, [graph, onSelect]);

	useEffect(() => {
		const ids = new Set<string | number>(
			devices.map((device) => device.id),
		);
		graph.edges.remove(graph.edges.getIds().filter((id) => !ids.has(id)));
		ids.add(SCANNER_NODE_ID);
		graph.nodes.remove(graph.nodes.getIds().filter((id) => !ids.has(id)));

		const font = {
			color: palette.text.primary,
			size: 14,
			face: "Roboto, Arial",
			strokeColor: background,
			strokeWidth: 4,
		};
		const deviceColor = dark ? "#b2a2f3" : "#6853c5";
		graph.nodes.update([
			{
				id: SCANNER_NODE_ID,
				label: scannerLabel,
				x: 0,
				y: 0,
				shape: "circularImage",
				image: scannerIcon,
				imagePadding: 7,
				size: 28,
				color: {
					background: "#fff",
					border: "#7298f5",
					highlight: { background: "#fff", border: "#466ae8" },
				},
				shadow: {
					enabled: true,
					color: "rgba(69, 115, 242, 0.35)",
					size: 20,
					x: 0,
					y: 0,
				},
				font: { ...font, size: 16 },
			},
			...deviceNodes(devices).map((node) => ({
				...node,
				color: {
					background: deviceColor,
					border: palette.background.paper,
					highlight: {
						background: deviceColor,
						border: palette.primary.main,
					},
					hover: {
						background: deviceColor,
						border: palette.primary.main,
					},
				},
				font,
			})),
		]);
		graph.edges.update(
			devices.map((device) => {
				const color = colors[device.quality];
				return {
					id: device.id,
					from: SCANNER_NODE_ID,
					to: device.id,
					color: {
						color,
						highlight: color,
						hover: color,
						inherit: false,
					},
					dashes: device.stale,
					width: 2,
					label:
						showRssi && device.rssi !== null
							? `${device.rssi} dBm`
							: "",
					font: {
						...font,
						size: 12,
						color,
						background: palette.background.paper,
						strokeWidth: 0,
					},
				};
			}),
		);

		if (!didFit.current && network.current) {
			network.current.fit();
			didFit.current = true;
		}
	}, [
		background,
		colors,
		dark,
		devices,
		graph,
		palette,
		scannerIcon,
		scannerLabel,
		showRssi,
	]);

	useEffect(() => {
		network.current?.selectNodes([selected], selected !== SCANNER_NODE_ID);
	}, [devices, selected]);

	return (
		<div
			className="ble-map-canvas"
			role="region"
			aria-label={label}
			ref={canvas}
		/>
	);
});
