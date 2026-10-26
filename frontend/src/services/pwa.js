export function registerServiceWorker({ onSharedFiles } = {}) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return null;
  }

  const handleSharedFiles = () => {
    if (typeof onSharedFiles === 'function') {
      onSharedFiles();
    }
  };

  const listenForMessages = () => {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SHARED_FILES_AVAILABLE') {
        handleSharedFiles();
      }
    });
  };

  listenForMessages();

  navigator.serviceWorker.addEventListener('controllerchange', handleSharedFiles);

  navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    .then((registration) => {
      if (navigator.serviceWorker.controller) {
        handleSharedFiles();
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;

        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
            handleSharedFiles();
          }
        });
      });
    })
    .catch((error) => {
      console.warn('[pwa] Service worker registration failed:', error?.message || error);
    });

  return navigator.serviceWorker.ready;
}
