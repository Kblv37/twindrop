// shared.js — debug версия (копии замените на этот файл временно)
function $(sel) { return document.querySelector(sel); }

function setStatus(el, text) {
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
}

function setBar(bar, ratio) {
    bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

// Debug wrapper over RTCPeerConnection + data channel
function createPeer({ initiator, onSignal, onConnect, onData, onClose, onError }) {
    console.log('[shared] createPeer called, initiator=', initiator);
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ]
    });

    let channel;

    // Expose for debugging in console
    window._lastPeer = { pc, getChannel: () => channel };

    if (initiator) {
        console.log('[shared] initiator -> createDataChannel');
        channel = pc.createDataChannel('file');
        hookupChannel();
    } else {
        pc.ondatachannel = (ev) => {
            console.log('[shared] ondatachannel event (received channel)', ev.channel.label);
            channel = ev.channel;
            hookupChannel();
        };
    }

    function hookupChannel() {
        try {
            channel.binaryType = 'arraybuffer';
            channel.onopen = () => {
                console.log('[shared] datachannel.onopen (state=', channel.readyState, ')');
                onConnect && onConnect();
            };
            channel.onmessage = (ev) => {
                console.log('[shared] datachannel.onmessage (len=', ev.data && ev.data.byteLength ? ev.data.byteLength : (typeof ev.data), ')', ev.data);
                onData && onData(ev.data);
            };
            channel.onclose = () => {
                console.log('[shared] datachannel.onclose');
                onClose && onClose();
            };
            channel.onerror = (e) => {
                console.error('[shared] datachannel.onerror', e);
                onError && onError(e);
            };
        } catch (e) {
            console.error('[shared] hookupChannel error', e);
        }
    }

    pc.onicecandidate = (ev) => {
        console.log('[shared] onicecandidate', !!ev.candidate);
        if (ev.candidate) onSignal({ candidate: ev.candidate });
    };

    pc.onconnectionstatechange = () => {
        console.log('[shared] connectionState ->', pc.connectionState, ', iceConnectionState ->', pc.iceConnectionState);
        if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
            onClose && onClose();
        }
    };

    async function startNegotiation() {
        console.log('[shared] startNegotiation()');
        try {
            const offer = await pc.createOffer();
            console.log('[shared] offer created');
            await pc.setLocalDescription(offer);
            console.log('[shared] setLocalDescription(offer) ok');
            onSignal(offer);
        } catch (e) {
            console.error('[shared] startNegotiation error', e);
        }
    }

    async function handleSignal(data) {
        console.log('[shared] handleSignal()', data && data.type ? data.type : (data && data.candidate ? 'candidate' : data));
        try {
            if (data && data.candidate) {
                await pc.addIceCandidate(data.candidate);
                console.log('[shared] addIceCandidate ok');
                return;
            }

            if (!data || !data.type) return;

            if (data.type === 'offer') {
                console.log('[shared] received offer -> setRemoteDescription');
                await pc.setRemoteDescription(new RTCSessionDescription(data));
                console.log('[shared] remote description set (offer)');
                const answer = await pc.createAnswer();
                console.log('[shared] answer created');
                await pc.setLocalDescription(answer);
                console.log('[shared] setLocalDescription(answer) ok');
                onSignal(answer);
            } else if (data.type === 'answer') {
                console.log('[shared] received answer -> setRemoteDescription');
                await pc.setRemoteDescription(new RTCSessionDescription(data));
                console.log('[shared] remote description set (answer)');
            }
        } catch (e) {
            console.error('[shared] handleSignal error', e);
        }
    }

    if (initiator) {
        // start negotiation exactly once
        startNegotiation();
    }

    function isOpen() {
        return !!(channel && channel.readyState === 'open');
    }

    function send(data) {
        if (!isOpen()) {
            console.warn('[shared] send() called but channel not open');
            return false;
        }
        try {
            channel.send(data);
            console.log('[shared] send ok', data instanceof ArrayBuffer ? `ArrayBuffer(${data.byteLength})` : data);
            return true;
        } catch (e) {
            console.error('[shared] send error', e);
            return false;
        }
    }

    function destroy() {
        try { channel?.close(); } catch (e) { console.warn('[shared] channel close failed', e); }
        try { pc.close(); } catch (e) { console.warn('[shared] pc close failed', e); }
    }

    return {
        pc,
        channel: () => channel,
        handleSignal,
        isOpen,
        send,
        destroy
    };
}

function parseQuery() {
    const u = new URL(location.href);
    return Object.fromEntries(u.searchParams.entries());
}
