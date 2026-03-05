const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS_ASC = [1, 2, 3, 4, 5, 6, 7, 8];
const RANKS_DESC = [8, 7, 6, 5, 4, 3, 2, 1];
const SESSION_KEY = "paaji_chess_session_v1";
const PREFERENCES_KEY = "paaji_chess_preferences_v1";
const BOARD_THEMES = ["classic", "emerald", "royal", "carbon", "sunset"];
const PIECE_THEMES = ["classic", "ivory", "steel", "neon", "obsidian"];
const PIECE_MODES = ["3d", "2d"];

const PIECE_SYMBOLS = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

const REASON_LABELS = {
  checkmate: "checkmate",
  stalemate: "stalemate",
  "insufficient-material": "insufficient material",
  "threefold-repetition": "threefold repetition",
  draw: "draw",
  resignation: "resignation",
};

function getSocketUrl() {
  const fromWindow = typeof window.__PAAJI_SOCKET_URL__ === "string" ? window.__PAAJI_SOCKET_URL__ : "";
  const fromMeta =
    document.querySelector('meta[name="paaji-socket-url"]')?.getAttribute("content")?.trim() || "";
  const fromQuery = new URLSearchParams(window.location.search).get("socketUrl") || "";

  const candidate = fromWindow || fromMeta || fromQuery;
  return candidate.trim();
}

const socketUrl = getSocketUrl();
const socket = socketUrl ? io(socketUrl, { transports: ["websocket", "polling"] }) : io();

const state = {
  roomCode: "",
  name: "",
  role: "spectator",
  color: null,
  gameState: null,
  selectedSquare: null,
  legalMoves: [],
  boardMap: {},
  flipped: false,
  promotionContext: null,
  toastTimer: null,
  sessionRestoreAttempted: false,
  resultModalVisible: false,
  lastResultSignature: "",
  reviewPly: null,
  boardTheme: "classic",
  pieceTheme: "classic",
  pieceMode: "3d",
};

