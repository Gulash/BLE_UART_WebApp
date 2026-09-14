# BLE UART WebApp

A browser-based serial terminal for Bluetooth Low Energy (BLE) devices that
expose the **Nordic UART Service (NUS)**. Built with the
[Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) —
no app install, no backend, just a static page that talks directly to your
hardware.

**Live demo:** https://gulash.github.io/BLE_UART_WebApp/

## Features

- Connect to any BLE peripheral advertising the NUS service UUID
- Live terminal view of incoming data (TX characteristic notifications)
- Send text/commands to the device (RX characteristic writes), chunked to
  fit the default BLE ATT MTU
- Optional timestamps and appended newline on send
- Autoscroll toggle and a one-click clear
- Zero build step — plain HTML/CSS/JS, works straight from GitHub Pages or
  any static file server

## Requirements

Web Bluetooth is currently supported in Chromium-based browsers
(Chrome, Edge, Opera) on desktop and Android, served over **HTTPS** or
`localhost`. It is not available in Safari or Firefox.

## Usage

1. Open the app in a supported browser.
2. Click **Connect** and pick your BLE UART device from the browser's
   device chooser.
3. Incoming data from the device appears in the terminal in real time.
4. Type into the input field and press **Enter** (or click **Send**) to
   write to the device.

## Nordic UART Service reference

| Role                  | UUID                                   |
| ---------------------- | --------------------------------------- |
| Service                | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (write, app→device) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (notify, device→app)| `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

Any firmware implementing this common service (e.g. Nordic nRF5 SDK /
nRF Connect SDK based boards) works out of the box — no pairing beyond the
browser's own device picker is required.

## Local development

This is a static site with no dependencies or build tooling. Serve the
directory with any local web server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Web Bluetooth treats `localhost` as a
secure context, so it works without HTTPS locally.

## Project structure

```
.
├── index.html       # markup / layout
├── css/style.css     # styling (dark terminal theme)
├── js/app.js         # Web Bluetooth + NUS logic
└── .github/workflows/pages.yml  # GitHub Pages deployment
```

## License

MIT — see [LICENSE](LICENSE).
