"use strict";

/**
 * BLE UART WebApp
 * Browser-based serial terminal for BLE peripherals that tunnel a UART
 * over GATT, via the Web Bluetooth API.
 */

/**
 * Supported UART-over-BLE profiles, probed in this order after connecting.
 *
 * NUS uses two characteristics (one written to, one notifying). The HM-10
 * and its clones use a single characteristic for both directions, so
 * writeChar and notifyChar are simply the same UUID there.
 */
const PROFILES = [
  {
    name: "Nordic UART Service",
    service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    writeChar: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    notifyChar: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  },
  {
    name: "HM-10",
    service: 0xffe0,
    writeChar: 0xffe1,
    notifyChar: 0xffe1,
  },
];

// Conservative chunk size for writes (default BLE ATT MTU is 23 bytes,
// leaving ~20 bytes of payload per write).
const WRITE_CHUNK_SIZE = 20;

// Commands the demo buttons send to the device.
const DEMO_START_MESSAGE = "demo";
const DEMO_STOP_MESSAGE = "demo stop";

// Line endings appended to outgoing messages, keyed by the value of the
// selector in the send form.
const LINE_ENDINGS = {
  none: "",
  lf: "\n",
  cr: "\r",
  crlf: "\r\n",
  lfcr: "\n\r",
};

