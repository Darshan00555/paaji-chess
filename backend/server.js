const http = require("http");
const net = require("net");
const express = require("express");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_MS = 30 * 60 * 1000;
const CHAT_THROTTLE_MS = 400;

const games = new Map();
const socketRegistry = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    methods: ["GET", "POST"],
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
  },
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    activeRooms: games.size,
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => {
  res.status(200).json({
    service: "paaji-chess-backend",
    socketPath: "/socket.io",
    health: "/health",
  });
});

function colorLabel(color) {
  return color === "w" ? "White" : "Black";
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRoomCode(roomCode) {
  if (typeof roomCode !== "string") {
    return "";
  }

  return roomCode.trim().toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

function sanitizeName(value) {
  if (typeof value !== "string") {
    return "";
  }

  const cleaned = value.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 24);
}

function sanitizeMessage(value, maxLength = 180) {
  if (typeof value !== "string") {
    return "";
  }

  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength);
}

function isValidSquare(square) {
  return typeof square === "string" && /^[a-h][1-8]$/.test(square);
}

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[randomIndex];
  }
  return code;
}

function createUniqueRoomCode() {
  let attempts = 0;
  while (attempts < 2000) {
    const roomCode = randomRoomCode();
    if (!games.has(roomCode)) {
      return roomCode;
    }
    attempts += 1;
  }

  throw new Error("Unable to allocate room code");
}

function createGame(roomCode, hostSocketId, hostName) {
  return {
    code: roomCode,
    chess: new Chess(),
    players: {
      white: {
        id: hostSocketId,
        name: hostName,
      },
      black: null,
    },
    spectators: new Set(),
    chat: [],
    rematchVotes: new Set(),
    forcedResult: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    emptySince: null,
  };
}

function pushChat(game, author, message, system = false) {
  const safeMessage = sanitizeMessage(message, 220);
  if (!safeMessage) {
    return;
  }

  game.chat.push({
    id: generateId(),
    author,
    message: safeMessage,
    system,
    timestamp: new Date().toISOString(),
  });

  if (game.chat.length > 120) {
    game.chat.shift();
  }

  game.updatedAt = Date.now();
}

function serializePlayer(slot) {
  if (!slot) {
    return null;
  }

  return {
    name: slot.name,
    connected: Boolean(slot.id),
  };
}

function computeCaptured(history) {
  const captured = {
    white: [],
    black: [],
  };

  for (const move of history) {
    if (!move.captured) {
      continue;
    }

    if (move.color === "w") {
      captured.white.push(move.captured);
    } else {
      captured.black.push(move.captured);
    }
  }

  return captured;
}

function buildTimeline(history) {
  const replay = new Chess();
  const timeline = [replay.fen()];

  for (const move of history) {
    if (!move || !move.san) {
      continue;
    }

    try {
      replay.move(move.san);
      timeline.push(replay.fen());
    } catch {
      break;
    }
  }

  return timeline;
}

function getGameStatus(game) {
  if (game.forcedResult) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: false,
      winner: game.forcedResult.winner,
      reason: game.forcedResult.reason,
    };
  }

  if (game.chess.isCheckmate()) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: true,
      winner: game.chess.turn() === "w" ? "b" : "w",
      reason: "checkmate",
    };
  }

  if (game.chess.isStalemate()) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: false,
      winner: null,
      reason: "stalemate",
    };
  }

  if (game.chess.isInsufficientMaterial()) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: false,
      winner: null,
      reason: "insufficient-material",
    };
  }

  if (game.chess.isThreefoldRepetition()) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: false,
      winner: null,
      reason: "threefold-repetition",
    };
  }

  if (game.chess.isDraw()) {
    return {
      state: "over",
      turn: game.chess.turn(),
      check: false,
      winner: null,
      reason: "draw",
    };
  }

  return {
    state: "active",
    turn: game.chess.turn(),
    check: game.chess.isCheck(),
    winner: null,
    reason: null,
  };
}

