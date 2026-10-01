/**
 * Self-contained xterm.js page for the focused terminal. Static on purpose:
 * dimensions, buffer and scale mode are pushed in after the 'ready' message,
 * so React state changes never reload the WebView.
 */
export const TERMINAL_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css"
        onerror="this.onerror=null;this.href='https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css'">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    // CDN fallback: if jsdelivr is blocked, try unpkg before giving up.
    if (typeof Terminal === 'undefined') {
      document.write('<script src="https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.js"><\\/script>');
    }
  </script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: #070d14;
      overflow: hidden;
      font-family: ui-monospace, Menlo, Monaco, "Courier New", monospace;
      -webkit-user-select: none;
      user-select: none;
    }
    #container {
      width: 100%;
      height: 100%;
      position: relative;
      background: #070d14;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
    }
    #scaler {
      transform-origin: top left;
      transition: transform 0.12s ease-out;
      display: inline-block;
    }
    .xterm {
      padding: 4px;
    }
    #container::-webkit-scrollbar {
      display: none;
    }
  </style>
</head>
<body>
  <div id="container">
    <div id="scaler">
      <div id="terminal"></div>
    </div>
  </div>

  <script>
    let term = null;
    let currentCols = 80;
    let currentRows = 24;
    let currentMode = 'fit-width';
    let currentScale = 1.0;

    function post(type, payload) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, payload || {})));
      }
    }

    let initialized = false;
    function init() {
      if (initialized) return;
      initialized = true;
      if (typeof Terminal === 'undefined') {
        document.body.innerHTML = '<p style="color:#ff8888;padding:16px;font:13px sans-serif">Could not load the terminal renderer (xterm.js). Check the phone\\'s internet connection.</p>';
        post('load_error');
        return;
      }
      term = new Terminal({
        cols: currentCols,
        rows: currentRows,
        fontSize: 13,
        lineHeight: 1.15,
        fontFamily: 'ui-monospace, Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#070d14',
          foreground: '#d6e6f5',
          cursor: '#00e5c8',
          cursorAccent: '#070d14',
          selectionBackground: 'rgba(0, 229, 200, 0.3)',
          black: '#0a1017',
          red: '#ff5c57',
          green: '#5af78e',
          yellow: '#f3f99d',
          blue: '#57c7ff',
          magenta: '#ff6ac1',
          cyan: '#9aedfe',
          white: '#f1f1f0',
          brightBlack: '#686868',
          brightRed: '#ff5c57',
          brightGreen: '#5af78e',
          brightYellow: '#f3f99d',
          brightBlue: '#57c7ff',
          brightMagenta: '#ff6ac1',
          brightCyan: '#9aedfe',
          brightWhite: '#eff0eb'
        },
        cursorBlink: true,
        convertEol: false,
        disableStdin: false,
        allowTransparency: true
      });

      term.open(document.getElementById('terminal'));

      // Raw keystroke stream from native mobile keyboard to desktop PTY
      term.onData(function(data) {
        post('input', { data: data });
      });

      // Configure helper textarea for seamless mobile terminal typing
      setTimeout(function() {
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) {
          ta.setAttribute('autocapitalize', 'none');
          ta.setAttribute('autocorrect', 'off');
          ta.setAttribute('autocomplete', 'off');
          ta.setAttribute('spellcheck', 'false');
          ta.setAttribute('enterkeyhint', 'enter');
        }
        applyScale();
        post('ready');
      }, 60);

      // Tapping anywhere focuses terminal and opens native keyboard
      const container = document.getElementById('container');
      container.addEventListener('click', function() {
        if (term) term.focus();
      });
      container.addEventListener('touchend', function() {
        if (term) term.focus();
      });
    }

    // Dynamic shellf-driving scaler: matches exact PTY dimensions, scales visually
    function applyScale() {
      const scaler = document.getElementById('scaler');
      const container = document.getElementById('container');
      if (!term || !term.element || !scaler || !container) return;

      scaler.style.transform = 'scale(1)';
      const termW = term.element.offsetWidth || (currentCols * 7.8);
      const termH = term.element.offsetHeight || (currentRows * 15.2);
      const contW = container.clientWidth || window.innerWidth;
      const contH = container.clientHeight || window.innerHeight;

      if (!termW || !termH || !contW || !contH) return;

      let s = 1.0;
      if (currentMode === 'fit-screen') {
        // Letterbox both dimensions: full desktop grid visible on phone
        s = Math.max(0.15, Math.min(contW / termW, contH / termH, 3));
      } else if (currentMode === 'fit-width') {
        // Fit width: scales to phone width, allows vertical scrolling
        s = Math.max(0.15, Math.min(contW / termW, 3));
      } else if (currentMode === '100') {
        s = 1.0;
      } else if (currentMode === 'custom') {
        s = currentScale;
      }

      currentScale = s;
      scaler.style.transform = 'scale(' + s.toFixed(4) + ')';

      post('scale_change', {
        scale: s,
        mode: currentMode,
        cols: currentCols,
        rows: currentRows
      });
    }

    window.writeOutput = function(chunk) {
      if (term && chunk) {
        term.write(chunk);
      }
    };

    window.syncTerminal = function(cols, rows, buffer) {
      if (!term) return;
      if (cols && rows && (cols !== currentCols || rows !== currentRows)) {
        currentCols = cols;
        currentRows = rows;
        term.resize(cols, rows);
      }
      if (typeof buffer === 'string') {
        term.reset();
        if (buffer.length > 0) {
          term.write(buffer);
        }
      }
      applyScale();
    };

    window.resizeTerminal = function(cols, rows) {
      if (!term || !cols || !rows) return;
      currentCols = cols;
      currentRows = rows;
      term.resize(cols, rows);
      applyScale();
    };

    window.setScaleMode = function(mode) {
      currentMode = mode;
      applyScale();
    };

    window.adjustZoom = function(delta) {
      currentMode = 'custom';
      currentScale = Math.max(0.2, Math.min(3.0, currentScale + delta));
      applyScale();
    };

    window.clearTerminal = function() {
      if (term) term.clear();
    };

    window.focusTerminal = function() {
      if (term) {
        term.focus();
      }
    };

    window.addEventListener('resize', function() {
      applyScale();
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  </script>
</body>
</html>`;
