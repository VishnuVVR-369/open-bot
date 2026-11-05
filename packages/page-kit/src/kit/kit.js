/*
 * open-bot page kit, v1: behavior for the components in page.css, and setup for the shared
 * libraries a page loads (Mermaid, highlight.js, KaTeX, Chart.js), so they match the page's theme.
 * Load it after the libraries and before your own script:
 *   <script src="/lib/kit@1/kit.js"></script>
 * Your script can read window.OpenBotPage: theme() ("light" or "dark") and color(name) (a token's
 * value, like color("series-1")), for charts drawn by hand.
 */
(function () {
  "use strict";
  var root = document.documentElement;

  function theme() {
    var set = root.getAttribute("data-theme");
    if (set === "dark" || set === "light") return set;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function color(name) {
    return getComputedStyle(root)
      .getPropertyValue("--" + name)
      .trim();
  }

  window.OpenBotPage = { theme: theme, color: color };

  // Chart.js: colors and type from the page, set before the page draws any chart.
  if (window.Chart && window.Chart.defaults) {
    var defaults = window.Chart.defaults;
    defaults.color = color("muted");
    defaults.borderColor = color("border");
    defaults.font.family = getComputedStyle(root).getPropertyValue("--font-body").trim();
    defaults.font.size = 13;
    defaults.maintainAspectRatio = false;
    defaults.plugins.legend.labels.usePointStyle = true;
    if (defaults.plugins.colors) defaults.plugins.colors.enabled = false;
    var series = [1, 2, 3, 4, 5, 6].map(function (n) {
      return color("series-" + n);
    });
    var perPoint = { pie: true, doughnut: true, polarArea: true };
    // Datasets without their own colors take the page's series colors, in order.
    window.Chart.register({
      id: "openbotSeries",
      beforeUpdate: function (chart) {
        var type = chart.config.type;
        chart.data.datasets.forEach(function (dataset, i) {
          var own = series[i % series.length];
          var kind = dataset.type || type;
          if (perPoint[kind]) {
            if (!dataset.backgroundColor)
              dataset.backgroundColor = (chart.data.labels || []).map(function (_, j) {
                return series[j % series.length];
              });
            if (!dataset.borderColor) dataset.borderColor = color("surface");
            return;
          }
          if (!dataset.borderColor) dataset.borderColor = own;
          if (!dataset.backgroundColor)
            dataset.backgroundColor = kind === "line" || kind === "radar" ? own + "26" : own;
        });
      },
    });
    window.OpenBotPage.series = series;
  }

  function slug(text) {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "section"
    );
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    // Headings get ids, so the table of contents and shared links can point at them.
    var used = {};
    document.querySelectorAll("h2, h3").forEach(function (heading) {
      if (!heading.id) {
        var id = slug(heading.textContent || "");
        while (used[id] || document.getElementById(id)) id += "-2";
        heading.id = id;
      }
      used[heading.id] = true;
    });

    // <nav class="toc"></nav> fills itself from the page's h2 (and h3 with data-depth="3").
    document.querySelectorAll("nav.toc").forEach(function (nav) {
      if (nav.querySelector("a")) return;
      var depth = nav.getAttribute("data-depth") === "3" ? "h2, h3" : "h2";
      var title = document.createElement("p");
      title.className = "toc-title";
      title.textContent = nav.getAttribute("data-title") || "On this page";
      var list = document.createElement("ol");
      document.querySelectorAll(depth).forEach(function (heading) {
        if (heading.closest(".toc, .card, .tabs, .stepper")) return;
        var item = document.createElement("li");
        if (heading.tagName === "H3") item.className = "toc-sub";
        var link = document.createElement("a");
        link.href = "#" + heading.id;
        link.textContent = heading.textContent;
        item.appendChild(link);
        list.appendChild(item);
      });
      nav.appendChild(title);
      nav.appendChild(list);
    });

    // Tabs: <div class="tabs"><div role="tablist"><button role="tab">A</button>…</div>
    //        <div role="tabpanel">…</div>…</div>
    document.querySelectorAll(".tabs").forEach(function (tabs, index) {
      var buttons = tabs.querySelectorAll('[role="tab"]');
      var panels = tabs.querySelectorAll('[role="tabpanel"]');
      function select(n) {
        buttons.forEach(function (button, i) {
          button.setAttribute("aria-selected", i === n ? "true" : "false");
          button.tabIndex = i === n ? 0 : -1;
        });
        panels.forEach(function (panel, i) {
          panel.hidden = i !== n;
        });
        // Charts drawn in hidden panels need to measure again.
        window.dispatchEvent(new Event("resize"));
      }
      buttons.forEach(function (button, i) {
        if (!button.id) button.id = "tab-" + index + "-" + i;
        if (panels[i]) panels[i].setAttribute("aria-labelledby", button.id);
        button.type = "button";
        button.addEventListener("click", function () {
          select(i);
        });
        button.addEventListener("keydown", function (event) {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          var next = (i + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
          select(next);
          buttons[next].focus();
        });
      });
      var initial = 0;
      buttons.forEach(function (button, i) {
        if (button.getAttribute("aria-selected") === "true") initial = i;
      });
      select(initial);
    });

    // Steppers: <div class="stepper"><div class="step">…</div>…</div>, one step at a time.
    document.querySelectorAll(".stepper").forEach(function (stepper) {
      var steps = stepper.querySelectorAll(":scope > .step");
      if (steps.length < 2) return;
      var current = 0;
      var controls = document.createElement("div");
      controls.className = "stepper-controls";
      var back = document.createElement("button");
      back.type = "button";
      back.textContent = "Back";
      var label = document.createElement("span");
      var next = document.createElement("button");
      next.type = "button";
      next.textContent = "Next";
      controls.appendChild(back);
      controls.appendChild(label);
      controls.appendChild(next);
      stepper.appendChild(controls);
      function show(n) {
        current = n;
        steps.forEach(function (step, i) {
          step.hidden = i !== n;
        });
        label.textContent = "Step " + (n + 1) + " of " + steps.length;
        back.disabled = n === 0;
        next.disabled = n === steps.length - 1;
        window.dispatchEvent(new Event("resize"));
      }
      back.addEventListener("click", function () {
        show(Math.max(0, current - 1));
      });
      next.addEventListener("click", function () {
        show(Math.min(steps.length - 1, current + 1));
      });
      show(0);
    });

    // Quizzes: <div class="quiz" data-answer="2"><p class="question">…</p>
    //   <div class="options"><button>…</button>…</div><p class="explain">…</p></div>
    document.querySelectorAll(".quiz").forEach(function (quiz) {
      var answer = Number(quiz.getAttribute("data-answer"));
      var explain = quiz.querySelector(".explain");
      if (explain) explain.hidden = true;
      var options = quiz.querySelectorAll(".options button");
      options.forEach(function (option, i) {
        option.type = "button";
        option.addEventListener("click", function () {
          options.forEach(function (other, j) {
            other.removeAttribute("data-result");
            if (j === answer) other.setAttribute("data-result", "right");
          });
          if (i !== answer) option.setAttribute("data-result", "wrong");
          if (explain) explain.hidden = false;
        });
      });
    });

    // Copy buttons on code blocks.
    document.querySelectorAll("pre > code").forEach(function (code) {
      var pre = code.parentElement;
      if (!pre || pre.querySelector(".copy-code") || !navigator.clipboard) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "Copy";
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(code.textContent || "").then(
          function () {
            button.textContent = "Copied";
            setTimeout(function () {
              button.textContent = "Copy";
            }, 1500);
          },
          function () {
            button.textContent = "Select and copy";
          },
        );
      });
      pre.appendChild(button);
    });

    // Code highlighting.
    if (window.hljs) {
      document.querySelectorAll("pre code").forEach(function (block) {
        if (!block.classList.contains("nohighlight")) window.hljs.highlightElement(block);
      });
    }

    // Math: $$…$$ and \[…\] for display, \(…\) inline.
    if (window.renderMathInElement) {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    }

    // Diagrams: <pre class="mermaid">…</pre> (or a div), drawn in the page's theme.
    if (window.mermaid && document.querySelector(".mermaid")) {
      var dark = theme() === "dark";
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: getComputedStyle(root).getPropertyValue("--font-body").trim(),
        themeVariables: {
          darkMode: dark,
          background: color("surface"),
          primaryColor: dark ? "#1f2a44" : "#eaf1ff",
          primaryBorderColor: color("accent"),
          primaryTextColor: color("ink"),
          secondaryColor: color("subtle"),
          tertiaryColor: color("surface"),
          lineColor: color("muted"),
          textColor: color("ink"),
          mainBkg: dark ? "#1f2a44" : "#eaf1ff",
          nodeBorder: color("accent"),
          clusterBkg: color("subtle"),
          clusterBorder: color("border"),
          edgeLabelBackground: color("surface"),
          noteBkgColor: dark ? "#3a3220" : "#fff6dd",
          noteTextColor: color("ink"),
          noteBorderColor: color("warn"),
          actorBkg: dark ? "#1f2a44" : "#eaf1ff",
          actorBorder: color("accent"),
          actorTextColor: color("ink"),
          signalColor: color("ink"),
          signalTextColor: color("ink"),
          fontSize: "15px",
        },
      });
      window.mermaid.run({ querySelector: ".mermaid" }).catch(function (error) {
        console.error("A diagram didn't draw: " + (error && error.message ? error.message : error));
      });
    }
  });
})();