const refs = {
  appShell: document.getElementById("app-shell"),
  lobbyPanel: document.getElementById("lobby-panel"),
  gameShell: document.getElementById("game-shell"),
  nicknameInput: document.getElementById("nickname-input"),
  roomCodeInput: document.getElementById("room-code-input"),
  createRoomForm: document.getElementById("create-room-form"),
  joinRoomForm: document.getElementById("join-room-form"),
  board: document.getElementById("board"),
  roomCodeText: document.getElementById("room-code-text"),
  copyRoomBtn: document.getElementById("copy-room-btn"),
  rolePill: document.getElementById("role-pill"),
  statusText: document.getElementById("status-text"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  flipBoardBtn: document.getElementById("flip-board-btn"),
  resignBtn: document.getElementById("resign-btn"),
  rematchBtn: document.getElementById("rematch-btn"),
  boardThemeSelect: document.getElementById("board-theme-select"),
  pieceThemeSelect: document.getElementById("piece-theme-select"),
  pieceModeSelect: document.getElementById("piece-mode-select"),
  whitePlayerName: document.getElementById("white-player-name"),
  blackPlayerName: document.getElementById("black-player-name"),
  whiteConnectionDot: document.getElementById("white-connection-dot"),
  blackConnectionDot: document.getElementById("black-connection-dot"),
  turnHint: document.getElementById("turn-hint"),
  whiteCaptures: document.getElementById("white-captures"),
  blackCaptures: document.getElementById("black-captures"),
  spectatorCount: document.getElementById("spectator-count"),
  movePrevBtn: document.getElementById("move-prev-btn"),
  moveNextBtn: document.getElementById("move-next-btn"),
  moveLiveBtn: document.getElementById("move-live-btn"),
  moveReviewText: document.getElementById("move-review-text"),
  moveList: document.getElementById("move-list"),
  chatLog: document.getElementById("chat-log"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  promotionModal: document.getElementById("promotion-modal"),
  promotionOptions: document.getElementById("promotion-options"),
  promotionCancelBtn: document.getElementById("promotion-cancel-btn"),
  resultModal: document.getElementById("result-modal"),
  resultTitle: document.getElementById("result-title"),
  resultSummary: document.getElementById("result-summary"),
  resultDetail: document.getElementById("result-detail"),
  resultCloseBtn: document.getElementById("result-close-btn"),
  resultRematchBtn: document.getElementById("result-rematch-btn"),
  toast: document.getElementById("toast"),
};

function sanitizeName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function normalizeRoomCode(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toUpperCase().slice(0, 6);
}

function pieceColor(piece) {
  if (!piece) {
    return null;
  }

  return piece === piece.toUpperCase() ? "w" : "b";
}

function colorLabel(color) {
  return color === "w" ? "White" : "Black";
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const session = JSON.parse(raw);
    if (!session || !session.roomCode || !session.name) {
      return null;
    }
    return {
      roomCode: normalizeRoomCode(session.roomCode),
      name: sanitizeName(session.name),
    };
  } catch {
    return null;
  }
}

function writeSession() {
  if (!state.roomCode || !state.name) {
    return;
  }

  const payload = JSON.stringify({
    roomCode: state.roomCode,
    name: state.name,
  });
  localStorage.setItem(SESSION_KEY, payload);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function normalizeTheme(value, list, fallback) {
  return list.includes(value) ? value : fallback;
}

function readPreferences() {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    state.boardTheme = normalizeTheme(parsed.boardTheme, BOARD_THEMES, "classic");
    state.pieceTheme = normalizeTheme(parsed.pieceTheme, PIECE_THEMES, "classic");
    state.pieceMode = normalizeTheme(parsed.pieceMode, PIECE_MODES, "3d");
  } catch {
    state.boardTheme = "classic";
    state.pieceTheme = "classic";
    state.pieceMode = "3d";
  }
}

function writePreferences() {
  const payload = JSON.stringify({
    boardTheme: state.boardTheme,
    pieceTheme: state.pieceTheme,
    pieceMode: state.pieceMode,
  });

  localStorage.setItem(PREFERENCES_KEY, payload);
}

function applyPreferences() {
  document.body.dataset.boardTheme = state.boardTheme;
  document.body.dataset.pieceTheme = state.pieceTheme;
  document.body.dataset.pieceMode = state.pieceMode;

  if (refs.boardThemeSelect) {
    refs.boardThemeSelect.value = state.boardTheme;
  }
  if (refs.pieceThemeSelect) {
    refs.pieceThemeSelect.value = state.pieceTheme;
  }
  if (refs.pieceModeSelect) {
    refs.pieceModeSelect.value = state.pieceMode;
  }
}

function showToast(message) {
  if (!message) {
    return;
  }

  refs.toast.textContent = message;
  refs.toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    refs.toast.classList.remove("visible");
  }, 2400);
}

function activateGameUI() {
  document.body.classList.add("in-game");
}

function deactivateGameUI() {
  document.body.classList.remove("in-game");
}

function updateFullscreenButton() {
  if (!refs.fullscreenBtn) {
    return;
  }

  const supported = Boolean(document.fullscreenEnabled);
  const active = document.fullscreenElement === refs.appShell;

  refs.fullscreenBtn.disabled = !supported;
  refs.fullscreenBtn.textContent = active ? "⤫" : "⛶";
  refs.fullscreenBtn.title = active ? "Exit fullscreen" : "Enter fullscreen";
  document.body.classList.toggle("is-fullscreen", active);
}

async function toggleFullscreen() {
  if (!document.fullscreenEnabled || !refs.appShell) {
    showToast("Fullscreen is not supported on this device.");
    return;
  }

  try {
    if (document.fullscreenElement === refs.appShell) {
      await document.exitFullscreen();
      return;
    }
    await refs.appShell.requestFullscreen({ navigationUI: "hide" });
  } catch {
    showToast("Unable to toggle fullscreen.");
  }
}

function boardOrientation() {
  const natural = state.color === "b" ? "black" : "white";
  if (!state.flipped) {
    return natural;
  }
  return natural === "white" ? "black" : "white";
}

