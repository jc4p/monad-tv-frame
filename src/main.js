import './style.css';
import pako from 'pako';
import * as frame from '@farcaster/frame-sdk';
import { createWalletClient, createPublicClient, custom, http, encodeFunctionData, bytesToHex, parseAbiItem, hexToBytes, formatUnits } from 'viem';

const MONAD_TESTNET_CHAIN_ID = 10143;
// Use the Alchemy RPC URL from Vite environment variables
const MONAD_TESTNET_RPC_URL = import.meta.env.VITE_ALCHEMY_MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz'; // Fallback if not set
if (!import.meta.env.VITE_ALCHEMY_MONAD_RPC_URL) {
    console.warn("VITE_ALCHEMY_MONAD_RPC_URL not found in .env, using default Monad public RPC. Log queries might be limited.");
}

const MONAD_TESTNET = {
  id: MONAD_TESTNET_CHAIN_ID,
  name: 'Monad Testnet',
  network: 'monad-testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, // Adjust if different
  rpcUrls: {
    default: { http: [MONAD_TESTNET_RPC_URL] },
    public: { http: [MONAD_TESTNET_RPC_URL] },
  },
  testnet: true
};
// --- End Monad Testnet Configuration ---

// --- Helper function to get Viem Public Client ---
function getPublicClient() {
  return createPublicClient({
    chain: MONAD_TESTNET,
    transport: http()
  });
}
// --- End Helper function ---

// --- Smart Contract Configuration ---
const FRAME_RECORDER_CONTRACT_ADDRESS = '0x1B5481D98B0cD6b3422E15d6e16102C3780B08Ec'; // Restored contract address
const frameRecorderAbi = [
  parseAbiItem('function setFrames(bytes calldata _firstFrame, bytes calldata _compressedDiffs, uint32[] calldata _diffLengths, uint256 fid) external'),
  parseAbiItem('event VideoClipUpdated(address indexed user, uint256 fid, uint256 timestamp)'),
  parseAbiItem('function getFullClipData(address user) external view returns (bytes memory firstFrame, bytes memory compressedDiffs, uint32[] memory diffLengths, uint256 fid, uint256 timestamp)'),
  parseAbiItem('function getFrameCount(address user) external view returns (uint256)'),
  parseAbiItem('function getClipMetadata(address user) external view returns (uint256 fid, uint256 timestamp)'),
  parseAbiItem('function getParticipants() external view returns (address[] memory)')
]; // Restored ABI definition
// --- End Smart Contract Configuration ---

// DOM Element References
const videoElement = document.getElementById('webcam');
const videoGridContainer = document.getElementById('videoGridContainer'); // Stays the same for grid display

// New Modal and Action Button DOM Element References
const openRecordModalButton = document.getElementById('openRecordModalButton');
const recordModal = document.getElementById('recordModal');
const closeRecordModalButton = document.getElementById('closeRecordModalButton');
const modalPreviewCanvas = document.getElementById('modalPreviewCanvas'); // Canvas inside the modal for preview
const modalRecordButton = document.getElementById('modalRecordButton');   // Record button inside the modal
const modalPlayButton = document.getElementById('modalPlayButton');     // Play button inside the modal
const modalSaveButton = document.getElementById('modalSaveButton');     // Save button inside the modal
const modalStatusElement = document.getElementById('modalStatus');        // Status message element inside the modal

const FPS = 5;
const FPS_GRID = 10;
const FPS_NOISE = 30; 
const RECORD_DURATION_MS = 2000;
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 160;
const TOTAL_PIXELS = FRAME_WIDTH * FRAME_HEIGHT;

let livePreviewInterval = null;
let recordingInterval = null;
let playbackInterval = null;
let recordedFrames = [];
let lastFrameImageData = null;

// Fallback if not set, and log a warning.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787'; 
if (!import.meta.env.VITE_API_BASE_URL) {
    console.warn(`VITE_API_BASE_URL not found in .env, using default ${API_BASE_URL}. Ensure your API worker is running there or configure the .env var.`);
}
const RECENT_LOGS_API_ENDPOINT = `${API_BASE_URL}/recent`;

// --- Live Preview Functions ---
function startLivePreview() {
  if (livePreviewInterval) {
    clearInterval(livePreviewInterval);
  }
  const modalCtx = modalPreviewCanvas.getContext('2d');
  livePreviewInterval = setInterval(() => {
    const videoWidth = videoElement.videoWidth;
    const videoHeight = videoElement.videoHeight;
    if (videoWidth === 0 || videoHeight === 0) return;

    const size = Math.min(videoWidth, videoHeight);
    const sx = (videoWidth - size) / 2;
    const sy = (videoHeight - size) / 2;

    // Draw to a temporary canvas to get ImageData for processing
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = FRAME_WIDTH;
    tempCanvas.height = FRAME_HEIGHT;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(videoElement, sx, sy, size, size, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    
    let imageData = tempCtx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    imageData = toGrayscale(imageData); 
    // imageData = adjustBrightness(imageData, 1.20); // Optional: Adjust brightness if needed for preview

    modalCtx.putImageData(imageData, 0, 0);
  }, 1000 / FPS); // Using the general FPS for live preview
}

function stopLivePreview() {
  if (livePreviewInterval) {
    clearInterval(livePreviewInterval);
    livePreviewInterval = null;
  }
  // Optionally clear the canvas
  const modalCtx = modalPreviewCanvas.getContext('2d');
  modalCtx.clearRect(0, 0, modalPreviewCanvas.width, modalPreviewCanvas.height);
}
// --- End Live Preview Functions ---

// --- Grid Playback State ---
let activeGridPlayers = [];
let masterLoopId = null;
let currentUserFid = null; // Store current user's FID

class GridPlayerData {
    constructor(canvas, contractData, senderAddress, fid, timestamp) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.sender = senderAddress;
        this.fid = fid;
        this.timestamp = timestamp;

        // Data from new contract structure
        this.firstFrameCompressed = contractData.firstFrame; // hex string from contract
        this.allDiffsCompressedBlob = contractData.compressedDiffs; // hex string from contract
        this.diffLengths = contractData.diffLengths; // array of numbers (uint32)

        this.totalFrames = 1 + (this.diffLengths ? this.diffLengths.length : 0);
        this.currentFrameIndex = 0;
        
        // Playback state
        this.reconstructedIBaseFrameData = null; // Stores the pixel data of the I-frame once decompressed
        this.decompressedDiffsBlob = null; // Stores the Uint8Array of all concatenated diffs, decompressed once
        this.currentPFramePixelData = null; // Stores pixel data for the current P-frame being built or shown

        this.lastFrameRenderTime = 0;
        this.frameIntervalMs = 1000 / FPS_GRID;
        this.canvas.title = `FID: ${fid} (${senderAddress.substring(0,6)}...) at ${new Date(Number(timestamp) * 1000).toLocaleTimeString()} (${this.totalFrames} frames)`;
    }

    // Method to decompress necessary blobs on demand (e.g., before first play)
    prepareForPlayback() {
        if (this.firstFrameCompressed && !this.reconstructedIBaseFrameData) {
            try {
                this.reconstructedIBaseFrameData = new Uint8Array(pako.inflate(hexToBytes(this.firstFrameCompressed)));
            } catch (e) {
                console.error(`GridPlayer ${this.sender}: Error decompressing I-frame`, e);
                this.reconstructedIBaseFrameData = null; // Mark as failed
            }
        }
        if (this.allDiffsCompressedBlob && !this.decompressedDiffsBlob && this.diffLengths && this.diffLengths.length > 0) {
            try {
                this.decompressedDiffsBlob = new Uint8Array(pako.inflate(hexToBytes(this.allDiffsCompressedBlob)));
            } catch (e) {
                console.error(`GridPlayer ${this.sender}: Error decompressing P-frames blob`, e);
                this.decompressedDiffsBlob = null; // Mark as failed
            }
        }
    }
}

