/** Port the remote scan server (bin/blerp.js) listens on by default */
export const DEFAULT_SERVER_PORT = 8734;

/** A remote scan server, see bin/blerp.js */
export interface RemoteServer {
	host: string;
	port: number;
	/** ID of the gateway: "server:<host>:<port>" */
	gatewayId: string;
}

const HOSTNAME_REGEX =
	/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const IPV6_REGEX = /^[0-9A-Fa-f:.]+$/;

function parsePort(text: string): number | undefined {
	if (!/^\d{1,5}$/.test(text)) {
		return undefined;
	}
	const port = +text;
	return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Parses one entry: "host", "host:port", "[ipv6]" or "[ipv6]:port".
 * Returns undefined if the entry is not valid.
 *
 * @param entry
 */
export function parseServer(entry: string): RemoteServer | undefined {
	let host: string;
	let port = DEFAULT_SERVER_PORT;

	const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(entry);
	if (bracketed) {
		host = bracketed[1];
		if (!IPV6_REGEX.test(host) || !host.includes(":")) {
			return undefined;
		}
		if (bracketed[2] !== undefined) {
			const parsed = parsePort(bracketed[2]);
			if (parsed === undefined) {
				return undefined;
			}
			port = parsed;
		}
	} else {
		const parts = entry.split(":");
		// More than one colon without brackets would be an IPv6 address without a port we could tell apart
		if (parts.length > 2) {
			return undefined;
		}
		host = parts[0];
		if (!HOSTNAME_REGEX.test(host)) {
			return undefined;
		}
		if (parts.length === 2) {
			const parsed = parsePort(parts[1]);
			if (parsed === undefined) {
				return undefined;
			}
			port = parsed;
		}
	}

	host = host.toLowerCase();
	return { host, port, gatewayId: `server:${host}:${port}` };
}

/**
 * Parses the setting with the remote scan servers. Entries are separated by commas, semicolons,
 * spaces or line breaks. Duplicates are removed, invalid entries are returned separately.
 *
 * @param setting
 */
export function parseServerList(setting: unknown): {
	servers: RemoteServer[];
	invalid: string[];
} {
	const servers: RemoteServer[] = [];
	const invalid: string[] = [];
	if (typeof setting !== "string") {
		return { servers, invalid };
	}

	for (const entry of setting.split(/[\s,;]+/)) {
		if (entry === "") {
			continue;
		}
		const server = parseServer(entry);
		if (!server) {
			invalid.push(entry);
		} else if (!servers.some((s) => s.gatewayId === server.gatewayId)) {
			servers.push(server);
		}
	}
	return { servers, invalid };
}

/** The settings of an instance that the migration reads and writes */
export interface ServerSettings {
	/** Up to version 0.14: a single remote scan server, which disabled the local Bluetooth adapter */
	server?: unknown;
	remoteServers?: unknown;
	localScanner?: unknown;
}

/**
 * Up to version 0.14 there was a single remote scan server (setting "server"), and configuring it
 * disabled the local Bluetooth adapter. Now there can be several (setting "remoteServers"), and they
 * work alongside the local Bluetooth adapter.
 *
 * Returns the changes that keep the behaviour of such a configuration, undefined if there is nothing
 * to migrate. A leftover "server" next to "remoteServers" is only removed: otherwise it would come back
 * as soon as the user empties "remoteServers".
 *
 * @param native
 */
export function migrateServerSettings(
	native: ServerSettings,
):
	| { server: string; remoteServers?: string; localScanner?: boolean }
	| undefined {
	const legacy =
		typeof native.server === "string" ? native.server.trim() : "";
	if (legacy === "") {
		return undefined;
	}
	const current =
		typeof native.remoteServers === "string"
			? native.remoteServers.trim()
			: "";
	// Both set: the new setting was saved by the new admin UI, the old one is a leftover
	if (current !== "") {
		return { server: "" };
	}
	return { server: "", remoteServers: legacy, localScanner: false };
}