function parseFenBoard(fen) {
  const board = {};
  if (!fen) {
    return board;
  }

  const rows = fen.split(" ")[0].split("/");
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    let fileIndex = 0;
    for (const token of row) {
      const maybeNumber = Number(token);
      if (Number.isInteger(maybeNumber) && maybeNumber > 0) {
        fileIndex += maybeNumber;
        continue;
      }

      const file = FILES[fileIndex];
      const rank = 8 - rowIndex;
      board[`${file}${rank}`] = token;
      fileIndex += 1;
    }
  }
  return board;
}

function getSquareTone(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rankIndex = Number(square[1]) - 1;
  return (fileIndex + rankIndex) % 2 === 1 ? "light" : "dark";
}

function totalPlyCount() {
  return state.gameState?.history?.length ?? 0;
}

function clampReviewPly(value) {
  const total = totalPlyCount();
  if (typeof value !== "number" || Number.isNaN(value)) {
    return total;
  }
  return Math.max(0, Math.min(total, Math.floor(value)));
}

function isReviewMode() {
  if (state.reviewPly === null) {
    return false;
  }

  return clampReviewPly(state.reviewPly) !== totalPlyCount();
}

function activePly() {
  if (state.reviewPly === null) {
    return totalPlyCount();
  }

  return clampReviewPly(state.reviewPly);
}

function goLiveBoard() {
  state.reviewPly = null;
  clearSelection();
}

function openReviewPly(ply) {
  const clamped = clampReviewPly(ply);
  state.reviewPly = clamped >= totalPlyCount() ? null : clamped;
  clearSelection();
}

function previousReviewPly() {
  const total = totalPlyCount();
  if (total === 0) {
    return;
  }

  if (state.reviewPly === null) {
    openReviewPly(total - 1);
    return;
  }

  openReviewPly(Math.max(0, state.reviewPly - 1));
}

function nextReviewPly() {
  const total = totalPlyCount();
  if (total === 0) {
    return;
  }

  if (state.reviewPly === null) {
    return;
  }

  const next = state.reviewPly + 1;
  if (next >= total) {
    goLiveBoard();
    return;
  }

  openReviewPly(next);
}

function getDisplayFen() {
  if (!state.gameState) {
    return "";
  }

  const ply = activePly();
  const timeline = Array.isArray(state.gameState.timeline) ? state.gameState.timeline : [];
  return timeline[ply] || state.gameState.fen;
}

function getDisplayHistory() {
  const history = state.gameState?.history || [];
  return history.slice(0, activePly());
}

