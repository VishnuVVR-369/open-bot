/*
 * open-bot page runtime. Added to every page when it's served (never stored with it), ahead of the
 * page's own scripts. It keeps pages working the same everywhere they open:
 * - links to other sites open in a new tab (or the phone's browser), never inside the page frame;
 * - the app's light or dark theme applies (`?theme=`);
 * - with `?ask=1`, selecting text offers "Ask about this", which hands the passage to the app.
 * The app only ever prefills a message you send yourself, so a page can't speak for you.
 */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var native = window.ReactNativeWebView;
  var framed = window.parent && window.parent !== window;

  var theme = params.get("theme");
  if (theme === "dark" || theme === "light") {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }

  function send(message) {
    if (native) native.postMessage(JSON.stringify(message));
    else if (framed) window.parent.postMessage(message, "*");
  }

  // Links: in-page anchors scroll; everything else opens outside the page.
  document.addEventListener(
    "click",
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      var target = event.target;
      var link = target && target.closest ? target.closest("a[href]") : null;
      if (!link) return;
      var href = link.getAttribute("href") || "";
      if (href.charAt(0) === "#") return;
      var url;
      try {
        url = new URL(href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:")
        return;
      event.preventDefault();
      if (native) send({ source: "openbot-page", type: "open", url: url.href });
      else window.open(url.href, "_blank", "noopener,noreferrer");
    },
    true,
  );

  if (params.get("ask") !== "1" || (!native && !framed)) return;

  var host = null;
  var button = null;
  var pending = null;

  function heading(node) {
    var headings = document.querySelectorAll("h1, h2, h3");
    var found = null;
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (h === node || h.contains(node)) return h.textContent;
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
      else break;
    }
    return found ? found.textContent : null;
  }

  function ensureButton() {
    if (button) return button;
    host = document.createElement("openbot-ask");
    host.style.cssText = "position:absolute;top:0;left:0;z-index:2147483647;display:none";
    // Its own styles, so the page's can't reach it (and its can't reach the page's).
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent =
      "button{all:initial;display:inline-flex;align-items:center;gap:6px;cursor:pointer;" +
      "font:600 13px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;" +
      "background:#14161b;border-radius:999px;padding:9px 13px;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.22),0 0 0 1px rgba(255,255,255,.08)}" +
      // Light on a dark page, dark on a light one.
      ":host([data-dark]) button{color:#14161b;background:#f3f4f6;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.2)}" +
      "button:focus-visible{outline:2px solid #3e7bfa;outline-offset:2px}" +
      "svg{width:14px;height:14px}";
    button = document.createElement("button");
    button.type = "button";
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Ask about this';
    button.addEventListener("mousedown", function (event) {
      event.preventDefault();
    });
    button.addEventListener("click", function () {
      if (!pending) return;
      send({ source: "openbot-page", type: "ask", quote: pending.quote, section: pending.section });
      hide();
      var selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    });
    shadow.appendChild(style);
    shadow.appendChild(button);
    document.body.appendChild(host);
    return button;
  }

  function isDark() {
    var set = root.getAttribute("data-theme");
    if (set === "dark" || set === "light") return set === "dark";
    return window.matchMedia ? matchMedia("(prefers-color-scheme: dark)").matches : false;
  }

  function hide() {
    pending = null;
    if (host) host.style.display = "none";
  }

  var timer = null;
  function update() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide();
    var quote = selection.toString().replace(/\s+/g, " ").trim();
    if (quote.length < 2) return hide();
    var range = selection.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return hide();
    pending = { quote: quote.slice(0, 1000), section: heading(range.startContainer) };
    ensureButton();
    if (isDark()) host.setAttribute("data-dark", "");
    else host.removeAttribute("data-dark");
    host.style.display = "block";
    var width = button.offsetWidth || 140;
    var left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - 8),
    );
    // Below the selection on touch screens, where the system's own menu sits above it.
    var below = native || "ontouchstart" in window || rect.top < 56;
    var top = below ? rect.bottom + 10 : rect.top - 46;
    host.style.transform =
      "translate(" + Math.round(left + scrollX) + "px," + Math.round(top + scrollY) + "px)";
  }

  document.addEventListener("selectionchange", function () {
    clearTimeout(timer);
    timer = setTimeout(update, 180);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hide();
  });
})();
