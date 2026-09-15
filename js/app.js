"use strict";

/**
 * BLE UART WebApp
 * Browser-based serial terminal for BLE peripherals exposing the
 * Nordic UART Service (NUS) via the Web Bluetooth API.
 */

// Nordic UART Service (NUS) UUIDs
const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write: web app -> device
const NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify: device -> web app

// Conservative chunk size for writes (default BLE ATT MTU is 23 bytes,
// leaving ~20 bytes of payload per write).
const WRITE_CHUNK_SIZE = 20;

// Interval between messages while the demo sender is running.
const DEMO_INTERVAL_MS = 1000;

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
  clearBtn: document.getElementById("clear-btn"),
  autoscrollToggle: document.getElementById("autoscroll-toggle"),
  timestampToggle: document.getElementById("timestamp-toggle"),
  newlineToggle: document.getElementById("newline-toggle"),
  supportWarning: document.getElementById("support-warning"),
};

const state = {
  device: null,
  server: null,
  rxChar: null, // write characteristic
  txChar: null, // notify characteristic
};

const demoState = {
  intervalId: null,
  counter: 0,
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
  els.demoStartBtn.disabled = !connected || demoState.intervalId !== null;
  els.demoStopBtn.disabled = demoState.intervalId === null;
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

// Incoming NUS notifications don't guarantee line boundaries, so we
// buffer bytes and flush on newlines, keeping any partial line pending.
let rxBuffer = "";

function handleIncomingChunk(chunk) {
  rxBuffer += chunk;
  const lines = rxBuffer.split(/\r?\n/);
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
  stopDemo();
  flushRxBuffer();
  cleanupConnection();
  setConnectedUI(false);
}

function cleanupConnection() {
  if (state.txChar) {
    state.txChar.removeEventListener("characteristicvaluechanged", onCharacteristicValueChanged);
  }
  if (state.device) {
    state.device.removeEventListener("gattserverdisconnected", onDeviceDisconnected);
  }
  state.device = null;
  state.server = null;
  state.rxChar = null;
  state.txChar = null;
}

async function connect() {
  if (!supportsWebBluetooth()) {
    els.supportWarning.hidden = false;
    return;
  }

  try {
    els.connectBtn.disabled = true;
    appendLine("Requesting Bluetooth device…", "sys");

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }],
      optionalServices: [NUS_SERVICE_UUID],
    });

    state.device = device;
    device.addEventListener("gattserverdisconnected", onDeviceDisconnected);

    appendLine(`Connecting to ${device.name || "device"}…`, "sys");
    const server = await device.gatt.connect();
    state.server = server;

    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    const [rxChar, txChar] = await Promise.all([
      service.getCharacteristic(NUS_RX_CHAR_UUID),
      service.getCharacteristic(NUS_TX_CHAR_UUID),
    ]);

    state.rxChar = rxChar;
    state.txChar = txChar;

    await txChar.startNotifications();
    txChar.addEventListener("characteristicvaluechanged", onCharacteristicValueChanged);

    appendLine(`Connected to ${device.name || "device"}.`, "sys");
    setConnectedUI(true, device.name || "Unnamed device");
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
  if (!state.rxChar) return;

  const payload = els.newlineToggle.checked ? `${text}\n` : text;
  const bytes = textEncoder.encode(payload);

  try {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK_SIZE);
      if (state.rxChar.writeValueWithoutResponse) {
        await state.rxChar.writeValueWithoutResponse(chunk);
      } else {
        await state.rxChar.writeValue(chunk);
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

function startDemo() {
  if (demoState.intervalId !== null || !state.rxChar) return;

  demoState.counter = 0;
  appendLine("Demo started.", "sys");
  demoState.intervalId = setInterval(() => {
    demoState.counter += 1;
    sendText(`Demo message #${demoState.counter}`);
  }, DEMO_INTERVAL_MS);

  els.demoStartBtn.disabled = true;
  els.demoStopBtn.disabled = false;
}

function stopDemo() {
  if (demoState.intervalId === null) return;

  clearInterval(demoState.intervalId);
  demoState.intervalId = null;
  appendLine("Demo stopped.", "sys");

  els.demoStartBtn.disabled = !state.rxChar;
  els.demoStopBtn.disabled = true;
}

els.connectBtn.addEventListener("click", connect);
els.disconnectBtn.addEventListener("click", disconnect);
els.demoStartBtn.addEventListener("click", startDemo);
els.demoStopBtn.addEventListener("click", stopDemo);
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