function buildGameState(game) {
  const verboseHistory = game.chess.history({ verbose: true });
  const timeline = buildTimeline(verboseHistory);
  const status = getGameStatus(game);

  return {
    roomCode: game.code,
    fen: game.chess.fen(),
    startFen: timeline[0] || game.chess.fen(),
    pgn: game.chess.pgn(),
    players: {
      white: serializePlayer(game.players.white),
      black: serializePlayer(game.players.black),
    },
    spectators: game.spectators.size,
    history: verboseHistory.map((move, index) => ({
      id: index + 1,
      ply: index + 1,
      san: move.san,
      color: move.color,
      from: move.from,
      to: move.to,
      piece: move.piece,
      captured: move.captured || null,
      promotion: move.promotion || null,
      flags: move.flags,
      fen: timeline[index + 1] || null,
    })),
    timeline,
    captured: computeCaptured(verboseHistory),
    chat: game.chat.slice(-80),
    status,
    rematchVotes: Array.from(game.rematchVotes),
    updatedAt: game.updatedAt,
  };
}

function emitGameState(game) {
  io.to(game.code).emit("game-state", buildGameState(game));
}

function isGameOver(game) {
  return getGameStatus(game).state === "over";
}

function pickSeatForJoin(game, playerName) {
  const name = playerName.toLowerCase();

  if (game.players.white && !game.players.white.id && game.players.white.name.toLowerCase() === name) {
    return "w";
  }

  if (game.players.black && !game.players.black.id && game.players.black.name.toLowerCase() === name) {
    return "b";
  }

  if (!game.players.white || !game.players.white.id) {
    return "w";
  }

  if (!game.players.black || !game.players.black.id) {
    return "b";
  }

  return null;
}

function assignPlayer(game, color, socketId, name) {
  if (color === "w") {
    game.players.white = {
      id: socketId,
      name,
    };
  } else {
    game.players.black = {
      id: socketId,
      name,
    };
  }

  game.updatedAt = Date.now();
  game.emptySince = null;
}

function releaseSocketFromGame(socket, disconnected = false) {
  const meta = socketRegistry.get(socket.id);
  if (!meta) {
    return;
  }

  socketRegistry.delete(socket.id);

  const game = games.get(meta.roomCode);
  if (!game) {
    return;
  }

  if (meta.role === "player" && meta.color) {
    const slot = meta.color === "w" ? "white" : "black";
    if (game.players[slot] && game.players[slot].id === socket.id) {
      game.players[slot].id = null;
    }
  } else {
    game.spectators.delete(socket.id);
  }

  if (!disconnected) {
    socket.leave(meta.roomCode);
  }

  game.rematchVotes.delete(meta.color);
  pushChat(game, "System", `${meta.name} ${disconnected ? "disconnected" : "left the room"}.`, true);

  const hasConnectedPlayers =
    (game.players.white && game.players.white.id) || (game.players.black && game.players.black.id);
  const hasSpectators = game.spectators.size > 0;

  if (!hasConnectedPlayers && !hasSpectators) {
    game.emptySince = Date.now();
  }

  emitGameState(game);
}

function getMetaAndGame(socket) {
  const meta = socketRegistry.get(socket.id);
  if (!meta) {
    return {};
  }

  const game = games.get(meta.roomCode);
  if (!game) {
    socketRegistry.delete(socket.id);
    return {};
  }

  return { meta, game };
}

function legalMovesForSquare(game, square) {
  const moves = game.chess.moves({ square, verbose: true });
  const grouped = new Map();

  for (const move of moves) {
    const current = grouped.get(move.to) || {
      to: move.to,
      capture: Boolean(move.captured),
      promotions: [],
    };

    current.capture = current.capture || Boolean(move.captured);

    if (move.promotion && !current.promotions.includes(move.promotion)) {
      current.promotions.push(move.promotion);
    }

    grouped.set(move.to, current);
  }

  return Array.from(grouped.values());
}