const els = {
  connectBtn: document.getElementById("connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  deviceName: document.getElementById("device-name"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  terminal: document.getElementById("terminal"),
  sendForm: document.getElementById("send-form"),
  sendInput: document.getElementById("send-input"),
  sendBtn: document.getElementById("send-btn"),
  demoStartBtn: document.getElementById("demo-start-btn"),
  demoStopBtn: document.getElementById("demo-stop-btn"),
  allDevicesToggle: document.getElementById("all-devices-toggle"),
  clearBtn: document.getElementById("clear-btn"),
  autoscrollToggle: document.getElementById("autoscroll-toggle"),
  timestampToggle: document.getElementById("timestamp-toggle"),
  lineEndingSelect: document.getElementById("line-ending-select"),
  supportWarning: document.getElementById("support-warning"),
};

const state = {
  device: null,
  server: null,
  profile: null, // entry from PROFILES that matched the connected device
  writeChar: null, // web app -> device
  notifyChar: null, // device -> web app
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function supportsWebBluetooth() {
  return "bluetooth" in navigator;
}

function setConnectedUI(connected, deviceLabel) {
  els.status.classList.toggle("status--connected", connected);
  els.status.classList.toggle("status--disconnected", !connected);
  els.statusText.textContent = connected ? "Connected" : "Disconnected";
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
  els.sendInput.disabled = !connected;
  els.sendBtn.disabled = !connected;
  els.demoStartBtn.disabled = !connected;
  els.demoStopBtn.disabled = !connected;
  els.deviceName.textContent = connected && deviceLabel ? deviceLabel : "";
  if (connected) {
    els.sendInput.focus();
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function appendLine(text, kind) {
  const line = document.createElement("span");
  line.className = `line line--${kind}`;

  if (els.timestampToggle.checked) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = timestamp();
    line.appendChild(ts);
  }

  line.appendChild(document.createTextNode(text));
  els.terminal.appendChild(line);

  if (els.autoscrollToggle.checked) {
    els.terminal.scrollTop = els.terminal.scrollHeight;
  }
}

// Incoming notifications don't guarantee line boundaries, so we buffer
// bytes and flush on newlines, keeping any partial line pending. Devices
// terminate lines with any of the endings the send form offers.
let rxBuffer = "";

function handleIncomingChunk(chunk) {
  rxBuffer += chunk;
  const lines = rxBuffer.split(/\r\n|\n\r|\r|\n/);
  rxBuffer = lines.pop(); // last element may be an incomplete line
  for (const line of lines) {
    if (line.length > 0) {
      appendLine(line, "rx");
    }
  }
}

function flushRxBuffer() {
  if (rxBuffer.length > 0) {
    appendLine(rxBuffer, "rx");
    rxBuffer = "";
  }
}

function onCharacteristicValueChanged(event) {
  const value = event.target.value; // DataView
  const text = textDecoder.decode(value);
  handleIncomingChunk(text);
}

function onDeviceDisconnected() {
  appendLine(`Disconnected from ${state.device ? state.device.name || "device" : "device"}.`, "sys");
  flushRxBuffer();
  cleanupConnection();
  setConnectedUI(false);
}

function cleanupConnection() {
  if (state.notifyChar) {
    state.notifyChar.removeEventListener("characteristicvaluechanged", onCharacteristicValueChanged);
  }
  if (state.device) {
    state.device.removeEventListener("gattserverdisconnected", onDeviceDisconnected);
  }
  state.device = null;
  state.server = null;
  state.profile = null;
  state.writeChar = null;
  state.notifyChar = null;
}

// Filtering by service UUID keeps the chooser clean, but HM-10 clones often
// do not advertise their service, so they only show up unfiltered.
function requestDeviceOptions() {
  const services = PROFILES.map((profile) => profile.service);
  if (els.allDevicesToggle.checked) {
    return { acceptAllDevices: true, optionalServices: services };
  }
  return {
    filters: services.map((service) => ({ services: [service] })),
    optionalServices: services,
  };
}

// Returns the first profile the connected device actually exposes, or null.
async function resolveProfile(server) {
  for (const profile of PROFILES) {
    try {
      const service = await server.getPrimaryService(profile.service);
      const [writeChar, notifyChar] = await Promise.all([
        service.getCharacteristic(profile.writeChar),
        service.getCharacteristic(profile.notifyChar),
      ]);
      return { profile, writeChar, notifyChar };
    } catch {
      // Service or characteristic missing — try the next profile.
    }
  }
  return null;
}

async function connect() {
  if (!supportsWebBluetooth()) {
    els.supportWarning.hidden = false;
    return;
  }

  try {
    els.connectBtn.disabled = true;
    appendLine("Requesting Bluetooth device…", "sys");

    const device = await navigator.bluetooth.requestDevice(requestDeviceOptions());
    const label = device.name || "Unnamed device";

    state.device = device;
    device.addEventListener("gattserverdisconnected", onDeviceDisconnected);

    appendLine(`Connecting to ${label}…`, "sys");
    state.server = await device.gatt.connect();

    const link = await resolveProfile(state.server);
    if (!link) {
      device.gatt.disconnect();
      throw new Error("device exposes neither the Nordic UART Service nor an HM-10 service");
    }

    state.profile = link.profile;
    state.writeChar = link.writeChar;
    state.notifyChar = link.notifyChar;

    await link.notifyChar.startNotifications();
    link.notifyChar.addEventListener("characteristicvaluechanged", onCharacteristicValueChanged);

    appendLine(`Connected to ${label} (${link.profile.name}).`, "sys");
    setConnectedUI(true, `${label} · ${link.profile.name}`);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      appendLine("Device selection cancelled.", "sys");
    } else {
      appendLine(`Connection failed: ${err && err.message ? err.message : err}`, "sys");
    }
    cleanupConnection();
    setConnectedUI(false);
  }
}

async function disconnect() {
  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
    // onDeviceDisconnected() fires via the gattserverdisconnected event
    // and takes care of UI/state cleanup.
  }
}

async function sendText(text) {
  if (!state.writeChar) return;

  const ending = LINE_ENDINGS[els.lineEndingSelect.value] ?? "";
  const payload = `${text}${ending}`;
  const bytes = textEncoder.encode(payload);

  try {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK_SIZE);
      if (state.writeChar.writeValueWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(chunk);
      } else {
        await state.writeChar.writeValue(chunk);
      }
    }
    appendLine(text, "tx");
  } catch (err) {
    appendLine(`Send failed: ${err && err.message ? err.message : err}`, "sys");
  }
}

function clearTerminal() {
  els.terminal.innerHTML = "";
}

// The demo buttons are shortcuts for the two commands the device expects;
// the device itself decides what to do with them.
function sendDemoStart() {
  sendText(DEMO_START_MESSAGE);
}

function sendDemoStop() {
  sendText(DEMO_STOP_MESSAGE);
}

els.connectBtn.addEventListener("click", connect);
els.disconnectBtn.addEventListener("click", disconnect);
els.demoStartBtn.addEventListener("click", sendDemoStart);
els.demoStopBtn.addEventListener("click", sendDemoStop);
els.clearBtn.addEventListener("click", clearTerminal);

els.sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.sendInput.value;
  if (text.length === 0) return;
  sendText(text);
  els.sendInput.value = "";
});

if (!supportsWebBluetooth()) {
  els.supportWarning.hidden = false;
  els.connectBtn.disabled = true;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
