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
var gateway_protocol_exports = {};
__export(gateway_protocol_exports, {
  GATEWAY_FEATURES: () => GATEWAY_FEATURES,
  GATEWAY_PROTOCOL: () => GATEWAY_PROTOCOL,
  GatewayCommands: () => GatewayCommands,
  GattCommands: () => GattCommands,
  MAX_ADVERTISEMENTS_PER_MESSAGE: () => MAX_ADVERTISEMENTS_PER_MESSAGE,
  MAX_WRITE_SEQUENCE_LENGTH: () => MAX_WRITE_SEQUENCE_LENGTH
});
module.exports = __toCommonJS(gateway_protocol_exports);
const GATEWAY_PROTOCOL = "ble-gateway/1";
const GatewayCommands = {
  advertisements: "gateway:advertisements",
  announce: "gateway:announce",
  connectionState: "gateway:connectionState",
  notification: "gateway:notification",
  getGateways: "getGateways",
  getDevices: "getDevices",
  discoverServices: "discoverServices",
  readCharacteristic: "readCharacteristic",
  writeCharacteristic: "writeCharacteristic"
};
const GattCommands = {
  connect: "gatt:connect",
  disconnect: "gatt:disconnect",
  getServices: "gatt:getServices",
  read: "gatt:read",
  write: "gatt:write",
  subscribe: "gatt:subscribe",
  writeSequence: "gatt:writeSequence"
};
const GATEWAY_FEATURES = ["writeSequence"];
const MAX_WRITE_SEQUENCE_LENGTH = 64;
const MAX_ADVERTISEMENTS_PER_MESSAGE = 500;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GATEWAY_FEATURES,
  GATEWAY_PROTOCOL,
  GatewayCommands,
  GattCommands,
  MAX_ADVERTISEMENTS_PER_MESSAGE,
  MAX_WRITE_SEQUENCE_LENGTH
});
//# sourceMappingURL=gateway-protocol.js.map