// New class for displaying animated noise
class NoisePlayerData {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { willReadFrequently: true });
        this.type = 'noise'; // To distinguish from GridPlayerData
        this.frameIntervalMs = 1000 / FPS_NOISE; // Use new FPS_NOISE constant
        this.lastFrameRenderTime = 0;
        this.canvas.title = "Noise Video Placeholder";
        this.pixelData = null; // To store current pixel state for distortion
    }

    renderNoiseFrame() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width === 0 || height === 0) return;

        if (!this.pixelData) {
            // Initialize with original TV static-like random pixel data (zoomed in)
            const initialImageData = this.ctx.createImageData(width, height);
            const data = initialImageData.data;
            const grainSize = 2; // Each 2x2 block of pixels will share the same color

            for (let y = 0; y < height; y += grainSize) {
                for (let x = 0; x < width; x += grainSize) {
                    const value = Math.random() > 0.5 ? 255 : 0; // Random black or white
                    for (let dy = 0; dy < grainSize; dy++) {
                        for (let dx = 0; dx < grainSize; dx++) {
                            if (y + dy < height && x + dx < width) {
                                const R_index = ((y + dy) * width + (x + dx)) * 4;
                                data[R_index] = value;     // R
                                data[R_index + 1] = value; // G
                                data[R_index + 2] = value; // B
                                data[R_index + 3] = 255;   // Alpha
                            }
                        }
                    }
                }
            }
            this.ctx.putImageData(initialImageData, 0, 0); 
            this.pixelData = this.ctx.getImageData(0, 0, width, height); 
        }

        // Create a working copy of the pixel data for the new frame
        const currentFramePixels = new Uint8ClampedArray(this.pixelData.data);
        const newFrameImageData = new ImageData(currentFramePixels, width, height);

        const numShifts = Math.floor(Math.random() * (width / 10)) + (width / 20); // Shift 5% to 15% of columns each frame

        for (let i = 0; i < numShifts; i++) {
            const x = Math.floor(Math.random() * width); // Column to shift
            // const yStart = Math.floor(Math.random() * height * 0.75); // No longer needed, we shift full column
            const segHeight = height; // Shift the entire column
            let yShift = Math.floor(Math.random() * 11) - 5; // Shift from -5 to +5 pixels
            if (yShift === 0) yShift = Math.random() > 0.5 ? 1 : -1; 

            for (let yOffset = 0; yOffset < segHeight; yOffset++) {
                const targetY = yOffset; // yStart is effectively 0 for the full column logic
                // if (targetY >= height) continue; // This check becomes redundant if targetY is yOffset and yOffset < segHeight (which is height)

                const sourceY = targetY - yShift;
                
                const targetIndex = (targetY * width + x) * 4;

                if (sourceY >= 0 && sourceY < height) {
                    const sourceIndex = (sourceY * width + x) * 4;
                    newFrameImageData.data[targetIndex] = this.pixelData.data[sourceIndex];         // R
                    newFrameImageData.data[targetIndex + 1] = this.pixelData.data[sourceIndex + 1]; // G
                    newFrameImageData.data[targetIndex + 2] = this.pixelData.data[sourceIndex + 2]; // B
                    newFrameImageData.data[targetIndex + 3] = this.pixelData.data[sourceIndex + 3]; // A
                } else {
                    // Source is out of bounds, fill with PURE BLACK
                    newFrameImageData.data[targetIndex] = 0;     // R (Black)
                    newFrameImageData.data[targetIndex + 1] = 0; // G (Black)
                    newFrameImageData.data[targetIndex + 2] = 0; // B (Black)
                    newFrameImageData.data[targetIndex + 3] = 255;  // A (opaque)
                }
            }
        }
        
        // Update the stored pixel data for the next frame
        this.pixelData = newFrameImageData;
        this.ctx.putImageData(this.pixelData, 0, 0);
    }
}
// --- End Grid Playback State ---

// New Modal Control Functions
function closeRecordModal() {
  recordModal.style.display = 'none';
  stopLivePreview();
  if (recordingInterval) {
    stopRecording(); 
  }
  if (playbackInterval) { // Ensure playback is stopped when modal closes
    clearInterval(playbackInterval);
    playbackInterval = null;
  }
  modalStatusElement.textContent = '';
}

// Event Listeners for Modal
openRecordModalButton.addEventListener('click', () => {
  console.log('Open Record Modal button clicked. Attempting to get user media...');
  // Set a very basic status immediately.
  // Avoid heavy DOM manipulation (like showing the full modal) BEFORE getUserMedia resolves.
  modalStatusElement.textContent = 'Requesting camera permission...';

  navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    .then(stream => {
      console.log('Camera stream acquired successfully!');
      modalStatusElement.textContent = 'Camera access granted. Initializing preview...';

      // --- NOW do all the UI setup that depends on having the stream ---
      recordModal.style.display = 'flex'; // Show the modal

      if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
      }
      recordedFrames = [];
      lastFrameImageData = null;
      reconstructedModalPlaybackFrame = null;

      modalPlayButton.style.display = 'none';
      modalSaveButton.style.display = 'none';
      modalRecordButton.textContent = 'Start Recording';
      modalRecordButton.disabled = true; // Will be enabled after preview setup

      videoElement.srcObject = stream;

      // It's crucial that the video element is already in the DOM and visible
      // if iOS has any visibility heuristics (you've made it visible, which is good).
      // The `autoplay` attribute should ideally handle playback.

      videoElement.onloadedmetadata = () => {
        console.log(`Webcam metadata loaded: ${videoElement.videoWidth}x${videoElement.videoHeight}.`);
        // `autoplay` should have started it, but if not, play explicitly.
        if (videoElement.paused) {
          videoElement.play().then(() => {
            console.log("Video element play() successful after metadata.");
            startLivePreview();
            modalStatusElement.textContent = 'Ready to record.';
            modalRecordButton.disabled = false;
          }).catch(e => {
            console.error("Error attempting to play video after metadata:", e);
            modalStatusElement.textContent = 'Error playing video: ' + (e.message || 'Unknown error');
            stopLivePreview();
            if (videoElement.srcObject) { // Attempt to stop tracks if play failed
                videoElement.srcObject.getTracks().forEach(track => track.stop());
                videoElement.srcObject = null;
            }
          });
        } else {
          console.log("Video already playing (likely due to autoplay).");
          startLivePreview();
          modalStatusElement.textContent = 'Ready to record.';
          modalRecordButton.disabled = false;
        }
      };

      videoElement.onended = () => {
        console.log('Webcam stream ended.');
        stopLivePreview();
      };

      videoElement.onerror = (e) => { // This catches errors on the video element itself
        console.error('Video element error:', e);
        modalStatusElement.textContent = 'Video element error. Cannot display preview.';
        stopLivePreview();
        if (videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(track => track.stop());
            videoElement.srcObject = null;
        }
      };

      // If metadata is already loaded (less common for a fresh stream but for robustness)
      if (videoElement.readyState >= videoElement.HAVE_METADATA) {
        console.log("Video metadata was already available.");
        if (videoElement.onloadedmetadata) videoElement.onloadedmetadata();
      }
      // --- End of UI setup dependent on stream ---
    })
    .catch(err => {
      console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.error('getUserMedia FAILED. Error Name:', err.name);
      console.error('getUserMedia FAILED. Error Message:', err.message);
      console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      modalStatusElement.textContent = `Camera Error: ${err.name} - ${err.message}. Please check site permissions for this app in your browser/OS settings.`;

      // Show modal to display the error, but ensure webcam-dependent UI is disabled/hidden
      recordModal.style.display = 'flex';
      modalRecordButton.disabled = true;
      modalPlayButton.style.display = 'none';
      modalSaveButton.style.display = 'none';
      modalPreviewCanvas.getContext('2d').clearRect(0,0,modalPreviewCanvas.width, modalPreviewCanvas.height); // Clear canvas
      
      // Ensure any previously acquired stream (if any, unlikely here) is stopped
      if (videoElement.srcObject) {
        videoElement.srcObject.getTracks().forEach(track => track.stop());
        videoElement.srcObject = null;
      }
    });
});

