// content.js

class ChessAssistant {
  constructor() {
    this.enabled = false;
    this.strength = 1.0;
    this.game = new Chess();
    this.isAnalyzing = false;
    this.playerColor = 'w';
    this.analysisMoves = [];
    this.arrowElement = null;
    this.analysisDebounceTime = 750;
    this.lastProcessedFullFenForAnalysis = "";
    this.boardElement = null; // Will store the found board element

    this.pieceCharMap = {
        'wk': 'K', 'wq': 'Q', 'wr': 'R', 'wb': 'B', 'wn': 'N', 'wp': 'P',
        'bk': 'k', 'bq': 'q', 'br': 'r', 'bb': 'b', 'bn': 'n', 'bp': 'p'
    };

    chrome.storage.local.get(['enabled', 'strength'], res => {
      this.enabled = res.enabled ?? false;
      this.strength = (res.strength ?? 1.0);
      console.log('[INIT] Loaded assistant state:', { enabled: this.enabled, strength: this.strength });
    });

    this.setupMessageListeners();
    this.waitForBoard();
    console.log('[INIT] Chess Assistant initialized');
  }

  waitForBoard() {
    const check = () => {
      let foundBoard = document.getElementById('board-play-computer');
      if (!foundBoard) {
        foundBoard = document.getElementById('board-single'); // For "Play Online" / Live
      }
      if (!foundBoard) {
        foundBoard = document.querySelector('wc-chess-board.board'); // General fallback
      }

      if (foundBoard) {
        console.log('[INIT] Board found, setting up observer. Element:', foundBoard);
        this.boardElement = foundBoard; // Store the identified board
        this.setupBoardObserver();
        if (this.enabled) {
            this.onBoardUpdate(); // Initial check if enabled and board is now ready
        }
      } else {
        console.log('[INIT] Board not found, retrying in 1s');
        setTimeout(check, 1000);
      }
    };
    check();
  }