function computeCapturedFromHistory(history) {
  const captured = {
    white: [],
    black: [],
  };

  for (const move of history) {
    if (!move?.captured) {
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

function getLastMoveSquares() {
  if (!state.gameState) {
    return null;
  }

  const history = state.gameState.history || [];
  const ply = activePly();
  if (!history.length || ply <= 0) {
    return null;
  }

  const lastMove = history[ply - 1];
  if (!lastMove) {
    return null;
  }

  return {
    from: lastMove.from,
    to: lastMove.to,
  };
}

function findKingSquare(boardMap, color) {
  const kingToken = color === "w" ? "K" : "k";
  for (const [square, piece] of Object.entries(boardMap)) {
    if (piece === kingToken) {
      return square;
    }
  }
  return null;
}

function clearSelection() {
  state.selectedSquare = null;
  state.legalMoves = [];
  closePromotion();
}

function isMyTurn() {
  if (!state.gameState || !state.gameState.status || isReviewMode()) {
    return false;
  }

  return (
    state.role === "player" &&
    state.color &&
    state.gameState.status.state === "active" &&
    state.gameState.status.turn === state.color
  );
}

function requestLegalMoves(square) {
  socket.emit("request-legal-moves", { square });
}

function sendMove(from, to, promotion = "q") {
  socket.emit("make-move", {
    from,
    to,
    promotion,
  });
  clearSelection();
  renderBoard();
}

function openPromotion(move) {
  state.promotionContext = move;
  refs.promotionOptions.innerHTML = "";

  const order = ["q", "r", "b", "n"];
  const options = [...move.promotions].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "promotion-btn";
    const token = state.color === "w" ? option.toUpperCase() : option.toLowerCase();
    button.textContent = PIECE_SYMBOLS[token];
    button.title = option.toUpperCase();
    button.addEventListener("click", () => {
      sendMove(move.from, move.to, option);
      closePromotion();
    });
    refs.promotionOptions.appendChild(button);
  }

  refs.promotionModal.classList.remove("hidden");
  refs.promotionModal.setAttribute("aria-hidden", "false");
}

function closePromotion() {
  state.promotionContext = null;
  refs.promotionModal.classList.add("hidden");
  refs.promotionModal.setAttribute("aria-hidden", "true");
}

function getResultSignature(gameState) {
  const status = gameState?.status;
  if (!status || status.state !== "over") {
    return "";
  }

  const moves = Array.isArray(gameState.history) ? gameState.history.length : 0;
  const winner = status.winner || "draw";
  const reason = status.reason || "result";
  const roomCode = gameState.roomCode || state.roomCode || "";
  return `${roomCode}:${winner}:${reason}:${moves}`;
}

function closeResultModal() {
  state.resultModalVisible = false;
  refs.resultModal.classList.add("hidden");
  refs.resultModal.setAttribute("aria-hidden", "true");
}

function openResultModal(status) {
  if (!status || status.state !== "over") {
    return;
  }

  const reason = REASON_LABELS[status.reason] || status.reason || "result";
  const isPlayer = state.role === "player" && Boolean(state.color);

  if (status.winner) {
    const winner = colorLabel(status.winner);
    refs.resultTitle.textContent = `${winner} Wins`;
    if (isPlayer) {
      refs.resultSummary.textContent = state.color === status.winner ? "You won this game." : "You lost this game.";
    } else {
      refs.resultSummary.textContent = `${winner} won this game.`;
    }
  } else {
    refs.resultTitle.textContent = "Game Drawn";
    refs.resultSummary.textContent = isPlayer ? "This game ended in a draw." : "Match ended in a draw.";
  }

  refs.resultDetail.textContent = `Reason: ${reason}.`;
  refs.resultModal.classList.remove("hidden");
  refs.resultModal.setAttribute("aria-hidden", "false");
  state.resultModalVisible = true;
}

function syncResultModal(previousStatus, nextGameState) {
  const nextStatus = nextGameState?.status;
  if (!nextStatus || nextStatus.state !== "over") {
    state.lastResultSignature = "";
    if (state.resultModalVisible) {
      closeResultModal();
    }
    return;
  }

  const nextSignature = getResultSignature(nextGameState);
  if (nextSignature === state.lastResultSignature) {
    return;
  }

  const wasOverBefore = previousStatus?.state === "over";
  state.lastResultSignature = nextSignature;

  if (!wasOverBefore || !state.resultModalVisible) {
    openResultModal(nextStatus);
  }
}

function handleSquareClick(square) {
  if (!state.gameState || state.role !== "player" || !state.color) {
    return;
  }

  if (isReviewMode()) {
    showToast("Review mode on hai. Live board pe jane ke liye Go Live dabao.");
    return;
  }

  if (state.gameState.status.state !== "active") {
    return;
  }

  const pieceOnSquare = state.boardMap[square];

  if (state.selectedSquare) {
    const matchingMove = state.legalMoves.find((candidate) => candidate.to === square);
    if (matchingMove) {
      if (matchingMove.promotions && matchingMove.promotions.length > 0) {
        openPromotion({
          from: state.selectedSquare,
          to: square,
          promotions: matchingMove.promotions,
        });
      } else {
        sendMove(state.selectedSquare, square, "q");
      }
      return;
    }

    if (isMyTurn() && pieceOnSquare && pieceColor(pieceOnSquare) === state.color) {
      state.selectedSquare = square;
      state.legalMoves = [];
      requestLegalMoves(square);
      renderBoard();
      return;
    }

    clearSelection();
    renderBoard();
    return;
  }

  if (!isMyTurn()) {
    return;
  }

  if (!pieceOnSquare || pieceColor(pieceOnSquare) !== state.color) {
    return;
  }

  state.selectedSquare = square;
  state.legalMoves = [];
  requestLegalMoves(square);
  renderBoard();
}

function renderBoard() {
  refs.board.replaceChildren();
  if (!state.gameState) {
    return;
  }

  const boardMap = parseFenBoard(getDisplayFen());
  state.boardMap = boardMap;
  const fragment = document.createDocumentFragment();

  const orientation = boardOrientation();
  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const ranks = orientation === "white" ? RANKS_DESC : RANKS_ASC;
  const lastMove = getLastMoveSquares();

  let checkSquare = null;
  if (!isReviewMode() && state.gameState.status.state === "active" && state.gameState.status.check) {
    checkSquare = findKingSquare(boardMap, state.gameState.status.turn);
  }

  const legalSquareSet = new Set(state.legalMoves.map((move) => move.to));
  const captureSquareSet = new Set(state.legalMoves.filter((move) => move.capture).map((move) => move.to));

  for (const rank of ranks) {
    for (const file of files) {
      const square = `${file}${rank}`;
      const piece = boardMap[square];
      const tone = getSquareTone(square);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `square ${tone}`;
      button.dataset.square = square;

      if (state.selectedSquare === square) {
        button.classList.add("selected");
      }
      if (legalSquareSet.has(square)) {
        button.classList.add(captureSquareSet.has(square) ? "capture" : "legal");
      }
      if (lastMove && (lastMove.from === square || lastMove.to === square)) {
        button.classList.add("last-move");
      }
      if (checkSquare === square) {
        button.classList.add("check");
      }

      const isRankLabelSquare =
        (orientation === "white" && file === "a") || (orientation === "black" && file === "h");
      const isFileLabelSquare =
        (orientation === "white" && rank === 1) || (orientation === "black" && rank === 8);

      if (isRankLabelSquare) {
        const rankTag = document.createElement("span");
        rankTag.className = "coord rank";
        rankTag.textContent = String(rank);
        button.appendChild(rankTag);
      }

      if (isFileLabelSquare) {
        const fileTag = document.createElement("span");
        fileTag.className = "coord file";
        fileTag.textContent = file;
        button.appendChild(fileTag);
      }

      if (piece) {
        const glyph = document.createElement("span");
        glyph.className = `piece ${piece === piece.toUpperCase() ? "white-piece" : "black-piece"}`;
        glyph.textContent = PIECE_SYMBOLS[piece];
        button.appendChild(glyph);
      }

      button.addEventListener("click", () => handleSquareClick(square));
      fragment.appendChild(button);
    }
  }

  refs.board.replaceChildren(fragment);
}

function renderPlayers() {
  const white = state.gameState?.players?.white;
  const black = state.gameState?.players?.black;

  refs.whitePlayerName.textContent = white?.name || "Waiting...";
  refs.blackPlayerName.textContent = black?.name || "Waiting...";

  refs.whiteConnectionDot.classList.toggle("online", Boolean(white?.connected));
  refs.whiteConnectionDot.classList.toggle("offline", !white?.connected);
  refs.blackConnectionDot.classList.toggle("online", Boolean(black?.connected));
  refs.blackConnectionDot.classList.toggle("offline", !black?.connected);
}

function renderCaptures() {
  const captured = computeCapturedFromHistory(getDisplayHistory());

  refs.whiteCaptures.innerHTML = "";
  refs.blackCaptures.innerHTML = "";

  for (const token of captured.white) {
    const span = document.createElement("span");
    span.className = "capture-piece";
    span.textContent = PIECE_SYMBOLS[token];
    refs.whiteCaptures.appendChild(span);
  }

  for (const token of captured.black) {
    const span = document.createElement("span");
    span.className = "capture-piece";
    span.textContent = PIECE_SYMBOLS[token.toUpperCase()];
    refs.blackCaptures.appendChild(span);
  }
}

function updateMoveReviewControls() {
  const total = totalPlyCount();
  const ply = activePly();
  const review = isReviewMode();

  refs.movePrevBtn.disabled = total === 0 || ply <= 0;
  refs.moveNextBtn.disabled = total === 0 || !review;
  refs.moveLiveBtn.disabled = !review;

  if (review) {
    refs.moveReviewText.textContent = `Review mode: move ${ply}/${total}`;
    refs.moveReviewText.classList.add("active");
  } else {
    refs.moveReviewText.textContent = total > 0 ? `Live board: ${total} moves` : "Live board";
    refs.moveReviewText.classList.remove("active");
  }
}

function renderMoves() {
  const stickToBottom =
    refs.moveList.scrollTop + refs.moveList.clientHeight >= refs.moveList.scrollHeight - 28;

  refs.moveList.innerHTML = "";
  const history = state.gameState?.history || [];
  const review = isReviewMode();
  const selectedPly = activePly();

  for (let index = 0; index < history.length; index += 2) {
    const whiteMove = history[index];
    const blackMove = history[index + 1];
    const whitePly = index + 1;
    const blackPly = index + 2;

    const row = document.createElement("li");
    row.className = "move-row";

    const moveIndex = document.createElement("span");
    moveIndex.className = "move-index";
    moveIndex.textContent = `${Math.floor(index / 2) + 1}.`;

    const whiteCell = document.createElement("button");
    whiteCell.type = "button";
    whiteCell.className = "move-cell";
    if (whiteMove) {
      whiteCell.textContent = whiteMove.san;
      if (review && selectedPly === whitePly) {
        whiteCell.classList.add("active");
      } else if (!review && selectedPly === whitePly) {
        whiteCell.classList.add("recent");
      }
      whiteCell.addEventListener("click", () => {
        openReviewPly(whitePly);
        renderAll();
      });
    } else {
      whiteCell.textContent = "—";
      whiteCell.disabled = true;
      whiteCell.classList.add("empty");
    }

    const blackCell = document.createElement("button");
    blackCell.type = "button";
    blackCell.className = "move-cell";
    if (blackMove) {
      blackCell.textContent = blackMove.san;
      if (review && selectedPly === blackPly) {
        blackCell.classList.add("active");
      } else if (!review && selectedPly === blackPly) {
        blackCell.classList.add("recent");
      }
      blackCell.addEventListener("click", () => {
        openReviewPly(blackPly);
        renderAll();
      });
    } else {
      blackCell.textContent = "—";
      blackCell.disabled = true;
      blackCell.classList.add("empty");
    }

    row.append(moveIndex, whiteCell, blackCell);
    refs.moveList.appendChild(row);
  }

  updateMoveReviewControls();

  if (stickToBottom || !review) {
    refs.moveList.scrollTop = refs.moveList.scrollHeight;
  }
}

function renderChat() {
  const chatEntries = state.gameState?.chat || [];
  const stickToBottom =
    refs.chatLog.scrollTop + refs.chatLog.clientHeight >= refs.chatLog.scrollHeight - 24;

  refs.chatLog.innerHTML = "";

  for (const item of chatEntries) {
    const row = document.createElement("div");
    const isSelf = !item.system && item.author === state.name;
    row.className = `chat-item${item.system ? " system" : ""}${isSelf ? " self" : ""}`;

    const author = document.createElement("strong");
    author.textContent = item.system ? "System" : item.author;
    row.appendChild(author);

    const message = document.createElement("span");
    message.textContent = item.message;
    row.appendChild(message);

    refs.chatLog.appendChild(row);
  }

  if (stickToBottom) {
    refs.chatLog.scrollTop = refs.chatLog.scrollHeight;
  }
}

function formatStatus(status) {
  if (!status) {
    return "Waiting for match to start...";
  }

  if (status.state === "over") {
    const reason = REASON_LABELS[status.reason] || status.reason || "result";
    if (status.winner) {
      return `${colorLabel(status.winner)} wins by ${reason}.`;
    }
    return `Game drawn: ${reason}.`;
  }

  if (status.check) {
    return `${colorLabel(status.turn)} to move. Check!`;
  }

  return `${colorLabel(status.turn)} to move.`;
}

function updateRoleUI() {
  if (state.role === "player" && state.color) {
    refs.rolePill.textContent = `You: ${colorLabel(state.color)}`;
  } else {
    refs.rolePill.textContent = "Spectator";
  }
}

function updateActionStates() {
  const status = state.gameState?.status;
  const isPlayer = state.role === "player";
  const liveBoard = !isReviewMode();
  const canRequestRematch = isPlayer && status?.state === "over";

  refs.resignBtn.disabled = !(isPlayer && liveBoard && status?.state === "active");
  refs.rematchBtn.disabled = !canRequestRematch || !liveBoard;
  refs.resultRematchBtn.disabled = !canRequestRematch;
  refs.resultRematchBtn.textContent = canRequestRematch ? "Request Rematch" : "Players can request rematch";
}

function updateTurnHint() {
  if (isReviewMode()) {
    refs.turnHint.textContent = "Review mode active. Go Live to play current move.";
    return;
  }

  if (!state.gameState?.status) {
    refs.turnHint.textContent = "Join a room to start playing.";
    return;
  }

  if (state.role !== "player" || !state.color) {
    refs.turnHint.textContent = "Spectator mode enabled. Sit back and enjoy.";
    return;
  }

  if (state.gameState.status.state === "over") {
    refs.turnHint.textContent = "Game over. Press Rematch to start fresh.";
    return;
  }

  refs.turnHint.textContent = isMyTurn() ? "Your turn. Make a strong move." : "Opponent turn. Wait for your chance.";
}

function renderMeta() {
  const review = isReviewMode();
  const total = totalPlyCount();
  const ply = activePly();

  refs.roomCodeText.textContent = state.roomCode || "------";
  refs.statusText.textContent = review
    ? `Reviewing move ${ply}/${total}. Press Go Live for current position.`
    : formatStatus(state.gameState?.status);
  refs.spectatorCount.textContent = `${state.gameState?.spectators ?? 0} spectators`;
  updateRoleUI();
  updateActionStates();
  updateTurnHint();
}

function renderAll() {
  renderMeta();
  renderPlayers();
  renderCaptures();
  renderMoves();
  renderChat();
  renderBoard();
}

function resetToLobby() {
  state.roomCode = "";
  state.role = "spectator";
  state.color = null;
  state.gameState = null;
  state.selectedSquare = null;
  state.legalMoves = [];
  state.boardMap = {};
  state.flipped = false;
  state.lastResultSignature = "";
  state.reviewPly = null;
  closePromotion();
  closeResultModal();
  deactivateGameUI();
}

refs.createRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = sanitizeName(refs.nicknameInput.value);
  if (!name) {
    showToast("Please enter your nickname.");
    return;
  }

  state.name = name;
  socket.emit("create-room", { name });
});