closeRecordModalButton.addEventListener('click', closeRecordModal);
// Also close modal if user clicks outside the modal content (on the overlay)
recordModal.addEventListener('click', (event) => {
  if (event.target === recordModal) { // Check if the click is on the overlay itself
    closeRecordModal();
  }
});

// modalRecordButton event listener - adapted from old recordButton logic
modalRecordButton.addEventListener('click', async () => {
  if (recordingInterval) {
    console.log('Modal Recording: stop requested.');
    // If already recording, this button acts as a STOP button
    stopRecording(); 
    return;
  }
  
  // --- This is STARTING a new recording ---
  stopLivePreview(); // Explicitly stop live preview first

  if (playbackInterval) { // Stop modal playback if it's running
    clearInterval(playbackInterval);
    playbackInterval = null; 
    modalPlayButton.disabled = false; // Re-enable play button
    modalPlayButton.textContent = 'Play Preview';
    // Clear the canvas from playback before starting new recording preview
    const modalCtx = modalPreviewCanvas.getContext('2d');
    modalCtx.clearRect(0, 0, modalPreviewCanvas.width, modalPreviewCanvas.height);
  }

  modalPlayButton.style.display = 'none'; 
  modalSaveButton.style.display = 'none'; 
  if (!videoElement.srcObject || !videoElement.srcObject.active) {
    alert('Webcam not started. Please ensure permissions are granted and try again.');
    modalStatusElement.textContent = 'Error: Webcam not active.';
    return;
  }

  console.log('Modal Recording: Starting recording...');
  modalStatusElement.textContent = 'Recording...';
  modalRecordButton.disabled = true; // Disable while setting up
  // Update button text to indicate it can stop recording
  modalRecordButton.textContent = 'Stop Recording';
  modalRecordButton.disabled = false; // Re-enable as a stop button

  recordedFrames = [];
  lastFrameImageData = null;

  const recordingTempCanvas = document.createElement('canvas');
  recordingTempCanvas.width = FRAME_WIDTH;
  recordingTempCanvas.height = FRAME_HEIGHT;
  const recordingContext = recordingTempCanvas.getContext('2d', { willReadFrequently: true });
  
  const frameIntervalMs = 1000 / FPS; 
  let framesCaptured = 0;
  const totalFramesToCapture = (RECORD_DURATION_MS / 1000) * FPS;

  // The main live preview on modalPreviewCanvas (from openRecordModal) should continue.
  // The recording process captures frames and can optionally draw them to modalPreviewCanvas too.

  recordingInterval = setInterval(() => {
    if (framesCaptured >= totalFramesToCapture) {
      stopRecording(); 
      return;
    }

    const videoWidth = videoElement.videoWidth;
    const videoHeight = videoElement.videoHeight;
    if (videoWidth === 0 || videoHeight === 0) {
        console.warn("Modal Recording: Video dimensions are zero, skipping frame capture.");
        return; // Skip this frame if video not ready
    }
    const size = Math.min(videoWidth, videoHeight);
    const sx = (videoWidth - size) / 2;
    const sy = (videoHeight - size) / 2;
    recordingContext.drawImage(videoElement, sx, sy, size, size, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

    let imageData = recordingContext.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    imageData = toGrayscale(imageData);
    imageData = adjustBrightness(imageData, 1.20); 

    // To show what's actually being recorded (after processing) on the modal canvas:
    const modalPreviewCtx = modalPreviewCanvas.getContext('2d');
    modalPreviewCtx.putImageData(imageData, 0, 0);

    let currentFrameStorage;

    if (!lastFrameImageData) { // This is the first frame (I-frame)
      const fullFrameGrayscalePixels = new Uint8Array(TOTAL_PIXELS);
      for (let i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
        fullFrameGrayscalePixels[j] = imageData.data[i];
      }
      const compressedData = pako.deflate(fullFrameGrayscalePixels);
      currentFrameStorage = {
        type: 'full',
        compressedData: compressedData,
      };
    } else { // This is a subsequent frame (P-frame/diff)
      const diffResult = diffFrames(imageData, lastFrameImageData);
      const serializedDiffData = serializeDiff(diffResult.diff);
      currentFrameStorage = {
        type: 'raw_diff',
        serializedData: serializedDiffData,
        originalLength: serializedDiffData.byteLength
      };
    }
    recordedFrames.push(currentFrameStorage);
    lastFrameImageData = imageData;
    framesCaptured++;
    modalStatusElement.textContent = `Recording... ${framesCaptured}/${totalFramesToCapture}`;
  }, frameIntervalMs);
});

// Event listener for modalPlayButton (now primarily for programmatic auto-play)
modalPlayButton.addEventListener('click', () => {
  const modalCtx = modalPreviewCanvas.getContext('2d');
  stopLivePreview(); // Good to ensure this is off

  // Clear any existing playback interval before starting a new one
  if (playbackInterval) {
    clearInterval(playbackInterval);
    playbackInterval = null;
  }

  if (!recordedFrames || recordedFrames.length === 0) {
    // This case should ideally be handled before programmatically clicking,
    // but as a safeguard:
    modalStatusElement.textContent = 'No recording to play.';
    return;
  }

  // Disable Re-record and Save during playback (even if play button is hidden)
  // This prevents interruption issues if the user somehow clicks them via other means
  // or if we re-show the play button later with different logic.
  // Let's assume they remain enabled for now as per earlier logic.
  // modalRecordButton.disabled = true; 
  // modalSaveButton.disabled = true;

  let currentFrameIndex = 0;
  reconstructedModalPlaybackFrame = null; // IMPORTANT: Reset before starting new playback sequence

  playbackInterval = setInterval(() => {
    if (currentFrameIndex >= recordedFrames.length) {
      console.log("Playback: Looping back to frame 0.");
      currentFrameIndex = 0; // Loop
      reconstructedModalPlaybackFrame = null; // Reset for the new loop to ensure first frame is full
    }
    
    if (recordedFrames[currentFrameIndex]) {
        reconstructAndDrawFrame(modalCtx, recordedFrames[currentFrameIndex]);
    } else {
        console.warn(`Playback Loop: Missing frame data at index ${currentFrameIndex}`);
        clearInterval(playbackInterval); // Stop if data is bad
        playbackInterval = null;
        modalStatusElement.textContent = 'Error: Playback data corrupted.';
        // Re-enable buttons if we stop due to error
        modalRecordButton.disabled = false;
        modalSaveButton.disabled = false;
        return;
    }
    currentFrameIndex++;
    const displayFrameNumber = (currentFrameIndex - 1 + recordedFrames.length) % recordedFrames.length + 1;
    modalStatusElement.textContent = `Previewing frame ${displayFrameNumber}/${recordedFrames.length}`;
  }, 1000 / FPS);
});

function stopRecording() {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
    console.log('Modal Recording: Stopped by call to stopRecording(). Total frames:', recordedFrames.length);
  } else {
    console.log('Modal Recording: stopRecording() called but no active recording interval.');
  }

  if (recordedFrames.length > 0) {
    modalSaveButton.style.display = 'inline-block'; 
    modalSaveButton.disabled = false;
    modalRecordButton.textContent = 'Re-record'; 
    modalRecordButton.disabled = false;         
    modalPlayButton.style.display = 'none'; 
    
    // Calculate total *uncompressed* size for display (approximate, as first frame is compressed)
    let estimatedTotalUncompressedSizeBytes = 0;
    if (recordedFrames[0] && recordedFrames[0].type === 'full') {
        // Estimate original size of full frame (TOTAL_PIXELS for grayscale)
        estimatedTotalUncompressedSizeBytes += TOTAL_PIXELS; 
    }
    recordedFrames.slice(1).forEach(frame => {
        if (frame.type === 'raw_diff') {
            estimatedTotalUncompressedSizeBytes += frame.originalLength;
        }
    });
    const estimatedTotalUncompressedSizeKB = (estimatedTotalUncompressedSizeBytes / 1024).toFixed(2);
    
    modalStatusElement.textContent = `Done! ${recordedFrames.length} frames. Playing preview... (Raw size ~${estimatedTotalUncompressedSizeKB} KB)`;
    
    stopLivePreview(); 

    modalPlayButton.click(); 

  } else {
    modalStatusElement.textContent = 'Recording stopped early or failed.';
    modalRecordButton.textContent = 'Start Recording'; 
    modalRecordButton.disabled = false;
    modalPlayButton.style.display = 'none'; 
    modalSaveButton.style.display = 'none'; 
    if (recordModal.style.display === 'flex' && !livePreviewInterval) { 
        startLivePreview(); 
    }
  }
  
  // Log summary including total size
  const recordingTimestamp = new Date().toISOString();
  console.log('--- Modal Recording Summary ---');
  if(currentUserFid) console.log(`FID (from Frame SDK): ${currentUserFid}`);
  console.log(`Timestamp: ${recordingTimestamp}`);
  console.log(`Total Frames: ${recordedFrames.length}`);
  if (recordedFrames.length > 0 && recordedFrames[0] && recordedFrames[0].type === 'full' && recordedFrames[0].compressedData) {
    console.log(`Size of first frame (compressed): ${recordedFrames[0].compressedData.byteLength} bytes (${(recordedFrames[0].compressedData.byteLength / 1024).toFixed(2)} KB)`);
    let totalRawDiffSize = 0;
    recordedFrames.slice(1).forEach(frame => {
        if (frame.type === 'raw_diff') totalRawDiffSize += frame.originalLength;
    });
    console.log(`Total size of raw serialized diffs: ${totalRawDiffSize} bytes (${(totalRawDiffSize / 1024).toFixed(2)} KB)`);
  }
}