  setupBoardObserver() {
    if (!this.boardElement) {
        console.error("[INIT] Cannot setup board observer: this.boardElement is null.");
        return;
    }
    if (this.boardObserver) this.boardObserver.disconnect();
    let debounceTimeout = null;
    const onMutate = (mutationsList) => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        // console.log('[BOARD_OBSERVER] Debounced mutation, triggering onBoardUpdate.');
        this.onBoardUpdate();
      }, this.analysisDebounceTime);
    };
    this.boardObserver = new MutationObserver(onMutate);
    this.boardObserver.observe(this.boardElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'id', 'style', 'fen', 'position']
    });
    console.log('[INIT] Board observer set up on:', this.boardElement);
  }

  setupMessageListeners() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // console.log('[MSG_HANDLER] Received message:', msg);
      try {
        if (msg.type === 'toggleAssistant') {
          this.enabled = msg.enabled;
          // console.log(`[MSG_HANDLER] Assistant toggled. Enabled: ${this.enabled}`);
          if (!this.enabled) {
            this.clearArrow();
            this.isAnalyzing = false;
            this.lastProcessedFullFenForAnalysis = "";
          } else {
            this.onBoardUpdate();
          }
          sendResponse({ success: true, enabled: this.enabled });
        } else if (msg.type === 'updateStrength') {
          this.strength = msg.strength;
          // console.log(`[MSG_HANDLER] Strength updated to: ${this.strength}`);
          this.lastProcessedFullFenForAnalysis = "";
          if (this.enabled) {
             this.onBoardUpdate();
          }
          sendResponse({ success: true, strength: this.strength });
        } else if (msg.type === 'stockfishAnalysis') {
          this.handleEngineMessage(msg.data);
          sendResponse({ success: true });
        }
      } catch (err) {
        console.error('[MSG_HANDLER] Error handling message:', msg, err);
        sendResponse({ success: false, error: err.message });
      }
      return true;
    });
  }

  determinePlayerColor() {
    if (!this.boardElement) {
        // console.warn('[PLAYER_INFO] Board element not available for player color determination.');
        this.playerColor = 'w';
        return;
    }
    if (this.boardElement.classList.contains('flipped')) {
        this.playerColor = 'b';
    } else {
        this.playerColor = 'w';
    }
    // console.log('[PLAYER_INFO] Determined player color:', this.playerColor);
  }

  determineActiveTurn() {
    // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn START -----');
    if (!this.boardElement) {
        console.error('[TURN_INFO_DEBUG] Board element (this.boardElement) is null for turn determination.');
        // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (board not found) -----');
        return null;
    }

    const directFen = this.boardElement.getAttribute('fen') || this.boardElement.getAttribute('position');
    if (directFen) {
        try {
            const gameFromDirectFen = new Chess(directFen);
            const turn = gameFromDirectFen.turn();
            // console.log(`[TURN_INFO_DEBUG] Turn '${turn}' from direct FEN attribute on board element.`);
            // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (direct FEN attribute) -----');
            return turn;
        } catch (e) { /* Proceed if invalid */ }
    }

    // Use the FEN from this.game, which should have been loaded by getCurrentPosition
    let fenForTurnCheck = this.game.fen();
    try {
        const tempGameForStartCheck = new Chess(fenForTurnCheck);
        if (tempGameForStartCheck.history().length === 0 && fenForTurnCheck.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")) {
            // console.log('[TURN_INFO_DEBUG] Board is in starting position (ply 0). Active turn: w');
            // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (start position) -----');
            return 'w';
        }
    } catch(e) { /* ignore if FEN is bad from this.game */ }


    const highlightElements = this.boardElement.querySelectorAll('.highlight[class*="square-"]');
    if (highlightElements.length < 2) {
        // console.warn('[TURN_INFO_DEBUG] Not enough highlight elements, and not start. Defaulting to "w".');
        // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (not enough highlights) -----');
        return 'w'; // Fallback
    }

    const piecesOnBoard = {};
    const pieceElements = this.boardElement.querySelectorAll('.piece[class*="square-"]');
    pieceElements.forEach(pieceEl => {
        const classList = Array.from(pieceEl.classList);
        const squareClass = classList.find(cls => cls.startsWith('square-') && cls.length === 9);
        const pieceTypeCodeClass = classList.find(cls => this.pieceCharMap[cls]);
        if (squareClass && pieceTypeCodeClass) {
            const fileNum = parseInt(squareClass[7]);
            const rankNum = parseInt(squareClass[8]);
            const algebraicSquare = String.fromCharCode('a'.charCodeAt(0) + fileNum - 1) + rankNum;
            piecesOnBoard[algebraicSquare] = this.pieceCharMap[pieceTypeCodeClass];
        }
    });

    let movedPieceColor = null;
    const uniqueHighlightedSquares = [...new Set(Array.from(highlightElements).map(hEl => {
        const sqClass = Array.from(hEl.classList).find(cls => cls.startsWith('square-') && cls.length === 9);
        if (sqClass) {
            const file = parseInt(sqClass[7]);
            const rank = parseInt(sqClass[8]);
            if (file >=1 && file <=8 && rank >=1 && rank <=8) return String.fromCharCode('a'.charCodeAt(0) + file - 1) + rank;
        }
        return null;
    }).filter(Boolean))];


    for (const sq of uniqueHighlightedSquares) {
        if (piecesOnBoard[sq]) {
            const pieceFenChar = piecesOnBoard[sq];
            movedPieceColor = (pieceFenChar === pieceFenChar.toUpperCase()) ? 'w' : 'b';
            break;
        }
    }

    if (!movedPieceColor) {
        // console.warn('[TURN_INFO_DEBUG] Could not determine moved piece color from highlights. Defaulting to "w".');
        // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (no moved piece color) -----');
        return 'w'; // Fallback
    }

    if (movedPieceColor === 'w') {
        // console.log('[TURN_INFO_DEBUG] Last move was by White (from highlights). Deduced active turn: b');
        // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (success via highlight) -----');
        return 'b';
    } else if (movedPieceColor === 'b') {
        // console.log('[TURN_INFO_DEBUG] Last move was by Black (from highlights). Deduced active turn: w');
        // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (success via highlight) -----');
        return 'w';
    }
    
    // console.warn('[TURN_INFO_DEBUG] Fallthrough in determineActiveTurn. Defaulting "w".');
    // console.log('[TURN_INFO_DEBUG] ----- determineActiveTurn END (bug fallthrough) -----');
    return 'w';
  }

  getCurrentPosition(isRecursiveCall = false) { // Renamed param for clarity
    if (!this.boardElement) {
        // Only log error if it's a top-level call, not a recursive one from determineActiveTurn
        if (!isRecursiveCall) console.error('[FEN_PARSE] ERROR: Board element (this.boardElement) is null in getCurrentPosition.');
        return null;
    }

    const directFen = this.boardElement.getAttribute('fen') || this.boardElement.getAttribute('position');
    if (directFen) {
        try {
            new Chess(directFen); // Validate
            // console.log('[FEN_PARSE] Using direct FEN from board attribute:', directFen);
            this.game.load(directFen);
            return directFen;
        } catch (e) {
            // console.warn('[FEN_PARSE] Board had FEN attribute, but it was invalid. Falling back.', directFen, e);
        }
    }

    const boardArray = Array(8).fill(null).map(() => Array(8).fill(null));
    const pieceElements = this.boardElement.querySelectorAll('.piece');

    if (pieceElements.length === 0) {
        // if (!isRecursiveCall) console.warn('[FEN_PARSE] No "piece" elements found on this.boardElement.');
        return '8/8/8/8/8/8/8/8 w - - 0 1';
    }

    pieceElements.forEach(pieceEl => {
        const classList = Array.from(pieceEl.classList);
        const squareClass = classList.find(cls => cls.startsWith('square-') && cls.length === 9 && !isNaN(parseInt(cls[7])) && !isNaN(parseInt(cls[8])));
        const pieceTypeCodeClass = classList.find(cls => this.pieceCharMap[cls]);

        if (squareClass && pieceTypeCodeClass) {
            const pieceFenChar = this.pieceCharMap[pieceTypeCodeClass];
            const fileNum = parseInt(squareClass[7]);
            const rankNum = parseInt(squareClass[8]);
            if (fileNum >= 1 && fileNum <= 8 && rankNum >= 1 && rankNum <= 8) {
                const fileIndex = fileNum - 1;
                const rankIndex = 8 - rankNum;
                boardArray[rankIndex][fileIndex] = pieceFenChar;
            }
        }
    });

    let fenPieces = '';
    for (let r = 0; r < 8; r++) {
        let emptyCount = 0;
        for (let f = 0; f < 8; f++) {
            if (boardArray[r][f]) {
                if (emptyCount > 0) fenPieces += emptyCount;
                fenPieces += boardArray[r][f];
                emptyCount = 0;
            } else {
                emptyCount++;
            }
        }
        if (emptyCount > 0) fenPieces += emptyCount;
        if (r < 7) fenPieces += '/';
    }

    const placeholderActiveColor = 'w'; // Will be overwritten in onBoardUpdate
    const castlingRights = this.detectCastlingRights(boardArray);
    const enPassantTarget = '-'; // TODO
    const halfMoveClock = '0';
    const fullMoveNumber = '1'; // TODO

    const constructedFen = `${fenPieces} ${placeholderActiveColor} ${castlingRights} ${enPassantTarget} ${halfMoveClock} ${fullMoveNumber}`;

    try {
        // Load into this.game also to ensure it's up-to-date for other methods like determineActiveTurn's ply check
        this.game.load(constructedFen);
        // if (!isRecursiveCall) console.log('[FEN_PARSE] Manually constructed FEN (validated):', constructedFen);
    } catch (e) {
        if (!isRecursiveCall) console.error('[FEN_PARSE] ERROR: Manually constructed FEN is invalid:', constructedFen, e);
        return null;
    }
    return constructedFen;
  }

  detectCastlingRights(boardArray) {
    let rights = "";
    if (boardArray[7][4] === 'K' && boardArray[7][7] === 'R') rights += 'K';
    if (boardArray[7][4] === 'K' && boardArray[7][0] === 'R') rights += 'Q';
    if (boardArray[0][4] === 'k' && boardArray[0][7] === 'r') rights += 'k';
    if (boardArray[0][4] === 'k' && boardArray[0][0] === 'r') rights += 'q';
    return rights === "" ? "-" : rights;
  }

  async onBoardUpdate() {
    if (!this.enabled) return;
    if (this.isAnalyzing) return;
    if (!this.boardElement) {
        console.warn("[BOARD_UPDATE] Board element not ready, skipping update.");
        return;
    }

    this.determinePlayerColor();
    // console.log('[DEBUG_BLACK_TURN] Current this.playerColor:', this.playerColor);

    const piecePlacementFen = this.getCurrentPosition();
    if (!piecePlacementFen) {
        console.error('[BOARD_UPDATE] Failed to get piece placement FEN.');
        return;
    }

    const activeTurnColor = this.determineActiveTurn();
    if (!activeTurnColor) {
        console.warn('[BOARD_UPDATE] Could not determine active turn. Analysis halted.');
        return;
    }

    const fenParts = piecePlacementFen.split(' ');
    fenParts[1] = activeTurnColor;
    // TODO: More accurate castling/enpassant/move counters if possible
    const currentFullFen = fenParts.join(' ');

    try {
        this.game.load(currentFullFen); // Ensure internal game state is current
    } catch (e) {
        console.error("[BOARD_UPDATE] Failed to load currentFullFen into chess.js:", currentFullFen, e);
        return;
    }

    const isUserTurn = (this.playerColor === activeTurnColor);
    // console.log(`[DEBUG_BLACK_TURN] isUserTurn check: playerColor=${this.playerColor}, activeTurnColor=${activeTurnColor}, isUserTurn=${isUserTurn}`);

    if (!isUserTurn) {
        this.clearArrow();
        this.isAnalyzing = false;
        this.lastProcessedFullFenForAnalysis = "";
        return;
    }

    if (currentFullFen === this.lastProcessedFullFenForAnalysis) {
        return;
    }

    console.log(`[BOARD_UPDATE] User's turn. Player: ${this.playerColor}, Active: ${activeTurnColor}. Full FEN for analysis: ${currentFullFen}`);
    this.isAnalyzing = true;
    this.analyzePosition(currentFullFen);
  }

  analyzePosition(fen) {
    this.analysisMoves = [];
    // console.log('[ENGINE_COMMS] Sending analysis request to background for FEN:', fen);
    chrome.runtime.sendMessage({
        type: 'analyzePosition',
        fen: fen,
        multiPV: 10,
        depth: 15
    }, response => {
      if (chrome.runtime.lastError || !response?.success) {
        console.error('[ENGINE_COMMS] Analysis request failed:', chrome.runtime.lastError?.message, response);
        this.isAnalyzing = false;
      }
    });
  }

  handleEngineMessage(data) {
    try {
      if (typeof data !== 'string') return;

      if (data.startsWith('info') && data.includes('multipv')) {
        const mv = this.parseMultipvLine(data);
        if (mv) this.analysisMoves.push(mv);
        return;
      }

      if (data.startsWith('bestmove')) {
        // console.log('[ENGINE_MSG] Bestmove line received, processing analysis results.');
        this.isAnalyzing = false;

        const activeTurnColor = this.determineActiveTurn();
        const isStillUserTurn = (this.playerColor === activeTurnColor);

        if (!this.enabled || !isStillUserTurn) {
            this.clearArrow();
            return;
        }
        if (this.analysisMoves.length === 0) return;

        const sortedMoves = [...this.analysisMoves].sort((a, b) => b.eval - a.eval);
        if (sortedMoves.length === 0) return;

        const B = sortedMoves[0].eval;
        const L = this.strength;
        let E;
        if (B >= 0) E = (1 - L) * B;
        else E = -2 * (1 - L) * B;

        const targetEvalMin = B - E;
        let acceptableMoves = sortedMoves.filter(move => move.eval >= targetEvalMin);

        let selectedMove;
        if (acceptableMoves.length === 0) {
            selectedMove = sortedMoves[0];
        } else {
            acceptableMoves.sort((a, b) => a.eval - b.eval);
            selectedMove = acceptableMoves[0];
        }

        // console.log(`[B-E_LOGIC] Selected move: ${selectedMove.from}${selectedMove.to} (Eval: ${selectedMove.eval})`);
        this.drawArrow(selectedMove.from, selectedMove.to);
        this.lastProcessedFullFenForAnalysis = this.game.fen();
      }
    } catch (err) {
      console.error('[ENGINE_MSG] Error processing engine message:', err, 'Data:', data);
      this.isAnalyzing = false;
    }
  }

  drawArrow(from, to) {
    this.clearArrow();
    if (!this.boardElement) {
        console.error('[DRAW_ARROW] Board element (this.boardElement) not found for drawing.');
        return;
    }

    let coordsSvg = this.boardElement.querySelector('svg.coordinates');
    if (!coordsSvg) coordsSvg = this.boardElement.querySelector('svg.arrows');
    if (!coordsSvg) {
        console.error('[DRAW_ARROW] Coordinates/Arrows SVG not found within this.boardElement.');
        return;
    }

    const ns = "http://www.w3.org/2000/svg";
    const markerId = 'chess-assistant-arrowhead';

    if (!coordsSvg.querySelector(`#${markerId}`)) {
      const defs = document.createElementNS(ns, 'defs');
      const marker = document.createElementNS(ns, 'marker');
      marker.setAttribute('id', markerId);
      marker.setAttribute('markerWidth', '10'); marker.setAttribute('markerHeight', '7');
      marker.setAttribute('refX', '10'); marker.setAttribute('refY', '3.5');
      marker.setAttribute('orient', 'auto');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M0,0 L10,3.5 L0,7 Z');
      path.setAttribute('fill', 'rgba(255,165,0,0.8)');
      marker.appendChild(path); defs.appendChild(marker);
      coordsSvg.insertBefore(defs, coordsSvg.firstChild);
    }

    const vb = coordsSvg.viewBox.baseVal;
    if (!vb || vb.width === 0 || vb.height === 0) {
        console.error('[DRAW_ARROW] SVG viewBox not found or has zero dimensions.');
        return;
    }

    const cellWidth = vb.width / 8; const cellHeight = vb.height / 8;
    const fileToX = (fChar) => (fChar.charCodeAt(0) - 'a'.charCodeAt(0)) * cellWidth + cellWidth / 2;
    const rankToY = (rChar) => (8 - parseInt(rChar, 10)) * cellHeight + cellHeight / 2;

    let fromX = fileToX(from[0]); let fromY = rankToY(from[1]);
    let toX = fileToX(to[0]); let toY = rankToY(to[1]);

    if (this.playerColor === 'b') { // Adjust for flipped board if player is Black
        fromX = vb.width - fromX; fromY = vb.height - fromY;
        toX = vb.width - toX; toY = vb.height - toY;
    }

    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', fromX.toString()); line.setAttribute('y1', fromY.toString());
    line.setAttribute('x2', toX.toString()); line.setAttribute('y2', toY.toString());
    line.setAttribute('stroke', 'rgba(255,165,0,0.8)');
    line.setAttribute('stroke-width', (Math.min(cellWidth, cellHeight) * 0.1).toString());
    line.setAttribute('marker-end', `url(#${markerId})`);
    coordsSvg.appendChild(line);
    this.arrowElement = line;
  }

  clearArrow() {
    if (this.arrowElement) {
      this.arrowElement.remove();
      this.arrowElement = null;
    }
  }

  parseMultipvLine(data) {
    const parts = data.trim().split(/\s+/);
    const mpIdx = parts.indexOf('multipv');
    if (mpIdx === -1 || mpIdx + 1 >= parts.length) return null;
    const multipv = parseInt(parts[mpIdx + 1], 10);
    const scoreIdx = parts.indexOf('score');
    if (scoreIdx === -1 || scoreIdx + 2 >= parts.length) return null;

    let evalScore = 0;
    const scoreType = parts[scoreIdx + 1];
    const scoreVal = parseInt(parts[scoreIdx + 2], 10);

    if (scoreType === 'cp') evalScore = scoreVal;
    else if (scoreType === 'mate') evalScore = scoreVal > 0 ? (1000000 / scoreVal) : (-1000000 / Math.abs(scoreVal));
    else return null;

    if (this.playerColor === 'b') evalScore *= -1;

    const pvIdx = parts.indexOf('pv');
    if (pvIdx === -1 || pvIdx + 1 >= parts.length) return null;
    const moveUci = parts[pvIdx + 1];
    if (moveUci.length < 4) return null;

    const from = moveUci.slice(0, 2); const to = moveUci.slice(2, 4);
    return { multipv, eval: evalScore, from, to, uci: moveUci };
  }
}

if (typeof Chess === 'function') {
  new ChessAssistant();
} else {
  console.error("Chess.js library not found! Extension cannot start.");
}