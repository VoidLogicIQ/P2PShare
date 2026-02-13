const SIGNALING_ENDPOINT = "api.php";
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const CHUNK_SIZE = 16 * 1024;
const POLL_INTERVAL_MS = 900;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const senderFileInput = document.getElementById("sender-file");
const generatePinBtn = document.getElementById("generate-pin-btn");
const senderPinDisplay = document.getElementById("sender-pin");
const senderStatusEl = document.getElementById("sender-status");

const receiverPinInput = document.getElementById("receiver-pin-input");
const connectPinBtn = document.getElementById("connect-pin-btn");
const receiverStatusEl = document.getElementById("receiver-status");
const downloadProgress = document.getElementById("download-progress");
const downloadPercent = document.getElementById("download-percent");

const senderState = {
  pin: "",
  peerId: "",
  pc: null,
  dataChannel: null,
  file: null,
  transferring: false,
  receiverConnected: false,
  pendingIce: [],
  pollTimer: null,
  pollInFlight: false,
};

const receiverState = {
  pin: "",
  peerId: "",
  pc: null,
  dataChannel: null,
  pendingIce: [],
  pollTimer: null,
  pollInFlight: false,
  incomingMeta: null,
  chunks: [],
  receivedSize: 0,
};

if (!isHttpsAllowed()) {
  setStatus(senderStatusEl, "Open this page over HTTPS to use P2P transfer.", true);
  setStatus(receiverStatusEl, "Open this page over HTTPS to use P2P transfer.", true);
}

generatePinBtn.addEventListener("click", () => {
  void startSenderSession();
});

senderFileInput.addEventListener("change", () => {
  senderState.file = senderFileInput.files[0] || null;
  if (senderState.file) {
    setStatus(senderStatusEl, `Selected file: ${senderState.file.name}`);
  }
  void maybeSendFile();
});

receiverPinInput.addEventListener("input", () => {
  receiverPinInput.value = receiverPinInput.value.replace(/\D/g, "").slice(0, 6);
});

connectPinBtn.addEventListener("click", () => {
  void startReceiverSession();
});

window.addEventListener("beforeunload", () => {
  sendLeaveBeacon(senderState);
  sendLeaveBeacon(receiverState);
});

async function startSenderSession() {
  senderState.file = senderFileInput.files[0] || null;
  await cleanupSenderConnection();

  senderPinDisplay.textContent = "------";
  setStatus(senderStatusEl, "Creating secure room...");

  if (!isHttpsAllowed()) {
    setStatus(senderStatusEl, "Use HTTPS (or localhost) before generating PIN.", true);
    return;
  }

  const response = await apiRequest({ action: "create-room" });
  if (!response.ok) {
    setStatus(senderStatusEl, response.error, true);
    return;
  }

  const pin = response.data?.pin;
  const peerId = response.data?.peerId;
  if (!isValidPin(pin) || !isValidPeerId(peerId)) {
    setStatus(senderStatusEl, "Invalid create-room response.", true);
    return;
  }

  senderState.pin = pin;
  senderState.peerId = peerId;
  senderPinDisplay.textContent = pin;

  setupSenderPeerConnection();
  startSenderPolling();
  setStatus(senderStatusEl, "Room created. Waiting for receiver...");
}

async function startReceiverSession() {
  const pin = receiverPinInput.value.trim();
  if (!isValidPin(pin)) {
    setStatus(receiverStatusEl, "Enter a valid 6-digit numeric PIN.", true);
    return;
  }

  await cleanupReceiverConnection();
  resetReceiverDownloadState();
  setStatus(receiverStatusEl, "Joining secure room...");

  if (!isHttpsAllowed()) {
    setStatus(receiverStatusEl, "Use HTTPS (or localhost) before connecting.", true);
    return;
  }

  const response = await apiRequest({ action: "join-room", pin });
  if (!response.ok) {
    setStatus(receiverStatusEl, response.error, true);
    return;
  }

  const peerId = response.data?.peerId;
  if (!isValidPeerId(peerId)) {
    setStatus(receiverStatusEl, "Invalid join-room response.", true);
    return;
  }

  receiverState.pin = pin;
  receiverState.peerId = peerId;

  setupReceiverPeerConnection();
  startReceiverPolling();
  setStatus(receiverStatusEl, "Joined room. Waiting for sender offer...");
}

