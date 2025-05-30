// background.js

let isEngineReady = false;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

async function hasOffscreenDocument(path) {
    // Check all windows controlled by the service worker to see if one
    // has a URL matching the provided path
    const offscreenUrl = chrome.runtime.getURL(path);
    if (chrome.runtime.getContexts) { // MV3 method
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });
        return contexts.length > 0;
    } else { // Fallback for older environments (less likely needed for pure MV3)
        const views = chrome.extension.getViews({ type: 'OFFSCREEN_DOCUMENT' });
        return views.some(view => view.location.href === offscreenUrl);
    }
}

async function ensureOffscreenDocument() {
    console.log('[BACKGROUND_OFFSCREEN] Checking for existing offscreen document...');
    if (await hasOffscreenDocument(OFFSCREEN_DOCUMENT_PATH)) {
        console.log('[BACKGROUND_OFFSCREEN] Offscreen document already exists.');
        return;
    }

    console.log('[BACKGROUND_OFFSCREEN] Creating offscreen document.');
    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: [chrome.offscreen.Reason.WORKERS], // Ensure this reason is appropriate and sufficient
            justification: 'To host the Stockfish WebAssembly worker which requires Blob URLs for optimal performance and CSP management.'
        });
        console.log('[BACKGROUND_OFFSCREEN] Offscreen document creation initiated.');
    } catch (e) {
        console.error('[BACKGROUND_OFFSCREEN] CRITICAL: Error calling chrome.offscreen.createDocument:', e);
        throw e; // Re-throw to be caught by initializeEngine
    }
}

