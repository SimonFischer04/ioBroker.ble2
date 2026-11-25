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
var test_fakes_exports = {};
__export(test_fakes_exports, {
  FAKE_SERVICES: () => FAKE_SERVICES,
  FakeLink: () => FakeLink,
  FakeProvider: () => FakeProvider,
  createGatewayRegistry: () => createGatewayRegistry,
  deferred: () => deferred
});
module.exports = __toCommonJS(test_fakes_exports);
var import_gateway_registry = require("../gateways/gateway-registry");
var import_gateway_error = require("../lib/gateway-error");
const FAKE_SERVICES = [
  {
    uuid: "00001f10-0000-1000-8000-00805f9b34fb",
    handle: 30,
    characteristics: [
      {
        uuid: "00001f1f-0000-1000-8000-00805f9b34fb",
        handle: 32,
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
];
class FakeLink {
  constructor(gatewayId, address, mtu = 23) {
    this.gatewayId = gatewayId;
    this.address = address;
    this.mtu = mtu;
  }
  services = FAKE_SERVICES;
  values = /* @__PURE__ */ new Map();
  calls = [];
  disconnects = 0;
  listeners = /* @__PURE__ */ new Map();
  disconnectListeners = [];
  getServices() {
    this.calls.push("getServices");
    return Promise.resolve(this.services);
  }
  read(handle) {
    var _a;
    this.calls.push(`read ${handle}`);
    return Promise.resolve((_a = this.values.get(handle)) != null ? _a : Buffer.alloc(0));
  }
  write(handle, data, withResponse) {
    this.calls.push(
      `write ${handle} ${data.toString("hex")} ${withResponse}`
    );
    this.values.set(handle, data);
    return Promise.resolve();
  }
  async writeSequence(handle, data, withResponse, readAfter) {
    this.calls.push(
      `writeSequence ${handle} ${data.length} ${withResponse} ${readAfter}`
    );
    for (const entry of data)
      await this.write(handle, entry, withResponse);
    return readAfter ? this.read(handle) : void 0;
  }
  subscribe(handle, listener) {
    this.calls.push(`subscribe ${handle}`);
    this.listeners.set(handle, listener);
    return Promise.resolve();
  }
  disconnect() {
    this.calls.push("disconnect");
    this.disconnects++;
    return Promise.resolve();
  }
  onDisconnect(listener) {
    this.disconnectListeners.push(listener);
  }
  notify(handle, data) {
    var _a;
    (_a = this.listeners.get(handle)) == null ? void 0 : _a(data);
  }
  simulateDisconnect() {
    for (const listener of this.disconnectListeners.splice(0))
      listener();
  }
}
class FakeProvider {
  behaviour = /* @__PURE__ */ new Map();
  connects = [];
  links = [];
  async connect(gatewayId, address, addressType) {
    var _a;
    this.connects.push(`${gatewayId} ${address} ${addressType}`);
    const behaviour = (_a = this.behaviour.get(gatewayId)) != null ? _a : "ok";
    let link;
    if (behaviour === "ok") {
      link = new FakeLink(gatewayId, address);
    } else if (typeof behaviour === "function") {
      link = await behaviour();
    } else {
      throw new import_gateway_error.GatewayError(behaviour, `${gatewayId} failed`);
    }
    this.links.push(link);
    return link;
  }
}
function createGatewayRegistry() {
  const adapter = {
    namespace: "ble.0",
    FORBIDDEN_CHARS: /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu,
    log: { debug() {
    }, info() {
    }, warn() {
    }, error() {
    } },
    setState() {
    },
    setStateAsync: () => Promise.resolve(),
    setObjectNotExistsAsync: () => Promise.resolve(),
    getStatesAsync: () => Promise.resolve({})
  };
  return new import_gateway_registry.GatewayRegistry(adapter);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FAKE_SERVICES,
  FakeLink,
  FakeProvider,
  createGatewayRegistry,
  deferred
});
//# sourceMappingURL=test-fakes.js.map
