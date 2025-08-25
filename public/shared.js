// Общие утилиты для send/receive
function $(sel) { return document.querySelector(sel); }

function setStatus(el, text) {
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
}

function setBar(bar, ratio) { 
    bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`; 
}

// Простая обёртка над RTCPeerConnection + data channel
function createPeer({ initiator, onSignal, onConnect, onData, onClose, onError }) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ]
    });

    let channel;
    if (initiator) {
        channel = pc.createDataChannel('file', {
            ordered: true,
            maxRetransmits: 30 // ограничение для надёжности
        });
        hookupChannel();
    } else {
        pc.ondatachannel = (ev) => { channel = ev.channel; hookupChannel(); };
    }

    function hookupChannel() {
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => onConnect && onConnect();
        channel.onmessage = (ev) => onData && onData(ev.data);
        channel.onclose = () => {
            onClose && onClose();
            if (pc.signalingState !== "closed") pc.close();
        };
        channel.onerror = (e) => onError && onError(e);
    }

    pc.onicecandidate = (ev) => {
        if (ev.candidate) onSignal({ candidate: ev.candidate });
    };

    // Более надёжное отслеживание статуса
    pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === 'disconnected' || st === 'failed' || st === 'closed') {
            onClose && onClose();
            if (pc.signalingState !== "closed") pc.close();
        }
    };

    async function startNegotiation() {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        onSignal(offer);
    }

    async function handleSignal(data) {
        try {
            if (data.candidate) {
                await pc.addIceCandidate(data.candidate);
                return;
            }
            if (data.type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                onSignal(answer);
            } else if (data.type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data));
            }
        } catch (e) {
            console.warn("Signal handling error:", e);
        }
    }

    if (initiator) startNegotiation();

    return { pc, channel: () => channel, handleSignal };
}

function parseQuery() {
    const u = new URL(location.href);
    return Object.fromEntries(u.searchParams.entries());
}
