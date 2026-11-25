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
var ota_protocol_exports = {};
__export(ota_protocol_exports, {
  MAX_IMAGE_SIZE: () => MAX_IMAGE_SIZE,
  OTA_CHARACTERISTIC: () => OTA_CHARACTERISTIC,
  OTA_CMD_START: () => OTA_CMD_START,
  OTA_CMD_VERSION: () => OTA_CMD_VERSION,
  OTA_SERVICE: () => OTA_SERVICE,
  OTA_WRITE_WITH_RESPONSE: () => OTA_WRITE_WITH_RESPONSE,
  PACKETS_PER_STATUS_READ: () => PACKETS_PER_STATUS_READ,
  crc16Modbus: () => crc16Modbus,
  crc32Telink: () => crc32Telink,
  encodeDataPacket: () => encodeDataPacket,
  encodeEndPacket: () => encodeEndPacket,
  otaStatusText: () => otaStatusText,
  toBlocks: () => toBlocks,
  validateImage: () => validateImage
});
module.exports = __toCommonJS(ota_protocol_exports);
const OTA_SERVICE = "00010203-0405-0607-0809-0a0b0c0d1912";
const OTA_CHARACTERISTIC = "00010203-0405-0607-0809-0a0b0c0d2b12";
const OTA_WRITE_WITH_RESPONSE = false;
const PACKETS_PER_STATUS_READ = 8;
const MAX_IMAGE_SIZE = 131072;
const MIN_IMAGE_SIZE = 1024;
const OTA_CMD_VERSION = Buffer.from([0, 255]);
const OTA_CMD_START = Buffer.from([1, 255]);
const BLOCK_SIZE = 16;
const SIGNATURE = Buffer.from("KNLT", "ascii");
const ZIGBEE_MAGIC = Buffer.from([30, 241, 238, 11]);
function crc16Modbus(data) {
  let crc = 65535;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? crc >>> 1 ^ 40961 : crc >>> 1;
    }
  }
  return crc;
}
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? c >>> 1 ^ 3988292384 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32Telink(data) {
  let crc = 4294967295;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  }
  return crc >>> 0;
}
function validateImage(image) {
  if (image.length < MIN_IMAGE_SIZE)
    return { problem: "TOO_SMALL" };
  if (image.length > MAX_IMAGE_SIZE)
    return { problem: "TOO_LARGE" };
  if (image.subarray(0, 4).equals(ZIGBEE_MAGIC))
    return { problem: "ZIGBEE" };
  if (!image.subarray(8, 12).equals(SIGNATURE)) {
    return { problem: "NO_SIGNATURE" };
  }
  const length = image.readUInt32LE(24);
  if (length > image.length || length < MIN_IMAGE_SIZE || (length & 15) !== 4) {
    return { problem: "BAD_LENGTH" };
  }
  if (image.readUInt32LE(length - 4) !== crc32Telink(image.subarray(0, length - 4))) {
    return { problem: "BAD_CHECKSUM" };
  }
  return { length };
}
function toBlocks(image, length) {
  const count = Math.ceil(length / BLOCK_SIZE);
  const padded = Buffer.alloc(count * BLOCK_SIZE, 255);
  image.copy(padded, 0, 0, length);
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push(padded.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
  }
  return blocks;
}
function encodeDataPacket(index, block) {
  const packet = Buffer.alloc(2 + BLOCK_SIZE + 2);
  packet.writeUInt16LE(index, 0);
  block.copy(packet, 2, 0, BLOCK_SIZE);
  packet.writeUInt16LE(crc16Modbus(packet.subarray(0, 18)), 18);
  return packet;
}
function encodeEndPacket(lastIndex) {
  const packet = Buffer.from([2, 255, 0, 0, 0, 0]);
  packet.writeUInt16LE(lastIndex, 2);
  packet.writeUInt16LE(~lastIndex & 65535, 4);
  return packet;
}
function otaStatusText(status) {
  switch (status) {
    case 1:
      return "packets lost";
    case 2:
      return "packet CRC error";
    case 3:
      return "flash write error";
    case 4:
      return "last packets missing";
    case 5:
      return "timeout";
    case 6:
      return "image check failed";
    default:
      return `unknown status ${status}`;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_IMAGE_SIZE,
  OTA_CHARACTERISTIC,
  OTA_CMD_START,
  OTA_CMD_VERSION,
  OTA_SERVICE,
  OTA_WRITE_WITH_RESPONSE,
  PACKETS_PER_STATUS_READ,
  crc16Modbus,
  crc32Telink,
  encodeDataPacket,
  encodeEndPacket,
  otaStatusText,
  toBlocks,
  validateImage
});
//# sourceMappingURL=ota-protocol.js.map
