// console.log('Background: Service worker starting up. Initializing engine...');
// initializeEngine(); // Commented out for now

let isEngineReady = false;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Function to manage the offscreen document
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });

  if (existingContexts.length > 0) {
    console.log('Background: Offscreen document already exists.');
    return;
  }

  console.log('Background: Preparing to create offscreen document.');
  // Diagnostic logging
  console.log('Background: typeof chrome.offscreen:', typeof chrome.offscreen);
  console.log('Background: chrome.offscreen object:', JSON.stringify(chrome.offscreen));
  if (chrome.offscreen) {
    console.log('Background: typeof chrome.offscreen.Reason:', typeof chrome.offscreen.Reason);
    console.log('Background: chrome.offscreen.Reason object:', JSON.stringify(chrome.offscreen.Reason));
    console.log('Background: typeof chrome.offscreen.Reason.WORKERS:', typeof chrome.offscreen.Reason.WORKERS);
    console.log('Background: chrome.offscreen.Reason.WORKERS value:', chrome.offscreen.Reason.WORKERS);
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'To host the Stockfish WebAssembly worker which requires Blob URLs.'
    });
    console.log('Background: Offscreen document creation initiated.');
  } catch (e) {
    console.error('Background: Error calling chrome.offscreen.createDocument:', e);
    throw e;
  }
}