// Old playButton listener (commented out, to be adapted for modalPlayButton next)
// playButton.addEventListener('click', () => { ... });

// Modified reconstructAndDrawFrame to handle a global playback state for the modal
let reconstructedModalPlaybackFrame = null; // Specific for modal playback

function reconstructAndDrawFrame(context, storedFrameData, isStaticPreview = false) {
  let decompressedData; // For full frames
  let currentFramePixelArray; // This will be the Uint8Array of grayscale pixels for the target frame

  if (!storedFrameData || !storedFrameData.type) {
      console.error("reconstructAndDrawFrame: Invalid storedFrameData (no type)", storedFrameData);
      context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      context.fillStyle = 'red';
      context.fillText('Invalid frame data', 10, 10);
      return;
  }

  try {
    if (storedFrameData.type === 'full') {
      if (!storedFrameData.compressedData) {
        console.error("reconstructAndDrawFrame: Full frame missing compressedData", storedFrameData);
        context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
        context.fillText('Error full frame data', 10, 10); return;
      }
      decompressedData = pako.inflate(storedFrameData.compressedData);
      currentFramePixelArray = new Uint8Array(decompressedData);
      if (!isStaticPreview) {
        reconstructedModalPlaybackFrame = currentFramePixelArray; // Update playback base for dynamic playback
      }
    } else if (storedFrameData.type === 'raw_diff') { // Handle new raw_diff type for local playback
      if (!storedFrameData.serializedData) {
        console.error("reconstructAndDrawFrame: Raw_diff frame missing serializedData", storedFrameData);
        context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
        context.fillText('Error diff data', 10, 10); return;
      }
      const diffArray = deserializeDiff(storedFrameData.serializedData); // Directly deserialize
      let baseFrameForDiffLogic;

      if (isStaticPreview) {
        // For static preview of a raw_diff, reconstruct from recordedFrames up to this point
        let tempReconstructed = null;
        let foundTarget = false;
        for (const frame of recordedFrames) {
          if (frame.type === 'full') {
            if (!frame.compressedData) { console.error("Static preview: Full frame in sequence missing data"); return; }
            tempReconstructed = new Uint8Array(pako.inflate(frame.compressedData));
          } else if (frame.type === 'raw_diff') { // It's a raw_diff in the sequence
            if (!tempReconstructed) {
              console.error("Static reconstruct: Raw_diff found before full frame in recorded sequence for preview.");
              context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
              context.fillText('Error static diff preview', 10, 10); return;
            }
            if (!frame.serializedData) { console.error("Static preview: Raw_diff in sequence missing data"); return; }
            const diffsToApply = deserializeDiff(frame.serializedData);
            let newPixelData = new Uint8Array(tempReconstructed); // Operate on a copy
            for (const d of diffsToApply) {
              if (d.index < newPixelData.length) newPixelData[d.index] = d.value;
            }
            tempReconstructed = newPixelData;
          }
          // Check if the current frame in the loop is the storedFrameData we want to preview
          if (frame === storedFrameData) { 
            currentFramePixelArray = tempReconstructed;
            foundTarget = true;
            break;
          }
        }
        if (!foundTarget) {
            console.error("Static reconstruct: Target raw_diff frame not found in sequence.", storedFrameData);
            context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
            context.fillText('Error finding static diff', 10, 10); return;
        }
      } else { // Dynamic Playback of raw_diff
        if (!reconstructedModalPlaybackFrame) {
          const firstFullFrame = recordedFrames.find(f => f.type === 'full');
          if (firstFullFrame && firstFullFrame.compressedData) {
              reconstructedModalPlaybackFrame = new Uint8Array(pako.inflate(firstFullFrame.compressedData));
              // If storedFrameData *is* the firstFullFrame (it shouldn't be if type is raw_diff, but defensive check)
              // This path primarily expects storedFrameData to be a raw_diff, so a base must exist or be created.
              baseFrameForDiffLogic = reconstructedModalPlaybackFrame;
          } else {
            console.error('Playback: Cannot reconstruct raw_diff. No base (first full) frame available.');
            context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
            context.fillText('Error playback: no full frame', 10, 10); return;
          }
        } else {
           baseFrameForDiffLogic = reconstructedModalPlaybackFrame;
        }
        
        if (!baseFrameForDiffLogic) {
            console.error('Playback: baseFrameForDiffLogic is unexpectedly null for raw_diff frame.');
            context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
            context.fillText('Error base for diff', 10, 10); return;
        }
        currentFramePixelArray = new Uint8Array(baseFrameForDiffLogic); // Start from the base (copy)
        for (const diff of diffArray) { // diffArray is from the current storedFrameData (raw_diff)
          if (diff.index < currentFramePixelArray.length) currentFramePixelArray[diff.index] = diff.value;
        }
        reconstructedModalPlaybackFrame = currentFramePixelArray; // Update global playback state
      }
    } else { // Old 'diff' type, which should no longer occur for local playback if new recording logic is used.
            // This block is for backwards compatibility or if old data is somehow loaded.
            // We can eventually remove this if all recordings are new.
      console.warn("reconstructAndDrawFrame: Encountered old 'diff' type. Assuming it has compressedData.");
      if (!storedFrameData.compressedData) {
        console.error("reconstructAndDrawFrame: Old diff frame missing compressedData", storedFrameData);
        context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
        context.fillText('Error old diff data', 10, 10); return;
      }
      decompressedData = pako.inflate(storedFrameData.compressedData);
      const diffArray = deserializeDiff(new Uint8Array(decompressedData));
      // ... (rest of old diff logic, which is similar to raw_diff dynamic playback but from compressed source) ...
      // For simplicity, during this refactor, focus on 'full' and 'raw_diff'.
      // If this old path is hit, it will likely rely on reconstructedModalPlaybackFrame being set correctly by a prior full frame.
      if (!reconstructedModalPlaybackFrame) {
          console.error("Old diff playback: no base frame."); return;
      }
      currentFramePixelArray = new Uint8Array(reconstructedModalPlaybackFrame);
      for (const diff of diffArray) { 
        if (diff.index < currentFramePixelArray.length) currentFramePixelArray[diff.index] = diff.value;
      }
      reconstructedModalPlaybackFrame = currentFramePixelArray;
    }

    if (!currentFramePixelArray) {
      console.error("Failed to obtain pixel data for frame after processing.", storedFrameData);
      context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); context.fillStyle = 'red';
      context.fillText('No pixel data', 10, 10);
      return;
    }

    const imageData = context.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    for (let i = 0, j = 0; i < currentFramePixelArray.length; i++, j += 4) {
      imageData.data[j]     = currentFramePixelArray[i];
      imageData.data[j + 1] = currentFramePixelArray[i];
      imageData.data[j + 2] = currentFramePixelArray[i];
      imageData.data[j + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);

  } catch (error) {
    console.error("Error in reconstructAndDrawFrame:", error, "for frame:", storedFrameData);
    context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    context.fillStyle = 'red';
    context.fillText('Reconstruction Error', 10, 10);
  }
}

