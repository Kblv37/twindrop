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
            { urls: 'stun:stun1.l.google.com:19302' }, // валидный второй STUN
        ]
    });

    let channel;
    if (initiator) {
        channel = pc.createDataChannel('file');
        hookupChannel();
    } else {
        pc.ondatachannel = (ev) => { channel = ev.channel; hookupChannel(); };
    }

    function hookupChannel() {
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => onConnect && onConnect();
        channel.onmessage = (ev) => onData && onData(ev.data);
        channel.onclose = () => onClose && onClose();
        channel.onerror = (e) => onError && onError(e);
    }

    pc.onicecandidate = (ev) => {
        if (ev.candidate) onSignal({ candidate: ev.candidate });
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            onClose && onClose();
        }
    };

    async function startNegotiation() {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        onSignal(offer);
    }

    async function handleSignal(data) {
        if (data.candidate) {
            try { await pc.addIceCandidate(data.candidate); } catch { }
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
    }

    if (initiator) startNegotiation();

    return { pc, channel: () => channel, handleSignal };
}

function parseQuery() {
    const u = new URL(location.href);
    return Object.fromEntries(u.searchParams.entries());
}
