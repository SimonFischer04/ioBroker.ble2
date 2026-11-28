import type { Plugin } from "./plugin";
import xiaomi = require("./xiaomi");
import miFlora = require("./mi-flora");
import eddystone = require("./eddystone");
import ruuviTag = require("./ruuvi-tag");
import atc = require("./atc");
import magicSwitchBot = require("./magicswitchbot");
import switchbot = require("./switchbot");
import bthome = require("./bthome");
import miScale = require("./mi-scale");
import govee = require("./govee");
import mopeka = require("./mopeka");
import parrot = require("./parrot");
import cyclingPower = require("./cycling-power");
import cometBlue = require("./comet-blue");
import yeelight = require("./yeelight");
import skyrc = require("./skyrc");
import defaultPlugin = require("./_default");

export default [
	xiaomi,
	miFlora,
	eddystone,
	ruuviTag,
	atc,
	magicSwitchBot,
	switchbot,
	bthome,
	miScale,
	govee,
	mopeka,
	// Only an active part, they decode no advertisements
	parrot,
	cyclingPower,
	cometBlue,
	yeelight,
	skyrc,
	defaultPlugin,
] satisfies Plugin[];
