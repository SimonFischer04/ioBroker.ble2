import { validateImage } from "./ota-protocol";
import type { Clock } from "./time-sync";
import { PvvxUpdateError } from "./update-error";

/** Where firmware.json and the images come from */
export interface FirmwareSource {
	/** The parsed firmware.json */
	getIndex(): Promise<unknown>;
	/** An image, path relative to the base URL, e.g. "bin/ATC_v59.bin" */
	getImage(path: string): Promise<Buffer>;
}

export const DEFAULT_FIRMWARE_URL =
	"https://raw.githubusercontent.com/pvvx/ATC_MiThermometer/master/";
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_DOWNLOAD_SIZE = 256 * 1024;
/** firmware.json is loaded again after this time */
export const INDEX_MAX_AGE_MS = 6 * 3600000;

/**
 * Loads from a base URL with fetch()
 *
 * @param baseUrl URL that firmware.json and the image paths are relative to
 * @param fetchImpl fetch() to use, replaceable in tests
 */
export function createHttpFirmwareSource(
	baseUrl: string,
	fetchImpl: typeof fetch = (...args) => fetch(...args),
): FirmwareSource {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

	async function load(path: string): Promise<Buffer> {
		if (path.startsWith("/") || path.split("/").includes("..")) {
			throw new Error(`Invalid path "${path}"`);
		}
		const url = base + path;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
		try {
			const response = await fetchImpl(url, {
				signal: controller.signal,
			});
			if (response.status !== 200) {
				throw new Error(`${url}: HTTP status ${response.status}`);
			}
			const length = Number(response.headers.get("content-length"));
			if (length > MAX_DOWNLOAD_SIZE) {
				throw new Error(
					`${url} is larger than ${MAX_DOWNLOAD_SIZE} bytes`,
				);
			}
			// Read piece by piece: Content-Length may be missing or describe the compressed size
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error(`${url}: empty response`);
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				size += value.length;
				if (size > MAX_DOWNLOAD_SIZE) {
					await reader.cancel().catch(() => {});
					controller.abort();
					throw new Error(
						`${url} is larger than ${MAX_DOWNLOAD_SIZE} bytes`,
					);
				}
				chunks.push(value);
			}
			return Buffer.concat(chunks);
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		getIndex: async () =>
			JSON.parse((await load("firmware.json")).toString("utf8")),
		getImage: (path) => load(path),
	};
}

/** The parts of firmware.json the update needs */
export interface FirmwareIndex {
	/** Newest version, same encoding as the version byte of 0x55 (89 = 0x59 = "5.9") */
	version: number;
	/** Image path per hardware ID */
	custom: string[];
}

/**
 * Checks the parsed firmware.json, undefined if it does not have the expected form
 *
 * @param json The parsed firmware.json
 */
export function parseFirmwareIndex(json: unknown): FirmwareIndex | undefined {
	if (json == null || typeof json !== "object") {
		return undefined;
	}
	const { version, custom } = json as Record<string, unknown>;
	if (
		!Number.isInteger(version) ||
		(version as number) < 1 ||
		(version as number) > 255
	) {
		return undefined;
	}
	if (!Array.isArray(custom) || custom.some((c) => typeof c !== "string")) {
		return undefined;
	}
	return { version: version as number, custom: custom as string[] };
}

export type ImageSelection =
	| {
			/** Image path relative to the base URL */
			path: string;
			/** Version of the image, from firmware.json */
			version: number;
	  }
	| {
			/** Why no image is offered */
			problem: "UNKNOWN_HARDWARE" | "NO_IMAGE" | "UP_TO_DATE";
	  };

/**
 * docs/pvvx-protocol.md 6.3
 *
 * @param index Parsed firmware.json
 * @param hardwareId Hardware ID reported by the device
 * @param installedVersion Version byte of the installed firmware
 */
export function selectImage(
	index: FirmwareIndex,
	hardwareId: number | undefined,
	installedVersion: number,
): ImageSelection {
	if (
		hardwareId === undefined ||
		!Number.isInteger(hardwareId) ||
		hardwareId < 0 ||
		hardwareId >= index.custom.length
	) {
		return { problem: "UNKNOWN_HARDWARE" };
	}
	const path = index.custom[hardwareId];
	if (!path.endsWith(".bin")) {
		return { problem: "NO_IMAGE" };
	}
	if (installedVersion >= index.version) {
		return { problem: "UP_TO_DATE" };
	}
	return { path, version: index.version };
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** firmware.json and the images, cached */
export class FirmwareCatalog {
	/**
	 * Creates an empty cache that loads from the given source.
	 *
	 * @param source Where firmware.json and the images come from
	 * @param clock Time source for the age of firmware.json
	 */
	public constructor(
		private readonly source: FirmwareSource,
		private readonly clock: Clock,
	) {}

	private index: { value: FirmwareIndex; loaded: number } | undefined;
	private readonly images = new Map<
		string,
		{ image: Buffer; length: number }
	>();

	/**
	 * firmware.json, loaded again when older than INDEX_MAX_AGE_MS or when refresh is set
	 *
	 * @param refresh Load firmware.json even if the cached copy is recent
	 */
	public async getIndex(refresh: boolean = false): Promise<FirmwareIndex> {
		const now = this.clock.now();
		if (
			!refresh &&
			this.index &&
			now - this.index.loaded < INDEX_MAX_AGE_MS
		) {
			return this.index.value;
		}
		let json: unknown;
		try {
			json = await this.source.getIndex();
		} catch (e) {
			throw new PvvxUpdateError(
				"DOWNLOAD_FAILED",
				`Could not load firmware.json: ${message(e)}`,
			);
		}
		const value = parseFirmwareIndex(json);
		if (!value) {
			throw new PvvxUpdateError(
				"DOWNLOAD_FAILED",
				"firmware.json has an unexpected form",
			);
		}
		this.index = { value, loaded: now };
		return value;
	}

	/**
	 * The image, loaded once per path and kept in memory
	 *
	 * @param path Image path relative to the base URL
	 */
	public async getImage(
		path: string,
	): Promise<{ image: Buffer; length: number }> {
		const cached = this.images.get(path);
		if (cached) {
			return cached;
		}
		let image: Buffer;
		try {
			image = await this.source.getImage(path);
		} catch (e) {
			throw new PvvxUpdateError(
				"DOWNLOAD_FAILED",
				`Could not load ${path}: ${message(e)}`,
			);
		}
		const result = validateImage(image);
		if ("problem" in result) {
			throw new PvvxUpdateError(
				"INVALID_IMAGE",
				`${path}: ${result.problem}`,
			);
		}
		const entry = { image, length: result.length };
		this.images.set(path, entry);
		return entry;
	}
}
