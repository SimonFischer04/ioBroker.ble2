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
var ota_transfer_exports = {};
__export(ota_transfer_exports, {
  transferImage: () => transferImage
});
module.exports = __toCommonJS(ota_transfer_exports);
var import_ota_protocol = require("./ota-protocol");
var import_update_error = require("./update-error");
const START_DELAY_MS = 300;
async function transferImage(session, image, length, options) {
  const blocks = (0, import_ota_protocol.toBlocks)(image, length);
  const count = blocks.length;
  const write = (data, withResponse) => session.write(import_ota_protocol.OTA_SERVICE, import_ota_protocol.OTA_CHARACTERISTIC, data, withResponse);
  await write(import_ota_protocol.OTA_CMD_VERSION, import_ota_protocol.OTA_WRITE_WITH_RESPONSE);
  await write(import_ota_protocol.OTA_CMD_START, import_ota_protocol.OTA_WRITE_WITH_RESPONSE);
  await options.sleep(START_DELAY_MS);
  for (let start = 0; start < count; start += import_ota_protocol.PACKETS_PER_STATUS_READ) {
    const end = Math.min(start + import_ota_protocol.PACKETS_PER_STATUS_READ, count);
    const packets = [];
    for (let index = start; index < end; index++) {
      packets.push((0, import_ota_protocol.encodeDataPacket)(index, blocks[index]));
    }
    const full = packets.length === import_ota_protocol.PACKETS_PER_STATUS_READ;
    const status = await session.writeSequence(
      import_ota_protocol.OTA_SERVICE,
      import_ota_protocol.OTA_CHARACTERISTIC,
      packets,
      import_ota_protocol.OTA_WRITE_WITH_RESPONSE,
      full
    );
    if (full) {
      if (!status || status.length === 0) {
        throw new import_update_error.PvvxUpdateError(
          "UNEXPECTED_ANSWER",
          "Empty update status"
        );
      }
      if (status[0] !== 0) {
        throw new import_update_error.PvvxUpdateError(
          `OTA_STATUS_${status[0]}`,
          (0, import_ota_protocol.otaStatusText)(status[0])
        );
      }
    }
    options.onProgress(end / count);
  }
  try {
    await write((0, import_ota_protocol.encodeEndPacket)(count - 1), false);
  } catch (e) {
    const code = e == null ? void 0 : e.code;
    if (code !== "NOT_CONNECTED" && code !== "TIMEOUT")
      throw e;
  }
  options.onProgress(1);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  transferImage
});
//# sourceMappingURL=ota-transfer.js.map