function logBufferSize(compressedSize, frameNumber, type, originalSize) {
  const listItem = document.createElement('li');
  const compressionRatio = originalSize > 0 ? (compressedSize / originalSize * 100).toFixed(2) : 'N/A';
  listItem.textContent = `Frame ${frameNumber} (${type}): ${originalSize} bytes -> ${compressedSize} bytes (compressed, ${compressionRatio}%)`;
  // bufferSizesLog.appendChild(listItem); // bufferSizesLog is commented out
}

function toGrayscale(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    data[i] = avg;
    data[i + 1] = avg;
    data[i + 2] = avg;
  }
  return imageData;
}

// --- Image Processing and Diffing Utilities ---
function adjustBrightness(imageData, factor) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, data[i] * factor);
    data[i + 1] = Math.min(255, data[i + 1] * factor);
    data[i + 2] = Math.min(255, data[i + 2] * factor);
  }
  return imageData;
}

function serializeDiff(diffArray) {
  // Each diff object has 'index' (pixel index) and 'value' (grayscale value)
  // Assuming index can be up to TOTAL_PIXELS (240*240 = 57600), needs 2 bytes (Uint16)
  // Value is 0-255, needs 1 byte (Uint8)
  // So, 3 bytes per diff entry.
  const buffer = new ArrayBuffer(diffArray.length * 3);
  const view = new DataView(buffer);
  let offset = 0;
  for (const diff of diffArray) {
    view.setUint16(offset, diff.index, true); // true for little-endian
    offset += 2;
    view.setUint8(offset, diff.value);
    offset += 1;
  }
  return new Uint8Array(buffer);
}

function deserializeDiff(uint8Array) {
  const diffArray = [];
  const view = new DataView(uint8Array.buffer);
  let offset = 0;
  while (offset < uint8Array.byteLength) {
    const index = view.getUint16(offset, true);
    offset += 2;
    const value = view.getUint8(offset);
    offset += 1;
    diffArray.push({ index, value });
  }
  return diffArray;
}
// --- End Image Processing and Diffing Utilities ---

function diffFrames(currentFrameImageData, previousFrameImageData) {
  const currentData = currentFrameImageData.data;
  const previousData = previousFrameImageData.data;
  const diffDataArray = [];
  for (let i = 0; i < currentData.length; i += 4) {
    const currentGrayscaleValue = currentData[i];
    const previousGrayscaleValue = previousData[i];
    if (Math.abs(currentGrayscaleValue - previousGrayscaleValue) > 5) {
      diffDataArray.push({ index: i / 4, value: currentGrayscaleValue });
    }
  }
  return { diff: diffDataArray };
}

// Function to calculate and set up the dynamic grid
function setupDynamicGrid() {
    stopMainAnimationLoop(); // Stop animation before re-calculating
    videoGridContainer.innerHTML = ''; // Clear grid before recalculating
    activeGridPlayers = [];

    const containerWidth = videoGridContainer.offsetWidth;
    if (containerWidth === 0) {
        // Fallback or wait for layout if container width isn't available yet
        // For now, let's request an animation frame and try again, or default to a small number
        requestAnimationFrame(setupDynamicGrid); 
        return;
    }

    const cellWidth = containerWidth / 3; // 3 columns
    const cellHeight = cellWidth; // Cells are square

    const viewportHeight = window.innerHeight;
    // Consider some padding or other elements if the grid doesn't take full viewport height
    // For now, assume grid container aims for full available height for simplicity
    const availableHeightForGrid = viewportHeight - videoGridContainer.offsetTop; // Approximate

    let numRows = Math.floor(availableHeightForGrid / cellHeight);
    numRows = Math.max(1, numRows); // Ensure at least 1 row

    const calculatedTotalCells = 3 * numRows;

    loadAndDisplayGridVideos(calculatedTotalCells); 
}

// Debounce function to limit resize event frequency
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

