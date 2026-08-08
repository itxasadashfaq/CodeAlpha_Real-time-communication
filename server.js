const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'rtc-collab-super-secret-key-12345';
const DB_FILE = path.join(__dirname, 'users.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Helpers
function loadUsers() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error("Error reading database file, resetting to empty array", err);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// REST Authentication Routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = loadUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: Date.now().toString(),
      username,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, username: newUser.username });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error during signup' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = loadUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: user.username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// Middleware to verify JWT for API routes (if needed in the future)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Socket.io Real-time Signaling & Collaboration
// Structure to keep track of active rooms and whiteboards
const rooms = {}; // roomCode => { participants: { socketId: username }, whiteboard: [strokes] }

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // When a user joins a room
  socket.on('join-room', ({ roomCode, username }) => {
    socket.join(roomCode);
    
    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        participants: {},
        whiteboard: []
      };
    }
    
    rooms[roomCode].participants[socket.id] = username;
    
    console.log(`${username} (${socket.id}) joined room: ${roomCode}`);
    
    // Tell the new user about existing participants in the room
    const otherUsers = Object.keys(rooms[roomCode].participants)
      .filter(id => id !== socket.id)
      .map(id => ({ socketId: id, username: rooms[roomCode].participants[id] }));
      
    socket.emit('room-users', otherUsers);
    
    // Send existing whiteboard drawings to the newly joined user
    socket.emit('whiteboard-history', rooms[roomCode].whiteboard);
    
    // Broadcast to other users that a new peer has joined
    socket.to(roomCode).emit('peer-joined', {
      socketId: socket.id,
      username: username
    });
  });

  // WebRTC Signaling Relay
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // Whiteboard Drawing Synchronization
  socket.on('draw', ({ roomCode, stroke }) => {
    if (rooms[roomCode]) {
      rooms[roomCode].whiteboard.push(stroke);
      // Relay stroke to all other participants
      socket.to(roomCode).emit('draw', stroke);
    }
  });

  socket.on('clear-whiteboard', (roomCode) => {
    if (rooms[roomCode]) {
      rooms[roomCode].whiteboard = [];
      io.in(roomCode).emit('clear-whiteboard');
    }
  });

  // Chat Message synchronization (Relay E2EE messages)
  socket.on('chat-message-encrypted', ({ roomCode, sender, encryptedPayload }) => {
    if (rooms[roomCode]) {
      socket.to(roomCode).emit('chat-message-encrypted', { sender, encryptedPayload });
    }
  });

  // Cursor movements sync (for real-time mouse collaboration on canvas/whiteboard)
  socket.on('cursor-move', ({ roomCode, x, y, username }) => {
    socket.to(roomCode).emit('cursor-move', {
      socketId: socket.id,
      username,
      x,
      y
    });
  });

  // Typing indicators sync
  socket.on('typing-start', ({ roomCode, username }) => {
    socket.to(roomCode).emit('typing-start', { socketId: socket.id, username });
  });

  socket.on('typing-stop', ({ roomCode, username }) => {
    socket.to(roomCode).emit('typing-stop', { socketId: socket.id, username });
  });

  // Ping-pong for latency monitor
  socket.on('ping-peer', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('ping-peer', { senderSocketId: socket.id });
  });

  socket.on('pong-peer', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('pong-peer', { senderSocketId: socket.id });
  });

  // Handle client disconnect
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    
    // Find room the user was in
    for (const roomCode in rooms) {
      if (rooms[roomCode].participants[socket.id]) {
        const username = rooms[roomCode].participants[socket.id];
        delete rooms[roomCode].participants[socket.id];
        
        console.log(`${username} left room: ${roomCode}`);
        
        // Notify others in room
        socket.to(roomCode).emit('peer-left', {
          socketId: socket.id,
          username
        });
        
        // If room is empty, optionally clear it (or keep whiteboard for a bit)
        if (Object.keys(rooms[roomCode].participants).length === 0) {
          delete rooms[roomCode];
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