refs.joinRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = sanitizeName(refs.nicknameInput.value);
  const roomCode = normalizeRoomCode(refs.roomCodeInput.value);

  if (!name) {
    showToast("Please enter your nickname.");
    return;
  }

  if (roomCode.length < 6) {
    showToast("Enter full 6-character room code.");
    return;
  }

  state.name = name;
  state.roomCode = roomCode;
  socket.emit("join-room", { name, roomCode });
});

refs.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = refs.chatInput.value.trim();
  if (!message) {
    return;
  }
  socket.emit("send-chat", { message });
  refs.chatInput.value = "";
});

refs.flipBoardBtn.addEventListener("click", () => {
  state.flipped = !state.flipped;
  renderBoard();
});

refs.fullscreenBtn.addEventListener("click", () => {
  toggleFullscreen();
});

refs.boardThemeSelect.addEventListener("change", (event) => {
  state.boardTheme = normalizeTheme(event.target.value, BOARD_THEMES, state.boardTheme);
  applyPreferences();
  writePreferences();
});

refs.pieceThemeSelect.addEventListener("change", (event) => {
  state.pieceTheme = normalizeTheme(event.target.value, PIECE_THEMES, state.pieceTheme);
  applyPreferences();
  writePreferences();
});

refs.pieceModeSelect.addEventListener("change", (event) => {
  state.pieceMode = normalizeTheme(event.target.value, PIECE_MODES, state.pieceMode);
  applyPreferences();
  writePreferences();
});