async function loadAndDisplayGridVideos(totalCells) { 
    stopMainAnimationLoop(); 
    activeGridPlayers = []; 
    videoGridContainer.innerHTML = ''; 

    // Initialize grid with noise players first
    for (let i = 0; i < totalCells; i++) { 
        const canvas = document.createElement('canvas');
        canvas.className = 'grid-video-canvas';
        videoGridContainer.appendChild(canvas);
        activeGridPlayers.push(new NoisePlayerData(canvas));
    }

    if (!FRAME_RECORDER_CONTRACT_ADDRESS || FRAME_RECORDER_CONTRACT_ADDRESS.toLowerCase() === '0xyourupdatedcontractaddresshere'.toLowerCase()) {
        console.warn("Grid: Contract address not set. Displaying noise only.");
        videoGridContainer.insertAdjacentHTML('afterbegin', '<p style="color:orange; grid-column: 1 / -1; text-align: center;">Contract address not set. Update main.js.</p>');
        if (activeGridPlayers.length > 0) {
            masterLoopId = requestAnimationFrame(mainAnimationLoop);
        }
        return;
    }
    
    const loadingMessage = document.createElement('p');
    loadingMessage.textContent = 'Loading videos (API & Recent)...';
    loadingMessage.style.cssText = 'color: white; grid-column: 1 / -1; text-align: center;';
    videoGridContainer.insertAdjacentElement('afterbegin', loadingMessage);

    let combinedLogs = [];
    const processedLogSignatures = new Set(); // To avoid duplicates if events overlap slightly

    try {
        // --- Phase 1: Fetch historical logs from API/Worker --- 
        console.log(`Grid: Phase 1 - Attempting to get logs from API endpoint: ${RECENT_LOGS_API_ENDPOINT}`);
        try {
            const response = await fetch(RECENT_LOGS_API_ENDPOINT);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed with status ${response.status}: ${errorText}`);
            }
            const apiResult = await response.json();
            const apiLogs = apiResult.logs || [];
            console.log(`Grid: Phase 1 - Received ${apiLogs.length} logs from API. Last processed block by API: ${apiResult.lastProcessedBlock}`);
            
            apiLogs.forEach(log => {
                // Create a unique signature for each log to help with deduplication
                const logSignature = `${log.transactionHash}-${log.logIndex}`;
                if (!processedLogSignatures.has(logSignature)) {
                    combinedLogs.push(log);
                    processedLogSignatures.add(logSignature);
                }
            });
        } catch (apiError) {
            console.error("Grid: Phase 1 - Error fetching or processing API logs:", apiError);
            // Continue to Phase 2 even if API fails, to get recent logs at least
        }

        // --- Phase 2: Fetch recent logs directly using Viem and public Monad RPC --- 
        console.log("Grid: Phase 2 - Attempting to get recent logs directly from public Monad RPC...");
        try {
            const directPublicClient = createPublicClient({ // Use the original getPublicClient helper if it points to public Monad RPC
                chain: MONAD_TESTNET, // Ensure MONAD_TESTNET uses the public RPC URL if different from Alchemy
                transport: http(import.meta.env.VITE_MONAD_PUBLIC_RPC_URL || 'https://testnet-rpc.monad.xyz') // Explicit public RPC
            });
            if (!directPublicClient.transport.url) {
                 console.warn("Grid: Phase 2 - Public Monad RPC URL for direct fetching is not configured. Add VITE_MONAD_PUBLIC_RPC_URL to .env or rely on fallback.");
            }
            console.log(`Grid: Phase 2 - Using direct RPC: ${directPublicClient.transport.url}`);

            const latestBlockDirect = await directPublicClient.getBlockNumber();
            console.log(`Grid: Phase 2 - Latest block (direct RPC): ${latestBlockDirect}`);

            const DIRECT_BLOCK_RANGE_LIMIT = 100;
            const DIRECT_TOTAL_BLOCKS_TO_QUERY = 200;
            
            let queryFromBlockDirect = BigInt(Math.max(0, Number(latestBlockDirect) - (DIRECT_TOTAL_BLOCKS_TO_QUERY -1)));
            if (queryFromBlockDirect < 0n) queryFromBlockDirect = 0n;

            console.log(`Grid: Phase 2 - Starting direct log query from block ${queryFromBlockDirect} up to ${latestBlockDirect}.`);

            for (let i = 0; i < Math.ceil(DIRECT_TOTAL_BLOCKS_TO_QUERY / DIRECT_BLOCK_RANGE_LIMIT); i++) {
                const chunkFromBlock = queryFromBlockDirect + BigInt(i * DIRECT_BLOCK_RANGE_LIMIT);
                let chunkToBlock = chunkFromBlock + BigInt(DIRECT_BLOCK_RANGE_LIMIT - 1);

                if (chunkFromBlock > latestBlockDirect) break;
                if (chunkToBlock > latestBlockDirect) chunkToBlock = latestBlockDirect;

                // console.log(`Grid: Phase 2 - Fetching direct logs for chunk: ${chunkFromBlock} to ${chunkToBlock}`); // Reduced verbosity
                const directChunkLogs = await directPublicClient.getLogs({
                    address: FRAME_RECORDER_CONTRACT_ADDRESS,
                    event: parseAbiItem('event VideoClipUpdated(address indexed user, uint256 fid, uint256 timestamp)'),
                    fromBlock: chunkFromBlock,
                    toBlock: chunkToBlock
                });

                if (directChunkLogs && directChunkLogs.length > 0) {
                    console.log(`Grid: Phase 2 - Found ${directChunkLogs.length} direct logs in chunk ${chunkFromBlock}-${chunkToBlock}.`);
                    directChunkLogs.forEach(log => {
                        const logSignature = `${log.transactionHash}-${log.logIndex}`;
                        if (!processedLogSignatures.has(logSignature)) {
                            combinedLogs.push(JSON.parse(JSON.stringify(log, (k,v) => typeof v === 'bigint' ? v.toString() : v))); // Ensure BigInts are strings for consistency
                            processedLogSignatures.add(logSignature);
                        }
                    });
                }
                 if (chunkToBlock === latestBlockDirect) break;
            }
        } catch (directRpcError) {
            console.error("Grid: Phase 2 - Error fetching or processing direct RPC logs:", directRpcError);
        }
        
        // --- Phase 3: Process Combined Logs --- 
        console.log(`Grid: Phase 3 - Total combined logs (after deduplication): ${combinedLogs.length}`);
        // console.log('Grid: Combined logs raw result:', JSON.stringify(combinedLogs, null, 2)); // Removed verbose log

        if (videoGridContainer.contains(loadingMessage)) {
            videoGridContainer.removeChild(loadingMessage);
        }

        if (!combinedLogs || combinedLogs.length === 0) {
            console.log('Grid: No VideoClipUpdated logs found from any source. Displaying noise only.');
        } else {
            combinedLogs.sort((a, b) => Number(b.args.timestamp) - Number(a.args.timestamp)); // Sort newest first
            
            const latestUpdates = new Map();
            combinedLogs.forEach(log => {
                if (log.args && log.args.user) { 
                    // Since we sort by timestamp DESC, the first one we see for a user is the latest.
                    if (!latestUpdates.has(log.args.user)) {
                        latestUpdates.set(log.args.user, { 
                            fid: BigInt(log.args.fid), 
                            timestamp: BigInt(log.args.timestamp)
                        });
                    }
                } else {
                    console.warn('Grid: Combined log entry missing args or args.user:', log);
                }
            });
            // console.log('Grid: latestUpdates map (from combined, sorted logs):', latestUpdates); // Removed verbose log

            let contractVideosLoaded = 0;
            const publicClientForClips = getPublicClient(); // This should use Alchemy for getFullClipData if preferred

            // Create an array from the map to control insertion order into activeGridPlayers
            const sortedUniqueUsers = Array.from(latestUpdates.entries());
            // The map already has the latest by user due to insertion logic after sorting combinedLogs.
            // If further specific sorting of users is needed (e.g. by their latest timestamp), it can be done here.
            // For now, map iteration order is fine as combinedLogs was pre-sorted.

            for (const [userAddress, { fid, timestamp }] of sortedUniqueUsers) {
                // console.log(`Grid: Processing final entry for user: ${userAddress}, FID: ${fid}, Timestamp: ${timestamp}`); // Reduced verbosity
                if (contractVideosLoaded >= totalCells) break;

                try {
                    // console.log(`Grid: Calling getFullClipData for user ${userAddress} (using client: ${publicClientForClips.transport.url})`);
                    const clipData = await publicClientForClips.readContract({
                        address: FRAME_RECORDER_CONTRACT_ADDRESS, 
                        abi: frameRecorderAbi,
                        functionName: 'getFullClipData', 
                        args: [userAddress]
                    });
                    
                    // console.log(`Grid: Raw clipData for ${userAddress}:`, JSON.stringify(clipData, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2)); // Removed verbose log

                    const structuredClipData = {
                        firstFrame: clipData[0],
                        compressedDiffs: clipData[1],
                        diffLengths: clipData[2].map(len => Number(len)),
                        fid: clipData[3],
                        timestamp: clipData[4]
                    };
                    // console.log(`Grid: Structured clipData for ${userAddress}:`, structuredClipData); // Removed verbose log

                    if (!structuredClipData.firstFrame || structuredClipData.firstFrame === '0x' || hexToBytes(structuredClipData.firstFrame).length === 0) {
                        console.warn(`Grid: No valid firstFrame data for user ${userAddress}, FID ${fid}. Skipping.`);
                        continue;
                    }

                    // Replace a noise player. Since sortedUniqueUsers is newest first, this inserts at start of available slots.
                    if (contractVideosLoaded < activeGridPlayers.length && activeGridPlayers[contractVideosLoaded] instanceof NoisePlayerData) {
                        const targetCanvas = activeGridPlayers[contractVideosLoaded].canvas;
                        activeGridPlayers[contractVideosLoaded] = new GridPlayerData(targetCanvas, structuredClipData, userAddress, fid, timestamp);
                        activeGridPlayers[contractVideosLoaded].prepareForPlayback(); 
                        // console.log(`Grid: Successfully placed video for ${userAddress} at grid index ${contractVideosLoaded}.`); // Reduced verbosity
                    } else if (contractVideosLoaded >= activeGridPlayers.length) {
                        // This case should ideally not be hit if totalCells matches noise player init
                        console.warn("Grid: Attempted to load more videos than available noise player slots.");
                    }
                    contractVideosLoaded++;
                } catch (userError) {
                    console.error(`Grid: Error loading full clip data for user ${userAddress} (FID: ${fid}):`, userError);
                }
            }
            console.log(`Grid: Loaded ${contractVideosLoaded} contract videos (combined sources) into the grid.`);
        }
    } catch (error) {
        console.error('Grid: Outer error in loadAndDisplayGridVideos:', error);
        if (videoGridContainer.contains(loadingMessage)) {
            videoGridContainer.removeChild(loadingMessage);
        }
        const errorMessage = document.createElement('p');
        errorMessage.textContent = `Error loading videos: ${error.message}`;
        errorMessage.style.cssText = 'color: red; grid-column: 1 / -1; text-align: center;';
        videoGridContainer.insertAdjacentElement('afterbegin', errorMessage);
    }

    if (activeGridPlayers.length > 0 && !masterLoopId) {
        masterLoopId = requestAnimationFrame(mainAnimationLoop);
    }
}

// Initialize Frame SDK context listener (as per Frame docs)
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await frame.sdk.actions.ready();
        console.log('Frame SDK ready signal sent.');
        const context = await frame.sdk.context
        if (context && context.user && context.user.fid) {
            currentUserFid = BigInt(context.user.fid);
            console.log('Frame User FID:', currentUserFid);
            // modalSaveButton.title = `Save recording as FID ${currentUserFid}`; // Assign to modal button later
        } else {
            console.log('Frame context/user not available. FID features for saving disabled.');
        }
        // Load videos after SDK init and FID check
    } catch (e) {
        console.warn('Frame SDK context error or not in Frame environment:', e.message);
        // Attempt to load grid videos even if Frame SDK fails for non-frame environments
        if (!FRAME_RECORDER_CONTRACT_ADDRESS || FRAME_RECORDER_CONTRACT_ADDRESS === '0xYourUpdatedContractAddressHere') {
            // videoGridContainer.innerHTML = '<p style="color:orange;">Contract address not set. Update main.js.</p>'; // Handled by loadAndDisplayGridVideos
        }
    } finally {
        setupDynamicGrid(); // Initial setup
        window.addEventListener('resize', debounce(setupDynamicGrid, 250)); // Re-setup on resize
    }
});

// Renamed and adapted for grid player objects
// Updated renderGridVideoFrame to handle scaling
function renderGridVideoFrame(player) {
    if (!player || player.totalFrames === 0) {
        // console.warn("GridRender: Invalid player or no frames for player", player ? player.sender : 'unknown');
        return; // Nothing to render
    }

    // Ensure data is prepared (blobs decompressed)
    if (!player.reconstructedIBaseFrameData && player.firstFrameCompressed) {
        player.prepareForPlayback(); // Attempt to decompress if not done
        if (!player.reconstructedIBaseFrameData) {
            console.warn(`GridRender: I-Frame for ${player.sender} not ready/failed decompression.`);
            // Optionally draw an error state on canvas
            player.ctx.fillStyle = 'orange';
            player.ctx.fillText('I-ERR', player.canvas.width/2, player.canvas.height/2);
            return;
        }
    }
    if (player.diffLengths && player.diffLengths.length > 0 && !player.decompressedDiffsBlob && player.allDiffsCompressedBlob) {
        player.prepareForPlayback();
        if (!player.decompressedDiffsBlob) {
            console.warn(`GridRender: P-Frames for ${player.sender} not ready/failed decompression.`);
            // Optionally draw an error state on canvas
            player.ctx.fillStyle = 'orange';
            player.ctx.fillText('P-ERR', player.canvas.width/2, player.canvas.height/2);
            return;
        }
    }

    let currentFramePixelData; // This will be the Uint8Array of 160x160 grayscale pixels for the target frame

    try {
        if (player.currentFrameIndex === 0) { // This is the I-frame (first frame)
            if (!player.reconstructedIBaseFrameData) {
                console.warn(`GridRender: I-frame data missing for player ${player.sender}`);
                return;
            }
            currentFramePixelData = player.reconstructedIBaseFrameData;
            player.currentPFramePixelData = player.reconstructedIBaseFrameData; // Set base for next P-frame
        } else { // This is a P-frame (diff frame)
            if (!player.decompressedDiffsBlob || !player.diffLengths || player.currentFrameIndex > player.diffLengths.length) {
                console.warn(`GridRender: P-frame data missing or index out of bounds for ${player.sender}, index ${player.currentFrameIndex -1}`);
                return;
            }
            if (!player.currentPFramePixelData) {
                // This should ideally not happen if I-frame was processed first.
                // Fallback: use I-frame as base if current P-frame state is lost.
                console.warn(`GridRender: Missing base for P-frame ${player.currentFrameIndex - 1} for ${player.sender}. Using I-frame.`);
                if (!player.reconstructedIBaseFrameData) return; // Cannot proceed
                player.currentPFramePixelData = player.reconstructedIBaseFrameData;
            }

            // Calculate offset and length for the current diff in the decompressed blob
            const diffIndexInArray = player.currentFrameIndex - 1; // 0-indexed for diffLengths array
            let offset = 0;
            for (let i = 0; i < diffIndexInArray; i++) {
                offset += player.diffLengths[i];
            }
            const currentDiffLength = player.diffLengths[diffIndexInArray];
            const serializedDiff = player.decompressedDiffsBlob.subarray(offset, offset + currentDiffLength);
            
            const diffArray = deserializeDiff(serializedDiff);
            
            // Apply diff to the *previous* frame's pixel data (which is stored in player.currentPFramePixelData)
            let newPFrameData = new Uint8Array(player.currentPFramePixelData); // Copy previous frame
            for (const diff of diffArray) {
                if (diff.index < newPFrameData.length) { 
                    newPFrameData[diff.index] = diff.value;
                }
            }
            currentFramePixelData = newPFrameData;
            player.currentPFramePixelData = newPFrameData; // Update current P-frame state for the next diff
        }

        if (!currentFramePixelData) {
            console.warn(`GridRender: No pixel data to render for frame ${player.currentFrameIndex} of ${player.sender}`);
            return;
        }

        // --- Drawing & Scaling Logic (remains largely the same) ---
        const gridCanvas = player.canvas;
        const gridCtx = player.ctx;
        const gridWidth = gridCanvas.width;
        const gridHeight = gridCanvas.height;

        // Create ImageData for the source resolution (160x160)
        const sourceImageData = gridCtx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
        for (let i = 0, j = 0; i < currentFramePixelData.length; i++, j += 4) {
            sourceImageData.data[j]     = currentFramePixelData[i];
            sourceImageData.data[j + 1] = currentFramePixelData[i];
            sourceImageData.data[j + 2] = currentFramePixelData[i];
            sourceImageData.data[j + 3] = 255;
        }
        
        // Use a temporary canvas to draw the 160x160 image data
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = FRAME_WIDTH;
        tempCanvas.height = FRAME_HEIGHT;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(sourceImageData, 0, 0);

        // Clear the grid canvas
        gridCtx.clearRect(0, 0, gridWidth, gridHeight);

        // Disable image smoothing for sharp pixelated look when scaling up
        gridCtx.imageSmoothingEnabled = false; 

        // Draw the temporary 160x160 canvas onto the grid canvas, scaling it
        gridCtx.drawImage(tempCanvas, 0, 0, FRAME_WIDTH, FRAME_HEIGHT, 0, 0, gridWidth, gridHeight);
        
        // Draw FID on bottom right (after scaling)
        if (player.fid) {
            gridCtx.font = 'bold 10px Arial'; 
            gridCtx.fillStyle = 'rgba(255, 255, 255, 0.7)'; 
            gridCtx.textAlign = 'right';
            gridCtx.fillText(`FID: ${player.fid}`, gridWidth - 5, gridHeight - 5); 
        }
        // --- End Drawing & Scaling Logic ---

    } catch (e) {
        console.error(`GridRenderErr for ${player.sender}`, e);
        // Optionally clear canvas on error
        player.ctx.fillStyle = 'red';
        player.ctx.fillText('ERR', gridWidth/2, gridHeight/2);
    }
}

function mainAnimationLoop(timestamp) {
    activeGridPlayers.forEach(player => {
        if (timestamp - player.lastFrameRenderTime >= player.frameIntervalMs) {
            if (player.type === 'noise') {
                player.renderNoiseFrame();
            } else { // Assumes it's GridPlayerData or similar with frames
                renderGridVideoFrame(player);
                player.currentFrameIndex = (player.currentFrameIndex + 1) % player.totalFrames;
            }
            player.lastFrameRenderTime = timestamp;
        }
    });
    masterLoopId = requestAnimationFrame(mainAnimationLoop);
}

function stopMainAnimationLoop() {
    if (masterLoopId) {
        cancelAnimationFrame(masterLoopId);
        masterLoopId = null;
    }
}

modalSaveButton.addEventListener('click', async () => {
  if (playbackInterval) {
    clearInterval(playbackInterval);
    playbackInterval = null;
  }
  
  modalRecordButton.disabled = true;
  modalSaveButton.disabled = true;
  modalStatusElement.textContent = 'Preparing to save...';

  if (!recordedFrames || recordedFrames.length === 0) {
    modalStatusElement.textContent = 'No recorded frames to save.';
    modalRecordButton.disabled = false;
    modalSaveButton.disabled = false;
    return;
  }

  // --- Start: Frame data processing and compression (moved earlier for logging) --- 
  modalStatusElement.textContent = 'Processing frame data for compression metrics...';
  
  const firstFrameData = recordedFrames.find(frame => frame.type === 'full');
  if (!firstFrameData || !firstFrameData.compressedData) {
      modalStatusElement.textContent = 'Error: First frame data is missing or invalid.';
      console.error('Save error: First frame (full) not found or data missing in recordedFrames.');
      modalRecordButton.disabled = false;
      modalSaveButton.disabled = false;
      return;
  }
  const firstFrameBytesForContract = bytesToHex(firstFrameData.compressedData);

  const diffFramesRaw = recordedFrames.filter(frame => frame.type === 'raw_diff');
  const diffLengthsForContract = diffFramesRaw.map(frame => frame.originalLength); 

  let concatenatedRawDiffsArray;
  if (diffFramesRaw.length > 0) {
      const totalRawDiffsLength = diffFramesRaw.reduce((sum, frame) => sum + frame.originalLength, 0);
      concatenatedRawDiffsArray = new Uint8Array(totalRawDiffsLength);
      let offset = 0;
      for (const frame of diffFramesRaw) {
          concatenatedRawDiffsArray.set(frame.serializedData, offset);
          offset += frame.originalLength;
      }
  } else {
      concatenatedRawDiffsArray = new Uint8Array(0); 
  }
  
  const compressedDiffsBytesForContract = bytesToHex(pako.deflate(concatenatedRawDiffsArray));

  // --- Output Compression Metrics --- 
  console.log('--- Pre-Save Compression Metrics ---');
  console.log(`Recorded Frames Count: ${recordedFrames.length}`);
  console.log(`First Frame (I-Frame) Compressed Size: ${firstFrameData.compressedData.byteLength} bytes`);
  console.log(`Number of Diff Frames (P-Frames): ${diffFramesRaw.length}`);
  if (diffFramesRaw.length > 0) {
    console.log(`Total Size of Concatenated RAW Serialized Diffs (before final compression): ${concatenatedRawDiffsArray.byteLength} bytes`);
    console.log(`Final Compressed Size of All Diffs Blob (P-Frames): ${hexToBytes(compressedDiffsBytesForContract).byteLength} bytes`);
    const savings = concatenatedRawDiffsArray.byteLength - hexToBytes(compressedDiffsBytesForContract).byteLength;
    const percentageSavings = concatenatedRawDiffsArray.byteLength > 0 ? (savings / concatenatedRawDiffsArray.byteLength * 100).toFixed(2) : 0;
    console.log(`Compression Savings on Diffs Blob: ${savings} bytes (${percentageSavings}%)`);
  } else {
    console.log('No diff frames to compress.');
  }
  const estimatedTotalSizeForContract = firstFrameData.compressedData.byteLength + (diffFramesRaw.length > 0 ? hexToBytes(compressedDiffsBytesForContract).byteLength : 0);
  console.log(`Estimated Total Bytes for Contract (I-frame + Compressed P-frames blob): ${estimatedTotalSizeForContract} bytes (${(estimatedTotalSizeForContract/1024).toFixed(2)} KB)`);
  // --- End: Frame data processing and compression --- 

  // Re-check/ensure currentUserFid is available
  if (!currentUserFid) {
    try {
        console.log('Save: currentUserFid not initially set, trying to get from Frame SDK context...');
        const context = await frame.sdk.context;
        // Workaround for potential nested user object
        let user = context.user;
        if (user && user.user) { 
            user = user.user; 
        }
        if (user && user.fid) {
            currentUserFid = BigInt(user.fid);
            console.log('Save: Re-fetched Frame User FID:', currentUserFid);
        } else {
            modalStatusElement.textContent = 'Error: User FID not found. Ensure you are in a Farcaster Frame.';
            console.error('Save: FID not found in Frame context after re-check.');
            modalRecordButton.disabled = false;
            modalSaveButton.disabled = false;
            return;
        }
    } catch (e) {
        modalStatusElement.textContent = 'Error: Could not get FID from Frame. Ensure app is in a Farcaster client.';
        console.error("Error getting frame context for FID on save:", e);
        modalRecordButton.disabled = false;
        modalSaveButton.disabled = false;
        return;
    }
  }
  
  if (!frame.sdk || !frame.sdk.wallet || !frame.sdk.wallet.ethProvider) {
      modalStatusElement.textContent = 'Error: Frame Wallet not detected. Ensure app is in a Farcaster client.';
      modalRecordButton.disabled = false;
      modalSaveButton.disabled = false;
      return;
  }

  try {
    modalStatusElement.textContent = 'Connecting to Frame wallet...';
    const accounts = await frame.sdk.wallet.ethProvider.request({ method: 'eth_requestAccounts' });
    
    if (!accounts || accounts.length === 0 || !accounts[0]) {
      modalStatusElement.textContent = 'Error: No account in Frame wallet. Please connect/select one.';
      modalRecordButton.disabled = false;
      modalSaveButton.disabled = false;
      return;
    }
    const account = accounts[0]; 

    modalStatusElement.textContent = 'Checking network...';
    const chainIdHex = await frame.sdk.wallet.ethProvider.request({ method: 'eth_chainId' });
    const currentChainId = parseInt(chainIdHex, 16);

    if (currentChainId !== MONAD_TESTNET_CHAIN_ID) {
        modalStatusElement.textContent = `Switching to Monad Testnet (ID: ${MONAD_TESTNET_CHAIN_ID})...`;
        try {
            await frame.sdk.wallet.ethProvider.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x' + MONAD_TESTNET_CHAIN_ID.toString(16) }],
            });
            modalStatusElement.textContent = 'Network switched. Please click "Save to Monad" again.';
            console.log('Network switched to Monad Testnet. User should re-initiate save.');
        } catch (switchError) {
            console.error('Failed to switch network:', switchError);
            modalStatusElement.textContent = `Error: Failed to switch to Monad Testnet. Please switch manually.`;
        }
        modalRecordButton.disabled = false;
        modalSaveButton.disabled = false;
        return; 
    }

    modalStatusElement.textContent = 'Encoding transaction for new contract...';
    const callData = encodeFunctionData({
        abi: frameRecorderAbi,
        functionName: 'setFrames',
        args: [firstFrameBytesForContract, compressedDiffsBytesForContract, diffLengthsForContract, currentUserFid],
    });

    modalStatusElement.textContent = 'Requesting signature via Frame...';
    
    const txHash = await frame.sdk.wallet.ethProvider.request({
        method: 'eth_sendTransaction',
        params: [{
            from: account,
            to: FRAME_RECORDER_CONTRACT_ADDRESS,
            data: callData,
        }],
    });

    modalStatusElement.textContent = `Tx sent: ${txHash.substring(0,10)}... Confirming...`;
    
    const publicClient = getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'success') {
      modalStatusElement.textContent = 'Video saved successfully to Monad!';
      console.log('Save transaction successful via Frame SDK:', receipt);
      setTimeout(() => {
        setupDynamicGrid();
      }, 1500); // Slightly increased delay for chain propagation if needed
    } else {
      modalStatusElement.textContent = 'Transaction failed. Check console for details.';
      console.error('Save transaction failed via Frame SDK:', receipt);
    }

  } catch (error) {
    console.error('Error saving video via Frame SDK:', error);
    let errorMessage = 'Error saving video.';
    if (error.data && error.data.message) errorMessage = error.data.message;
    else if (error.message) errorMessage = error.message;
    else if (error.shortMessage) errorMessage = error.shortMessage;
    
    if (error.code) errorMessage += ` (Code: ${error.code})`;

    modalStatusElement.textContent = `Error: ${errorMessage}`;
  } finally {
    modalRecordButton.disabled = false;
    modalSaveButton.disabled = false;
  }
});

