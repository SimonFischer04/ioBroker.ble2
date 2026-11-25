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
var connection_manager_exports = {};
__export(connection_manager_exports, {
  ConnectionManager: () => ConnectionManager
});
module.exports = __toCommonJS(connection_manager_exports);
var import_advertisement = require("../lib/advertisement");
var import_gateway_error = require("../lib/gateway-error");
var import_gatt_session = require("./gatt-session");
const DEFAULT_TIMEOUT_MS = 6e4;
const CLOSE_TIMEOUT_MS = 1e4;
function stoppingError() {
  return new import_gateway_error.GatewayError("NOT_CONNECTED", "The adapter is stopping");
}
class ConnectionManager {
  constructor(ctx) {
    this.ctx = ctx;
  }
  queues = /* @__PURE__ */ new Map();
  disposed = false;
  withSession(address, job, options = {}) {
    const normalized = (0, import_advertisement.normalizeAddress)(address);
    if (!normalized) {
      return Promise.reject(
        new import_gateway_error.GatewayError(
          "INVALID_PAYLOAD",
          `"${String(address)}" is not a MAC address`
        )
      );
    }
    if (this.disposed)
      return Promise.reject(stoppingError());
    return new Promise((resolve, reject) => {
      let queue = this.queues.get(normalized);
      if (!queue) {
        queue = { running: false, waiting: [] };
        this.queues.set(normalized, queue);
      }
      queue.waiting.push({ run: job, options, resolve, reject });
      this.pump(normalized);
    });
  }
  dispose() {
    var _a;
    this.disposed = true;
    for (const queue of this.queues.values()) {
      for (const job of queue.waiting.splice(0))
        job.reject(stoppingError());
      void ((_a = queue.session) == null ? void 0 : _a.close().catch(() => {
      }));
    }
  }
  pump(address) {
    const queue = this.queues.get(address);
    if (!queue || queue.running)
      return;
    if (queue.waiting.length === 0) {
      this.queues.delete(address);
      return;
    }
    let index = queue.waiting.findIndex(
      (job2) => job2.options.priority === "high"
    );
    if (index === -1)
      index = 0;
    const [job] = queue.waiting.splice(index, 1);
    queue.running = true;
    void this.run(address, queue, job);
  }
  bestGateway(address, requireFeature) {
    const normalized = (0, import_advertisement.normalizeAddress)(address);
    if (!normalized)
      return void 0;
    const [gatewayId] = this.getCandidates(
      normalized,
      void 0,
      requireFeature
    );
    if (!gatewayId)
      return void 0;
    const receiver = this.ctx.devices.getReceivers(normalized).find((r) => r.gatewayId === gatewayId);
    return receiver && { gatewayId, rssi: receiver.rssi };
  }
  getCandidates(address, preferGateway, requireFeature) {
    const candidates = this.ctx.devices.getReceivers(address).map((r) => r.gatewayId).filter((id) => {
      const gateway = this.ctx.gateways.get(id);
      return (gateway == null ? void 0 : gateway.connected) === true && gateway.connect === true && gateway.freeSlots !== 0 && (!requireFeature || gateway.features.includes(requireFeature));
    });
    if (preferGateway && candidates.includes(preferGateway)) {
      candidates.splice(candidates.indexOf(preferGateway), 1);
      candidates.unshift(preferGateway);
    }
    return candidates;
  }
  async connect(address, options) {
    var _a;
    const candidates = this.getCandidates(
      address,
      options.preferGateway,
      options.requireFeature
    );
    if (candidates.length === 0) {
      throw new import_gateway_error.GatewayError(
        "NO_GATEWAY",
        options.requireFeature ? `No gateway with ${options.requireFeature} receives ${address}` : `No gateway that can connect receives ${address}`
      );
    }
    const addressType = this.ctx.devices.getAddressType(address);
    let lastError;
    for (const gatewayId of candidates) {
      try {
        return await this.ctx.provider.connect(
          gatewayId,
          address,
          addressType
        );
      } catch (e) {
        lastError = e;
        this.ctx.log.debug(
          `Could not connect to ${address} through ${gatewayId}: ${(_a = e == null ? void 0 : e.message) != null ? _a : String(e)}`
        );
      }
    }
    throw lastError;
  }
  async run(address, queue, job) {
    var _a;
    const timeoutMs = (_a = job.options.timeoutMs) != null ? _a : DEFAULT_TIMEOUT_MS;
    let aborted = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.ctx.setTimeout(() => {
        aborted = true;
        reject(
          new import_gateway_error.GatewayError(
            "TIMEOUT",
            `Session with ${address} took longer than ${timeoutMs} ms`
          )
        );
      }, timeoutMs);
    });
    const work = (async () => {
      const link = await this.connect(address, job.options);
      const session = new import_gatt_session.GattSession(link);
      if (aborted || this.disposed) {
        await session.close().catch(() => {
        });
        throw this.disposed ? stoppingError() : new import_gateway_error.GatewayError("TIMEOUT", "");
      }
      queue.session = session;
      return job.run(session);
    })();
    work.catch(() => {
    });
    try {
      job.resolve(await Promise.race([work, timeout]));
    } catch (e) {
      job.reject(e);
    } finally {
      aborted = true;
      this.ctx.clearTimeout(timer);
      const session = queue.session;
      queue.session = void 0;
      if (session)
        await this.closeSession(session);
      queue.running = false;
      this.pump(address);
    }
  }
  async closeSession(session) {
    let timer;
    await Promise.race([
      session.close().catch(() => {
      }),
      new Promise((resolve) => {
        timer = this.ctx.setTimeout(resolve, CLOSE_TIMEOUT_MS);
      })
    ]);
    this.ctx.clearTimeout(timer);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ConnectionManager
});
//# sourceMappingURL=connection-manager.js.map