async function initializeEngine() {
  console.log('Background: Ensuring offscreen document exists and then initializing Stockfish via offscreen...');
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    console.error('Background: Failed to ensure offscreen document:', e);
    isEngineReady = false;
    return;
  }

  const stockfishJsUrl = chrome.runtime.getURL('lib/stockfish.js');
  const stockfishWasmUrl = chrome.runtime.getURL('lib/stockfish.wasm');
  
  // This is the script content for the Stockfish worker itself (the one created from a blob)
  // Note the placeholder for the library URL.
  const stockfishWorkerScriptString = `
    // Worker script for Stockfish
    let moduleInitialized = false;
    let wasmBinary = null;
    let initialCommandsQueue = []; // Queue commands received before Module is fully ready
    let stockfishWorker = null;

    // Listener for the WASM binary and other commands
    self.onmessage = function(e) {
      const commandData = e.data;
      // console.log('Stockfish Worker (blob): Received initial message:', commandData.type);

      if (commandData.type === 'SET_WASM_BINARY') {
        wasmBinary = commandData.wasmBinary;
        console.log('Stockfish Worker (blob): WASM binary received. Size:', wasmBinary ? wasmBinary.byteLength : 'null');
        // Now that WASM is here, proceed with creating the Stockfish worker
        initializeStockfishModule();
        return; // Important: stop further processing of this onmessage until Module is up
      }

      // If Module is not ready, queue other commands
      if (!moduleInitialized || !stockfishWorker) {
        // console.log('Stockfish Worker (blob): Module not ready, queuing command:', commandData);
        initialCommandsQueue.push(commandData);
        return;
      }
      
      // If Module is ready, process command directly
      if (typeof commandData === 'string') { // Assuming direct UCI strings for now after init
        if (!moduleInitialized) {
          console.warn('Stockfish Worker: Received command before runtime initialized. Ignoring.', commandData);
          return;
        }
        try {
          console.log('Stockfish Worker (blob): Sending command to Stockfish worker:', commandData);
          stockfishWorker.postMessage(commandData);
        } catch (error) {
          console.error('Stockfish Worker: Error sending command to Stockfish:', error);
          self.postMessage({ type: 'error', error: 'Failed to send command: ' + error.message });
        }
      } else {
        // console.log('Stockfish Worker (blob): Received non-string command after init:', commandData);
      }
    };

    async function initializeStockfishModule() {
      console.log('Stockfish Worker (blob): Creating nested Stockfish worker from:', '{{STOCKFISH_JS_URL}}');
      try {
        // Create a new worker directly from stockfish.js
        stockfishWorker = new Worker('{{STOCKFISH_JS_URL}}', { type: 'module' });
        
        // Set up message handling from the Stockfish worker
        stockfishWorker.onmessage = function(e) {
          const msg = e.data;
          console.log('Stockfish Worker (blob): Received message from Stockfish worker:', msg);
          if (msg === 'readyok') {
            console.log('Stockfish Worker (blob): Stockfish is ready');
            moduleInitialized = true;
            self.postMessage({ type: 'ready' });
            
            // Process any queued commands
            console.log('Stockfish Worker (blob): Processing queued commands (' + initialCommandsQueue.length + ')');
            while(initialCommandsQueue.length > 0) {
              const queuedCommand = initialCommandsQueue.shift();
              if (typeof queuedCommand === 'string') {
                console.log('Stockfish Worker (blob): Sending queued command to Stockfish worker:', queuedCommand);
                stockfishWorker.postMessage(queuedCommand);
              }
            }
          } else if (msg.startsWith('info') || msg.startsWith('bestmove')) {
            self.postMessage({ type: 'analysis', data: msg });
          }
        };

        stockfishWorker.onerror = function(error) {
          console.error('Stockfish Worker (blob): Error from Stockfish worker:', error);
          self.postMessage({ type: 'error', error: 'Stockfish worker error: ' + error.message });
          self.close();
        };

        // Send the WASM binary to the Stockfish worker
        stockfishWorker.postMessage({ type: 'SET_WASM_BINARY', wasmBinary: wasmBinary });

        // Initialize Stockfish
        stockfishWorker.postMessage('uci');
        stockfishWorker.postMessage('setoption name Threads value 4');
        stockfishWorker.postMessage('setoption name MultiPV value 10');
        stockfishWorker.postMessage('isready');

      } catch (e) {
        console.error('Stockfish Worker (blob): Error creating Stockfish worker:', e);
        self.postMessage({ type: 'error', error: 'Failed to create Stockfish worker: ' + e.message });
        self.close();
        return;
      }
    }
  `;

  console.log('Background: Sending worker script and WASM URL to offscreen document.');
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-stockfish-worker',
    workerScriptString: stockfishWorkerScriptString,
    stockfishJsUrl: stockfishJsUrl,
    stockfishWasmUrl: stockfishWasmUrl
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Background: Error sending start-stockfish-worker to offscreen:', chrome.runtime.lastError.message);
      isEngineReady = false;
    } else if (response && response.success) {
      console.log('Background: Offscreen document confirmed Stockfish worker startup process initiated.');
    } else {
      console.error('Background: Offscreen document failed to start Stockfish worker:', response?.error);
      isEngineReady = false;
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'service-worker' && message.type === 'analyzePosition') {
    if (!isEngineReady) {
      console.error('Background: Engine not ready for analyzePosition');
      sendResponse({ success: false, error: 'Engine not ready' });
      return true; 
    }
    // Accept multiPV and depth from message, default to 10 and 20
    const multiPV = message.multiPV || 10;
    const depth = message.depth || 20;
    console.log('Background: Sending command to Stockfish via Offscreen:', message.fen, 'MultiPV:', multiPV, 'Depth:', depth);
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'send-to-stockfish',
      command: 'setoption name MultiPV value ' + multiPV
    });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'send-to-stockfish',
      command: 'position fen ' + message.fen
    });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'send-to-stockfish',
      command: 'go depth ' + depth
    });
    sendResponse({ success: true });
    return true; 
  } else if (message.target !== 'service-worker' && message.type === 'ping') {
    console.log('Background: Ping received from content/popup');
    sendResponse({ success: true, message: 'Pong from background', ready: isEngineReady });
    return true; 
  }

  // Relay analysis from offscreen to content script (always, regardless of message.target)
  if (message.type === 'STOCKFISH_ANALYSIS') {
    if (typeof message.data === 'string' && message.data.startsWith('bestmove')) {
      console.log('Background: Received bestmove from offscreen:', message.data);
    }
    console.log('Background: Relaying analysis to content script (from offscreen):', message.data);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        if (typeof message.data === 'string' && message.data.startsWith('bestmove')) {
          console.log('Background: Relaying bestmove to content script:', message.data);
        }
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'stockfishAnalysis',
          data: message.data
        }).catch(error => {
          console.error('Background: Error sending relayed analysis to content script:', error.message);
        });
      }
    });
    return;
  }

  if (message.target === 'service-worker') {
    switch (message.type) {
      case 'stockfish-message':
        const stockfishData = message.data;
        if (stockfishData.type === 'ready') {
          console.log('Background: Stockfish is ready (relayed from offscreen).');
          isEngineReady = true;
        } else if (stockfishData.type === 'analysis') {
          console.log('Background: Relaying analysis to content script:', stockfishData.data);
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0 && tabs[0].id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'stockfishAnalysis',
                data: stockfishData.data
              }).catch(error => {
                console.error('Background: Error sending relayed analysis to content script:', error.message);
              });
            }
          });
        } else if (stockfishData.type === 'error') {
          console.error('Background: Stockfish relayed an error from worker:', stockfishData.error);
          isEngineReady = false;
        }
        break;
      case 'stockfish-error':
        console.error('Background: Stockfish worker error (relayed from offscreen):', message.error);
        isEngineReady = false;
        break;
      case 'STOCKFISH_ANALYSIS':
        console.log('Background: Relaying analysis to content script (from offscreen):', message.data);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0 && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'stockfishAnalysis',
              data: message.data
            }).catch(error => {
              console.error('Background: Error sending relayed analysis to content script:', error.message);
            });
          }
        });
        break;
      default:
        console.warn(`Background: Unexpected message type for service-worker target: "${message.type}".`);
    }
  }
  return true; 
});

self.addEventListener('install', (event) => {
  console.log('Background: Service worker installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Background: Service worker activating. Initializing engine setup...');
  initializeEngine(); 
});

console.log('Background: Service worker script loaded. Waiting for activate event to initialize engine setup.'); 