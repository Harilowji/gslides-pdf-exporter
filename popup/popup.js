/**
 * Google Slides High-Res PDF Exporter
 * Popup UI Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('statusPill');
  const invalidTabWarning = document.getElementById('invalidTabWarning');
  const deckInfoCard = document.getElementById('deckInfoCard');
  const settingsCard = document.getElementById('settingsCard');
  const progressCard = document.getElementById('progressCard');

  const deckTitle = document.getElementById('deckTitle');
  const metaTotalSlides = document.getElementById('metaTotalSlides');
  const metaCurrentSlide = document.getElementById('metaCurrentSlide');

  const delaySlider = document.getElementById('delaySlider');
  const delayInput = document.getElementById('delayInput');
  const delayBadge = document.getElementById('delayBadge');

  const startSlideInput = document.getElementById('startSlideInput');
  const endSlideInput = document.getElementById('endSlideInput');
  const dprSelect = document.getElementById('dprSelect');
  const formatSelect = document.getElementById('formatSelect');

  const startBtn = document.getElementById('startBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  const progressStatusText = document.getElementById('progressStatusText');
  const progressPercentText = document.getElementById('progressPercentText');
  const popupProgressBar = document.getElementById('popupProgressBar');

  let activeTabId = null;
  let statusPollInterval = null;

  function updateDelay(val) {
    const num = Math.max(200, Math.min(3000, parseInt(val, 10) || 450));
    delaySlider.value = num;
    delayInput.value = num;
    delayBadge.textContent = `${num} ms`;
  }

  delaySlider.addEventListener('input', (e) => updateDelay(e.target.value));
  delayInput.addEventListener('change', (e) => updateDelay(e.target.value));

  // Identify active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab || !activeTab.url) {
    showInvalidTabUI();
    return;
  }

  activeTabId = activeTab.id;
  // Support /edit, /view, /preview, /present, and query parameters
  const isGoogleSlides = /^https:\/\/docs\.google\.com\/presentation\/d\/[^/]+/.test(activeTab.url);

  if (!isGoogleSlides) {
    showInvalidTabUI();
    return;
  }

  // Ensure content script is injected even if tab was open before extension load
  await ensureContentScriptInjected();
  fetchDeckInfo();

  function showInvalidTabUI() {
    statusPill.textContent = 'Invalid Tab';
    statusPill.className = 'status-pill invalid';
    invalidTabWarning.style.display = 'flex';
    deckInfoCard.style.display = 'none';
    settingsCard.style.display = 'none';
    startBtn.disabled = true;
  }

  async function ensureContentScriptInjected() {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: activeTabId },
        files: ['content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['libs/jspdf.umd.min.js', 'content.js']
      });
    } catch (err) {
      // Content script may already be injected, continue
    }
  }

  function fetchDeckInfo() {
    chrome.tabs.sendMessage(activeTabId, { action: 'getSlideInfo' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        deckTitle.textContent = activeTab.title ? activeTab.title.replace(/ - Google Slides$/, '') : 'Google Slides Presentation';
        metaTotalSlides.textContent = 'Ready';
        metaCurrentSlide.textContent = '1';
        return;
      }

      deckTitle.textContent = response.title || 'Untitled Presentation';
      metaTotalSlides.textContent = response.totalSlides || '1';
      metaCurrentSlide.textContent = response.currentSlide || '1';

      startSlideInput.value = '1';
      endSlideInput.value = response.totalSlides || '1';
      endSlideInput.max = response.totalSlides || 9999;

      if (response.isExporting) {
        setExportingUI(true);
        startPollingStatus();
      }
    });
  }

  function setExportingUI(isExporting) {
    if (isExporting) {
      statusPill.textContent = 'Running';
      statusPill.className = 'status-pill running';
      progressCard.style.display = 'block';
      startBtn.style.display = 'none';
      cancelBtn.style.display = 'flex';
      settingsCard.style.opacity = '0.6';
      settingsCard.style.pointerEvents = 'none';
    } else {
      statusPill.textContent = 'Ready';
      statusPill.className = 'status-pill ready';
      progressCard.style.display = 'none';
      startBtn.style.display = 'flex';
      cancelBtn.style.display = 'none';
      settingsCard.style.opacity = '1';
      settingsCard.style.pointerEvents = 'auto';
    }
  }

  function startPollingStatus() {
    if (statusPollInterval) clearInterval(statusPollInterval);

    statusPollInterval = setInterval(() => {
      chrome.tabs.sendMessage(activeTabId, { action: 'getStatus' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.isExporting) {
          clearInterval(statusPollInterval);
          setExportingUI(false);
          return;
        }

        const current = res.currentSlide || 1;
        const end = res.endSlide || 1;
        const total = Math.max(1, end);
        const percent = Math.min(100, Math.round((current / total) * 100));

        progressStatusText.textContent = `Capturing slide ${current} / ${end}...`;
        progressPercentText.textContent = `${percent}%`;
        popupProgressBar.style.width = `${percent}%`;
      });
    }, 500);
  }

  startBtn.addEventListener('click', async () => {
    await ensureContentScriptInjected();

    const config = {
      delayMs: parseInt(delayInput.value, 10) || 450,
      startSlide: parseInt(startSlideInput.value, 10) || 1,
      endSlide: parseInt(endSlideInput.value, 10) || parseInt(metaTotalSlides.textContent, 10) || 1,
      dpr: parseFloat(dprSelect.value) || 2.0,
      format: formatSelect.value || 'image/jpeg',
      quality: 0.95
    };

    chrome.tabs.sendMessage(
      activeTabId,
      { action: 'startExport', config: config },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          alert('Could not start export. Please refresh the Google Slides tab (F5) and try again.');
          return;
        }

        setExportingUI(true);
        startPollingStatus();
      }
    );
  });

  cancelBtn.addEventListener('click', () => {
    chrome.tabs.sendMessage(activeTabId, { action: 'cancelExport' }, () => {
      cancelBtn.textContent = 'Stopping...';
      cancelBtn.disabled = true;
    });
  });
});
