const QR_SCRIPT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const QR_SCRIPT_ID = 'twindrop-qr-library';

let qrPromise = null;

export function loadQrCode() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('qr-unavailable'));
  }

  if (typeof window.QRCode === 'function') {
    return Promise.resolve(window.QRCode);
  }

  if (qrPromise) {
    return qrPromise;
  }

  qrPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(QR_SCRIPT_ID);

    // A previous failed load leaves a dead <script> in the DOM. Remove it so
    // the next attempt creates a fresh element and can actually load again.
    if (existing) {
      existing.remove();
    }

    const script = document.createElement('script');

    const cleanup = () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };

    const handleLoad = () => {
      cleanup();

      if (typeof window.QRCode === 'function') {
        resolve(window.QRCode);
      } else {
        script.remove();
        qrPromise = null;
        reject(new Error('qr-unavailable'));
      }
    };

    const handleError = () => {
      cleanup();
      script.remove();
      qrPromise = null;
      reject(new Error('qr-unavailable'));
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
    script.id = QR_SCRIPT_ID;
    script.src = QR_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.head.appendChild(script);
  });

  return qrPromise;
}
