class ChessAssistant {
  constructor() {
    this.enabled = false;
    this.strength = 1.0;
    this.engine = null;
    this.game = new Chess();
    this.isAnalyzing = false;
    this.playerColor = null;
    this.arrowElement = null;
    this.setupEngine();
    this.setupMessageListeners();
    this.setupBoardObserver();
  }

  setupEngine() {
    this.engine = new Worker(chrome.runtime.getURL('lib/stockfish.js'));
    this.engine.postMessage('uci');
    this.engine.postMessage('setoption name Threads value 4');
    this.engine.postMessage('setoption name MultiPV value 10');
    this.engine.onmessage = (event) => this.handleEngineMessage(event);
  }

  setupMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'toggleAssistant') {
        this.enabled = message.enabled;
        if (!this.enabled) {
          this.clearArrow();
        }
      } else if (message.type === 'updateStrength') {
        this.strength = message.strength;
      }
    });
  }

  setupBoardObserver() {
    const observer = new MutationObserver(() => this.onBoardUpdate());
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async onBoardUpdate() {
    if (!this.enabled || this.isAnalyzing) return;

    const position = this.getCurrentPosition();
    if (!position) return;

    const isUserTurn = this.isUserTurn();
    if (!isUserTurn) return;

    this.isAnalyzing = true;
    this.analyzePosition(position);
  }

  getCurrentPosition() {
    const board = document.querySelector('chess-board');
    if (!board) return null;

    // Get player color if not already set
    if (!this.playerColor) {
      const orientation = board.getAttribute('orientation');
      this.playerColor = orientation || 'white';
    }

    // Parse the board state
    const pieces = board.querySelectorAll('.piece');
    const position = new Array(64).fill(null);

    pieces.forEach(piece => {
      const square = piece.parentElement;
      if (!square) return;

      const file = square.getAttribute('data-file');
      const rank = square.getAttribute('data-rank');
      if (!file || !rank) return;

      const index = (8 - rank) * 8 + (file.charCodeAt(0) - 'a'.charCodeAt(0));
      const pieceType = piece.getAttribute('class').split(' ')[1];
      position[index] = this.mapPieceTypeToFEN(pieceType);
    });

    return this.positionToFEN(position);
  }

  mapPieceTypeToFEN(pieceType) {
    const [color, piece] = pieceType.split('-');
    const fenPiece = {
      'pawn': 'p',
      'knight': 'n',
      'bishop': 'b',
      'rook': 'r',
      'queen': 'q',
      'king': 'k'
    }[piece];

    return color === 'white' ? fenPiece.toUpperCase() : fenPiece;
  }

  positionToFEN(position) {
    let fen = '';
    let emptyCount = 0;

    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = position[rank * 8 + file];
        
        if (piece === null) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            fen += emptyCount;
            emptyCount = 0;
          }
          fen += piece;
        }
      }
      
      if (emptyCount > 0) {
        fen += emptyCount;
        emptyCount = 0;
      }
      
      if (rank < 7) fen += '/';
    }

    // Add other FEN components (active color, castling, etc.)
    fen += ` ${this.playerColor === 'white' ? 'w' : 'b'} KQkq - 0 1`;
    return fen;
  }

  isUserTurn() {
    const turnIndicator = document.querySelector('.move-indicator');
    if (!turnIndicator) return false;

    const isWhiteTurn = !turnIndicator.classList.contains('black');
    return isWhiteTurn === (this.playerColor === 'white');
  }

  analyzePosition(fen) {
    this.game.load(fen);
    this.engine.postMessage('position fen ' + fen);
    this.engine.postMessage('go depth 20');
  }

  handleEngineMessage(event) {
    const data = event.data;
    if (typeof data !== 'string') return;

    if (data.startsWith('bestmove')) {
      this.isAnalyzing = false;
      return;
    }

    if (!data.startsWith('info depth')) return;

    const moves = this.parseEngineOutput(data);
    if (!moves || moves.length === 0) return;

    const selectedMove = this.selectMove(moves);
    if (selectedMove) {
      this.drawArrow(selectedMove.from, selectedMove.to);
    }
  }

  parseEngineOutput(data) {
    const moves = [];
    const parts = data.split(' ');
    
    let i = 0;
    while (i < parts.length) {
      if (parts[i] === 'pv') {
        const move = parts[i + 1];
        let score = 0;
        
        // Look for score
        for (let j = 0; j < i; j++) {
          if (parts[j] === 'cp') {
            score = parseInt(parts[j + 1]) / 100;
            break;
          } else if (parts[j] === 'mate') {
            const mateIn = parseInt(parts[j + 1]);
            score = 1000000 / Math.abs(mateIn);
            if (mateIn < 0) score = -score;
            break;
          }
        }
        
        moves.push({
          move,
          from: move.substring(0, 2),
          to: move.substring(2, 4),
          score
        });
      }
      i++;
    }
    
    return moves;
  }

  selectMove(moves) {
    let bestEval = this.playerColor === 'black' ? -moves[0].score : moves[0].score;
    
    const maxError = bestEval >= 0 
      ? (1 - this.strength) * bestEval 
      : -2 * (1 - this.strength) * bestEval;
    
    const threshold = bestEval - maxError;
    
    // Find the worst move above the threshold
    return moves.reverse().find(move => {
      const score = this.playerColor === 'black' ? -move.score : move.score;
      return score >= threshold;
    });
  }

  drawArrow(from, to) {
    this.clearArrow();

    const board = document.querySelector('chess-board');
    if (!board) return;

    const fromSquare = board.querySelector(`[data-square="${from}"]`);
    const toSquare = board.querySelector(`[data-square="${to}"]`);
    if (!fromSquare || !toSquare) return;

    const fromRect = fromSquare.getBoundingClientRect();
    const toRect = toSquare.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();

    const arrow = document.createElement('div');
    arrow.className = 'chess-assistant-arrow';
    arrow.style.left = boardRect.left + 'px';
    arrow.style.top = boardRect.top + 'px';
    arrow.style.width = boardRect.width + 'px';
    arrow.style.height = boardRect.height + 'px';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    marker.setAttribute('id', 'arrowhead');
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'strokeWidth');

    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'M0,0 L0,6 L9,3 z');
    arrowPath.setAttribute('fill', 'rgba(255, 165, 0, 0.8)');

    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const fromX = fromRect.left + fromRect.width / 2 - boardRect.left;
    const fromY = fromRect.top + fromRect.height / 2 - boardRect.top;
    const toX = toRect.left + toRect.width / 2 - boardRect.left;
    const toY = toRect.top + toRect.height / 2 - boardRect.top;

    path.setAttribute('d', `M${fromX},${fromY} L${toX},${toY}`);
    svg.appendChild(path);
    arrow.appendChild(svg);

    document.body.appendChild(arrow);
    this.arrowElement = arrow;
  }

  clearArrow() {
    if (this.arrowElement) {
      this.arrowElement.remove();
      this.arrowElement = null;
    }
  }
}

// Initialize the assistant
const assistant = new ChessAssistant(); 