// Import Stockfish
importScripts('lib/stockfish.js');

// Initialize Stockfish
try {
  console.log('Worker: Initializing Stockfish...');
  const engine = new Module();
  console.log('Worker: Stockfish initialized successfully');

  // Handle messages from the main thread
  self.onmessage = function(e) {
    const command = e.data;
    console.log('Worker: Received command:', command);
    
    if (typeof command === 'string') {
      try {
        console.log('Worker: Sending command to Stockfish:', command);
        engine.postMessage(command);
      } catch (error) {
        console.error('Worker: Error sending command to Stockfish:', error);
        self.postMessage({ type: 'error', error: 'Failed to send command: ' + error.message });
      }
    }
  };

  // Forward engine output to the main thread
  engine.onmessage = function(msg) {
    console.log('Worker: Received message from Stockfish:', msg);
    self.postMessage(msg);
  };

  // Notify that the worker is ready
  self.postMessage('ready');
} catch (error) {
  console.error('Worker: Failed to initialize Stockfish:', error);
  self.postMessage({ type: 'error', error: 'Failed to initialize Stockfish: ' + error.message });
}

// Handle worker errors
self.onerror = function(error) {
  console.error('Worker: Unhandled error:', error);
  self.postMessage({ type: 'error', error: 'Worker error: ' + error.message });
}; 