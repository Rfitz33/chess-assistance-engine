// offscreen.js

let stockfishBlobWorker; // Renamed for clarity, this is the worker created from the blob string

// Listen for messages from the service worker (background.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // console.log("[OFFSCREEN_MSG_HANDLER] Raw message received in offscreen:", message);
  handleMessagesFromBackground(message, sender, sendResponse);
  return true; // Keeps the message port open for async sendResponse
});

async function handleMessagesFromBackground(message, sender, sendResponse) {
  if (message.target !== 'offscreen') {
    // console.log("[OFFSCREEN_MSG_HANDLER] Message not targeted to offscreen, ignoring.", message.target);
    return;
  }
  console.log("[OFFSCREEN_MSG_HANDLER] Processing message for offscreen:", message.type);

  switch (message.type) {
    case 'start-stockfish-worker': // This is for the blob worker method
      console.log('Offscreen: Received request to start Stockfish worker (blob method).');
      console.log('Offscreen: stockfishJsUrl (for placeholder):', message.stockfishJsUrl);
      console.log('Offscreen: stockfishWasmUrl (for fetch):', message.stockfishWasmUrl);
      try {
        await startStockfishViaBlobWorker(message.workerScriptString, message.stockfishJsUrl, message.stockfishWasmUrl);
        sendResponse({ success: true });
      } catch (e) {
        console.error('Offscreen: Error starting Stockfish (blob method)', e);
        sendResponse({ success: false, error: e.message });
      }
      break;
    case 'send-to-stockfish':
      if (stockfishBlobWorker) {
        // console.log('Offscreen: Relaying command to Stockfish (blob worker):', message.command);
        stockfishBlobWorker.postMessage(message.command); // Send UCI string directly
      } else {
        console.error('Offscreen: Stockfish (blob worker) not started, cannot send command.');
      }
      break;
    default:
      console.warn(`Offscreen: Unexpected message type received: "${message.type}".`);
  }
}

async function startStockfishViaBlobWorker(workerScriptString, stockfishJsUrlForPlaceholder, stockfishWasmUrlToFetch) {
  console.log('Offscreen: Starting Stockfish via Blob Worker with:', {
    // workerScriptString: workerScriptString.substring(0, 200) + '...', // Log snippet
    stockfishJsUrlForPlaceholder,
    stockfishWasmUrlToFetch
  });

  if (stockfishBlobWorker) {
    console.log("Offscreen: Terminating existing stockfishBlobWorker.");
    stockfishBlobWorker.terminate();
    stockfishBlobWorker = null;
  }

  try {
    console.log('Offscreen: Fetching WASM binary from:', stockfishWasmUrlToFetch);
    const wasmResponse = await fetch(stockfishWasmUrlToFetch);
    if (!wasmResponse.ok) {
      throw new Error(`Failed to fetch WASM: ${wasmResponse.status} ${wasmResponse.statusText} from ${stockfishWasmUrlToFetch}`);
    }
    const wasmBinary = await wasmResponse.arrayBuffer();
    console.log('Offscreen: Fetched WASM binary, size:', wasmBinary.byteLength);

    const finalWorkerScript = workerScriptString
      .replace(/\{\{STOCKFISH_JS_URL\}\}/g, stockfishJsUrlForPlaceholder); // Replace placeholder

    const blob = new Blob([finalWorkerScript], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    console.log('Offscreen: Created blob URL for worker:', blobUrl);

    stockfishBlobWorker = new Worker(blobUrl, { type: 'module' }); // type: 'module' if script string uses import/export
    console.log('Offscreen: Created stockfishBlobWorker from blob URL.');
    URL.revokeObjectURL(blobUrl); // Clean up blob URL after worker is created

    stockfishBlobWorker.onmessage = function(e) {
      const msgFromBlobWorker = e.data;
      // console.log('Offscreen: Message from stockfishBlobWorker:', msgFromBlobWorker);

      if (msgFromBlobWorker.type === 'ready') {
        console.log('Offscreen: Blob worker reported ready. Attempting to send "stockfish-message" with type:ready to SERVICE WORKER.');
        chrome.runtime.sendMessage({
          target: 'service-worker',
          type: 'stockfish-message', // To be handled by background.js
          data: { type: 'ready' }
        }, response => {
            if (chrome.runtime.lastError) {
                console.error("Offscreen: Error sending 'ready' message to service worker:", chrome.runtime.lastError.message);
            } else {
                // console.log("Offscreen: 'ready' message sent to service worker, response:", response);
            }
        });
      } else if (msgFromBlobWorker.type === 'analysis') {
        // Forward analysis results (UCI strings) to the service worker
        // console.log('Offscreen: Relaying analysis from blob worker to service worker:', msgFromBlobWorker.data ? msgFromBlobWorker.data.substring(0,100) + "..." : "no data");
        chrome.runtime.sendMessage({
            target: 'service-worker',
            type: 'STOCKFISH_ANALYSIS', // To be handled by background.js
            data: msgFromBlobWorker.data
        });
      } else if (msgFromBlobWorker.type === 'error') {
        console.error('Offscreen: Error from stockfishBlobWorker:', msgFromBlobWorker.error);
        chrome.runtime.sendMessage({
            target: 'service-worker',
            type: 'stockfish-error', // To be handled by background.js
            error: msgFromBlobWorker.error
        });
      }
    };

    stockfishBlobWorker.onerror = function(errorEvent) {
      console.error('Offscreen: stockfishBlobWorker onerror:', errorEvent.message, errorEvent);
      chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'stockfish-error',
        error: 'Blob worker main error: ' + errorEvent.message
      });
    };

    console.log('Offscreen: Sending SET_WASM_BINARY to stockfishBlobWorker.');
    stockfishBlobWorker.postMessage({ type: 'SET_WASM_BINARY', wasmBinary });

  } catch (error) {
    console.error('Offscreen: CRITICAL Error in startStockfishViaBlobWorker:', error);
    chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'stockfish-error',
        error: 'Failed to start blob worker pipeline: ' + error.message
    });
    throw error; // Propagate error for the sendResponse in handleMessagesFromBackground
  }
}

console.log('Offscreen: Offscreen document script loaded.');