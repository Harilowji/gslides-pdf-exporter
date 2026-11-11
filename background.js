/**
 * Google Slides High-Res PDF Exporter
 * Background Service Worker (Manifest V3)
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[GSlides PDF Exporter] Background service worker initialized.');
});

// Handle incoming messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureVisibleTab') {
    // Determine windowId from sender tab if available
    const windowId = sender.tab ? sender.tab.windowId : undefined;

    chrome.tabs.captureVisibleTab(
      windowId,
      { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          console.error('[GSlides PDF Exporter] Tab capture error:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, dataUrl: dataUrl });
        }
      }
    );
    return true; // Keep message port open for async response
  }

  if (message.action === 'downloadFile') {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename || 'Google_Slides_Presentation.pdf',
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[GSlides PDF Exporter] Download error:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[GSlides PDF Exporter] Download initiated. ID:', downloadId);
          sendResponse({ success: true, downloadId: downloadId });
        }
      }
    );
    return true;
  }
});