refs.movePrevBtn.addEventListener("click", () => {
  previousReviewPly();
  renderAll();
});

refs.moveNextBtn.addEventListener("click", () => {
  nextReviewPly();
  renderAll();
});

refs.moveLiveBtn.addEventListener("click", () => {
  goLiveBoard();
  renderAll();
});

refs.resignBtn.addEventListener("click", () => {
  if (refs.resignBtn.disabled) {
    return;
  }
  const confirmResign = window.confirm("Are you sure you want to resign this game?");
  if (!confirmResign) {
    return;
  }
  socket.emit("resign");
});

refs.rematchBtn.addEventListener("click", () => {
  if (refs.rematchBtn.disabled) {
    return;
  }
  socket.emit("request-rematch");
});

refs.copyRoomBtn.addEventListener("click", async () => {
  if (!state.roomCode) {
    return;
  }

  try {
    await navigator.clipboard.writeText(state.roomCode);
    showToast("Room code copied.");
  } catch {
    showToast("Copy failed. Code: " + state.roomCode);
  }
});

refs.promotionCancelBtn.addEventListener("click", () => {
  closePromotion();
});

refs.promotionModal.addEventListener("click", (event) => {
  if (event.target === refs.promotionModal) {
    closePromotion();
  }
});

refs.resultCloseBtn.addEventListener("click", () => {
  closeResultModal();
});

