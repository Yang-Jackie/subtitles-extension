# Real-Time Tab Subtitles

A Chrome extension that captures audio from the active browser tab, streams it to Deepgram for live transcription, and renders subtitles directly on top of the page.

## Features

- Captures audio from the current `http` or `https` tab
- Streams audio to Deepgram over WebSocket
- Displays interim and final subtitle text as an on-page overlay
- Keeps tab audio audible while capture is active
- Stores the Deepgram API key and selected language locally in Chrome extension storage
- Uses `nova-3` with selectable languages: English, Mandarin (Simplified), Mandarin (Traditional), and Vietnamese
- Lets you drag the whole subtitle overlay and snap it back to the default bottom-center position
- Keeps the stop button in sync across page reloads and service worker lifecycle changes

## How It Works

The extension uses a Manifest V3 service worker plus an offscreen document:

1. The popup saves your Deepgram API key and selected language, then starts or stops subtitle capture.
2. The background service worker requests a tab audio stream ID with `chrome.tabCapture`.
3. The offscreen document opens the tab audio stream, runs an `AudioWorklet`, converts audio to mono PCM, downsamples to `16 kHz`, and sends `linear16` frames to Deepgram.
4. Transcript updates are relayed back through the background worker to the content script.
5. The content script renders a subtitle overlay on the current page.

The offscreen document owns the runtime capture state because it holds the media stream, audio graph, and Deepgram WebSocket. The background worker reconciles that state for the popup and tracks page reload/content-script readiness separately.

## Requirements

- Google Chrome with support for Manifest V3 offscreen documents
- A Deepgram API key with access to the live transcription API

## Local Setup

No build step is required. This repo is plain HTML and JavaScript.

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.

## Usage

1. Open a normal `http` or `https` page that is playing audio.
2. Click the extension icon.
3. Paste your Deepgram API key.
4. Select a language.
5. Click **Save API Key**.
6. Click **Start Subtitles**.

When subtitles are active, the extension injects a fixed overlay near the bottom of the page and updates it with interim and final transcript text.

Drag the subtitle box itself to reposition it. Drag it near the default bottom-center target to snap it back. The custom position is saved locally.

## Permissions

The extension requests these permissions in [`manifest.json`](/d:/001-Code/Dev/subtitles-extension/manifest.json):

- `activeTab`: identify and interact with the currently focused tab
- `offscreen`: run audio capture and WebSocket streaming in an offscreen document
- `scripting`: inject the content script when needed
- `storage`: persist the Deepgram API key locally
- `tabCapture`: capture audio from the active tab

Host permissions allow access to Deepgram plus standard web pages so the content script can run and subtitles can be shown.

## Language Options

- `English`: sends `model=nova-3` and `language=en`
- `Mandarin (Simplified)`: sends `model=nova-3` and `language=zh-CN`
- `Mandarin (Traditional)`: sends `model=nova-3` and `language=zh-TW`
- `Vietnamese`: sends `model=nova-3` and `language=vi`

## Project Structure

- [`manifest.json`](/d:/001-Code/Dev/subtitles-extension/manifest.json): Chrome extension manifest
- [`background.js`](/d:/001-Code/Dev/subtitles-extension/background.js): service worker that manages sessions and Chrome APIs
- [`offscreen.html`](/d:/001-Code/Dev/subtitles-extension/offscreen.html): offscreen document host
- [`offscreen.js`](/d:/001-Code/Dev/subtitles-extension/offscreen.js): audio pipeline and Deepgram WebSocket client
- [`pcm-processor.js`](/d:/001-Code/Dev/subtitles-extension/pcm-processor.js): audio worklet that mixes tab audio to mono PCM frames
- [`content.js`](/d:/001-Code/Dev/subtitles-extension/content.js): subtitle overlay renderer
- [`popup.html`](/d:/001-Code/Dev/subtitles-extension/popup.html): popup UI
- [`popup.js`](/d:/001-Code/Dev/subtitles-extension/popup.js): popup state and controls

## Limitations

- Only `http` and `https` tabs are capturable.
- The API key is stored locally in extension storage, not encrypted by this project.
- Language is currently limited to the four options in the popup.
- There is no automated test suite or packaging workflow in this repo.
- If the Deepgram WebSocket disconnects repeatedly, recovery depends on the built-in reconnect loop.
- Subtitles are transient; there is no transcript history panel yet.

## Development Notes

- There is no bundler, package manager, or build pipeline.
- Reload the extension from `chrome://extensions` after changing source files.
- Open the service worker and offscreen document DevTools from the extensions page when debugging.
- Useful syntax checks:
  - `node --check background.js`
  - `node --check offscreen.js`
  - `node --check popup.js`
  - `node --check content.js`

## Future Improvements

- Add richer language/settings controls
- Add transcript history instead of a transient overlay only
- Add keyboard shortcuts and per-site controls
- Add packaging and release automation
- Add tests around message routing and audio conversion utilities
