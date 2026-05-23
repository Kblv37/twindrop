export class WebRtcPeerSession {
  constructor({
    initiator,
    iceServers,
    onSignal,
    onMessage,
    onStateChange,
    onChannelOpen,
    onChannelClose,
    onError,
    maxRestartAttempts = 2,
  }) {
    this.initiator = initiator;
    this.onSignal = onSignal;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.onChannelOpen = onChannelOpen;
    this.onChannelClose = onChannelClose;
    this.onError = onError;
    this.maxRestartAttempts = maxRestartAttempts;
    this.pendingIceCandidates = [];
    this.signalChain = Promise.resolve();
    this.remoteDescriptionSet = false;
    this.closed = false;
    this.restartAttempts = 0;
    this.restartTimer = null;

    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignal?.({
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.onStateChange?.({
        connectionState: this.pc.connectionState,
        iceConnectionState: this.pc.iceConnectionState,
        iceGatheringState: this.pc.iceGatheringState,
      });

      if (this.pc.connectionState === 'connected') {
        this.restartAttempts = 0;
        window.clearTimeout(this.restartTimer);
      }

      if (['disconnected', 'failed'].includes(this.pc.connectionState) && this.initiator) {
        this.scheduleIceRestart();
      }

      if (this.pc.connectionState === 'closed') {
        this.onChannelClose?.();
      }
    };

    this.pc.ondatachannel = (event) => {
      this.attachDataChannel(event.channel);
    };

    if (this.initiator) {
      this.attachDataChannel(this.pc.createDataChannel('twindrop-file', { ordered: true }));
      queueMicrotask(() => {
        this.createAndSendOffer().catch((error) => this.handleError(error));
      });
    }
  }

  attachDataChannel(channel) {
    this.channel = channel;
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = 256 * 1024;

    this.channel.onopen = () => {
      this.onChannelOpen?.();
    };

    this.channel.onmessage = (event) => {
      this.onMessage?.(event.data);
    };

    this.channel.onclose = () => {
      this.onChannelClose?.();
    };

    this.channel.onerror = (error) => {
      this.handleError(error);
    };
  }

  handleError(error) {
    this.onError?.(error instanceof Error ? error : new Error('webrtc-error'));
  }

  scheduleIceRestart() {
    if (this.closed || this.restartAttempts >= this.maxRestartAttempts || this.restartTimer) {
      return;
    }

    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      this.createAndSendOffer({ iceRestart: true }).catch((error) => this.handleError(error));
    }, 1500);
  }

  async createAndSendOffer(options = {}) {
    if (this.closed) {
      return;
    }

    const offer = await this.pc.createOffer(options);
    await this.pc.setLocalDescription(offer);
    this.restartAttempts += options.iceRestart ? 1 : 0;
    this.onSignal?.({
      type: this.pc.localDescription.type,
      sdp: this.pc.localDescription.sdp,
    });
  }

  async flushPendingIceCandidates() {
    const pendingCandidates = [...this.pendingIceCandidates];
    this.pendingIceCandidates = [];

    for (const candidate of pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  async processSignal(signal) {
    if (signal.candidate) {
      const candidate = new RTCIceCandidate(signal.candidate);

      if (!this.remoteDescriptionSet || !this.pc.remoteDescription) {
        this.pendingIceCandidates.push(candidate);
        return;
      }

      await this.pc.addIceCandidate(candidate);
      return;
    }

    if (!signal.type || !signal.sdp) {
      throw new Error('invalid-signal');
    }

    await this.pc.setRemoteDescription(new RTCSessionDescription(signal));
    this.remoteDescriptionSet = true;
    await this.flushPendingIceCandidates();

    if (signal.type === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.onSignal?.({
        type: this.pc.localDescription.type,
        sdp: this.pc.localDescription.sdp,
      });
    }
  }

  handleSignal(signal) {
    this.signalChain = this.signalChain
      .then(() => this.processSignal(signal))
      .catch((error) => this.handleError(error));

    return this.signalChain;
  }

  getDataChannel() {
    return this.channel;
  }

  isReady() {
    return this.channel?.readyState === 'open';
  }

  async waitForOpen(timeoutMs = 15000) {
    if (this.isReady()) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error('data-channel-timeout'));
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        this.channel?.removeEventListener('open', handleOpen);
        this.channel?.removeEventListener('close', handleClose);
      };

      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleClose = () => {
        cleanup();
        reject(new Error('data-channel-closed'));
      };

      this.channel?.addEventListener('open', handleOpen, { once: true });
      this.channel?.addEventListener('close', handleClose, { once: true });
    });
  }

  destroy() {
    this.closed = true;
    window.clearTimeout(this.restartTimer);
    this.pendingIceCandidates = [];

    try {
      this.channel?.close();
    } catch {}

    try {
      this.pc.close();
    } catch {}
  }
}
