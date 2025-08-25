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
            maxRetransmits: 30
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

// Чанковая отправка файла
async function sendFile(file, channel, { chunkSize = 64 * 1024, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        let offset = 0;
        const reader = new FileReader();

        // Отправляем метаданные
        channel.send(JSON.stringify({
            fileInfo: { name: file.name, size: file.size, type: file.type }
        }));

        reader.onload = (e) => {
            channel.send(e.target.result);
            offset += e.target.result.byteLength;
            if (onProgress) onProgress(offset / file.size);

            if (offset < file.size) {
                readSlice(offset);
            } else {
                channel.send(JSON.stringify({ done: true }));
                resolve();
            }
        };

        reader.onerror = (err) => reject(err);

        function readSlice(o) {
            const slice = file.slice(o, o + chunkSize);
            reader.readAsArrayBuffer(slice);
        }

        readSlice(0);
    });
}

// Приём файла чанками
function createFileReceiver({ onFileStart, onFileProgress, onFileComplete }) {
    let incomingFile = null;
    let receivedChunks = [];
    let receivedBytes = 0;

    return function handleData(data) {
        if (typeof data === "string") {
            try {
                const msg = JSON.parse(data);
                if (msg.fileInfo) {
                    incomingFile = msg.fileInfo;
                    receivedChunks = [];
                    receivedBytes = 0;
                    onFileStart && onFileStart(incomingFile);
                } else if (msg.done) {
                    const blob = new Blob(receivedChunks, { type: incomingFile.type });
                    onFileComplete && onFileComplete(blob, incomingFile);
                    incomingFile = null;
                }
            } catch (e) {
                console.warn("Non-JSON text message:", data);
            }
        } else if (data instanceof ArrayBuffer) {
            receivedChunks.push(new Uint8Array(data));
            receivedBytes += data.byteLength;
            if (incomingFile) {
                onFileProgress && onFileProgress(receivedBytes / incomingFile.size);
            }
        }
    };
}

function parseQuery() {
    const u = new URL(location.href);
    return Object.fromEntries(u.searchParams.entries());
}