function setupSenderPeerConnection() {
  if (senderState.pc) {
    senderState.pc.close();
  }
  senderState.pendingIce = [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  senderState.pc = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !senderState.pin || !senderState.peerId) {
      return;
    }
    sendSignal(senderState, "ice-candidate", event.candidate, senderStatusEl).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setStatus(senderStatusEl, "Peer connection established.");
    } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      setStatus(senderStatusEl, `Connection state: ${pc.connectionState}`, true);
    }
  };

  const channel = pc.createDataChannel("file-transfer");
  senderState.dataChannel = channel;
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    setStatus(senderStatusEl, "Data channel open.");
    void maybeSendFile();
  };
  channel.onerror = () => {
    setStatus(senderStatusEl, "Data channel error.", true);
  };
  channel.onclose = () => {
    setStatus(senderStatusEl, "Data channel closed.", true);
  };
}

function setupReceiverPeerConnection() {
  if (receiverState.pc) {
    receiverState.pc.close();
  }
  receiverState.pendingIce = [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  receiverState.pc = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !receiverState.pin || !receiverState.peerId) {
      return;
    }
    sendSignal(receiverState, "ice-candidate", event.candidate, receiverStatusEl).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setStatus(receiverStatusEl, "Peer connection established.");
    } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      setStatus(receiverStatusEl, `Connection state: ${pc.connectionState}`, true);
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    receiverState.dataChannel = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      setStatus(receiverStatusEl, "Ready to receive file.");
    };
    channel.onmessage = (messageEvent) => {
      handleIncomingData(messageEvent.data);
    };
    channel.onerror = () => {
      setStatus(receiverStatusEl, "Data channel error.", true);
    };
    channel.onclose = () => {
      setStatus(receiverStatusEl, "Data channel closed.", true);
    };
  };
}

