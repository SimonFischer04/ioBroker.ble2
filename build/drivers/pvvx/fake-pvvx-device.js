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
  OTA_HANDLE: () => OTA_HANDLE,
  createFakeSession: () => createFakeSession
});
module.exports = __toCommonJS(fake_pvvx_device_exports);
var import_gatt_session = require("../../connections/gatt-session");
var import_gateway_error = require("../../lib/gateway-error");
var import_ota_protocol = require("./ota-protocol");
var import_protocol = require("./protocol");
const COMMAND_HANDLE = 32;
const OTA_HANDLE = 42;
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
  ota = {
    writes: [],
    started: false,
    received: [],
    status: 0,
    finished: false,
    newVersion: 96,
    dataPackets: 0
  };
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
      },
      {
        uuid: import_ota_protocol.OTA_SERVICE,
        handle: 40,
        characteristics: [
          {
            uuid: import_ota_protocol.OTA_CHARACTERISTIC,
            handle: OTA_HANDLE,
            properties: 6,
            descriptors: []
          }
        ]
      }
    ]);
  }
  read(handle) {
    if (handle === OTA_HANDLE) {
      return Promise.resolve(Buffer.from([this.ota.status]));
    }
    return Promise.resolve(this.configResponse);
  }
  writeOta(data, withResponse) {
    const ota = this.ota;
    const dropped = ota.dropAfterPackets !== void 0 && ota.dataPackets >= ota.dropAfterPackets;
    if (dropped) {
      return Promise.reject(
        new import_gateway_error.GatewayError("NOT_CONNECTED", "The device is gone")
      );
    }
    ota.writes.push({ data: Buffer.from(data), withResponse });
    const setStatus = (status) => {
      if (ota.status === 0)
        ota.status = status;
    };
    if (data.length === 2 && data[0] === 1 && data[1] === 255) {
      ota.started = true;
      ota.finished = false;
      ota.received = [];
      ota.status = 0;
      ota.dataPackets = 0;
    } else if (data.length === 20) {
      ota.dataPackets++;
      const index = data.readUInt16LE(0);
      if (index !== ota.received.length) {
        setStatus(1);
      } else if ((0, import_ota_protocol.crc16Modbus)(data.subarray(0, 18)) !== data.readUInt16LE(18)) {
        setStatus(2);
      } else {
        ota.received.push(Buffer.from(data.subarray(2, 18)));
      }
      const fail = ota.failStatusAfterPackets;
      if (fail && ota.dataPackets >= fail.after)
        ota.status = fail.status;
    } else if (data.length === 6 && data[0] === 2 && data[1] === 255) {
      if (data.readUInt16LE(2) !== ota.received.length - 1) {
        setStatus(4);
      } else if ("problem" in (0, import_ota_protocol.validateImage)(Buffer.concat(ota.received))) {
        setStatus(6);
      } else if (ota.status === 0) {
        ota.finished = true;
        this.configResponse = Buffer.from(this.configResponse);
        this.configResponse[1] = ota.newVersion;
      }
    }
    return Promise.resolve();
  }
  write(handle, data, withResponse) {
    if (this.failWrite)
      return Promise.reject(this.failWrite);
    if (handle === OTA_HANDLE)
      return this.writeOta(data, withResponse);
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
  async writeSequence(handle, data, withResponse, readAfter) {
    for (const entry of data)
      await this.write(handle, entry, withResponse);
    return readAfter ? this.read(handle) : void 0;
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
  OTA_HANDLE,
  createFakeSession
});
//# sourceMappingURL=fake-pvvx-device.js.map