refs.resultModal.addEventListener("click", (event) => {
  if (event.target === refs.resultModal) {
    closeResultModal();
  }
});

refs.resultRematchBtn.addEventListener("click", () => {
  if (refs.resultRematchBtn.disabled) {
    return;
  }

  socket.emit("request-rematch");
  closeResultModal();
});

socket.on("connect", () => {
  const session = readSession();

  if (state.roomCode && state.name) {
    socket.emit("join-room", {
      roomCode: state.roomCode,
      name: state.name,
    });
    return;
  }

  if (!state.sessionRestoreAttempted && session?.roomCode && session?.name) {
    state.sessionRestoreAttempted = true;
    state.roomCode = session.roomCode;
    state.name = session.name;
    refs.nicknameInput.value = session.name;
    refs.roomCodeInput.value = session.roomCode;
    socket.emit("join-room", {
      roomCode: session.roomCode,
      name: session.name,
    });
  }
});

socket.on("disconnect", () => {
  showToast("Connection lost. Trying to reconnect...");
});

socket.on("room-joined", (payload = {}) => {
  state.roomCode = normalizeRoomCode(payload.roomCode || "");
  state.role = payload.role === "player" ? "player" : "spectator";
  state.color = payload.color || null;
  state.name = sanitizeName(payload.name || state.name);
  state.selectedSquare = null;
  state.legalMoves = [];
  state.flipped = false;
  state.sessionRestoreAttempted = true;
  state.lastResultSignature = "";
  state.reviewPly = null;

  refs.nicknameInput.value = state.name;
  refs.roomCodeInput.value = state.roomCode;

  writeSession();
  activateGameUI();
  closeResultModal();

  const roleText = state.role === "player" && state.color ? colorLabel(state.color) : "Spectator";
  showToast(`Joined ${state.roomCode} as ${roleText}.`);
});