function startSenderPolling() {
  stopSenderPolling();
  const poll = async () => {
    if (!senderState.pin || !senderState.peerId) {
      return;
    }
    if (senderState.pollInFlight) {
      senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    senderState.pollInFlight = true;
    const response = await apiRequest({
      action: "poll",
      pin: senderState.pin,
      peerId: senderState.peerId,
    });
    senderState.pollInFlight = false;

    if (!response.ok) {
      if (isRoomMissingError(response.error)) {
        senderState.receiverConnected = false;
        setStatus(senderStatusEl, "Room closed or expired.", true);
        stopSenderPolling();
        return;
      }
      setStatus(senderStatusEl, `Signaling error: ${response.error}`, true);
      if (senderState.pin && senderState.peerId) {
        senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
      return;
    }

    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    for (const message of messages) {
      await handleSenderSignal(message);
    }
    if (senderState.pin && senderState.peerId) {
      senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();
}

function startReceiverPolling() {
  stopReceiverPolling();
  const poll = async () => {
    if (!receiverState.pin || !receiverState.peerId) {
      return;
    }
    if (receiverState.pollInFlight) {
      receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    receiverState.pollInFlight = true;
    const response = await apiRequest({
      action: "poll",
      pin: receiverState.pin,
      peerId: receiverState.peerId,
    });
    receiverState.pollInFlight = false;

    if (!response.ok) {
      if (isRoomMissingError(response.error)) {
        setStatus(receiverStatusEl, "Sender disconnected.", true);
        stopReceiverPolling();
        return;
      }
      setStatus(receiverStatusEl, `Signaling error: ${response.error}`, true);
      if (receiverState.pin && receiverState.peerId) {
        receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
      return;
    }

    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    for (const message of messages) {
      await handleReceiverSignal(message);
    }
    if (receiverState.pin && receiverState.peerId) {
      receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();
}

async function handleSenderSignal(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return;
  }

  if (message.type === "receiver-connected") {
    senderState.receiverConnected = true;
    setStatus(senderStatusEl, "Receiver connected. Negotiating secure channel...");
    await createAndSendOffer();
    return;
  }

  if (message.type === "answer" && senderState.pc && message.payload) {
    try {
      await senderState.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await flushPendingIce(senderState, senderStatusEl);
      setStatus(senderStatusEl, "Connected. Waiting for data channel to open...");
    } catch (err) {
      setStatus(senderStatusEl, `Failed to apply answer: ${String(err)}`, true);
    }
    return;
  }

  if (message.type === "ice-candidate" && senderState.pc && message.payload) {
    await queueOrAddIce(senderState, message.payload, senderStatusEl);
    return;
  }

  if (message.type === "peer-disconnected") {
    senderState.receiverConnected = false;
    setStatus(senderStatusEl, "Receiver disconnected.", true);
  }
}

async function handleReceiverSignal(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return;
  }

  if (message.type === "offer") {
    if (!receiverState.pc) {
      setupReceiverPeerConnection();
    }
    await handleIncomingOffer(message.payload);
    return;
  }

  if (message.type === "ice-candidate" && receiverState.pc && message.payload) {
    await queueOrAddIce(receiverState, message.payload, receiverStatusEl);
    return;
  }

  if (message.type === "peer-disconnected") {
    setStatus(receiverStatusEl, "Sender disconnected.", true);
    stopReceiverPolling();
  }
}

async function createAndSendOffer() {
  if (!senderState.pc || !senderState.pin || !senderState.peerId) {
    return;
  }

  try {
    const offer = await senderState.pc.createOffer();
    await senderState.pc.setLocalDescription(offer);
    await sendSignal(senderState, "offer", offer, senderStatusEl);
  } catch (err) {
    setStatus(senderStatusEl, `Failed to create offer: ${String(err)}`, true);
  }
}

async function handleIncomingOffer(offerPayload) {
  if (!receiverState.pc || !receiverState.pin || !receiverState.peerId) {
    return;
  }
  if (!offerPayload) {
    setStatus(receiverStatusEl, "Offer payload missing.", true);
    return;
  }

  try {
    await receiverState.pc.setRemoteDescription(new RTCSessionDescription(offerPayload));
    await flushPendingIce(receiverState, receiverStatusEl);
    const answer = await receiverState.pc.createAnswer();
    await receiverState.pc.setLocalDescription(answer);
    await sendSignal(receiverState, "answer", answer, receiverStatusEl);
    setStatus(receiverStatusEl, "Offer accepted. Finalizing connection...");
  } catch (err) {
    setStatus(receiverStatusEl, `Failed to handle offer: ${String(err)}`, true);
  }
}

async function sendSignal(state, type, payload, statusElement) {
  const response = await apiRequest({
    action: "send-signal",
    pin: state.pin,
    peerId: state.peerId,
    type,
    payload,
  });

  if (!response.ok) {
    setStatus(statusElement, `Signaling error: ${response.error}`, true);
    throw new Error(response.error);
  }
}

async function queueOrAddIce(state, candidatePayload, statusElement) {
  if (!state.pc || !candidatePayload) {
    return;
  }
  if (state.pc.remoteDescription && state.pc.remoteDescription.type) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
    } catch (err) {
      setStatus(statusElement, `Failed to add ICE candidate: ${String(err)}`, true);
    }
    return;
  }
  state.pendingIce.push(candidatePayload);
}

async function flushPendingIce(state, statusElement) {
  if (!state.pc) {
    state.pendingIce = [];
    return;
  }
  while (state.pendingIce.length > 0) {
    const candidatePayload = state.pendingIce.shift();
    if (!candidatePayload) {
      continue;
    }
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
    } catch (err) {
      setStatus(statusElement, `Failed to add queued ICE candidate: ${String(err)}`, true);
      break;
    }
  }
}

async function maybeSendFile() {
  const channel = senderState.dataChannel;
  if (!channel || channel.readyState !== "open") {
    return;
  }
  if (!senderState.receiverConnected || senderState.transferring) {
    return;
  }

  const file = senderFileInput.files[0] || senderState.file;
  if (!file) {
    setStatus(senderStatusEl, "Choose a file to send.");
    return;
  }

  senderState.file = file;
  await sendFileInChunks(file);
}

async function sendFileInChunks(file) {
  const channel = senderState.dataChannel;
  if (!channel || channel.readyState !== "open") {
    setStatus(senderStatusEl, "Data channel is not open.", true);
    return;
  }

  senderState.transferring = true;
  setStatus(senderStatusEl, "Preparing file...");

  try {
    const buffer = await file.arrayBuffer();
    channel.send(
      JSON.stringify({
        type: "file-meta",
        name: file.name,
        size: file.size,
      })
    );

    if (file.size === 0) {
      setStatus(senderStatusEl, "Empty file sent.", false, true);
      senderState.transferring = false;
      return;
    }

    let offset = 0;
    let lastPercent = -1;

    while (offset < buffer.byteLength) {
      while (channel.bufferedAmount > CHUNK_SIZE * 64) {
        await wait(10);
      }

      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      channel.send(buffer.slice(offset, end));
      offset = end;

      const percent = Math.floor((offset / buffer.byteLength) * 100);
      if (percent !== lastPercent && (percent % 5 === 0 || percent === 100)) {
        lastPercent = percent;
        setStatus(senderStatusEl, `Sending file... ${percent}%`);
      }
    }

    setStatus(senderStatusEl, "File sent successfully.", false, true);
  } catch (err) {
    setStatus(senderStatusEl, `Failed to send file: ${String(err)}`, true);
  } finally {
    senderState.transferring = false;
  }
}

function handleIncomingData(data) {
  if (typeof data === "string") {
    const parsed = parseJsonObject(data);
    if (parsed && parsed.type === "file-meta") {
      const name = typeof parsed.name === "string" ? parsed.name : "download.bin";
      const size = Number(parsed.size);
      if (!Number.isFinite(size) || size < 0) {
        setStatus(receiverStatusEl, "Invalid file metadata.", true);
        return;
      }

      receiverState.incomingMeta = { name, size };
      receiverState.chunks = [];
      receiverState.receivedSize = 0;
      updateReceiverProgress(0);
      setStatus(receiverStatusEl, `Receiving "${name}"...`);

      if (size === 0) {
        completeDownload();
      }
    }
    return;
  }

  if (data instanceof ArrayBuffer) {
    appendIncomingChunk(data);
    return;
  }

  if (data instanceof Blob) {
    data
      .arrayBuffer()
      .then(appendIncomingChunk)
      .catch(() => {
        setStatus(receiverStatusEl, "Failed to read incoming chunk.", true);
      });
  }
}

function appendIncomingChunk(buffer) {
  const meta = receiverState.incomingMeta;
  if (!meta) {
    return;
  }

  receiverState.chunks.push(buffer);
  receiverState.receivedSize += buffer.byteLength;

  const percent =
    meta.size > 0
      ? Math.min(100, Math.floor((receiverState.receivedSize / meta.size) * 100))
      : 100;

  updateReceiverProgress(percent);
  setStatus(receiverStatusEl, `Receiving "${meta.name}"... ${percent}%`);

  if (receiverState.receivedSize >= meta.size) {
    completeDownload();
  }
}

function completeDownload() {
  const meta = receiverState.incomingMeta;
  if (!meta) {
    return;
  }

  const blob = new Blob(receiverState.chunks);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = meta.name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  updateReceiverProgress(100);
  setStatus(receiverStatusEl, `Download complete: ${meta.name}`, false, true);

  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
}

async function cleanupSenderConnection() {
  stopSenderPolling();
  await leaveRoom(senderState);

  if (senderState.dataChannel) {
    senderState.dataChannel.close();
  }
  senderState.dataChannel = null;

  if (senderState.pc) {
    senderState.pc.close();
  }
  senderState.pc = null;

  senderState.pin = "";
  senderState.peerId = "";
  senderState.pendingIce = [];
  senderState.transferring = false;
  senderState.receiverConnected = false;
}

async function cleanupReceiverConnection() {
  stopReceiverPolling();
  await leaveRoom(receiverState);

  if (receiverState.dataChannel) {
    receiverState.dataChannel.close();
  }
  receiverState.dataChannel = null;

  if (receiverState.pc) {
    receiverState.pc.close();
  }
  receiverState.pc = null;

  receiverState.pin = "";
  receiverState.peerId = "";
  receiverState.pendingIce = [];
  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
}

function stopSenderPolling() {
  if (senderState.pollTimer) {
    clearTimeout(senderState.pollTimer);
  }
  senderState.pollTimer = null;
  senderState.pollInFlight = false;
}

function stopReceiverPolling() {
  if (receiverState.pollTimer) {
    clearTimeout(receiverState.pollTimer);
  }
  receiverState.pollTimer = null;
  receiverState.pollInFlight = false;
}

async function leaveRoom(state) {
  if (!isValidPin(state.pin) || !isValidPeerId(state.peerId)) {
    return;
  }
  await apiRequest({
    action: "leave",
    pin: state.pin,
    peerId: state.peerId,
  });
}

function sendLeaveBeacon(state) {
  if (!isValidPin(state.pin) || !isValidPeerId(state.peerId)) {
    return;
  }

  const body = JSON.stringify({
    action: "leave",
    pin: state.pin,
    peerId: state.peerId,
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(SIGNALING_ENDPOINT, blob);
    return;
  }

  fetch(SIGNALING_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    cache: "no-store",
  }).catch(() => {});
}

function resetReceiverDownloadState() {
  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
  updateReceiverProgress(0);
}

function updateReceiverProgress(percent) {
  const safe = Math.min(100, Math.max(0, Number(percent) || 0));
  downloadProgress.value = safe;
  downloadPercent.textContent = `${safe}%`;
}

async function apiRequest(payload) {
  try {
    const response = await fetch(SIGNALING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const message =
        data && typeof data.error === "string" && data.error
          ? data.error
          : `Request failed (${response.status})`;
      return { ok: false, error: message };
    }

    return { ok: true, data: data.data || {} };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

function isValidPin(pin) {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

function isValidPeerId(peerId) {
  return typeof peerId === "string" && /^[a-f0-9]{32}$/.test(peerId);
}

function isRoomMissingError(errorText) {
  return typeof errorText === "string" && /room not found|expired|closed/i.test(errorText);
}

function isHttpsAllowed() {
  return window.location.protocol === "https:" || LOCAL_HOSTS.has(window.location.hostname);
}

function setStatus(element, text, isError = false, isSuccess = false) {
  element.textContent = text;
  element.classList.remove("error", "success");
  if (isError) {
    element.classList.add("error");
  } else if (isSuccess) {
    element.classList.add("success");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
