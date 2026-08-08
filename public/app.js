// AetherCall Client Application Logic
// Orchestrates authentication, WebRTC signaling, screen sharing, collaborative drawing, and E2EE.

const App = (() => {
  // --- APPLICATION STATE ---
  const state = {
    token: localStorage.getItem('token') || null,
    username: localStorage.getItem('username') || null,
    roomCode: null,
    roomPassword: null,
    cryptoKey: null, // Derived client-side E2EE key
    socket: null,
    localStream: null,
    screenStream: null,
    isScreenSharing: false,
    peerConnections: {}, // socketId => RTCPeerConnection
    dataChannels: {}, // socketId => RTCDataChannel (for file transfers)
    activeScreenSender: {}, // socketId => RTCRtpSender for screen stream swapping
    participants: {}, // socketId => username
    isMicMuted: false,
    isVideoMuted: false,
    
    // File Transfer State (Receiving)
    incomingTransfers: {}, // fileId => { chunks: [], metadata, bytesReceived }
    
    // Phase 2 additions
    isSettingsOpen: false,
    activeCameraId: null,
    activeMicId: null,
    remotePings: {}, // socketId => sendTimestamp
    pingInterval: null,
    typingTimeout: null
  };

  // --- CONFIGURATION ---
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // --- DOM ELEMENTS ---
  const dom = {
    // Views
    authView: document.getElementById('auth-view'),
    dashboardView: document.getElementById('dashboard-view'),
    meetingView: document.getElementById('meeting-view'),
    
    // Auth
    tabLoginBtn: document.getElementById('tab-login-btn'),
    tabSignupBtn: document.getElementById('tab-signup-btn'),
    loginForm: document.getElementById('login-form'),
    signupForm: document.getElementById('signup-form'),
    authAlert: document.getElementById('auth-alert'),
    authAlertMsg: document.getElementById('auth-alert-msg'),
    
    // Dashboard
    displayUsername: document.getElementById('display-username'),
    logoutBtn: document.getElementById('logout-btn'),
    tabJoinRoomBtn: document.getElementById('tab-join-room-btn'),
    tabCreateRoomBtn: document.getElementById('tab-create-room-btn'),
    joinRoomPanel: document.getElementById('join-room-panel'),
    createRoomPanel: document.getElementById('create-room-panel'),
    joinRoomForm: document.getElementById('join-room-form'),
    createRoomForm: document.getElementById('create-room-form'),
    createRoomCode: document.getElementById('create-room-code'),
    createRoomPass: document.getElementById('create-room-pass'),
    joinRoomCode: document.getElementById('join-room-code'),
    joinRoomPass: document.getElementById('join-room-pass'),
    regenerateCodeBtn: document.getElementById('regenerate-code-btn'),
    dashAlert: document.getElementById('dash-alert'),
    dashAlertMsg: document.getElementById('dash-alert-msg'),
    
    // Meeting Room Header
    currentRoomId: document.getElementById('current-room-id'),
    copyRoomCodeBtn: document.getElementById('copy-room-code-btn'),
    copyInviteLinkBtn: document.getElementById('copy-invite-link-btn'),
    participantCount: document.getElementById('participant-count'),
    
    // Meeting Controls
    toggleMicBtn: document.getElementById('toggle-mic-btn'),
    toggleVideoBtn: document.getElementById('toggle-video-btn'),
    shareScreenBtn: document.getElementById('share-screen-btn'),
    toggleWhiteboardBtn: document.getElementById('toggle-whiteboard-btn'),
    toggleChatBtn: document.getElementById('toggle-chat-btn'),
    settingsToggleBtn: document.getElementById('settings-toggle-btn'),
    leaveCallBtn: document.getElementById('leave-call-btn'),
    chatBadge: document.querySelector('.chat-badge'),
    
    // Device settings
    mediaSettingsPanel: document.getElementById('media-settings-panel'),
    closeSettingsBtn: document.getElementById('close-settings-btn'),
    cameraSelect: document.getElementById('camera-select'),
    micSelect: document.getElementById('mic-select'),

    // Chat items
    emojiToggleBtn: document.getElementById('emoji-toggle-btn'),
    emojiDrawer: document.getElementById('emoji-drawer'),
    typingIndicator: document.getElementById('typing-indicator'),
    typingText: document.getElementById('typing-text'),
    
    // Meeting Sidebar panels
    sidebarPanel: document.getElementById('sidebar-panel'),
    sidebarTabChat: document.getElementById('sidebar-tab-chat'),
    sidebarTabFiles: document.getElementById('sidebar-tab-files'),
    sidebarChatPanel: document.getElementById('sidebar-chat-panel'),
    sidebarFilesPanel: document.getElementById('sidebar-files-panel'),
    
    // Chat & Files
    chatMessages: document.getElementById('chat-messages'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    fileSelector: document.getElementById('file-selector'),
    fileUploaderBox: document.querySelector('.file-uploader-box'),
    transfersList: document.getElementById('transfers-list'),
    
    // Video grid
    videoGridContainer: document.getElementById('video-grid-container'),
    localVideo: document.getElementById('local-video'),
    localMicIndicator: document.querySelector('#wrapper-local .mic-muted-indicator'),
    localVideoIndicator: document.querySelector('#wrapper-local .video-muted-indicator'),
    
    // Whiteboard Canvas
    whiteboardContainer: document.getElementById('whiteboard-container'),
    whiteboardCanvas: document.getElementById('whiteboard-canvas'),
    brushSizeInput: document.getElementById('brush-size'),
    eraserBtn: document.getElementById('eraser-btn'),
    clearBoardBtn: document.getElementById('clear-board-btn'),
    closeWhiteboardBtn: document.getElementById('close-whiteboard-btn'),
    cursorsContainer: document.getElementById('canvas-cursors-container'),
  };

  // --- WHITEBOARD Drawing state ---
  const whiteboard = {
    canvas: null,
    ctx: null,
    drawing: false,
    color: '#ffffff', // Default brush color
    size: 3,
    isEraser: false,
    lastX: 0,
    lastY: 0,
    tool: 'brush', // brush, line, rect, circle, text
    snapshot: null
  };

  // --- INITIALIZATION ---
  async function init() {
    setupEventListeners();
    setupWhiteboard();
    
    // Check if token exists
    if (state.token && state.username) {
      dom.displayUsername.textContent = state.username;
      showView('dashboardView');
      generateAndSetRoomCode();
      
      const pendingRoom = localStorage.getItem('pending_invite_room');
      const urlParams = new URLSearchParams(window.location.search);
      const inviteRoom = urlParams.get('room') || pendingRoom;
      
      if (inviteRoom) {
        localStorage.removeItem('pending_invite_room');
        dom.tabJoinRoomBtn.click();
        dom.joinRoomCode.value = inviteRoom;
        showToastNotification("Invite code detected. Enter password to join!");
        setTimeout(() => dom.joinRoomPass.focus(), 500);
      }
    } else {
      showView('authView');
      // Store pending invite if user needs to authenticate first
      const urlParams = new URLSearchParams(window.location.search);
      const inviteRoom = urlParams.get('room');
      if (inviteRoom) {
        localStorage.setItem('pending_invite_room', inviteRoom);
      }
    }
  }

  // Helper to change active view
  function showView(viewId) {
    // Hide all views
    [dom.authView, dom.dashboardView, dom.meetingView].forEach(el => {
      el.classList.remove('active');
      el.style.display = 'none';
    });
    
    // Show selected view
    const target = dom[viewId];
    target.style.display = viewId === 'meetingView' ? 'grid' : 'flex';
    // Small delay to trigger CSS fade-in
    setTimeout(() => {
      target.classList.add('active');
    }, 50);
  }

  // --- EVENT LISTENERS REGISTRATION ---
  function setupEventListeners() {
    // Auth Tab toggles
    dom.tabLoginBtn.addEventListener('click', () => {
      dom.tabLoginBtn.classList.add('active');
      dom.tabSignupBtn.classList.remove('active');
      dom.loginForm.classList.add('active-form');
      dom.signupForm.classList.remove('active-form');
      hideAlert('auth');
    });

    dom.tabSignupBtn.addEventListener('click', () => {
      dom.tabSignupBtn.classList.add('active');
      dom.tabLoginBtn.classList.remove('active');
      dom.signupForm.classList.add('active-form');
      dom.loginForm.classList.remove('active-form');
      hideAlert('auth');
    });

    // Forms Auth Submit
    dom.loginForm.addEventListener('submit', handleLogin);
    dom.signupForm.addEventListener('submit', handleSignup);
    dom.logoutBtn.addEventListener('click', handleLogout);

    // Dashboard Tab toggles
    dom.tabJoinRoomBtn.addEventListener('click', () => {
      dom.tabJoinRoomBtn.classList.add('active');
      dom.tabCreateRoomBtn.classList.remove('active');
      dom.joinRoomPanel.classList.add('active-panel');
      dom.createRoomPanel.classList.remove('active-panel');
      hideAlert('dash');
    });

    dom.tabCreateRoomBtn.addEventListener('click', () => {
      dom.tabCreateRoomBtn.classList.add('active');
      dom.tabJoinRoomBtn.classList.remove('active');
      dom.createRoomPanel.classList.add('active-panel');
      dom.joinRoomPanel.classList.remove('active-panel');
      hideAlert('dash');
      generateAndSetRoomCode();
    });

    dom.regenerateCodeBtn.addEventListener('click', generateAndSetRoomCode);

    // Join & Create room submits
    dom.joinRoomForm.addEventListener('submit', handleJoinRoomSubmit);
    dom.createRoomForm.addEventListener('submit', handleCreateRoomSubmit);

    // Meeting Controls
    dom.toggleMicBtn.addEventListener('click', toggleMic);
    dom.toggleVideoBtn.addEventListener('click', toggleVideo);
    dom.shareScreenBtn.addEventListener('click', toggleScreenShare);
    dom.toggleWhiteboardBtn.addEventListener('click', toggleWhiteboardPanel);
    dom.closeWhiteboardBtn.addEventListener('click', () => toggleWhiteboardPanel(false));
    dom.toggleChatBtn.addEventListener('click', toggleChatSidebar);
    dom.settingsToggleBtn.addEventListener('click', toggleSettingsPanel);
    dom.closeSettingsBtn.addEventListener('click', () => toggleSettingsPanel(false));
    dom.cameraSelect.addEventListener('change', () => switchDevice('video', dom.cameraSelect.value));
    dom.micSelect.addEventListener('change', () => switchDevice('audio', dom.micSelect.value));
    dom.leaveCallBtn.addEventListener('click', leaveMeeting);
    dom.copyRoomCodeBtn.addEventListener('click', copyRoomCode);
    dom.copyInviteLinkBtn.addEventListener('click', copyInviteLink);

    // Emojis events
    dom.emojiToggleBtn.addEventListener('click', toggleEmojiDrawer);
    document.querySelectorAll('.emoji-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const emoji = e.currentTarget.getAttribute('data-emoji');
        dom.chatInput.value += emoji;
        dom.chatInput.focus();
        toggleEmojiDrawer(false);
      });
    });

    // Chat Typing listener
    dom.chatInput.addEventListener('input', handleChatInputTyping);

    // Whiteboard tools swatches
    const toolSwatches = document.querySelectorAll('.tool-swatch');
    toolSwatches.forEach(swatch => {
      swatch.addEventListener('click', (e) => {
        toolSwatches.forEach(s => s.classList.remove('active'));
        e.currentTarget.classList.add('active');
        whiteboard.tool = e.currentTarget.getAttribute('data-tool');
        
        // If select eraser or other tool, clear eraser state
        whiteboard.isEraser = whiteboard.tool === 'eraser';
        dom.eraserBtn.classList.toggle('active', whiteboard.isEraser);
      });
    });

    // Sidebar panels switching
    dom.sidebarTabChat.addEventListener('click', () => {
      dom.sidebarTabChat.classList.add('active');
      dom.sidebarTabFiles.classList.remove('active');
      dom.sidebarChatPanel.classList.add('active-content');
      dom.sidebarFilesPanel.classList.remove('active-content');
    });

    dom.sidebarTabFiles.addEventListener('click', () => {
      dom.sidebarTabFiles.classList.add('active');
      dom.sidebarTabChat.classList.remove('active');
      dom.sidebarFilesPanel.classList.add('active-content');
      dom.sidebarChatPanel.classList.remove('active-content');
    });

    // Chat submit
    dom.chatForm.addEventListener('submit', handleChatSubmit);

    // File selection
    dom.fileSelector.addEventListener('change', handleFileSelected);
    dom.fileUploaderBox.addEventListener('click', () => dom.fileSelector.click());
    
    // Drag and drop files
    dom.fileUploaderBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.fileUploaderBox.style.borderColor = 'var(--primary)';
    });
    dom.fileUploaderBox.addEventListener('dragleave', () => {
      dom.fileUploaderBox.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    });
    dom.fileUploaderBox.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.fileUploaderBox.style.borderColor = 'rgba(255, 255, 255, 0.15)';
      if (e.dataTransfer.files.length > 0) {
        dom.fileSelector.files = e.dataTransfer.files;
        handleFileSelected();
      }
    });

    // Canvas size event
    window.addEventListener('resize', resizeCanvas);
  }

  // --- ALERTS HELPER ---
  function showAlert(type, msg) {
    const alertEl = type === 'auth' ? dom.authAlert : dom.dashAlert;
    const msgEl = type === 'auth' ? dom.authAlertMsg : dom.dashAlertMsg;
    msgEl.textContent = msg;
    alertEl.classList.remove('hidden');
  }

  function hideAlert(type) {
    const alertEl = type === 'auth' ? dom.authAlert : dom.dashAlert;
    alertEl.classList.add('hidden');
  }

  // --- AUTHENTICATION HANDLERS ---
  async function handleLogin(e) {
    e.preventDefault();
    hideAlert('auth');
    
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      state.token = data.token;
      state.username = data.username;
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      
      dom.displayUsername.textContent = state.username;
      showView('dashboardView');
      generateAndSetRoomCode();
    } catch (err) {
      showAlert('auth', err.message);
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    hideAlert('auth');
    
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Signup failed');
      }

      state.token = data.token;
      state.username = data.username;
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      
      dom.displayUsername.textContent = state.username;
      showView('dashboardView');
      generateAndSetRoomCode();
    } catch (err) {
      showAlert('auth', err.message);
    }
  }

  function handleLogout() {
    state.token = null;
    state.username = null;
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    showView('authView');
  }

  // --- DASHBOARD ACTIONS ---
  function generateRoomCode() {
    // Generate a code resembling xxxx-xxxx
    const randHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${randHex()}-${randHex()}`;
  }

  function generateAndSetRoomCode() {
    dom.createRoomCode.value = generateRoomCode();
  }

  async function handleJoinRoomSubmit(e) {
    e.preventDefault();
    const roomCode = dom.joinRoomCode.value.trim();
    const password = dom.joinRoomPass.value;
    if (!roomCode || !password) return;
    
    await enterRoom(roomCode, password);
  }

  async function handleCreateRoomSubmit(e) {
    e.preventDefault();
    const roomCode = dom.createRoomCode.value;
    const password = dom.createRoomPass.value;
    if (!roomCode || !password) return;
    
    await enterRoom(roomCode, password);
  }

  // --- ROOM SETUP ---
  async function enterRoom(roomCode, password) {
    hideAlert('dash');
    try {
      state.roomCode = roomCode;
      state.roomPassword = password;
      
      // Derive E2EE Crypto Key client-side
      state.cryptoKey = await CryptoHelper.deriveKey(password, roomCode);
      
      // Request mic and camera access
      await initLocalStream();
      
      // Initialize Socket connection
      initSocket();
      
      // Start latency monitoring
      startLatencyMonitor();
      
      // Switch view to meeting room
      dom.currentRoomId.textContent = roomCode;
      showView('meetingView');
      
      // Reset sidebar & whiteboard controls
      toggleChatSidebar(true);
      toggleWhiteboardPanel(false);
      
      // Refresh Canvas size
      setTimeout(resizeCanvas, 300);
      
      showToastNotification('Joined E2EE Secure Room!');
    } catch (err) {
      console.error(err);
      showAlert('dash', 'Could not access camera/microphone or connect. Check permissions.');
    }
  }

  // Media Capture with Device Fallbacks (Audio-only, Video-only, or No-media)
  async function initLocalStream() {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 640, height: 360 }
      });
      state.isMicMuted = false;
      state.isVideoMuted = false;
      showToastNotification('Connected audio & video.');
    } catch (err) {
      console.warn("Failed to get both video and audio. Trying audio only...", err);
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
        state.isMicMuted = false;
        state.isVideoMuted = true;
        showToastNotification('Connected audio only (no camera).');
      } catch (err2) {
        console.warn("Failed to get audio. Trying video only...", err2);
        try {
          state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { width: 640, height: 360 }
          });
          state.isMicMuted = true;
          state.isVideoMuted = false;
          showToastNotification('Connected video only (no microphone).');
        } catch (err3) {
          console.warn("No camera/microphone found or access denied. Joining without media.", err3);
          state.localStream = null;
          state.isMicMuted = true;
          state.isVideoMuted = true;
          showToastNotification('Joined room in text & whiteboard mode.');
        }
      }
    }
    
    if (state.localStream) {
      dom.localVideo.srcObject = state.localStream;
    } else {
      dom.localVideo.srcObject = null;
    }
    
    updateMediaControlButtons();
  }

  function updateMediaControlButtons() {
    if (state.isMicMuted) {
      dom.toggleMicBtn.classList.add('muted');
      dom.toggleMicBtn.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
      dom.localMicIndicator.classList.remove('hidden');
    } else {
      dom.toggleMicBtn.classList.remove('muted');
      dom.toggleMicBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
      dom.localMicIndicator.classList.add('hidden');
    }

    if (state.isVideoMuted) {
      dom.toggleVideoBtn.classList.add('muted');
      dom.toggleVideoBtn.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
      dom.localVideoIndicator.classList.remove('hidden');
    } else {
      dom.toggleVideoBtn.classList.remove('muted');
      dom.toggleVideoBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
      dom.localVideoIndicator.classList.add('hidden');
    }
  }

  // --- SOCKET SIGNALLING & RTC ---
  function initSocket() {
    state.socket = io({
      query: { token: state.token } // Pass auth token in connection headers
    });

    state.socket.on('connect', () => {
      console.log('Connected to signaling server');
      
      // Join Room socket call
      state.socket.emit('join-room', {
        roomCode: state.roomCode,
        username: state.username
      });
    });

    // Existing users list when joining
    state.socket.on('room-users', (users) => {
      console.log('Existing users in room:', users);
      users.forEach(user => {
        state.participants[user.socketId] = user.username;
        // As the newly joined member, initiate a WebRTC caller connection
        createPeerConnection(user.socketId, user.username, true);
      });
      updateParticipantCount();
    });

    // When another peer joins later, wait for them to call us (they will send webrtc-offer)
    state.socket.on('peer-joined', ({ socketId, username }) => {
      console.log('New peer joined:', username, socketId);
      state.participants[socketId] = username;
      showSystemMessage(`${username} joined the meeting.`);
      updateParticipantCount();
    });

    // Receive RTC Signaling
    state.socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      console.log('Received WebRTC offer from:', senderSocketId);
      const username = state.participants[senderSocketId] || 'Remote Peer';
      const pc = createPeerConnection(senderSocketId, username, false);
      
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        state.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer
        });
      } catch (err) {
        console.error('Error handling WebRTC offer:', err);
      }
    });

    state.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log('Received WebRTC answer from:', senderSocketId);
      const pc = state.peerConnections[senderSocketId];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error('Error handling WebRTC answer:', err);
        }
      }
    });

    state.socket.on('webrtc-candidate', async ({ senderSocketId, candidate }) => {
      const pc = state.peerConnections[senderSocketId];
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
      }
    });

    // Handle when a peer leaves
    state.socket.on('peer-left', ({ socketId, username }) => {
      console.log('Peer left room:', username, socketId);
      showSystemMessage(`${username} left the meeting.`);
      handlePeerDisconnect(socketId);
      updateParticipantCount();
    });

    // Receive synced whiteboard data
    state.socket.on('draw', (stroke) => {
      drawRemoteStroke(stroke);
    });

    state.socket.on('whiteboard-history', (strokes) => {
      strokes.forEach(stroke => drawRemoteStroke(stroke));
    });

    state.socket.on('clear-whiteboard', () => {
      clearLocalCanvas();
    });

    // Relayed encrypted text message
    state.socket.on('chat-message-encrypted', async (msg) => {
      try {
        const decryptedText = await CryptoHelper.decryptText(msg.encryptedPayload, state.cryptoKey);
        addChatMessageToUI(msg.sender, decryptedText, false);
      } catch (e) {
        addChatMessageToUI(msg.sender, '[Corrupt/Undecryptable Message]', false);
      }
    });

    // Remote cursors movement
    state.socket.on('cursor-move', ({ socketId, username, x, y }) => {
      updateRemoteCursor(socketId, username, x, y);
    });

    // Typing indicators
    state.socket.on('typing-start', ({ socketId, username }) => {
      dom.typingText.textContent = `${username} is typing...`;
      dom.typingIndicator.classList.remove('hidden');
    });

    state.socket.on('typing-stop', ({ socketId, username }) => {
      dom.typingIndicator.classList.add('hidden');
    });

    // Latency Ping-Pong monitor
    state.socket.on('ping-peer', ({ senderSocketId }) => {
      state.socket.emit('pong-peer', { targetSocketId: senderSocketId });
    });

    state.socket.on('pong-peer', ({ senderSocketId }) => {
      handlePong(senderSocketId);
    });
  }

  // --- WEBRTC CONNECTION CREATION ---
  function createPeerConnection(targetSocketId, username, isInitiator) {
    if (state.peerConnections[targetSocketId]) {
      return state.peerConnections[targetSocketId];
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.peerConnections[targetSocketId] = pc;

    // Attach local media tracks
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, state.localStream);
        if (track.kind === 'video') {
          // Keep a reference to the video sender to replace it during screen sharing
          state.activeScreenSender[targetSocketId] = sender;
        }
      });
    }

    // ICE Candidate Gathering
    pc.onicecandidate = (event) => {
      if (event.candidate && state.socket) {
        state.socket.emit('webrtc-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // Remote Track Listener
    pc.ontrack = (event) => {
      console.log('Received remote track from peer:', targetSocketId);
      addRemoteVideo(targetSocketId, username, event.streams[0]);
    };

    // Connection state changes logging
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${username}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        handlePeerDisconnect(targetSocketId);
      }
    };

    // Data Channel configuration (Caller initiates the DataChannel)
    if (isInitiator) {
      const channel = pc.createDataChannel('fileTransfer');
      setupDataChannel(targetSocketId, channel);
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(targetSocketId, event.channel);
      };
    }

    // If caller, send WebRTC Offer
    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          state.socket.emit('webrtc-offer', {
            targetSocketId: targetSocketId,
            offer: offer
          });
        } catch (err) {
          console.error('Error creating offer:', err);
        }
      };
    }

    return pc;
  }

  // Handle peer disconnect cleaning
  function handlePeerDisconnect(socketId) {
    // Remove video panel
    const videoWrapper = document.getElementById(`wrapper-${socketId}`);
    if (videoWrapper) {
      videoWrapper.remove();
    }
    
    // Close RTC Peer Connection
    if (state.peerConnections[socketId]) {
      state.peerConnections[socketId].close();
      delete state.peerConnections[socketId];
    }

    // Clean data channels
    if (state.dataChannels[socketId]) {
      state.dataChannels[socketId].close();
      delete state.dataChannels[socketId];
    }

    delete state.participants[socketId];
    delete state.activeScreenSender[socketId];
    
    // Clean cursor cursor tracker UI
    const cursor = document.getElementById(`cursor-${socketId}`);
    if (cursor) cursor.remove();
    
    adjustVideoGridClass();
  }

  // --- AUDIO/VIDEO TOGGLING ---
  function toggleMic() {
    if (!state.localStream) {
      showToastNotification("No microphone available.");
      return;
    }
    
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
      state.isMicMuted = !state.isMicMuted;
      audioTrack.enabled = !state.isMicMuted;
      updateMediaControlButtons();
    } else {
      showToastNotification("No microphone available.");
    }
  }

  function toggleVideo() {
    if (!state.localStream) {
      showToastNotification("No camera available.");
      return;
    }
    
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
      state.isVideoMuted = !state.isVideoMuted;
      videoTrack.enabled = !state.isVideoMuted;
      updateMediaControlButtons();
    } else {
      showToastNotification("No camera available.");
    }
  }

  // --- SCREEN SHARING ---
  async function toggleScreenShare() {
    if (state.isScreenSharing) {
      stopScreenSharing();
    } else {
      try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true
        });

        const screenTrack = state.screenStream.getVideoTracks()[0];
        
        // Swap camera track with screen share track on all peer connections
        Object.keys(state.peerConnections).forEach(socketId => {
          const sender = state.activeScreenSender[socketId];
          if (sender) {
            sender.replaceTrack(screenTrack);
          }
        });

        // Mirror local display UI representation
        dom.localVideo.srcObject = state.screenStream;
        document.getElementById('wrapper-local').classList.add('sharing-screen');
        
        state.isScreenSharing = true;
        dom.shareScreenBtn.classList.add('active');

        // Handle browser's native "Stop Sharing" button click
        screenTrack.onended = () => {
          stopScreenSharing();
        };

        showToastNotification('Screen sharing started.');
      } catch (err) {
        console.error('Error starting screen share:', err);
      }
    }
  }

  function stopScreenSharing() {
    if (!state.isScreenSharing) return;

    const cameraTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
    
    // Stop sharing tracks
    state.screenStream.getTracks().forEach(track => track.stop());
    
    // Revert track swap back to camera
    Object.keys(state.peerConnections).forEach(socketId => {
      const sender = state.activeScreenSender[socketId];
      if (sender) {
        sender.replaceTrack(cameraTrack);
      }
    });

    // Revert local UI video stream
    dom.localVideo.srcObject = state.localStream;
    document.getElementById('wrapper-local').classList.remove('sharing-screen');

    state.isScreenSharing = false;
    dom.shareScreenBtn.classList.remove('active');
    
    showToastNotification('Screen sharing stopped.');
  }

  // --- VIDEO GRID MANAGEMENT ---
  function addRemoteVideo(socketId, username, stream) {
    // If wrapper already exists, update track object
    let videoWrapper = document.getElementById(`wrapper-${socketId}`);
    if (videoWrapper) {
      const video = videoWrapper.querySelector('video');
      video.srcObject = stream;
      return;
    }

    videoWrapper = document.createElement('div');
    videoWrapper.id = `wrapper-${socketId}`;
    videoWrapper.className = 'video-wrapper remote-video-wrapper';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;

    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';
    
    const label = document.createElement('span');
    label.className = 'user-label';
    label.textContent = username;

    const indicators = document.createElement('div');
    indicators.className = 'peer-status-indicators';
    indicators.innerHTML = `
      <span class="latency-indicator" id="latency-${socketId}"><i class="fa-solid fa-signal"></i> -- ms</span>
      <i class="fa-solid fa-microphone-slash mic-muted-indicator hidden"></i>
      <i class="fa-solid fa-video-slash video-muted-indicator hidden"></i>
    `;

    overlay.appendChild(label);
    overlay.appendChild(indicators);
    videoWrapper.appendChild(video);
    videoWrapper.appendChild(overlay);

    dom.videoGridContainer.appendChild(videoWrapper);
    adjustVideoGridClass();
  }

  function adjustVideoGridClass() {
    const totalVideos = dom.videoGridContainer.querySelectorAll('.video-wrapper').length;
    
    // Clear all grid adaptive sizing classes
    dom.videoGridContainer.className = 'video-grid';
    
    if (totalVideos === 1) {
      dom.videoGridContainer.classList.add('grid-1');
    } else if (totalVideos === 2) {
      dom.videoGridContainer.classList.add('grid-2');
    } else if (totalVideos === 3) {
      dom.videoGridContainer.classList.add('grid-3');
    } else if (totalVideos === 4) {
      dom.videoGridContainer.classList.add('grid-4');
    } else {
      dom.videoGridContainer.classList.add('grid-multi');
    }
  }

  function updateParticipantCount() {
    const count = Object.keys(state.participants).length + 1; // plus local user
    dom.participantCount.textContent = count;
  }

  // --- CLIENT-SIDE SECURED E2EE CHAT ---
  async function handleChatSubmit(e) {
    e.preventDefault();
    const text = dom.chatInput.value.trim();
    if (!text) return;

    dom.chatInput.value = '';

    try {
      // Encrypt text client-side before sending
      const encrypted = await CryptoHelper.encryptText(text, state.cryptoKey);
      
      // Emit to server to broadcast to room
      state.socket.emit('chat-message-encrypted', {
        roomCode: state.roomCode,
        sender: state.username,
        encryptedPayload: encrypted
      });

      // Render local message immediately (decrypted)
      addChatMessageToUI(state.username, text, true);
    } catch (err) {
      console.error('Encryption failed, sending aborted', err);
    }
  }

  function addChatMessageToUI(sender, text, isLocal) {
    const msgCard = document.createElement('div');
    msgCard.className = `chat-msg ${isLocal ? 'local' : 'remote'}`;

    const header = document.createElement('div');
    header.className = 'msg-header';
    header.textContent = isLocal ? 'You' : sender;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = `
      <span>${escapeHTML(text)}</span>
      <i class="fa-solid fa-lock msg-security-icon" title="E2EE Protected"></i>
    `;

    msgCard.appendChild(header);
    msgCard.appendChild(bubble);
    dom.chatMessages.appendChild(msgCard);
    
    // Auto Scroll to bottom
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;

    // Show indicator if panel is collapsed
    if (!dom.sidebarPanel.classList.contains('active-panel')) {
      dom.chatBadge.classList.remove('hidden');
    }
  }

  function showSystemMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'system-message';
    msg.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${escapeHTML(text)}`;
    dom.chatMessages.appendChild(msg);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }

  // --- P2P SECURED E2EE FILE TRANSFERS ---
  function setupDataChannel(targetSocketId, channel) {
    state.dataChannels[targetSocketId] = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => console.log(`File transfer data channel open with: ${targetSocketId}`);
    channel.onclose = () => console.log(`File transfer data channel closed with: ${targetSocketId}`);
    
    // Receive incoming binary / metadata chunks
    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.type === 'file-start') {
          // Initialize incoming file structure
          state.incomingTransfers[msg.fileId] = {
            metadata: msg,
            chunks: [],
            bytesReceived: 0
          };
          createTransferCardUI(msg.fileId, msg.fileName, msg.fileSize, true);
        } else if (msg.type === 'file-end') {
          await finalizeFileReceive(msg.fileId);
        }
      } else {
        // Binary Chunk received
        // Note: Chunks contain data in format: [First 32 bytes = fileId string padding, next = payload bytes]
        // To simplify, we can send a custom header or just split file transfers. Let's prepend fileId into the buffer
        // Or wait: if we transfer one file at a time, we can assume the active chunk belongs to the latest transfer.
        // Let's prepend a 16-byte fixed fileId identifier to make it robust for simultaneous transfers.
        // Let's define chunk packaging: [16 bytes UTF-8 FileId] [Binary Payload]
        const data = event.data;
        const fileIdBytes = new Uint8Array(data, 0, 16);
        const fileId = new TextDecoder().decode(fileIdBytes).replace(/\0/g, ''); // strip null padding
        
        const chunkPayload = data.slice(16);
        const transfer = state.incomingTransfers[fileId];
        if (transfer) {
          transfer.chunks.push(chunkPayload);
          transfer.bytesReceived += chunkPayload.byteLength;
          const percent = Math.round((transfer.bytesReceived / transfer.metadata.fileSize) * 100);
          updateProgressUI(fileId, percent);
        }
      }
    };
  }

  async function handleFileSelected() {
    const file = dom.fileSelector.files[0];
    if (!file) return;

    // Reset file input value
    dom.fileSelector.value = '';

    const fileId = Math.random().toString(36).substring(2, 10).padEnd(16, '\0').substring(0, 16); // 16 bytes padded
    const fileIdStr = fileId.replace(/\0/g, '');

    createTransferCardUI(fileIdStr, file.name, file.size, false);

    // Read file as ArrayBuffer
    const reader = new FileReader();
    reader.onload = async () => {
      const arrayBuffer = reader.result;
      
      try {
        // 1. Encrypt buffer client-side using PBKDF2 derived AES-GCM Room key
        const { encryptedBuffer, iv } = await CryptoHelper.encryptBuffer(arrayBuffer, state.cryptoKey);
        
        // 2. Prepare metadata
        const metadata = {
          type: 'file-start',
          fileId: fileIdStr,
          fileName: file.name,
          fileType: file.type,
          fileSize: encryptedBuffer.byteLength,
          iv: CryptoHelper.bufferToBase64(iv) // send IV so receivers can decrypt
        };

        // 3. Broadcast metadata over all active peer data channels
        Object.keys(state.dataChannels).forEach(socketId => {
          const channel = state.dataChannels[socketId];
          if (channel && channel.readyState === 'open') {
            channel.send(JSON.stringify(metadata));
          }
        });

        // 4. Send encrypted chunks with E2EE backpressure thresholding
        sendEncryptedFileChunks(encryptedBuffer, fileId);

      } catch (err) {
        console.error('File encryption or sending failed:', err);
        updateProgressUI(fileIdStr, 0, 'Error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function sendEncryptedFileChunks(encryptedBuffer, fileIdPadded) {
    const fileIdStr = fileIdPadded.replace(/\0/g, '');
    const CHUNK_SIZE = 16384; // 16KB WebRTC chunk limit safety
    let offset = 0;
    
    // Prepare the fixed 16-byte header containing fileId bytes
    const encoder = new TextEncoder();
    const headerBuffer = new Uint8Array(16);
    const idEncoded = encoder.encode(fileIdStr);
    headerBuffer.set(idEncoded);

    function sliceAndSend() {
      while (offset < encryptedBuffer.byteLength) {
        // Check buffers on all data channels for backpressure throttling
        let isWaiting = false;
        Object.keys(state.dataChannels).forEach(socketId => {
          if (state.dataChannels[socketId].bufferedAmount > 65536) {
            isWaiting = true;
          }
        });

        if (isWaiting) {
          setTimeout(sliceAndSend, 50); // check again in 50ms
          return;
        }

        const payloadSize = Math.min(CHUNK_SIZE, encryptedBuffer.byteLength - offset);
        const packet = new Uint8Array(16 + payloadSize);
        packet.set(headerBuffer, 0);
        packet.set(new Uint8Array(encryptedBuffer, offset, payloadSize), 16);

        // Send to all peers
        Object.keys(state.dataChannels).forEach(socketId => {
          const channel = state.dataChannels[socketId];
          if (channel && channel.readyState === 'open') {
            channel.send(packet.buffer);
          }
        });

        offset += payloadSize;
        const progress = Math.round((offset / encryptedBuffer.byteLength) * 100);
        updateProgressUI(fileIdStr, progress);
      }

      // Finish signaling
      const finishSignal = JSON.stringify({ type: 'file-end', fileId: fileIdStr });
      Object.keys(state.dataChannels).forEach(socketId => {
        const channel = state.dataChannels[socketId];
        if (channel && channel.readyState === 'open') {
          channel.send(finishSignal);
        }
      });
      
      updateProgressUI(fileIdStr, 100, 'Completed');
    }

    sliceAndSend();
  }

  async function finalizeFileReceive(fileId) {
    const transfer = state.incomingTransfers[fileId];
    if (!transfer) return;

    try {
      // Reassemble chunks
      const blobChunks = transfer.chunks;
      const totalLength = blobChunks.reduce((acc, val) => acc + val.byteLength, 0);
      const combinedBuffer = new Uint8Array(totalLength);
      
      let pos = 0;
      for (const chunk of blobChunks) {
        combinedBuffer.set(new Uint8Array(chunk), pos);
        pos += chunk.byteLength;
      }

      // Decrypt reassembled buffer
      const iv = new Uint8Array(CryptoHelper.base64ToBuffer(transfer.metadata.iv));
      const decryptedBuffer = await CryptoHelper.decryptBuffer(combinedBuffer.buffer, iv, state.cryptoKey);

      // Save blob and trigger download link in UI
      const decryptedBlob = new Blob([decryptedBuffer], { type: transfer.metadata.fileType });
      const downloadUrl = URL.createObjectURL(decryptedBlob);

      updateProgressUI(fileId, 100, 'Ready');
      appendDownloadLink(fileId, downloadUrl, transfer.metadata.fileName);

      showToastNotification(`Received file: ${transfer.metadata.fileName}`);
    } catch (err) {
      console.error('File reassembly/decryption failed', err);
      updateProgressUI(fileId, 0, 'Failed');
    }
  }

  // --- FILE TRANSFER UI INTERACTION ---
  function createTransferCardUI(fileId, fileName, fileSize, isIncoming) {
    // Clean empty state if present
    const emptyState = dom.transfersList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const formattedSize = formatBytes(fileSize);
    const card = document.createElement('div');
    card.id = `transfer-${fileId}`;
    card.className = 'transfer-card';
    card.innerHTML = `
      <div class="transfer-info">
        <div class="file-details">
          <i class="fa-regular fa-file"></i>
          <div>
            <div class="file-name" title="${escapeHTML(fileName)}">${escapeHTML(fileName)}</div>
            <div class="file-size">${formattedSize}</div>
          </div>
        </div>
        <span class="transfer-status ${isIncoming ? 'incoming' : 'outgoing'}">
          ${isIncoming ? 'Receiving...' : 'Sending...'}
        </span>
      </div>
      <div class="progress-bar-wrapper">
        <div class="progress-fill" id="progress-fill-${fileId}"></div>
      </div>
      <div class="transfer-actions" id="actions-${fileId}"></div>
    `;

    dom.transfersList.appendChild(card);
  }

  function updateProgressUI(fileId, percent, statusOverride = null) {
    const fill = document.getElementById(`progress-fill-${fileId}`);
    if (fill) {
      fill.style.width = `${percent}%`;
    }

    const card = document.getElementById(`transfer-${fileId}`);
    if (card && statusOverride) {
      const statusEl = card.querySelector('.transfer-status');
      statusEl.textContent = statusOverride;
      statusEl.className = 'transfer-status completed';
      if (statusOverride === 'Failed') statusEl.style.color = 'var(--text-red)';
    }
  }

  function appendDownloadLink(fileId, url, fileName) {
    const actionsContainer = document.getElementById(`actions-${fileId}`);
    if (actionsContainer) {
      actionsContainer.innerHTML = `
        <a href="${url}" download="${fileName}" class="download-link">
          <i class="fa-solid fa-cloud-arrow-down"></i>
          <span>Save File</span>
        </a>
      `;
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // --- COLLABORATIVE WHITEBOARD LOGIC ---
  function setupWhiteboard() {
    whiteboard.canvas = dom.whiteboardCanvas;
    whiteboard.ctx = whiteboard.canvas.getContext('2d');
    
    // Canvas Mouse draw controls
    whiteboard.canvas.addEventListener('mousedown', startDrawing);
    whiteboard.canvas.addEventListener('mousemove', drawStroke);
    whiteboard.canvas.addEventListener('mouseup', stopDrawing);
    whiteboard.canvas.addEventListener('mouseout', stopDrawing);
    
    // Remote coordinate mouse cursor tracking
    whiteboard.canvas.addEventListener('mousemove', emitCursorCoordinates);

    // Color Swatch buttons selection
    const swatches = document.querySelectorAll('.color-swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', (e) => {
        swatches.forEach(s => s.classList.remove('active'));
        e.target.classList.add('active');
        whiteboard.color = e.target.getAttribute('data-color');
        whiteboard.isEraser = false;
        dom.eraserBtn.classList.remove('active');
      });
    });

    // Brush Size range input
    dom.brushSizeInput.addEventListener('input', (e) => {
      whiteboard.size = e.target.value;
    });

    // Eraser toggle
    dom.eraserBtn.addEventListener('click', () => {
      whiteboard.isEraser = !whiteboard.isEraser;
      dom.eraserBtn.classList.toggle('active', whiteboard.isEraser);
    });

    // Clear board action
    dom.clearBoardBtn.addEventListener('click', () => {
      if (state.socket) {
        state.socket.emit('clear-whiteboard', state.roomCode);
      }
    });
  }

  function resizeCanvas() {
    const rect = whiteboard.canvas.parentElement.getBoundingClientRect();
    // Save current drawing buffer
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = whiteboard.canvas.width;
    tempCanvas.height = whiteboard.canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(whiteboard.canvas, 0, 0);

    // Resize canvas pixels
    whiteboard.canvas.width = rect.width;
    whiteboard.canvas.height = rect.height;

    // Redraw backup buffer
    whiteboard.ctx.drawImage(tempCanvas, 0, 0, rect.width, rect.height);
    
    // Set board drawing context variables defaults
    whiteboard.ctx.lineCap = 'round';
    whiteboard.ctx.lineJoin = 'round';
  }

  function startDrawing(e) {
    const { x, y } = getMousePositionOnCanvas(e);
    
    // For text tool, click spawns text input
    if (whiteboard.tool === 'text') {
      spawnTextInput(x, y);
      return;
    }

    whiteboard.drawing = true;
    whiteboard.lastX = x;
    whiteboard.lastY = y;
    
    // If shape drawing, capture a snapshot of current canvas state
    if (['line', 'rect', 'circle'].includes(whiteboard.tool)) {
      whiteboard.snapshot = whiteboard.ctx.getImageData(0, 0, whiteboard.canvas.width, whiteboard.canvas.height);
      whiteboard.startX = x;
      whiteboard.startY = y;
    }
  }

  function stopDrawing(e) {
    if (!whiteboard.drawing) return;
    
    const { x, y } = getMousePositionOnCanvas(e);
    
    // If final shape drawn, broadcast payload
    if (['line', 'rect', 'circle'].includes(whiteboard.tool)) {
      const stroke = {
        type: 'shape',
        shape: whiteboard.tool,
        x0: whiteboard.startX,
        y0: whiteboard.startY,
        x1: x,
        y1: y,
        color: whiteboard.color,
        size: whiteboard.size
      };
      
      // Sync to signaling server
      if (state.socket) {
        state.socket.emit('draw', {
          roomCode: state.roomCode,
          stroke: stroke
        });
      }
    }

    whiteboard.drawing = false;
    whiteboard.snapshot = null;
  }

  function drawStroke(e) {
    if (!whiteboard.drawing) return;
    
    const { x, y } = getMousePositionOnCanvas(e);

    // Brush freehand drawing
    if (whiteboard.tool === 'brush' || whiteboard.isEraser) {
      const stroke = {
        type: 'brush',
        x0: whiteboard.lastX,
        y0: whiteboard.lastY,
        x1: x,
        y1: y,
        color: whiteboard.isEraser ? '#11121d' : whiteboard.color,
        size: whiteboard.isEraser ? 20 : whiteboard.size
      };

      // Draw locally
      drawStrokeOnCanvas(stroke);

      // Emit to other peers via signaling server
      if (state.socket) {
        state.socket.emit('draw', {
          roomCode: state.roomCode,
          stroke: stroke
        });
      }

      whiteboard.lastX = x;
      whiteboard.lastY = y;
    } 
    // Shape preview overlay drawing
    else if (['line', 'rect', 'circle'].includes(whiteboard.tool)) {
      // Restore previous clean snapshot
      whiteboard.ctx.putImageData(whiteboard.snapshot, 0, 0);
      
      const stroke = {
        shape: whiteboard.tool,
        x0: whiteboard.startX,
        y0: whiteboard.startY,
        x1: x,
        y1: y,
        color: whiteboard.color,
        size: whiteboard.size
      };
      
      drawShape(stroke);
    }
  }

  function drawStrokeOnCanvas(stroke) {
    whiteboard.ctx.strokeStyle = stroke.color;
    whiteboard.ctx.lineWidth = stroke.size;
    whiteboard.ctx.beginPath();
    whiteboard.ctx.moveTo(stroke.x0, stroke.y0);
    whiteboard.ctx.lineTo(stroke.x1, stroke.y1);
    whiteboard.ctx.stroke();
  }

  function drawShape(stroke) {
    whiteboard.ctx.strokeStyle = stroke.color;
    whiteboard.ctx.lineWidth = stroke.size;
    whiteboard.ctx.beginPath();
    
    if (stroke.shape === 'line') {
      whiteboard.ctx.moveTo(stroke.x0, stroke.y0);
      whiteboard.ctx.lineTo(stroke.x1, stroke.y1);
    } else if (stroke.shape === 'rect') {
      const width = stroke.x1 - stroke.x0;
      const height = stroke.y1 - stroke.y0;
      whiteboard.ctx.strokeRect(stroke.x0, stroke.y0, width, height);
    } else if (stroke.shape === 'circle') {
      const radius = Math.sqrt(Math.pow(stroke.x1 - stroke.x0, 2) + Math.pow(stroke.y1 - stroke.y0, 2));
      whiteboard.ctx.arc(stroke.x0, stroke.y0, radius, 0, 2 * Math.PI);
    }
    whiteboard.ctx.stroke();
  }

  function spawnTextInput(x, y) {
    if (document.getElementById('temp-canvas-text-input')) return;
    
    const input = document.createElement('input');
    input.id = 'temp-canvas-text-input';
    input.type = 'text';
    input.style.position = 'absolute';
    input.style.left = `${x + whiteboard.canvas.offsetLeft}px`;
    input.style.top = `${y + whiteboard.canvas.offsetTop}px`;
    input.style.background = 'rgba(0,0,0,0.85)';
    input.style.color = whiteboard.color;
    input.style.border = '1px solid var(--primary)';
    input.style.borderRadius = '4px';
    input.style.padding = '4px';
    input.style.fontFamily = 'var(--font-body)';
    input.style.fontSize = `${whiteboard.size * 2 + 12}px`;
    input.style.zIndex = '1000';
    input.style.outline = 'none';
    
    whiteboard.canvas.parentElement.appendChild(input);
    input.focus();
    
    function submitText() {
      const textVal = input.value.trim();
      if (textVal) {
        const textStroke = {
          type: 'text',
          text: textVal,
          x: x,
          y: y + (whiteboard.size * 2 + 10), // offset for height
          color: whiteboard.color,
          size: whiteboard.size * 2 + 12
        };
        
        drawTextOnCanvas(textStroke);
        if (state.socket) {
          state.socket.emit('draw', {
            roomCode: state.roomCode,
            stroke: textStroke
          });
        }
      }
      input.remove();
    }
    
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        submitText();
      }
    });
    
    input.addEventListener('blur', submitText);
  }

  function drawTextOnCanvas(stroke) {
    whiteboard.ctx.fillStyle = stroke.color;
    whiteboard.ctx.font = `${stroke.size}px Outfit, sans-serif`;
    whiteboard.ctx.fillText(stroke.text, stroke.x, stroke.y);
  }

  function drawRemoteStroke(stroke) {
    if (stroke.type === 'shape') {
      drawShape(stroke);
    } else if (stroke.type === 'text') {
      drawTextOnCanvas(stroke);
    } else {
      drawStrokeOnCanvas(stroke);
    }
  }

  function clearLocalCanvas() {
    whiteboard.ctx.clearRect(0, 0, whiteboard.canvas.width, whiteboard.canvas.height);
  }

  // Get mouse coordinates relative to canvas positioning
  function getMousePositionOnCanvas(e) {
    const rect = whiteboard.canvas.getBoundingClientRect();
    // Support mouse and responsive scaling touch events if necessary
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  // Emit cursor coordinates for remote pointer overlays
  function emitCursorCoordinates(e) {
    if (!state.socket || !state.roomCode) return;
    const { x, y } = getMousePositionOnCanvas(e);
    state.socket.emit('cursor-move', {
      roomCode: state.roomCode,
      username: state.username,
      x,
      y
    });
  }

  // Render or update remote client cursor pointers
  function updateRemoteCursor(socketId, username, x, y) {
    let cursor = document.getElementById(`cursor-${socketId}`);
    
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = `cursor-${socketId}`;
      cursor.className = 'canvas-cursor';
      cursor.innerHTML = `
        <i class="fa-solid fa-location-arrow cursor-pointer"></i>
        <span class="cursor-label">${escapeHTML(username)}</span>
      `;
      dom.cursorsContainer.appendChild(cursor);
    }
    
    // Position cursor pointer matching client positioning
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
  }

  // --- LEAVE MEETING DISCONNECT ---
  function leaveMeeting() {
    if (confirm('Are you sure you want to leave the workspace session?')) {
      cleanupMeetingSession();
      showView('dashboardView');
    }
  }

  function cleanupMeetingSession() {
    stopScreenSharing();
    stopLatencyMonitor();
    toggleSettingsPanel(false);
    
    // Stop local media
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => track.stop());
      state.localStream = null;
    }

    // Disconnect active peers connections
    Object.keys(state.peerConnections).forEach(socketId => {
      handlePeerDisconnect(socketId);
    });

    // Close socket
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    // Clean video containers
    const remoteWrappers = dom.videoGridContainer.querySelectorAll('.remote-video-wrapper');
    remoteWrappers.forEach(w => w.remove());
    adjustVideoGridClass();

    // Clear variables
    state.roomCode = null;
    state.roomPassword = null;
    state.cryptoKey = null;
    state.participants = {};
    dom.chatMessages.innerHTML = `
      <div class="system-message">
        <i class="fa-solid fa-lock"></i> All text and file communication is encrypted end-to-end client-side. The server cannot inspect or save your content.
      </div>
    `;
    dom.transfersList.innerHTML = `<div class="empty-state">No file transfers yet. Click above to send a file to the room.</div>`;
    clearLocalCanvas();
  }

  // --- TOGGLE PANELS VISIBILITY ---
  function toggleChatSidebar(forceState = null) {
    const isVisible = forceState !== null ? !forceState : dom.sidebarPanel.classList.contains('active-panel');
    
    if (isVisible) {
      // Hide
      dom.sidebarPanel.classList.remove('active-panel');
      dom.sidebarPanel.classList.add('hidden');
      dom.toggleChatBtn.classList.remove('active');
    } else {
      // Show
      dom.sidebarPanel.classList.remove('hidden');
      dom.sidebarPanel.classList.add('active-panel');
      dom.toggleChatBtn.classList.add('active');
      dom.chatBadge.classList.add('hidden'); // Clear notifications badge
    }
  }

  function toggleWhiteboardPanel(forceState = null) {
    const isVisible = forceState !== null ? !forceState : dom.whiteboardContainer.classList.contains('hidden');
    
    if (isVisible) {
      // Show
      dom.whiteboardContainer.classList.remove('hidden');
      dom.toggleWhiteboardBtn.classList.add('active');
      resizeCanvas();
    } else {
      // Hide
      dom.whiteboardContainer.classList.add('hidden');
      dom.toggleWhiteboardBtn.classList.remove('active');
    }
  }

  // --- TOAST NOTIFICATION AND UTIL CHIPS ---
  function showToastNotification(text) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${text}`;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('show');
    }, 100);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function copyRoomCode() {
    if (!state.roomCode) return;
    navigator.clipboard.writeText(state.roomCode).then(() => {
      showToastNotification('Room code copied to clipboard!');
    });
  }

  function copyInviteLink() {
    if (!state.roomCode) return;
    const inviteLink = `${window.location.origin}?room=${state.roomCode}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
      showToastNotification('Secure Invite Link copied to clipboard!');
    });
  }

  function toggleEmojiDrawer(forceState = null) {
    const isVisible = forceState !== null ? !forceState : dom.emojiDrawer.classList.contains('hidden');
    if (isVisible) {
      dom.emojiDrawer.classList.remove('hidden');
      dom.emojiToggleBtn.classList.add('active');
    } else {
      dom.emojiDrawer.classList.add('hidden');
      dom.emojiToggleBtn.classList.remove('active');
    }
  }

  function handleChatInputTyping() {
    if (!state.socket || !state.roomCode) return;
    
    if (!state.typingTimeout) {
      state.socket.emit('typing-start', {
        roomCode: state.roomCode,
        username: state.username
      });
    } else {
      clearTimeout(state.typingTimeout);
    }
    
    state.typingTimeout = setTimeout(() => {
      state.socket.emit('typing-stop', {
        roomCode: state.roomCode,
        username: state.username
      });
      state.typingTimeout = null;
    }, 2000);
  }

  function toggleSettingsPanel(forceState = null) {
    const isVisible = forceState !== null ? !forceState : dom.mediaSettingsPanel.classList.contains('hidden');
    if (isVisible) {
      dom.mediaSettingsPanel.classList.remove('hidden');
      dom.settingsToggleBtn.classList.add('active');
      populateDeviceSelectors();
    } else {
      dom.mediaSettingsPanel.classList.add('hidden');
      dom.settingsToggleBtn.classList.remove('active');
    }
  }

  async function populateDeviceSelectors() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      dom.cameraSelect.innerHTML = '';
      dom.micSelect.innerHTML = '';
      
      let videoCount = 0;
      let audioCount = 0;
      
      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        
        if (device.kind === 'videoinput') {
          videoCount++;
          option.text = device.label || `Camera ${videoCount}`;
          if (state.localStream) {
            const activeVideoTrack = state.localStream.getVideoTracks()[0];
            if (activeVideoTrack && activeVideoTrack.label === device.label) {
              option.selected = true;
              state.activeCameraId = device.deviceId;
            }
          }
          dom.cameraSelect.appendChild(option);
        } else if (device.kind === 'audioinput') {
          audioCount++;
          option.text = device.label || `Microphone ${audioCount}`;
          if (state.localStream) {
            const activeAudioTrack = state.localStream.getAudioTracks()[0];
            if (activeAudioTrack && activeAudioTrack.label === device.label) {
              option.selected = true;
              state.activeMicId = device.deviceId;
            }
          }
          dom.micSelect.appendChild(option);
        }
      });
      
      if (videoCount === 0) {
        dom.cameraSelect.innerHTML = '<option value="">No camera detected</option>';
      }
      if (audioCount === 0) {
        dom.micSelect.innerHTML = '<option value="">No microphone detected</option>';
      }
    } catch (err) {
      console.error("Error listing media devices", err);
    }
  }

  async function switchDevice(type, deviceId) {
    if (!deviceId) return;
    try {
      const constraints = {
        audio: type === 'audio' ? { deviceId: { exact: deviceId } } : (state.localStream ? { deviceId: { exact: state.activeMicId } } : false),
        video: type === 'video' ? { deviceId: { exact: deviceId } } : (state.localStream ? { deviceId: { exact: state.activeCameraId } } : false)
      };
      
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (type === 'video') {
        const oldTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
        const newTrack = newStream.getVideoTracks()[0];
        
        if (oldTrack && state.localStream) {
          state.localStream.removeTrack(oldTrack);
          oldTrack.stop();
          state.localStream.addTrack(newTrack);
        } else {
          state.localStream = newStream;
        }
        
        dom.localVideo.srcObject = state.localStream;
        state.activeCameraId = deviceId;
        
        Object.keys(state.peerConnections).forEach(socketId => {
          const sender = state.activeScreenSender[socketId];
          if (sender) {
            sender.replaceTrack(newTrack);
          } else {
            const pc = state.peerConnections[socketId];
            const newSender = pc.addTrack(newTrack, state.localStream);
            state.activeScreenSender[socketId] = newSender;
          }
        });
        showToastNotification("Switched video source.");
      } else {
        const oldTrack = state.localStream ? state.localStream.getAudioTracks()[0] : null;
        const newTrack = newStream.getAudioTracks()[0];
        
        if (oldTrack && state.localStream) {
          state.localStream.removeTrack(oldTrack);
          oldTrack.stop();
          state.localStream.addTrack(newTrack);
        } else {
          state.localStream = newStream;
        }
        
        state.activeMicId = deviceId;
        
        Object.keys(state.peerConnections).forEach(socketId => {
          const pc = state.peerConnections[socketId];
          const senders = pc.getSenders();
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (audioSender) {
            audioSender.replaceTrack(newTrack);
          } else {
            pc.addTrack(newTrack, state.localStream);
          }
        });
        showToastNotification("Switched audio source.");
      }
    } catch (err) {
      console.error("Failed to switch input device", err);
      showToastNotification("Failed to connect device.");
    }
  }

  function startLatencyMonitor() {
    state.pingInterval = setInterval(pingAllPeers, 8000);
  }

  function stopLatencyMonitor() {
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
  }

  function pingAllPeers() {
    if (!state.socket || Object.keys(state.peerConnections).length === 0) return;
    
    Object.keys(state.peerConnections).forEach(socketId => {
      state.remotePings[socketId] = Date.now();
      state.socket.emit('ping-peer', { targetSocketId: socketId });
    });
  }

  function handlePong(senderSocketId) {
    const sentTime = state.remotePings[senderSocketId];
    if (sentTime) {
      const rtt = Date.now() - sentTime;
      const latency = Math.round(rtt / 2);
      
      updateLatencyUI(senderSocketId, latency);
      delete state.remotePings[senderSocketId];
    }
  }

  function updateLatencyUI(socketId, latency) {
    const el = document.getElementById(`latency-${socketId}`);
    if (el) {
      el.innerHTML = `<i class="fa-solid fa-signal"></i> ${latency} ms`;
      el.className = 'latency-indicator';
      
      if (latency > 250) {
        el.classList.add('poor');
      } else if (latency > 100) {
        el.classList.add('medium');
      }
    }
  }

  // XSS protection
  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }

  // DOMContentLoaded loader
  document.addEventListener('DOMContentLoaded', init);

  return {
    init
  };
})();
