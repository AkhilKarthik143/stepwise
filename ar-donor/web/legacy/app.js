/*
 * AR Technician Assistant — client logic.
 * ---------------------------------------
 * On "Connect":
 *   1. Capture the technician's viewpoint (camera) + voice (mic) via
 *      getUserMedia. This works whether or not an immersive WebXR session is
 *      active, which sidesteps the fragmented state of raw camera-pixel access
 *      inside WebXR today.
 *   2. Open a WebRTC RTCPeerConnection, push the local audio+video tracks to
 *      the FastAPI backend, and POST the SDP offer to /offer.
 *   3. Apply the SDP answer. The backend adds ONE audio track (the AI's voice);
 *      we route it to a hidden <audio> element that autoplays.
 */
(() => {
  "use strict";

  const connectBtn = document.getElementById("connect-btn");
  const hangupBtn = document.getElementById("hangup-btn");
  const connStatus = document.getElementById("conn-status");
  const localVideo = document.getElementById("local-video");
  const remoteAudio = document.getElementById("remote-audio");
  const logEl = document.getElementById("log");
  const statusLabel = document.getElementById("status-label");

  let pc = null;
  let localStream = null;
  let reconnectTimer = null;

  // ---- UI helpers --------------------------------------------------------
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    if (logEl) {
      const div = document.createElement("div");
      div.textContent = line;
      logEl.prepend(div);
      while (logEl.childNodes.length > 12) logEl.removeChild(logEl.lastChild);
    }
  }

  function setStatus(text, cls) {
    if (connStatus) {
      connStatus.textContent = text;
      connStatus.className = "status " + (cls || "");
    }
    if (statusLabel) {
      statusLabel.setAttribute(
        "text",
        `value: ${text}; align: center; color: #FFFFFF; width: 1.4`
      );
    }
  }

  // Wait for ICE gathering to finish — aiortc on the backend does NOT do
  // trickle ICE, so we send the offer only once candidates are gathered.
  function waitForIceGathering(peer) {
    return new Promise((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      const check = () => {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", check);
      // Safety timeout: don't hang forever if a candidate stalls.
      setTimeout(resolve, 3000);
    });
  }

  // ---- Connect flow ------------------------------------------------------
  async function connect() {
    connectBtn.disabled = true;
    setStatus("Requesting camera & mic…", "connecting");

    try {
      // Prefer the rear/environment camera (the technician's viewpoint).
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      log("getUserMedia failed: " + err);
      setStatus("Camera/mic denied", "error");
      connectBtn.disabled = false;
      return;
    }

    localVideo.srcObject = localStream;
    log("Local media acquired (" + localStream.getTracks().map((t) => t.kind).join("+") + ").");

    // If a device is unplugged or permission is revoked mid-call, the track ends
    // while pc can stay "connected" — surface it instead of silent dead-air.
    localStream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        log(track.kind + " track ended (device lost or permission revoked).");
        setStatus("Camera/mic lost", "error");
        teardown();
      });
    });

    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // The backend sends back ONE audio track: the AI's spoken response.
    pc.addEventListener("track", (evt) => {
      if (evt.track.kind === "audio") {
        log("Receiving AI audio track.");
        remoteAudio.srcObject = evt.streams[0] || new MediaStream([evt.track]);
        // Connect was a user gesture, so autoplay-with-sound is allowed.
        remoteAudio.play().catch((e) => log("audio play blocked: " + e));
      }
    });

    // Snapshot this peer so a connectionstatechange event that browsers queue
    // *after* teardown (which sets the module-level pc = null) is ignored
    // instead of throwing on a null dereference.
    const thisPc = pc;
    pc.addEventListener("connectionstatechange", () => {
      if (!pc || pc !== thisPc) return;            // stale/post-teardown event
      const state = thisPc.connectionState;
      log("PC state: " + state);
      if (state === "connected") {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        setStatus("Connected — assistant is listening", "connected");
        hangupBtn.hidden = false;
        connectBtn.hidden = true;
      } else if (state === "disconnected") {
        // "disconnected" is usually a transient blip (common on Wi-Fi/headset)
        // that WebRTC recovers from on its own. Don't tear down immediately —
        // wait out a grace period and only give up if it stays down.
        setStatus("Reconnecting…", "connecting");
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            // Only tear down on a genuinely dead state — leave a peer that is
            // still negotiating ("connecting"/"checking") alone so it can recover.
            if (pc === thisPc &&
                (thisPc.connectionState === "disconnected" ||
                 thisPc.connectionState === "failed")) {
              log("Still down after grace period — tearing down.");
              setStatus("Disconnected", "error");
              teardown();
            }
          }, 6000);
        }
      } else if (state === "failed" || state === "closed") {
        setStatus("Disconnected", "error");
        teardown();
      }
    });

    // Push local mic + camera to the backend (creates sendrecv transceivers;
    // the backend reuses the audio transceiver to send the AI voice back).
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    try {
      // Use the thisPc snapshot throughout; bail if a concurrent teardown
      // (failed ICE, user hangup) nulled/replaced pc during an await.
      setStatus("Negotiating…", "connecting");
      const offer = await thisPc.createOffer({ offerToReceiveAudio: true });
      await thisPc.setLocalDescription(offer);
      await waitForIceGathering(thisPc);
      if (pc !== thisPc) return;

      const res = await fetch("/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: thisPc.localDescription.sdp,
          type: thisPc.localDescription.type,
        }),
      });
      if (pc !== thisPc) return;

      if (!res.ok) {
        const errText = await res.text();
        throw new Error("Backend /offer error " + res.status + ": " + errText);
      }

      const answer = await res.json();
      if (pc !== thisPc) return;
      await thisPc.setRemoteDescription(answer);
      log("SDP answer applied — waiting for media to flow.");
    } catch (err) {
      log("Negotiation failed: " + err);
      if (pc === thisPc) {
        setStatus("Connection failed", "error");
        teardown();
      }
    }
  }

  // ---- Teardown ----------------------------------------------------------
  function teardown() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    hangupBtn.hidden = true;
    connectBtn.hidden = false;
    connectBtn.disabled = false;
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (remoteAudio) remoteAudio.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
  }

  // ---- Wire up -----------------------------------------------------------
  connectBtn.addEventListener("click", connect);
  hangupBtn.addEventListener("click", () => {
    log("Disconnected by user.");
    setStatus("Idle", "idle");
    teardown();
  });

  // Report WebXR AR availability for clarity (does not gate Connect).
  if (navigator.xr && navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported("immersive-ar").then((ok) => {
      log(ok ? "Immersive AR supported — use ENTER AR." : "Immersive AR not available on this device (desktop fallback active).");
    });
  } else {
    log("WebXR not present — running in 2D fallback mode.");
  }

  setStatus("Idle", "idle");
})();
