/**
 * Google Slides High-Res PDF Exporter
 * Content Script (Manifest V3)
 *
 * Automates slide stage traversal and captures rendered stages
 * progressively into a consolidated high-resolution 16:9 PDF.
 */

(() => {
  // Global export state
  const state = {
    isExporting: false,
    cancelRequested: false,
    totalSlides: 1,
    currentSlide: 1,
    startSlide: 1,
    endSlide: 1,
    capturedCount: 0,
    startTime: null,
    config: {
      delayMs: 450,
      dpr: 2.0, // 2x DPR for crisp text rendering
      format: 'image/jpeg',
      quality: 0.95
    },
    doc: null,
    hudEl: null
  };

  /**
   * Safe sleep helper
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Helper to wait for the next animation frame and idle callback
   */
  const waitForPaint = () => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        if ('requestIdleCallback' in window) {
          requestIdleCallback(() => resolve(), { timeout: 150 });
        } else {
          setTimeout(resolve, 50);
        }
      });
    });
  };

  /**
   * Detect presentation title
   */
  function getPresentationTitle() {
    const titleInput = document.querySelector('.docs-title-input, input.docs-title-input');
    if (titleInput && titleInput.value && titleInput.value.trim().length > 0) {
      return titleInput.value.trim();
    }
    const docTitle = document.title || 'Google Slides Presentation';
    return docTitle.replace(/ - Google (Slides|Trang trình bày)$/i, '').trim();
  }

  /**
   * Automatically detect total number of slides from Google Slides UI
   */
  function detectTotalSlides() {
    // 1. Check aria-setsize on any filmstrip item
    const ariaSetElement = document.querySelector('[aria-setsize]');
    if (ariaSetElement) {
      const setSize = parseInt(ariaSetElement.getAttribute('aria-setsize'), 10);
      if (!isNaN(setSize) && setSize > 0) {
        return setSize;
      }
    }

    // 2. Count distinct filmstrip thumbnail elements
    const thumbnails = document.querySelectorAll(
      '.punch-filmstrip-thumbnail, .punch-filmstrip-item, [role="option"][aria-posinset]'
    );
    if (thumbnails && thumbnails.length > 0) {
      // Find maximum aria-posinset among thumbnails
      let maxPos = 0;
      thumbnails.forEach((el) => {
        const pos = parseInt(el.getAttribute('aria-posinset'), 10);
        if (!isNaN(pos) && pos > maxPos) {
          maxPos = pos;
        }
      });
      if (maxPos > 0) return maxPos;
      return thumbnails.length;
    }

    // 3. Fallback: query all elements with aria-posinset in the document
    const allPosElements = document.querySelectorAll('[aria-posinset]');
    let fallbackMax = 0;
    allPosElements.forEach((el) => {
      const pos = parseInt(el.getAttribute('aria-posinset'), 10);
      if (!isNaN(pos) && pos > fallbackMax) {
        fallbackMax = pos;
      }
    });

    return fallbackMax > 0 ? fallbackMax : 1;
  }

  /**
   * Detect current active slide index from Google Slides UI
   */
  function detectCurrentSlideIndex() {
    // 1. Look for selected thumbnail in filmstrip
    const selectedItem = document.querySelector(
      '[role="option"][aria-selected="true"], [aria-posinset][aria-selected="true"], .punch-filmstrip-thumbnail-focused'
    );
    if (selectedItem) {
      const pos = parseInt(selectedItem.getAttribute('aria-posinset'), 10);
      if (!isNaN(pos) && pos > 0) return pos;
    }

    // 2. Check filmstrip element with focused class
    const focused = document.querySelector('.punch-filmstrip-item.focused, .punch-filmstrip-thumbnail.focused');
    if (focused) {
      const pos = parseInt(focused.getAttribute('aria-posinset'), 10);
      if (!isNaN(pos) && pos > 0) return pos;
    }

    return state.currentSlide || 1;
  }

  /**
   * Find primary rendered slide stage element (SVG or Canvas)
   * and return its exact bounding rectangle.
   */
  function findSlideElement() {
    // Priority candidate selectors
    const candidates = [
      document.querySelector('.punch-viewer-svgpage svg'),
      document.querySelector('.punch-viewer-svgpage'),
      document.querySelector('.punch-viewer-content svg.punch-viewer-svgpage-svg'),
      document.querySelector('.punch-viewer-content canvas'),
      document.querySelector('svg.punch-viewer-svgpage-svg'),
      document.querySelector('.punch-viewer-content')
    ];

    for (const el of candidates) {
      if (el) {
        const rect = el.getBoundingClientRect();
        // Valid slide stage dimensions check
        if (rect.width > 240 && rect.height > 135) {
          return { element: el, rect };
        }
      }
    }

    // Fallback: search all SVGs or canvases in main editor viewport
    const viewportElements = Array.from(document.querySelectorAll('svg, canvas'));
    for (const el of viewportElements) {
      const rect = el.getBoundingClientRect();
      const ratio = rect.width / rect.height;
      // Expect 16:9 (~1.77) or 4:3 (~1.33) or 16:10 (~1.6)
      if (rect.width > 320 && rect.height > 180 && ratio >= 1.2 && ratio <= 2.2) {
        return { element: el, rect };
      }
    }

    // Ultimate fallback: workspace window container
    const fallbackEl = document.querySelector('#workspace-container, .docs-editor-container') || document.body;
    return { element: fallbackEl, rect: fallbackEl.getBoundingClientRect() };
  }

  /**
   * Focus stage or filmstrip for navigation
   */
  function focusNavigationTarget() {
    const targets = [
      document.querySelector('.punch-filmstrip-thumbnail-focused'),
      document.querySelector('[role="option"][aria-selected="true"]'),
      document.querySelector('.punch-filmstrip-scroll-container'),
      document.querySelector('.punch-filmstrip'),
      document.querySelector('.punch-viewer-content'),
      document.body
    ];

    for (const t of targets) {
      if (t) {
        try {
          t.focus();
          return t;
        } catch (e) {
          // Continue
        }
      }
    }
    return document.body;
  }

  /**
   * Dispatch keyboard event sequence (ArrowDown, PageDown, etc.)
   */
  function dispatchKey(key, keyCode, target) {
    const el = target || focusNavigationTarget();
    const eventParams = {
      key: key,
      code: key,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };

    el.dispatchEvent(new KeyboardEvent('keydown', eventParams));
    el.dispatchEvent(new KeyboardEvent('keyup', eventParams));
  }

  /**
   * Navigate to a specific slide index or advance forward
   */
  async function advanceToSlide(targetIndex) {
    // 1. Try to find thumbnail by aria-posinset and click
    const thumb = document.querySelector(`[aria-posinset="${targetIndex}"]`);
    if (thumb) {
      thumb.scrollIntoView({ block: 'nearest' });
      thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      thumb.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      thumb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return;
    }

    // 2. Dispatch ArrowDown on filmstrip
    const filmstrip = document.querySelector('.punch-filmstrip-scroll-container, .punch-filmstrip');
    if (filmstrip) {
      dispatchKey('ArrowDown', 40, filmstrip);
    }

    // 3. Dispatch PageDown on stage as reliable backup
    const stage = document.querySelector('.punch-viewer-content') || document.body;
    dispatchKey('PageDown', 34, stage);
  }

  /**
   * Navigate to Slide 1
   */
  async function navigateToStartSlide(startSlideIndex) {
    updateHUDStatus(`Navigating to slide ${startSlideIndex}...`);

    // If starting at slide 1, try Home key or clicking first thumbnail
    if (startSlideIndex === 1) {
      const firstThumb = document.querySelector('[aria-posinset="1"]');
      if (firstThumb) {
        firstThumb.scrollIntoView({ block: 'nearest' });
        firstThumb.click();
      } else {
        const filmstrip = document.querySelector('.punch-filmstrip-scroll-container, .punch-filmstrip');
        if (filmstrip) {
          dispatchKey('Home', 36, filmstrip);
        }
      }
    } else {
      await advanceToSlide(startSlideIndex);
    }

    await sleep(state.config.delayMs + 200);
    await waitForPaint();
  }

  /**
   * Capture slide stage into high-res HTML5 Canvas with 2x DPR
   */
  async function captureSlideStage(rect, scale = 2.0) {
    // 1. Temporarily hide HUD to prevent it appearing in PDF capture
    const hud = document.getElementById('gslides-pdf-hud-root');
    if (hud) hud.classList.add('hud-hidden');

    // Wait 1 animation frame for repaint without HUD
    await new Promise((r) => requestAnimationFrame(r));

    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
    } finally {
      // 2. Restore HUD immediately
      if (hud) hud.classList.remove('hud-hidden');
    }

    if (!response || !response.success || !response.dataUrl) {
      throw new Error(response?.error || 'Failed to capture visible tab from background service worker.');
    }

    // 3. Load screenshot into an image element
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = (e) => reject(new Error('Failed to load tab screenshot image.'));
      image.src = response.dataUrl;
    });

    // 4. Calculate source and destination coordinates with Device Pixel Ratio
    const tabDpr = window.devicePixelRatio || 1;
    const sx = Math.round(rect.left * tabDpr);
    const sy = Math.round(rect.top * tabDpr);
    const sw = Math.round(rect.width * tabDpr);
    const sh = Math.round(rect.height * tabDpr);

    // Destination canvas scaled with target DPR (e.g., 2.0 for sharp text)
    const targetWidth = Math.round(rect.width * scale);
    const targetHeight = Math.round(rect.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Crop exact slide stage area
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

    // 5. Convert to compact high-quality JPEG / PNG data URL
    const format = state.config.format || 'image/jpeg';
    const quality = state.config.quality || 0.95;
    const dataUrl = canvas.toDataURL(format, quality);

    // 6. Explicitly cleanup canvas and image memory
    canvas.width = 0;
    canvas.height = 0;
    img.src = '';

    return dataUrl;
  }

  /**
   * Floating Progress HUD Management
   */
  function createHUD() {
    if (document.getElementById('gslides-pdf-hud-root')) {
      return document.getElementById('gslides-pdf-hud-root');
    }

    const hudRoot = document.createElement('div');
    hudRoot.id = 'gslides-pdf-hud-root';
    hudRoot.innerHTML = `
      <div class="gslides-hud-card">
        <div class="gslides-hud-header">
          <div class="gslides-hud-title-wrap">
            <span class="gslides-hud-badge-dot" id="gslides-hud-dot"></span>
            <span class="gslides-hud-title">Exporting Presentation</span>
          </div>
          <span class="gslides-hud-slide-counter" id="gslides-hud-counter">1 / 1</span>
        </div>

        <div class="gslides-hud-status-text" id="gslides-hud-status">Preparing stages...</div>

        <div class="gslides-hud-progress-bg">
          <div class="gslides-hud-progress-fill" id="gslides-hud-fill"></div>
        </div>

        <div class="gslides-hud-stats-row">
          <span id="gslides-hud-elapsed">Elapsed: 00:00</span>
          <span class="gslides-hud-eta" id="gslides-hud-eta">ETA: Calculating...</span>
        </div>

        <div class="gslides-hud-actions">
          <button class="gslides-hud-btn gslides-hud-btn-cancel" id="gslides-hud-btn-cancel">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Cancel Export
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(hudRoot);

    // Event listener for cancel button
    const cancelBtn = hudRoot.querySelector('#gslides-hud-btn-cancel');
    cancelBtn.addEventListener('click', () => {
      cancelExportWorkflow();
    });

    state.hudEl = hudRoot;
    return hudRoot;
  }

  function updateHUDProgress(current, total, customStatus) {
    if (!state.hudEl) createHUD();

    const counter = state.hudEl.querySelector('#gslides-hud-counter');
    const fill = state.hudEl.querySelector('#gslides-hud-fill');
    const status = state.hudEl.querySelector('#gslides-hud-status');
    const elapsedEl = state.hudEl.querySelector('#gslides-hud-elapsed');
    const etaEl = state.hudEl.querySelector('#gslides-hud-eta');

    const totalToExport = Math.max(1, state.endSlide - state.startSlide + 1);
    const completed = Math.max(0, current - state.startSlide + 1);
    const percent = Math.min(100, Math.round((completed / totalToExport) * 100));

    if (counter) counter.textContent = `Slide ${current} / ${state.endSlide}`;
    if (fill) fill.style.width = `${percent}%`;
    if (status && customStatus) status.textContent = customStatus;

    if (state.startTime) {
      const elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
      const min = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
      const sec = String(elapsedSeconds % 60).padStart(2, '0');
      if (elapsedEl) elapsedEl.textContent = `Elapsed: ${min}:${sec}`;

      if (completed > 1) {
        const avgTimePerSlide = elapsedSeconds / completed;
        const remainingSlides = totalToExport - completed;
        const remainingSeconds = Math.round(remainingSlides * avgTimePerSlide);
        const rMin = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
        const rSec = String(remainingSeconds % 60).padStart(2, '0');
        if (etaEl) etaEl.textContent = `ETA: ~${rMin}:${rSec} (${percent}%)`;
      }
    }
  }

  function updateHUDStatus(msg) {
    if (!state.hudEl) return;
    const status = state.hudEl.querySelector('#gslides-hud-status');
    if (status) status.textContent = msg;
  }

  function removeHUD(delayMs = 4000) {
    setTimeout(() => {
      if (state.hudEl && !state.isExporting) {
        state.hudEl.remove();
        state.hudEl = null;
      }
    }, delayMs);
  }

  /**
   * Cancel export workflow
   */
  function cancelExportWorkflow() {
    if (!state.isExporting) return;
    state.cancelRequested = true;
    updateHUDStatus('Stopping export... Saving captured slides.');
    const dot = state.hudEl?.querySelector('#gslides-hud-dot');
    if (dot) dot.classList.add('cancelled');
    const cancelBtn = state.hudEl?.querySelector('#gslides-hud-btn-cancel');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  /**
   * Main PDF Export Pipeline
   */
  async function runExportWorkflow(config) {
    if (state.isExporting) return;

    // Verify jsPDF library availability
    const jsPdfConstructor = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
    if (!jsPdfConstructor) {
      alert('jsPDF library is not loaded. Please ensure jspdf.umd.min.js is present in libs/.');
      return;
    }

    state.isExporting = true;
    state.cancelRequested = false;
    state.capturedCount = 0;
    state.startTime = Date.now();
    state.config = Object.assign(state.config, config);

    // Detect total slides
    const detectedTotal = detectTotalSlides();
    state.totalSlides = detectedTotal;
    state.startSlide = Math.max(1, parseInt(config.startSlide || 1, 10));
    state.endSlide = Math.min(
      detectedTotal,
      parseInt(config.endSlide || detectedTotal, 10)
    );

    if (state.endSlide < state.startSlide) {
      state.endSlide = state.startSlide;
    }

    createHUD();
    updateHUDProgress(state.startSlide, state.endSlide, 'Initializing PDF document...');

    // 1. Locate slide element and determine 16:9 PDF dimensions
    const slideInfo = findSlideElement();
    const rect = slideInfo.rect;
    const slideRatio = rect.width / rect.height;

    // Strict 16:9 landscape aspect ratio: 960 pt x 540 pt
    // If presentation has custom aspect ratio, dynamically match it to avoid margin clipping
    const pdfWidth = 960;
    const pdfHeight = Math.round(pdfWidth / slideRatio);

    // 2. Initialize jsPDF instance progressively
    const doc = new jsPdfConstructor({
      orientation: 'landscape',
      unit: 'pt',
      format: [pdfWidth, pdfHeight],
      compress: true
    });
    state.doc = doc;

    // 3. Move to start slide
    await navigateToStartSlide(state.startSlide);

    let isFirstPage = true;

    // 4. Sequential traversal from startSlide to endSlide
    for (let current = state.startSlide; current <= state.endSlide; current++) {
      if (state.cancelRequested) {
        console.warn('[GSlides PDF Exporter] Export cancelled by user at slide', current);
        break;
      }

      state.currentSlide = current;
      updateHUDProgress(
        current,
        state.endSlide,
        `Capturing slide stage ${current} of ${state.endSlide}...`
      );

      // Render settle delay: allows SVG/canvas elements to settle in viewport
      await sleep(state.config.delayMs);
      await waitForPaint();

      // Refresh bounding box of slide stage in case of dynamic zoom
      const activeStage = findSlideElement();

      // Capture primary rendered stage with 2x DPR
      try {
        const slideDataUrl = await captureSlideStage(activeStage.rect, state.config.dpr);

        // Progressively append into jsPDF document instance
        if (isFirstPage) {
          doc.addImage(slideDataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
          isFirstPage = false;
        } else {
          doc.addPage([pdfWidth, pdfHeight], 'landscape');
          doc.addImage(slideDataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
        }

        state.capturedCount++;
      } catch (err) {
        console.error(`[GSlides PDF Exporter] Error capturing slide ${current}:`, err);
        updateHUDStatus(`Warning: Error capturing slide ${current}. Skipping...`);
        await sleep(300);
      }

      // If not at the last slide, advance to next
      if (current < state.endSlide && !state.cancelRequested) {
        await advanceToSlide(current + 1);
      }
    }

    // 5. Finalize and trigger download
    if (state.capturedCount > 0) {
      updateHUDStatus('Compiling consolidated PDF file...');
      const dot = state.hudEl?.querySelector('#gslides-hud-dot');
      if (dot) dot.classList.add('finalizing');

      await sleep(150);

      const title = getPresentationTitle();
      const sanitizedTitle = title.replace(/[/\\?%*:|"<>]/g, '_');
      const filename = `${sanitizedTitle}.pdf`;

      try {
        const pdfBlob = doc.output('blob');
        const blobUrl = URL.createObjectURL(pdfBlob);

        chrome.runtime.sendMessage(
          {
            action: 'downloadFile',
            url: blobUrl,
            filename: filename
          },
          (res) => {
            if (res && res.success) {
              updateHUDStatus(`Complete! Exported ${state.capturedCount} slides to PDF.`);
            } else {
              // Direct browser fallback download
              doc.save(filename);
              updateHUDStatus(`Complete! PDF saved.`);
            }
          }
        );
      } catch (saveErr) {
        console.error('[GSlides PDF Exporter] Error saving PDF:', saveErr);
        doc.save(`${sanitizedTitle}.pdf`);
        updateHUDStatus('PDF downloaded directly.');
      }
    } else {
      updateHUDStatus('No slides captured.');
    }

    state.isExporting = false;
    removeHUD(5000);
  }

  // Chrome Runtime Message Listener for Popup and Background commands
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getSlideInfo') {
      const total = detectTotalSlides();
      const current = detectCurrentSlideIndex();
      const title = getPresentationTitle();

      sendResponse({
        success: true,
        title: title,
        totalSlides: total,
        currentSlide: current,
        isExporting: state.isExporting,
        capturedCount: state.capturedCount
      });
      return true;
    }

    if (request.action === 'startExport') {
      if (state.isExporting) {
        sendResponse({ success: false, message: 'Export is already in progress.' });
        return true;
      }

      runExportWorkflow(request.config || {})
        .then(() => {
          console.log('[GSlides PDF Exporter] Workflow completed.');
        })
        .catch((err) => {
          console.error('[GSlides PDF Exporter] Workflow fatal error:', err);
          updateHUDStatus('Fatal error during export. Check console.');
          state.isExporting = false;
        });

      sendResponse({ success: true, message: 'Export initiated.' });
      return true;
    }

    if (request.action === 'cancelExport') {
      cancelExportWorkflow();
      sendResponse({ success: true, message: 'Cancellation requested.' });
      return true;
    }

    if (request.action === 'getStatus') {
      sendResponse({
        isExporting: state.isExporting,
        currentSlide: state.currentSlide,
        endSlide: state.endSlide,
        capturedCount: state.capturedCount
      });
      return true;
    }
  });

  console.log('[GSlides PDF Exporter] Content script loaded and ready.');
})();