socket.on("game-state", (payload = {}) => {
  const previousStatus = state.gameState?.status;
  state.gameState = payload;

  const total = totalPlyCount();
  if (state.reviewPly !== null) {
    state.reviewPly = clampReviewPly(state.reviewPly);
    if (state.reviewPly >= total) {
      state.reviewPly = null;
    }
  }

  renderAll();
  syncResultModal(previousStatus, payload);
});

socket.on("legal-moves", (payload = {}) => {
  if (isReviewMode()) {
    return;
  }

  if (!state.selectedSquare || payload.square !== state.selectedSquare) {
    return;
  }

  state.legalMoves = Array.isArray(payload.moves) ? payload.moves : [];
  renderBoard();
});

socket.on("error-message", (payload = {}) => {
  if (payload.message) {
    showToast(payload.message);
  }

  if (payload.clearSession) {
    clearSession();
    resetToLobby();
  }
});

window.addEventListener("beforeunload", () => {
  socket.emit("leave-room");
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  closePromotion();
  closeResultModal();
});

document.addEventListener("fullscreenchange", () => {
  updateFullscreenButton();
});

function hydrateLobbyFromSession() {
  const session = readSession();
  if (!session) {
    return;
  }

  refs.nicknameInput.value = session.name;
  refs.roomCodeInput.value = session.roomCode;
}

readPreferences();
applyPreferences();
updateFullscreenButton();
hydrateLobbyFromSession();
