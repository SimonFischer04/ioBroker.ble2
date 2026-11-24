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
var protocol_exports = {};
__export(protocol_exports, {
  CMD_CONFIG: () => CMD_CONFIG,
  CMD_TIME: () => CMD_TIME,
  PVVX_COMMAND_CHARACTERISTIC: () => PVVX_COMMAND_CHARACTERISTIC,
  PVVX_SERVICE: () => PVVX_SERVICE,
  PVVX_WRITE_WITH_RESPONSE: () => PVVX_WRITE_WITH_RESPONSE,
  clockDeviation: () => clockDeviation,
  encodeConfigRequest: () => encodeConfigRequest,
  encodeTimeRequest: () => encodeTimeRequest,
  formatVersion: () => formatVersion,
  localClockValue: () => localClockValue,
  parseConfigResponse: () => parseConfigResponse,
  parseTimeResponse: () => parseTimeResponse
});
module.exports = __toCommonJS(protocol_exports);
const PVVX_SERVICE = "00001f10-0000-1000-8000-00805f9b34fb";
const PVVX_COMMAND_CHARACTERISTIC = "00001f1f-0000-1000-8000-00805f9b34fb";
const PVVX_WRITE_WITH_RESPONSE = false;
const CMD_CONFIG = 85;
const CMD_TIME = 35;
function localClockValue(nowMs, timezoneOffsetMinutes) {
  return Math.floor(nowMs / 1e3) - timezoneOffsetMinutes * 60 >>> 0;
}
function encodeTimeRequest(value) {
  if (value === void 0)
    return Buffer.from([CMD_TIME]);
  const request = Buffer.alloc(5);
  request[0] = CMD_TIME;
  request.writeUInt32LE(value >>> 0, 1);
  return request;
}
function parseTimeResponse(data) {
  if (data.length < 5 || data[0] !== CMD_TIME)
    return void 0;
  const clock = data.readUInt32LE(1);
  if (data.length >= 9)
    return { clock, lastSet: data.readUInt32LE(5) };
  return { clock };
}
function encodeConfigRequest() {
  return Buffer.from([CMD_CONFIG]);
}
function parseConfigResponse(data) {
  if (data.length < 10 || data[0] !== CMD_CONFIG)
    return void 0;
  const version = data[1];
  if (data.length < 12)
    return { version };
  let hver = data[11];
  if (version < 54)
    hver &= 135;
  if (version >= 72)
    return { version, hardwareId: hver };
  const id = hver & 15;
  return {
    version,
    hardwareId: id === 15 ? 16 + (data[10] & 127) : id
  };
}
function formatVersion(version) {
  return `${version >> 4}.${version & 15}`;
}
function clockDeviation(deviceClock, expectedValue) {
  return deviceClock - expectedValue | 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CMD_CONFIG,
  CMD_TIME,
  PVVX_COMMAND_CHARACTERISTIC,
  PVVX_SERVICE,
  PVVX_WRITE_WITH_RESPONSE,
  clockDeviation,
  encodeConfigRequest,
  encodeTimeRequest,
  formatVersion,
  localClockValue,
  parseConfigResponse,
  parseTimeResponse
});
//# sourceMappingURL=protocol.js.map