io.on("connection", (socket) => {
  socket.emit("connected", {
    socketId: socket.id,
    serverTime: new Date().toISOString(),
  });

  socket.on("create-room", (payload = {}) => {
    if (socketRegistry.has(socket.id)) {
      socket.emit("error-message", { message: "You are already in a room." });
      return;
    }

    const playerName = sanitizeName(payload.name) || `Paaji${Math.floor(Math.random() * 900 + 100)}`;

    let roomCode = "";
    try {
      roomCode = createUniqueRoomCode();
    } catch {
      socket.emit("error-message", { message: "Room allocation failed. Try again." });
      return;
    }

    const game = createGame(roomCode, socket.id, playerName);
    pushChat(game, "System", `${playerName} created room ${roomCode}. Share it with your dost.`, true);
    games.set(roomCode, game);

    socket.join(roomCode);
    socketRegistry.set(socket.id, {
      roomCode,
      role: "player",
      color: "w",
      name: playerName,
      lastChatAt: 0,
    });

    socket.emit("room-joined", {
      roomCode,
      role: "player",
      color: "w",
      name: playerName,
    });

    emitGameState(game);
  });

  socket.on("join-room", (payload = {}) => {
    if (socketRegistry.has(socket.id)) {
      socket.emit("error-message", { message: "You are already in a room." });
      return;
    }

    const roomCode = normalizeRoomCode(payload.roomCode);
    const playerName = sanitizeName(payload.name) || `Paaji${Math.floor(Math.random() * 900 + 100)}`;

    if (!roomCode) {
      socket.emit("error-message", { message: "Enter a valid room code." });
      return;
    }

    const game = games.get(roomCode);
    if (!game) {
      socket.emit("error-message", {
        message: `Room ${roomCode} not found.`,
        clearSession: true,
      });
      return;
    }

    const seat = pickSeatForJoin(game, playerName);
    let role = "spectator";
    let color = null;

    if (seat) {
      role = "player";
      color = seat;
      assignPlayer(game, seat, socket.id, playerName);
      pushChat(game, "System", `${playerName} joined as ${colorLabel(seat)}.`, true);
    } else {
      game.spectators.add(socket.id);
      game.updatedAt = Date.now();
      game.emptySince = null;
      pushChat(game, "System", `${playerName} joined as spectator.`, true);
    }

    socket.join(roomCode);
    socketRegistry.set(socket.id, {
      roomCode,
      role,
      color,
      name: playerName,
      lastChatAt: 0,
    });

    socket.emit("room-joined", {
      roomCode,
      role,
      color,
      name: playerName,
    });

    emitGameState(game);
  });

  socket.on("request-legal-moves", (payload = {}) => {
    const { meta, game } = getMetaAndGame(socket);
    if (!meta || !game) {
      return;
    }

    const square = typeof payload.square === "string" ? payload.square : "";
    if (!isValidSquare(square)) {
      socket.emit("legal-moves", { square, moves: [] });
      return;
    }

    if (meta.role !== "player" || !meta.color || isGameOver(game) || game.chess.turn() !== meta.color) {
      socket.emit("legal-moves", { square, moves: [] });
      return;
    }

    const piece = game.chess.get(square);
    if (!piece || piece.color !== meta.color) {
      socket.emit("legal-moves", { square, moves: [] });
      return;
    }

    socket.emit("legal-moves", {
      square,
      moves: legalMovesForSquare(game, square),
    });
  });

  socket.on("make-move", (payload = {}) => {
    const { meta, game } = getMetaAndGame(socket);
    if (!meta || !game) {
      return;
    }

    if (meta.role !== "player" || !meta.color) {
      socket.emit("error-message", { message: "Spectators cannot make moves." });
      return;
    }

    if (isGameOver(game)) {
      socket.emit("error-message", { message: "Game is already over." });
      return;
    }

    if (game.chess.turn() !== meta.color) {
      socket.emit("error-message", { message: "Wait for your turn." });
      return;
    }

    const from = typeof payload.from === "string" ? payload.from : "";
    const to = typeof payload.to === "string" ? payload.to : "";
    const promotion = typeof payload.promotion === "string" ? payload.promotion.toLowerCase() : "q";

    if (!isValidSquare(from) || !isValidSquare(to)) {
      socket.emit("error-message", { message: "Invalid move coordinates." });
      return;
    }

    const movingPiece = game.chess.get(from);
    if (!movingPiece || movingPiece.color !== meta.color) {
      socket.emit("error-message", { message: "Select your own piece." });
      return;
    }

    let moveResult = null;
    try {
      moveResult = game.chess.move({
        from,
        to,
        promotion: ["q", "r", "b", "n"].includes(promotion) ? promotion : "q",
      });
    } catch {
      moveResult = null;
    }

    if (!moveResult) {
      socket.emit("error-message", { message: "Illegal move." });
      return;
    }

    game.updatedAt = Date.now();
    game.rematchVotes.clear();

    const status = getGameStatus(game);
    if (status.state === "over") {
      if (status.winner) {
        pushChat(game, "System", `${colorLabel(status.winner)} wins by ${status.reason}.`, true);
      } else {
        pushChat(game, "System", `Game drawn (${status.reason}).`, true);
      }
    } else if (status.check) {
      pushChat(game, "System", `${colorLabel(status.turn)} king is in check.`, true);
    }

    emitGameState(game);
  });

  socket.on("send-chat", (payload = {}) => {
    const { meta, game } = getMetaAndGame(socket);
    if (!meta || !game) {
      return;
    }

    const now = Date.now();
    if (now - (meta.lastChatAt || 0) < CHAT_THROTTLE_MS) {
      socket.emit("error-message", { message: "Slow down. Please wait before sending next message." });
      return;
    }

    const message = sanitizeMessage(payload.message);
    if (!message) {
      return;
    }

    meta.lastChatAt = now;
    pushChat(game, meta.name, message, false);
    emitGameState(game);
  });

  socket.on("resign", () => {
    const { meta, game } = getMetaAndGame(socket);
    if (!meta || !game) {
      return;
    }

    if (meta.role !== "player" || !meta.color) {
      socket.emit("error-message", { message: "Only players can resign." });
      return;
    }

    if (isGameOver(game)) {
      socket.emit("error-message", { message: "Game is already over." });
      return;
    }

    const winner = meta.color === "w" ? "b" : "w";
    game.forcedResult = {
      winner,
      reason: "resignation",
    };
    game.updatedAt = Date.now();
    game.rematchVotes.clear();

    pushChat(game, "System", `${meta.name} resigned. ${colorLabel(winner)} wins.`, true);
    emitGameState(game);
  });

  socket.on("request-rematch", () => {
    const { meta, game } = getMetaAndGame(socket);
    if (!meta || !game) {
      return;
    }

    if (meta.role !== "player" || !meta.color) {
      socket.emit("error-message", { message: "Only players can request rematch." });
      return;
    }

    if (!isGameOver(game)) {
      socket.emit("error-message", { message: "Rematch is available after game over." });
      return;
    }

    game.rematchVotes.add(meta.color);
    game.updatedAt = Date.now();

    const hasWhiteVote = game.rematchVotes.has("w");
    const hasBlackVote = game.rematchVotes.has("b");

    if (hasWhiteVote && hasBlackVote) {
      game.chess = new Chess();
      game.forcedResult = null;
      game.rematchVotes.clear();
      game.updatedAt = Date.now();
      pushChat(game, "System", "Rematch started. Fresh board loaded.", true);
    } else {
      pushChat(game, "System", `${meta.name} requested a rematch.`, true);
    }

    emitGameState(game);
  });

  socket.on("leave-room", () => {
    releaseSocketFromGame(socket, false);
  });

  socket.on("disconnect", () => {
    releaseSocketFromGame(socket, true);
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [roomCode, game] of games.entries()) {
    const hasConnectedPlayers =
      (game.players.white && game.players.white.id) || (game.players.black && game.players.black.id);
    const hasSpectators = game.spectators.size > 0;

    if (hasConnectedPlayers || hasSpectators) {
      game.emptySince = null;
      continue;
    }

    const emptySince = game.emptySince || game.updatedAt || game.createdAt;
    if (now - emptySince > ROOM_TTL_MS) {
      games.delete(roomCode);
    }
  }
}, 60 * 1000);

let activePort = PORT;

function isPortFree(port) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();

    tester.once("error", (error) => {
      if (error && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
        resolve(false);
        return;
      }
      reject(error);
    });

    tester.once("listening", () => {
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(true);
      });
    });

    tester.listen(port);
  });
}

async function findAvailablePort(startPort, attempts) {
  let candidate = startPort;

  for (let index = 0; index < attempts; index += 1) {
    const free = await isPortFree(candidate);
    if (free) {
      return candidate;
    }
    candidate += 1;
  }

  throw new Error(`No available port found from ${startPort} after ${attempts} attempts.`);
}

async function startServer() {
  const maxAttempts = process.env.PORT ? 1 : 25;
  activePort = await findAvailablePort(PORT, maxAttempts);

  if (activePort !== PORT) {
    // eslint-disable-next-line no-console
    console.warn(`Port ${PORT} is busy. Using port ${activePort}.`);
  }

  server.listen(activePort, () => {
    // eslint-disable-next-line no-console
    console.log(`Paaji Chess running on http://localhost:${activePort}`);
  });
}

server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error("Server runtime error:", error);
  process.exit(1);
});

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Server start failed:", error);
  process.exit(1);
});
