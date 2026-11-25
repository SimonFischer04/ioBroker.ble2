"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var firmware_catalog_exports = {};
__export(firmware_catalog_exports, {
  DEFAULT_FIRMWARE_URL: () => DEFAULT_FIRMWARE_URL,
  FirmwareCatalog: () => FirmwareCatalog,
  INDEX_MAX_AGE_MS: () => INDEX_MAX_AGE_MS,
  createHttpFirmwareSource: () => createHttpFirmwareSource,
  parseFirmwareIndex: () => parseFirmwareIndex,
  selectImage: () => selectImage
});
module.exports = __toCommonJS(firmware_catalog_exports);
var import_ota_protocol = require("./ota-protocol");
var import_update_error = require("./update-error");
const DEFAULT_FIRMWARE_URL = "https://raw.githubusercontent.com/pvvx/ATC_MiThermometer/master/";
const DOWNLOAD_TIMEOUT_MS = 3e4;
const MAX_DOWNLOAD_SIZE = 256 * 1024;
const INDEX_MAX_AGE_MS = 6 * 36e5;
function createHttpFirmwareSource(baseUrl, fetchImpl = (...args) => fetch(...args)) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  async function load(path) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`Invalid path "${path}"`);
    }
    const url = base + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal
      });
      if (response.status !== 200) {
        throw new Error(`${url}: HTTP status ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_DOWNLOAD_SIZE) {
        throw new Error(
          `${url} is larger than ${MAX_DOWNLOAD_SIZE} bytes`
        );
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_DOWNLOAD_SIZE) {
        throw new Error(
          `${url} is larger than ${MAX_DOWNLOAD_SIZE} bytes`
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    getIndex: async () => JSON.parse((await load("firmware.json")).toString("utf8")),
    getImage: (path) => load(path)
  };
}
function parseFirmwareIndex(json) {
  if (json == null || typeof json !== "object")
    return void 0;
  const { version, custom } = json;
  if (!Number.isInteger(version) || version < 1 || version > 255) {
    return void 0;
  }
  if (!Array.isArray(custom) || custom.some((c) => typeof c !== "string")) {
    return void 0;
  }
  return { version, custom };
}
function selectImage(index, hardwareId, installedVersion) {
  if (hardwareId === void 0 || !Number.isInteger(hardwareId) || hardwareId < 0 || hardwareId >= index.custom.length) {
    return { problem: "UNKNOWN_HARDWARE" };
  }
  const path = index.custom[hardwareId];
  if (!path.endsWith(".bin"))
    return { problem: "NO_IMAGE" };
  if (installedVersion >= index.version)
    return { problem: "UP_TO_DATE" };
  return { path, version: index.version };
}
function message(e) {
  return e instanceof Error ? e.message : String(e);
}
class FirmwareCatalog {
  constructor(source, clock) {
    this.source = source;
    this.clock = clock;
  }
  index;
  images = /* @__PURE__ */ new Map();
  async getIndex(refresh = false) {
    const now = this.clock.now();
    if (!refresh && this.index && now - this.index.loaded < INDEX_MAX_AGE_MS) {
      return this.index.value;
    }
    let json;
    try {
      json = await this.source.getIndex();
    } catch (e) {
      throw new import_update_error.PvvxUpdateError(
        "DOWNLOAD_FAILED",
        `Could not load firmware.json: ${message(e)}`
      );
    }
    const value = parseFirmwareIndex(json);
    if (!value) {
      throw new import_update_error.PvvxUpdateError(
        "DOWNLOAD_FAILED",
        "firmware.json has an unexpected form"
      );
    }
    this.index = { value, loaded: now };
    return value;
  }
  async getImage(path) {
    const cached = this.images.get(path);
    if (cached)
      return cached;
    let image;
    try {
      image = await this.source.getImage(path);
    } catch (e) {
      throw new import_update_error.PvvxUpdateError(
        "DOWNLOAD_FAILED",
        `Could not load ${path}: ${message(e)}`
      );
    }
    const result = (0, import_ota_protocol.validateImage)(image);
    if ("problem" in result) {
      throw new import_update_error.PvvxUpdateError(
        "INVALID_IMAGE",
        `${path}: ${result.problem}`
      );
    }
    const entry = { image, length: result.length };
    this.images.set(path, entry);
    return entry;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_FIRMWARE_URL,
  FirmwareCatalog,
  INDEX_MAX_AGE_MS,
  createHttpFirmwareSource,
  parseFirmwareIndex,
  selectImage
});
//# sourceMappingURL=firmware-catalog.js.map
