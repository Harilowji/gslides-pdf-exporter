# Google Slides High-Res PDF Exporter (Chrome Extension)

A Chrome Extension built with **Manifest V3** to automate traversing and exporting Google Slides presentations directly into a high-resolution 16:9 PDF file—even when document downloading or printing is disabled.

---

## 🚀 Features
- **Auto Stage Navigation:** Automatically traverses through slides via DOM stage events without manual scrolling.
- **Lazy Loading Resolution:** Overcomes Google Slides virtual scrolling by settling and capturing each rendered SVG/canvas stage at 2x DPR.
- **Low-RAM Footprint:** Progressively streams slide captures directly into a local `jsPDF` instance, handling 380+ slide decks without browser memory crashes.
- **Floating Progress HUD:** Real-time progress bar, slide counter, elapsed time, ETA estimation, and cancellation control.
- **16:9 Landscape Aspect Ratio:** Zero-margin, edge-to-edge PDF compilation matching standard presentation dimensions.

---

## 🛠 Architecture
```text
gslides-pdf-exporter/
├── manifest.json       # Manifest V3 configuration & permissions
├── background.js       # Background Service Worker (captureVisibleTab & downloads)
├── content.js          # Automation engine, stage detection & PDF compiler
├── content.css         # Glassmorphism Progress HUD styling
├── popup/
│   ├── popup.html      # Configuration & run popup
│   ├── popup.css       # Dark-mode popup UI
│   └── popup.js        # Controller & message passing logic
├── libs/
│   └── jspdf.umd.min.js# Standalone local jsPDF build
└── icons/              # Extension icons (16px, 48px, 128px)
```

---

## 📥 Installation & Usage

1. Clone or download this repository:
```bash
git clone https://github.com/<YOUR_USERNAME>/gslides-pdf-exporter.git
```

2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left) and select this repository folder.
5. Open your Google Slides deck in edit/view mode (`https://docs.google.com/presentation/d/*/edit*`).
6. Click the extension icon in your Chrome toolbar, configure the settle delay (default 450ms), and click **Start Export to PDF**.

---

## 📄 License
MIT License
