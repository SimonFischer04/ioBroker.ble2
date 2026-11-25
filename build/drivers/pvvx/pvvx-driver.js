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
var pvvx_driver_exports = {};
__export(pvvx_driver_exports, {
  FALLBACK_INTERVAL_MS: () => FALLBACK_INTERVAL_MS,
  PvvxDriver: () => PvvxDriver,
  RETRY_DELAYS_MS: () => RETRY_DELAYS_MS,
  SESSION_TIMEOUT_MS: () => SESSION_TIMEOUT_MS,
  START_DELAY_MS: () => START_DELAY_MS,
  TICK_INTERVAL_MS: () => TICK_INTERVAL_MS,
  parseDeviceList: () => parseDeviceList
});
module.exports = __toCommonJS(pvvx_driver_exports);
var import_advertisement = require("../../lib/advertisement");
var import_command_channel = require("./command-channel");
var import_protocol = require("./protocol");
var import_time_sync = require("./time-sync");
function parseDeviceList(setting) {
  const addresses = [];
  const invalid = [];
  if (typeof setting !== "string")
    return { addresses, invalid };
  for (const entry of setting.split(/[\s,;]+/)) {
    if (!entry)
      continue;
    const address = (0, import_advertisement.normalizeAddress)(entry);
    if (!address)
      invalid.push(entry);
    else if (!addresses.includes(address))
      addresses.push(address);
  }
  return { addresses, invalid };
}
const TICK_INTERVAL_MS = 6e4;
const START_DELAY_MS = 6e4;
const RETRY_DELAYS_MS = [5, 15, 60].map((minutes) => minutes * 6e4);
const FALLBACK_INTERVAL_MS = 24 * 36e5;
const SESSION_TIMEOUT_MS = 45e3;
const STATES = {
  syncTime: {
    name: "Set the clock now",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  },
  lastTimeSync: {
    name: "Last time sync",
    type: "number",
    role: "date",
    read: true,
    write: false
  },
  timeDeviation: {
    name: "Deviation of the clock before the last sync",
    type: "number",
    role: "value",
    unit: "s",
    read: true,
    write: false
  },
  firmwareVersion: {
    name: "Firmware version",
    type: "string",
    role: "info.firmware",
    read: true,
    write: false
  },
  hardwareId: {
    name: "Hardware ID",
    type: "number",
    role: "value",
    read: true,
    write: false
  },
  lastError: {
    name: "Last error",
    type: "string",
    role: "text",
    read: true,
    write: false
  }
};
class PvvxDriver {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
    for (const address of options.addresses) {
      this.devices.set(address, {
        address,
        nextDue: Infinity,
        failures: 0,
        running: false
      });
    }
  }
  devices = /* @__PURE__ */ new Map();
  interval;
  ticking = false;
  disposed = false;
  lastOffset = 0;
  get intervalMs() {
    return this.options.syncIntervalHours * 36e5;
  }
  async start() {
    if (this.devices.size === 0)
      return;
    const { adapter, clock } = this.ctx;
    for (const address of this.devices.keys()) {
      await this.createObjects(address);
    }
    const now = clock.now();
    for (const device of this.devices.values()) {
      device.nextDue = now + START_DELAY_MS;
      device.failures = 0;
    }
    this.lastOffset = clock.timezoneOffset(now);
    if (this.disposed)
      return;
    this.interval = this.ctx.setInterval(
      () => void this.tick(),
      TICK_INTERVAL_MS
    );
    adapter.log.info(`pvvx time sync for ${this.devices.size} devices`);
  }
  async createObjects(address) {
    const { adapter } = this.ctx;
    try {
      await adapter.setObjectNotExistsAsync(address, {
        type: "device",
        common: { name: address },
        native: { address }
      });
      await adapter.setObjectNotExistsAsync(`${address}.pvvx`, {
        type: "channel",
        common: { name: "pvvx firmware" },
        native: {}
      });
      for (const [id, common] of Object.entries(STATES)) {
        await adapter.setObjectNotExistsAsync(`${address}.pvvx.${id}`, {
          type: "state",
          common,
          native: {}
        });
      }
    } catch (e) {
      adapter.log.warn(
        `Could not create the pvvx objects of ${address}: ${errorMessage(e)}`
      );
    }
  }
  async tick() {
    var _a, _b;
    if (this.ticking || this.disposed)
      return;
    this.ticking = true;
    try {
      const { clock, adapter } = this.ctx;
      const now = clock.now();
      const offset = clock.timezoneOffset(now);
      if (offset !== this.lastOffset) {
        this.lastOffset = offset;
        adapter.log.info(
          "The UTC offset changed, setting the clock of all pvvx devices"
        );
        for (const device of this.devices.values()) {
          device.nextDue = now;
          device.failures = 0;
        }
      }
      const due = [...this.devices.values()].filter((device) => device.nextDue <= now).sort((a, b) => a.nextDue - b.nextDue);
      for (const device of due) {
        if (this.disposed)
          break;
        if ((_b = (_a = this.ctx).isBusy) == null ? void 0 : _b.call(_a, device.address)) {
          device.nextDue = now + RETRY_DELAYS_MS[0];
          continue;
        }
        await this.sync(device);
      }
    } finally {
      this.ticking = false;
    }
  }
  async sync(device) {
    const { ctx } = this;
    device.running = true;
    try {
      const result = await ctx.connections.withSession(
        device.address,
        async (session) => {
          const channel = new import_command_channel.PvvxCommandChannel(session, ctx);
          await channel.open();
          return (0, import_time_sync.syncTime)(channel, ctx.clock);
        },
        { timeoutMs: SESSION_TIMEOUT_MS }
      );
      if (this.disposed)
        return;
      device.failures = 0;
      device.nextDue = this.intervalMs > 0 ? ctx.clock.now() + this.intervalMs : Infinity;
      await this.setStates(device.address, {
        lastTimeSync: ctx.clock.now(),
        timeDeviation: result.deviation,
        firmwareVersion: (0, import_protocol.formatVersion)(result.version),
        ...result.hardwareId !== void 0 ? { hardwareId: result.hardwareId } : {},
        lastError: ""
      });
      ctx.adapter.log.info(
        `Set the clock of ${device.address}, it was ${result.deviation} s off`
      );
    } catch (e) {
      if (this.disposed)
        return;
      const now = ctx.clock.now();
      device.failures++;
      const failures = device.failures;
      if (failures <= RETRY_DELAYS_MS.length) {
        device.nextDue = now + RETRY_DELAYS_MS[failures - 1];
      } else {
        device.nextDue = now + (this.intervalMs || FALLBACK_INTERVAL_MS);
        device.failures = 0;
      }
      const code = e != null && typeof e === "object" && typeof e.code === "string" ? e.code : "ERROR";
      const lastError = `${code}: ${errorMessage(e)}`;
      const message = `Could not set the clock of ${device.address}: ${lastError}`;
      if (failures === RETRY_DELAYS_MS.length) {
        ctx.adapter.log.warn(message);
      } else {
        ctx.adapter.log.info(message);
      }
      await this.setStates(device.address, { lastError });
    } finally {
      device.running = false;
    }
  }
  async setStates(address, values) {
    for (const [id, value] of Object.entries(values)) {
      if (this.disposed)
        return;
      try {
        await this.ctx.adapter.setStateAsync(
          `${address}.pvvx.${id}`,
          value,
          true
        );
      } catch (e) {
        this.ctx.adapter.log.warn(
          `Could not write ${address}.pvvx.${id}: ${errorMessage(e)}`
        );
      }
    }
  }
  handleStateChange(id, state) {
    const prefix = `${this.ctx.adapter.namespace}.`;
    const match = id.startsWith(prefix) ? /^(.+)\.pvvx\.syncTime$/.exec(id.slice(prefix.length)) : null;
    const device = match ? this.devices.get(match[1]) : void 0;
    if (!device)
      return false;
    if (!state || state.ack === true || !state.val || this.disposed) {
      return true;
    }
    this.ctx.adapter.setStateAsync(id, false, true).catch(() => {
    });
    device.nextDue = 0;
    device.failures = 0;
    void this.tick();
    return true;
  }
  requestSync(address) {
    const device = this.devices.get(address);
    if (!device || this.disposed)
      return;
    device.nextDue = 0;
    device.failures = 0;
    void this.tick();
  }
  dispose() {
    this.disposed = true;
    if (this.interval !== void 0) {
      this.ctx.clearInterval(this.interval);
      this.interval = void 0;
    }
  }
}
function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FALLBACK_INTERVAL_MS,
  PvvxDriver,
  RETRY_DELAYS_MS,
  SESSION_TIMEOUT_MS,
  START_DELAY_MS,
  TICK_INTERVAL_MS,
  parseDeviceList
});
//# sourceMappingURL=pvvx-driver.js.map
