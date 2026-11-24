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
var fake_pvvx_device_exports = {};
__export(fake_pvvx_device_exports, {
  COMMAND_HANDLE: () => COMMAND_HANDLE,
  DEFAULT_CONFIG_RESPONSE: () => DEFAULT_CONFIG_RESPONSE,
  FakePvvxDevice: () => FakePvvxDevice,
  createFakeSession: () => createFakeSession
});
module.exports = __toCommonJS(fake_pvvx_device_exports);
var import_gatt_session = require("../../connections/gatt-session");
var import_protocol = require("./protocol");
const COMMAND_HANDLE = 32;
const DEFAULT_CONFIG_RESPONSE = "5559000000000a048b003700";
class FakePvvxDevice {
  constructor(address = "a4:c1:38:12:34:56", gatewayId = "esphome.0:proxy-og", mtu = 23) {
    this.address = address;
    this.gatewayId = gatewayId;
    this.mtu = mtu;
  }
  clock = 0;
  lastSet = 0;
  timeAdjust = false;
  ignoreSetTime = false;
  configResponse = Buffer.from(DEFAULT_CONFIG_RESPONSE, "hex");
  silentCommands = [];
  beforeEachAnswer = [];
  failWrite;
  writes = [];
  disconnects = 0;
  listener;
  getServices() {
    return Promise.resolve([
      {
        uuid: import_protocol.PVVX_SERVICE,
        handle: 30,
        characteristics: [
          {
            uuid: import_protocol.PVVX_COMMAND_CHARACTERISTIC,
            handle: COMMAND_HANDLE,
            properties: 22,
            descriptors: [
              {
                uuid: "00002902-0000-1000-8000-00805f9b34fb",
                handle: 33
              }
            ]
          }
        ]
      }
    ]);
  }
  read() {
    return Promise.resolve(this.configResponse);
  }
  write(handle, data, withResponse) {
    if (this.failWrite)
      return Promise.reject(this.failWrite);
    this.writes.push({ data: Buffer.from(data), withResponse });
    const listener = this.listener;
    const command = data[0];
    if (handle === COMMAND_HANDLE && listener && !this.silentCommands.includes(command)) {
      const answer = this.answer(data);
      setImmediate(() => {
        for (const notification of this.beforeEachAnswer) {
          listener(notification);
        }
        listener(answer);
      });
    }
    return Promise.resolve();
  }
  answer(data) {
    const command = data[0];
    if (command === import_protocol.CMD_CONFIG)
      return this.configResponse;
    if (command === import_protocol.CMD_TIME && data.length >= 5) {
      if (!this.ignoreSetTime) {
        this.clock = data.readUInt32LE(1);
        this.lastSet = this.clock;
      }
      return this.timeResponse();
    }
    if (command === import_protocol.CMD_TIME)
      return this.timeResponse();
    return Buffer.from([command, 255]);
  }
  timeResponse() {
    const answer = Buffer.alloc(this.timeAdjust ? 9 : 5);
    answer[0] = import_protocol.CMD_TIME;
    answer.writeUInt32LE(this.clock >>> 0, 1);
    if (this.timeAdjust)
      answer.writeUInt32LE(this.lastSet >>> 0, 5);
    return answer;
  }
  subscribe(handle, listener) {
    if (handle === COMMAND_HANDLE)
      this.listener = listener;
    return Promise.resolve();
  }
  disconnect() {
    this.disconnects++;
    return Promise.resolve();
  }
  onDisconnect() {
  }
}
function createFakeSession(device) {
  return new import_gatt_session.GattSession(device);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMAND_HANDLE,
  DEFAULT_CONFIG_RESPONSE,
  FakePvvxDevice,
  createFakeSession
});
//# sourceMappingURL=fake-pvvx-device.js.map
