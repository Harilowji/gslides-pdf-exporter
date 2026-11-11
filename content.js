/**
 * Google Slides High-Res PDF Exporter
 * Content Script (Manifest V3)
 *
 * Automates slide stage traversal and captures rendered stages
 * progressively into a consolidated high-resolution 16:9 PDF.
 */

(() => {
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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function getPresentationTitle() {
    const titleInput = document.querySelector('.docs-title-input, input.docs-title-input');
    if (titleInput && titleInput.value && titleInput.value.trim().length > 0) {
      return titleInput.value.trim();
    }
    const docTitle = document.title || 'Google Slides Presentation';
    return docTitle.replace(/ - Google (Slides|Trang trình bày)$/i, '').trim();
  }

  /**
   * Accurate detection of total slides in Google Slides (works in View-Only & Edit mode)
   */
  function detectTotalSlides() {
    // 1. Specifically look inside the filmstrip container (excludes menus like File menu which has 8 items)
    const filmstrip = document.querySelector(
      '.punch-filmstrip-scroll-container, .punch-filmstrip, [role="listbox"], .docs-filmstrip'
    );
    if (filmstrip) {
      const filmstripItem = filmstrip.querySelector('[aria-setsize]');
      if (filmstripItem) {
        const val = parseInt(filmstripItem.getAttribute('aria-setsize'), 10);
        if (!isNaN(val) && val > 0) return val;
      }
    }

    // 2. Scan all aria-setsize elements excluding menus and toolbars, find maximum
    const allSetSize = Array.from(document.querySelectorAll('[aria-setsize]'));
    let maxSet = 0;
    for (const el of allSetSize) {
      if (el.closest('[role="menu"], [role="menubar"], .goog-menu, .docs-material-menu, .goog-toolbar')) {
        continue;
      }
      const val = parseInt(el.getAttribute('aria-setsize'), 10);
      if (!isNaN(val) && val > maxSet) {
        maxSet = val;
      }
    }
    if (maxSet > 0) return maxSet;

    // 3. Scan all aria-posinset elements in the filmstrip or document body
    const posElements = Array.from(document.querySelectorAll('[aria-posinset]'));
    let maxPos = 0;
    for (const el of posElements) {
      if (el.closest('[role="menu"], [role="menubar"], .goog-menu, .docs-material-menu, .goog-toolbar')) {
        continue;
      }
      const val = parseInt(el.getAttribute('aria-posinset'), 10);
      if (!isNaN(val) && val > maxPos) {
        maxPos = val;
      }
    }
    if (maxPos > 0) return maxPos;

    // 4. Count filmstrip items
    const thumbnails = document.querySelectorAll(
      '.punch-filmstrip-thumbnail, .punch-filmstrip-item, [role="option"]'
    );
    if (thumbnails && thumbnails.length > 0) {
      return thumbnails.length;
    }

    return 1;
  }

  function detectCurrentSlideIndex() {
    const selectedItem = document.querySelector(
      '.punch-filmstrip [role="option"][aria-selected="true"], .punch-filmstrip [aria-posinset][aria-selected="true"], .punch-filmstrip-thumbnail-focused'
    );
    if (selectedItem) {
      const pos = parseInt(selectedItem.getAttribute('aria-posinset'), 10);
      if (!isNaN(pos) && pos > 0) return pos;
    }

    const anySelected = document.querySelector('[role="option"][aria-selected="true"]');
    if (anySelected && !anySelected.closest('[role="menu"]')) {
      const pos = parseInt(anySelected.getAttribute('aria-posinset'), 10);
      if (!isNaN(pos) && pos > 0) return pos;
    }

    return state.currentSlide || 1;
  }

  /**
   * Find exact rendered 16:9 slide stage element (excludes grey workspace border)
   */
  function findSlideElement() {
    // 1. Highest priority: exact SVG slide page container
    const candidates = [
      document.querySelector('.punch-viewer-svgpage svg'),
      document.querySelector('svg.punch-viewer-svgpage-svg'),
      document.querySelector('.punch-viewer-svgpage'),
      document.querySelector('.punch-viewer-content svg.punch-viewer-svgpage-svg'),
      document.querySelector('.punch-viewer-content canvas'),
      document.querySelector('.punch-viewer-content')
    ];

    for (const el of candidates) {
      if (el) {
        const rect = el.getBoundingClientRect();
        // Check for realistic 16:9 dimensions
        const ratio = rect.width / rect.height;
        if (rect.width > 240 && rect.height > 135 && ratio >= 1.2 && ratio <= 2.2) {
          return { element: el, rect };
        }
      }
    }

    // 2. Fallback: inspect any SVG or Canvas in center stage
    const svgs = Array.from(document.querySelectorAll('svg, canvas'));
    for (const el of svgs) {
      if (el.closest('.punch-filmstrip, [role="listbox"], [role="menu"]')) continue;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width / rect.height;
      if (rect.width > 300 && rect.height > 180 && ratio >= 1.3 && ratio <= 2.0) {
        return { element: el, rect };
      }
    }

    const fallbackEl = document.querySelector('#workspace-container, .docs-editor-container') || document.body;
    return { element: fallbackEl, rect: fallbackEl.getBoundingClientRect() };
  }

  /**
   * Dispatches navigation events across all candidate targets
   */
  function dispatchNavigationEvent(direction = 'next') {
    const isNext = direction === 'next';
    const key = isNext ? 'ArrowDown' : 'ArrowUp';
    const keyCode = isNext ? 40 : 38;
    const pageKey = isNext ? 'PageDown' : 'PageUp';
    const pageKeyCode = isNext ? 34 : 33;
    const rightKey = isNext ? 'ArrowRight' : 'ArrowLeft';
    const rightKeyCode = isNext ? 39 : 37;

    const makeOpts = (k, code) => ({
      key: k,
      code: k,
      keyCode: code,
      which: code,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });

    const targets = [
      document.querySelector('.punch-filmstrip-scroll-container'),
      document.querySelector('.punch-filmstrip'),
      document.querySelector('.punch-viewer-content'),
      document.querySelector('.docs-editor-container'),
      document.activeElement,
      document.body,
      document
    ].filter(Boolean);

    for (const t of targets) {
      try {
        t.focus?.();
        t.dispatchEvent(new KeyboardEvent('keydown', makeOpts(key, keyCode)));
        t.dispatchEvent(new KeyboardEvent('keyup', makeOpts(key, keyCode)));
        t.dispatchEvent(new KeyboardEvent('keydown', makeOpts(pageKey, pageKeyCode)));
        t.dispatchEvent(new KeyboardEvent('keyup', makeOpts(pageKey, pageKeyCode)));
        t.dispatchEvent(new KeyboardEvent('keydown', makeOpts(rightKey, rightKeyCode)));
        t.dispatchEvent(new KeyboardEvent('keyup', makeOpts(rightKey, rightKeyCode)));
      } catch (e) {}
    }
  }

  async function advanceToSlide(targetIndex) {
    const filmstrip = document.querySelector('.punch-filmstrip-scroll-container') ||
                      document.querySelector('.punch-filmstrip');

    let thumb = document.querySelector(`[aria-posinset="${targetIndex}"]`);

    // If thumbnail is not yet mounted in the virtual DOM, scroll filmstrip to mount it
    if (!thumb && filmstrip) {
      filmstrip.scrollTop = Math.max(0, (targetIndex - 2) * 78);
      await sleep(250);
      thumb = document.querySelector(`[aria-posinset="${targetIndex}"]`);
    }

    if (thumb) {
      thumb.scrollIntoView({ block: 'nearest' });
      thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      thumb.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      thumb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return;
    }

    // Fallback if still missing: dispatch ArrowDown on filmstrip and PageDown on stage
    if (filmstrip) {
      filmstrip.focus?.();
      filmstrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true }));
      filmstrip.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true }));
    }

    const stage = document.querySelector('.punch-viewer-content') || document.body;
    stage.focus?.();
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', keyCode: 34, which: 34, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new KeyboardEvent('keyup', { key: 'PageDown', code: 'PageDown', keyCode: 34, which: 34, bubbles: true, cancelable: true }));
  }

  async function navigateToStartSlide(startSlideIndex) {
    updateHUDStatus(`Navigating to slide ${startSlideIndex}...`);

    const filmstrip = document.querySelector(
      '.punch-filmstrip-scroll-container, .punch-filmstrip'
    );
    if (filmstrip && startSlideIndex === 1) {
      filmstrip.scrollTop = 0;
      await sleep(200);
    }

    if (startSlideIndex === 1) {
      let firstThumb = document.querySelector('[aria-posinset="1"]');
      if (!firstThumb && filmstrip) {
        filmstrip.scrollTop = 0;
        await sleep(200);
        firstThumb = document.querySelector('[aria-posinset="1"]');
      }
      if (firstThumb) {
        firstThumb.scrollIntoView({ block: 'nearest' });
        firstThumb.click();
      } else {
        dispatchNavigationEvent('prev');
      }
    } else {
      await advanceToSlide(startSlideIndex);
    }

    await sleep(state.config.delayMs + 200);
    await waitForPaint();
  }

  async function captureSlideStage(rect, scale = 2.0) {
    const hud = document.getElementById('gslides-pdf-hud-root');
    if (hud) {
      hud.classList.add('hud-hidden');
      hud.style.display = 'none';
    }

    // Guarantee the browser compositor has completed a full repaint without the HUD element
    await sleep(70);
    await new Promise((r) => requestAnimationFrame(r));

    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
    } finally {
      if (hud) {
        hud.classList.remove('hud-hidden');
        hud.style.display = 'block';
      }
    }

    if (!response || !response.success || !response.dataUrl) {
      throw new Error(response?.error || 'Failed to capture visible tab.');
    }

    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load tab screenshot image.'));
      image.src = response.dataUrl;
    });

    const tabDpr = window.devicePixelRatio || 1;
    const sx = Math.round(rect.left * tabDpr);
    const sy = Math.round(rect.top * tabDpr);
    const sw = Math.round(rect.width * tabDpr);
    const sh = Math.round(rect.height * tabDpr);

    const targetWidth = Math.round(rect.width * scale);
    const targetHeight = Math.round(rect.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

    const format = state.config.format || 'image/jpeg';
    const quality = state.config.quality || 0.95;
    const dataUrl = canvas.toDataURL(format, quality);

    // Free canvas & image memory immediately
    canvas.width = 0;
    canvas.height = 0;
    img.src = '';

    return dataUrl;
  }

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

  function cancelExportWorkflow() {
    if (!state.isExporting) return;
    state.cancelRequested = true;
    updateHUDStatus('Stopping export... Saving captured slides.');
    const dot = state.hudEl?.querySelector('#gslides-hud-dot');
    if (dot) dot.classList.add('cancelled');
    const cancelBtn = state.hudEl?.querySelector('#gslides-hud-btn-cancel');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  async function runExportWorkflow(config) {
    if (state.isExporting) return;

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

    const detectedTotal = detectTotalSlides();
    state.startSlide = Math.max(1, parseInt(config.startSlide || 1, 10));
    state.endSlide = parseInt(config.endSlide, 10) || detectedTotal || 1;
    state.totalSlides = Math.max(detectedTotal, state.endSlide);

    if (state.endSlide < state.startSlide) {
      state.endSlide = state.startSlide;
    }

    createHUD();
    updateHUDProgress(state.startSlide, state.endSlide, 'Initializing PDF document...');

    // 1. Locate slide element and establish strict 16:9 PDF dimensions
    const slideInfo = findSlideElement();
    const rect = slideInfo.rect;
    const slideRatio = rect.width / rect.height;

    // Strict 16:9 landscape aspect ratio: 960 pt x 540 pt
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
      if (state.cancelRequested) break;

      state.currentSlide = current;
      updateHUDProgress(
        current,
        state.endSlide,
        `Capturing slide stage ${current} of ${state.endSlide}...`
      );

      // Render settle delay for SVG/canvas stabilization
      await sleep(state.config.delayMs);
      await waitForPaint();

      const activeStage = findSlideElement();

      try {
        const slideDataUrl = await captureSlideStage(activeStage.rect, state.config.dpr);

        // Progressively append directly into jsPDF
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

        // Direct DOM download link (works 100% in all View-Only protected Google Slides)
        const downloadLink = document.createElement('a');
        downloadLink.href = blobUrl;
        downloadLink.download = filename;
        downloadLink.style.display = 'none';
        document.body.appendChild(downloadLink);
        downloadLink.click();

        setTimeout(() => {
          if (downloadLink.parentNode) downloadLink.parentNode.removeChild(downloadLink);
          URL.revokeObjectURL(blobUrl);
        }, 15000);

        updateHUDStatus(`Complete! Exported ${state.capturedCount} slides to PDF.`);
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

  // Runtime Message Listener
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getSlideInfo') {
      sendResponse({
        success: true,
        title: getPresentationTitle(),
        totalSlides: detectTotalSlides(),
        currentSlide: detectCurrentSlideIndex(),
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
