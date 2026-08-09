# Task 4: Real-Time Communication App

A full-featured, secure, room-based video conferencing and collaboration platform. It implements peer-to-peer WebRTC connections for real-time video/audio streaming, a collaborative drawing canvas, cursor position syncing, and End-to-End Encrypted (E2EE) chat messages.

---

## 🎨 Design & Interface
* **Aesthetics:** Sleek dark-mode aesthetic with glow highlights and responsive modular layouts.
* **Responsive Grid:** Automatically scales remote video streams dynamically as new users join or leave.
* **Canvas Whiteboard:** Full HTML5 Canvas implementation with custom color picker, brush sizes, clearing, and canvas snapshot options.

---

## 🛠️ Technology Stack
* **Frontend:** Vanilla HTML5, CSS3, & Modern ES6+ JavaScript.
* **WebRTC:** Native browser APIs (`RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`) for low-latency P2P audio/video transmission.
* **Backend:** Node.js & Express.js server acting as the WebRTC signaling gateway.
* **Sockets:** Socket.io for room state management, signaling relay, canvas sync, cursor tracking, and real-time alerts.
* **Security & E2EE:** 
  * JSON Web Tokens (JWT) for secure user sessions.
  * SHA-256 for cryptographic room-key derivation.
  * AES-GCM (Web Crypto API) for local client-side E2EE encryption/decryption of chat messages.

---

## ✨ Features
1. **Secure Registration & Login:**
   * JWT-based secure signup and login.
   * Persistent sessions stored inside JSON file database (`users.json`).
2. **Video & Audio Calling:**
   * Dynamic Room joining with passcode validation.
   * Direct P2P audio & video streams.
   * Real-time mute/unmute buttons and video toggle buttons.
3. **Collaborative Canvas (Whiteboard):**
   * Real-time drawing canvas with synchronized stroke streams.
   * Custom brush sizes, color selection, and full canvas clear commands.
   * Shared history replay for late-joining peers.
4. **End-to-End Encrypted Chat:**
   * Text chat panel using secure client-side encryption.
   * All messages are encrypted locally using AES-GCM prior to Socket.io transmission, ensuring the server never sees plain text.
5. **Presence & UX Enhancements:**
   * Real-time cursor coordinates tracking showing active mouse movements of all room peers.
   * Live peer latency monitoring (ping-pong roundtrip timers).
   * Real-time typing indicators.

---

## 📁 Directory Structure
```text
Real time communication/
├── server.js              # Node.js Express & Socket.io server
├── users.json             # Flat file database storing user login credentials
├── package.json           # Application script definitions and dependencies
├── .gitignore             # Ignored directories (e.g. node_modules)
└── public/                # Frontend web client
    ├── index.html         # Main dashboard templates
    ├── styles.css         # Styling stylesheet for RTC dashboard and canvas
    ├── app.js             # Client-side routing, WebRTC handlers, and socket logic
    └── crypto-helper.js   # Client-side AES-GCM cryptographic encryption utilities
```

---

## 🚀 Setup & Execution

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed (v18+ recommended).

### 2. Install Dependencies
Run the package installation:
```bash
npm install
```

### 3. Start the Server
Run the local node server:
```bash
# Direct run
npm start

# Development mode
npm run dev
```

### 4. Connect to Rooms
Navigate to:
* **http://localhost:3000**
* Register an account, log in, create/join a room, and share the room code with peers.
