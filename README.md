# Chess Assistance Engine

A Chrome extension that provides move suggestions while playing on chess.com.

## Features

- Enable/disable assistance with a single click
- Adjustable strength level (0.01 to 1.00)
- Visual move suggestions using arrows
- Works on chess.com live games
- Customizable move selection based on position evaluation

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/chess-assistance-engine.git
```

2. Download the required dependencies:
- [Stockfish.js](https://github.com/niklasf/stockfish.js)
- [Chess.js](https://github.com/jhlywa/chess.js)

Place them in the `lib` directory.

3. Load the extension in Chrome:
- Open Chrome and go to `chrome://extensions/`
- Enable "Developer mode" in the top right
- Click "Load unpacked" and select the extension directory

## Usage

1. Click the extension icon to open the control panel
2. Use the toggle button to enable/disable the assistant
3. Adjust the strength slider to control the quality of suggested moves:
   - 1.00: Always suggests the best move
   - 0.01: Suggests moves that may lose advantage while staying within calculated bounds

## Technical Details

The extension:
1. Monitors the chess.com game board
2. Parses the current position when it's the user's turn
3. Uses Stockfish to evaluate possible moves
4. Applies the strength factor to select an appropriate move
5. Displays the suggestion using an arrow overlay

## Development

To modify the extension:
1. Make your changes to the source files
2. Reload the extension in Chrome
3. Test the changes on chess.com

## Disclaimer

This extension is for educational purposes only. Using it in real games may violate chess.com's terms of service. 