async function initializeEngine() {
    console.log('[BACKGROUND_ENGINE_INIT] Ensuring offscreen document and then initializing Stockfish via offscreen...');
    try {
        await ensureOffscreenDocument();
        // Small delay to allow offscreen document to fully load its script
        await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
        console.error('[BACKGROUND_ENGINE_INIT] Failed to ensure/create offscreen document:', e);
        isEngineReady = false;
        return;
    }

    const stockfishJsUrl = chrome.runtime.getURL('lib/stockfish.js');
    const stockfishWasmUrl = chrome.runtime.getURL('lib/stockfish.wasm');
    console.log('[BACKGROUND_ENGINE_INIT] stockfish.js URL for offscreen:', stockfishJsUrl);
    console.log('[BACKGROUND_ENGINE_INIT] stockfish.wasm URL for offscreen:', stockfishWasmUrl);

    // In background.js

    const stockfishWorkerScriptString = `
      // Worker script for Stockfish (this runs inside a blob worker in the offscreen document)
      console.log('[BLOB_WORKER] Blob worker script started.');
      let moduleInitialized = false;
      let wasmBinary = null;
      let initialCommandsQueue = [];
      let stockfishWorkerNested = null; // The actual stockfish.js worker

      self.onmessage = function(e) {
        const commandData = e.data;
        console.log('[BLOB_WORKER] Received message:', commandData.type, commandData);

        if (commandData.type === 'SET_WASM_BINARY') {
          wasmBinary = commandData.wasmBinary;
          console.log('[BLOB_WORKER] WASM binary received. Size:', wasmBinary ? wasmBinary.byteLength : 'null');
          initializeStockfishModule(); // Now initialize the nested worker
          return;
        }

        if (!moduleInitialized || !stockfishWorkerNested) {
          console.log('[BLOB_WORKER] Module not ready, queuing command:', commandData);
          initialCommandsQueue.push(commandData);
          return;
        }
        
        if (typeof commandData === 'string') { // Assuming direct UCI strings after init
          console.log('[BLOB_WORKER] Sending UCI command to nested Stockfish:', commandData);
          stockfishWorkerNested.postMessage(commandData);
        } else {
          console.log('[BLOB_WORKER] Received non-string/non-init command (ignoring for now):', commandData);
        }
      };

      async function initializeStockfishModule() {
        const stockfishJsLibUrl = '{{STOCKFISH_JS_URL}}';
        console.log('[BLOB_WORKER] Attempting to create nested Stockfish worker from URL:', stockfishJsLibUrl);
        try {
          stockfishWorkerNested = new Worker(stockfishJsLibUrl, { type: 'module' });
          console.log('[BLOB_WORKER] Nested Stockfish worker instance created.');
          
          stockfishWorkerNested.onmessage = function(e) {
            const msg = e.data;
            console.log('[BLOB_WORKER] Message from NESTED Stockfish:', msg);
            
            if (typeof msg === 'string' && msg.startsWith('uciok')) {
              console.log('[BLOB_WORKER] Nested Stockfish uciok received. Sending "isready" command.');
              stockfishWorkerNested.postMessage('isready'); // <--- **** ADDED/MOVED HERE ****
            } else if (typeof msg === 'string' && msg === 'readyok') {
              if (!moduleInitialized) { 
                console.log('[BLOB_WORKER] Nested Stockfish is fully READY (received readyok).');
                moduleInitialized = true;
                self.postMessage({ type: 'ready' }); // Inform offscreen.js
                
                console.log('[BLOB_WORKER] Processing queued commands (' + initialCommandsQueue.length + ')');
                while(initialCommandsQueue.length > 0) {
                  const queuedCommand = initialCommandsQueue.shift();
                  if (typeof queuedCommand === 'string') {
                    console.log('[BLOB_WORKER] Sending queued UCI command to nested Stockfish:', queuedCommand);
                    stockfishWorkerNested.postMessage(queuedCommand);
                  }
                }
              }
            } else if (typeof msg === 'string' && (msg.startsWith('info') || msg.startsWith('bestmove'))) {
              self.postMessage({ type: 'analysis', data: msg });
            } else if (msg && msg.type === 'engine_error') {
                console.error('[BLOB_WORKER] Nested Stockfish reported structured error:', msg.error);
                self.postMessage({ type: 'error', error: 'Nested Stockfish: ' + msg.error });
            }
          };

          stockfishWorkerNested.onerror = function(errorEvent) {
            console.error('[BLOB_WORKER] Error from NESTED Stockfish worker:', errorEvent.message, errorEvent);
            self.postMessage({ type: 'error', error: 'Nested Stockfish worker error: ' + errorEvent.message });
          };

          // Optional: If your stockfish.js needs WASM binary passed this way.
          // Many modern stockfish.js workers handle WASM loading internally if the .wasm file
          // is placed alongside the .js file and web_accessible_resources is set up.
          // If this message is not needed by your specific stockfish.js, it might cause the "Unknown command"
          // if (wasmBinary) {
          //    console.log('[BLOB_WORKER] Attempting to send SET_WASM_BINARY to nested worker (if supported).');
          //    stockfishWorkerNested.postMessage({ type: 'SET_WASM_BINARY', wasmBinary: wasmBinary, path: 'stockfish.wasm' }); // Path might be needed
          // }

          console.log('[BLOB_WORKER] Sending initial "uci" command to nested Stockfish.');
          stockfishWorkerNested.postMessage('uci'); 
          // 'isready' will now be sent after 'uciok' is received.

        } catch (e) {
          console.error('[BLOB_WORKER] CRITICAL ERROR creating nested Stockfish worker:', e.message, e);
          self.postMessage({ type: 'error', error: 'Failed to create nested Stockfish worker: ' + e.message });
        }
      }
      console.log('[BLOB_WORKER] Blob worker script initialized, waiting for parent (offscreen.js) to send SET_WASM_BINARY.');
    `;

  console.log('[BACKGROUND_ENGINE_INIT] Sending start-stockfish-worker command to offscreen document.');
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-stockfish-worker', // This will use the blob worker string method
    workerScriptString: stockfishWorkerScriptString, // The string defined above
    stockfishJsUrl: stockfishJsUrl,     // For the {{STOCKFISH_JS_URL}} placeholder
    stockfishWasmUrl: stockfishWasmUrl  // For fetching the wasm binary
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[BACKGROUND_ENGINE_INIT] Error sending/receiving response for start-stockfish-worker to/from offscreen:', chrome.runtime.lastError.message);
      isEngineReady = false;
    } else if (response && response.success) {
      console.log('[BACKGROUND_ENGINE_INIT] Offscreen document acknowledged start-stockfish-worker: SUCCESS.');
      // isEngineReady is set when the 'ready' message comes back from the engine pipeline
    } else {
      console.error('[BACKGROUND_ENGINE_INIT] Offscreen document reported failure for start-stockfish-worker:', response?.error);
      isEngineReady = false;
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // console.log("[BACKGROUND_MSG_HANDLER] Raw message received:", message);

  if (message.target !== 'service-worker' && message.type === 'analyzePosition') {
    if (!isEngineReady) {
      console.error('[BACKGROUND_MSG_HANDLER] Engine not ready for analyzePosition. Current FEN:', message.fen);
      sendResponse({ success: false, error: 'Engine not ready' });
      return true;
    }
    const multiPV = message.multiPV || 10;
    const depth = message.depth || 15; // Adjusted default depth
    console.log(`[BACKGROUND_MSG_HANDLER] Relaying to Stockfish (via Offscreen): fen ${message.fen}, MultiPV ${multiPV}, Depth ${depth}`);

    // It's better to send options once, or ensure they are set before each 'go' if they can change.
    // For simplicity, sending them before each analysis here.
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'send-to-stockfish', command: `setoption name MultiPV value ${multiPV}` });
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'send-to-stockfish', command: `position fen ${message.fen}` });
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'send-to-stockfish', command: `go depth ${depth}` });
    sendResponse({ success: true }); // Acknowledge the request was received and relayed
    return true;
  } else if (message.target !== 'service-worker' && message.type === 'ping') {
    sendResponse({ success: true, message: 'Pong from background', engineReady: isEngineReady });
    return true;
  }


  if (message.target === 'service-worker') {
    console.log('[BACKGROUND_MSG_HANDLER] Received message targeted to service-worker:', message.type, message.data || message.error);
    switch (message.type) {
      case 'stockfish-message': // This comes from offscreen.js
        const stockfishData = message.data;
        // console.log('[BACKGROUND_MSG_HANDLER] Processing stockfish-message, data:', stockfishData);
        if (stockfishData && stockfishData.type === 'ready') {
          console.log('Background: Stockfish IS READY signal received from offscreen! Setting isEngineReady = true.');
          isEngineReady = true;
          // Notify content script that engine is ready (optional, if content script needs to know)
          // chrome.tabs.query({ active: true, currentWindow: true, url: "*://*.chess.com/*" }, (tabs) => {
          //   if (tabs.length > 0 && tabs[0].id) {
          //     chrome.tabs.sendMessage(tabs[0].id, { type: 'ENGINE_NOW_READY' });
          //   }
          // });
        }
        // Analysis data is now handled by 'STOCKFISH_ANALYSIS' type directly from offscreen
        break;
      case 'stockfish-error': // This comes from offscreen.js
        console.error('[BACKGROUND_MSG_HANDLER] Stockfish worker error relayed from offscreen:', message.error);
        isEngineReady = false; // Assume engine is not usable
        break;
      case 'STOCKFISH_ANALYSIS': // This comes from offscreen.js, relaying from blob worker
        // console.log('[BACKGROUND_MSG_HANDLER] Relaying STOCKFISH_ANALYSIS to content script:', message.data ? message.data.substring(0,100) + "..." : "no data");
        chrome.tabs.query({ active: true, currentWindow: true, url: "*://*.chess.com/*" }, (tabs) => {
          if (tabs.length > 0 && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'stockfishAnalysis', // Message type content.js expects
              data: message.data
            }).catch(error => {
              if (!error.message.includes("Could not establish connection") && !error.message.includes("Receiving end does not exist")) {
                console.error('Background: Error sending relayed STOCKFISH_ANALYSIS to content script:', error.message);
              }
            });
          }
        });
        break;
      default:
        console.warn(`[BACKGROUND_MSG_HANDLER] Unexpected message type for service-worker target: "${message.type}".`);
    }
  }
  return true; // Keep channel open for other listeners or async responses if any part becomes async
});

self.addEventListener('install', (event) => {
  console.log('[BACKGROUND_LIFECYCLE] Service worker installing. Skipping waiting.');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[BACKGROUND_LIFECYCLE] Service worker activating. Initializing engine setup...');
  // Don't make activate event wait for initializeEngine if it's very long
  initializeEngine();
  // event.waitUntil(initializeEngine()); // Use if initializeEngine returns a promise and you need activate to wait for it
});

console.log('Background: Service worker script loaded. Waiting for activate event.');