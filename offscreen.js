let stockfishWorker;

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessages(message, sender, sendResponse);
  return true; // Keeps the message port open for async sendResponse
});

async function handleMessages(message, sender, sendResponse) {
  if (message.target !== 'offscreen') {
    return;
  }

  switch (message.type) {
    case 'start-stockfish-worker':
      console.log('Offscreen: Received request to start Stockfish worker.');
      console.log('Offscreen: stockfishJsUrl:', message.stockfishJsUrl);
      console.log('Offscreen: stockfishWasmUrl:', message.stockfishWasmUrl);
      try {
        await startStockfishWorker(message.workerScriptString, message.stockfishJsUrl, message.stockfishWasmUrl);
        sendResponse({ success: true });
      } catch (e) {
        console.error('Offscreen: Error starting Stockfish worker', e);
        sendResponse({ success: false, error: e.message });
      }
      break;
    case 'send-to-stockfish':
      if (stockfishWorker) {
        console.log('Offscreen: Relaying command to Stockfish worker:', message.command);
        stockfishWorker.postMessage(message.command);
      } else {
        console.error('Offscreen: Stockfish worker not started, cannot send command.');
      }
      break;
    default:
      console.warn(`Offscreen: Unexpected message type received: "${message.type}".`);
  }
}

async function startStockfishWorker(workerScriptString, stockfishJsUrl, stockfishWasmUrl) {
  console.log('Offscreen: Starting Stockfish worker with:', {
    workerScriptString: workerScriptString.substring(0, 100) + '...',
    stockfishJsUrl,
    stockfishWasmUrl
  });

  try {
    // Fetch the WASM binary
    const wasmResponse = await fetch(stockfishWasmUrl);
    if (!wasmResponse.ok) {
      throw new Error(`Failed to fetch WASM: ${wasmResponse.status} ${wasmResponse.statusText}`);
    }
    const wasmBinary = await wasmResponse.arrayBuffer();
    console.log('Offscreen: Fetched WASM binary, size:', wasmBinary.byteLength);

    // Replace placeholders in the worker script
    const finalWorkerScript = workerScriptString
      .replace(/\{\{STOCKFISH_JS_URL\}\}/g, stockfishJsUrl)
      .replace(/\{\{STOCKFISH_WASM_URL\}\}/g, stockfishWasmUrl);

    // Create the blob worker
    const blob = new Blob([finalWorkerScript], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    console.log('Offscreen: Created blob URL for worker:', blobUrl);

    // Create the worker
    const worker = new Worker(blobUrl, { type: 'module' });
    console.log('Offscreen: Created worker from blob URL');

    // Set up message handling
    worker.onmessage = function(e) {
      const msg = e.data;
      if (typeof msg === 'string' && msg.startsWith('bestmove')) {
        console.log('Offscreen: Received bestmove from Stockfish worker:', msg);
      }
      if (msg.type === 'ready') {
        console.log('Offscreen: Stockfish worker is ready');
        // Notify the service worker that initialization is complete
        chrome.runtime.sendMessage({
          target: 'service-worker',
          type: 'stockfish-message',
          data: { type: 'ready' }
        });
      } else if (msg.type === 'analysis') {
        if (msg.type === 'bestmove') {
          console.log('Offscreen: Relaying bestmove to background:', msg);
        }
        // Forward analysis results to the service worker
        chrome.runtime.sendMessage({ type: 'STOCKFISH_ANALYSIS', data: msg.data });
      } else if (msg.type === 'error') {
        console.error('Offscreen: Error from Stockfish worker:', msg.error);
        chrome.runtime.sendMessage({ type: 'STOCKFISH_ERROR', error: msg.error });
      }
    };

    worker.onerror = function(error) {
      console.error('Offscreen: Worker error:', error);
      chrome.runtime.sendMessage({ type: 'STOCKFISH_ERROR', error: error.message });
    };

    // Send the WASM binary to the worker
    worker.postMessage({ type: 'SET_WASM_BINARY', wasmBinary });
    console.log('Offscreen: Sent WASM binary to worker');

    // Store the worker reference
    stockfishWorker = worker;

  } catch (error) {
    console.error('Offscreen: Error starting Stockfish worker:', error);
    chrome.runtime.sendMessage({ type: 'STOCKFISH_ERROR', error: error.message });
  }
}

console.log('Offscreen document script loaded.'); 