/**
 * The starting point for a page: a complete, working file that passes the check, showing the
 * kit's pieces. The page skill tells teammates to copy it and replace the content.
 */
export const PAGE_TEMPLATE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>How the example service works</title>
  <link rel="stylesheet" href="/lib/kit@1/page.css">
  <!-- Only the libraries this page uses, then the kit's script. -->
  <script src="/lib/mermaid@12/mermaid.min.js"></script>
  <script src="/lib/chart.js@4/chart.umd.min.js"></script>
  <script src="/lib/highlight@11/highlight.min.js"></script>
  <script src="/lib/kit@1/kit.js"></script>
  <style>
    /* Give the page its own character with a few tokens. */
    :root { --accent: #2f6fed; }
  </style>
</head>
<body>
<main class="page">
  <header class="hero">
    <div class="eyebrow">System design</div>
    <h1>How the example service works</h1>
    <p class="lede">The answer first, in two or three sentences: what it is, the one idea that makes it work, and what it costs.</p>
    <div class="meta"><span>Researched November 2026</span><span>From 4 sources</span><span>8 min read</span></div>
  </header>

  <nav class="toc"></nav>

  <section>
    <h2>The short version</h2>
    <div class="stats">
      <div class="stat"><span class="value">2.1M</span><span class="label">requests per second at peak</span></div>
      <div class="stat"><span class="value">&lt;20 ms</span><span class="label">p99 latency</span></div>
      <div class="stat"><span class="value">3</span><span class="label">regions, active-active</span></div>
    </div>
    <div class="callout tip"><strong>Key idea</strong>The one thing to remember, said plainly.</div>
  </section>

  <section>
    <h2>Architecture</h2>
    <figure class="diagram">
      <pre class="mermaid">
flowchart LR
  client[Client] --> edge[Edge proxy]
  edge --> api[API service]
  api --> cache[(Cache)]
  api --> db[(Primary database)]
      </pre>
      <figcaption>Requests go through the edge to the API, which reads from cache first.</figcaption>
    </figure>
  </section>

  <section>
    <h2>A request, step by step</h2>
    <div class="stepper">
      <div class="step"><h3>1. The client calls the edge</h3><p>What happens and why it matters.</p></div>
      <div class="step"><h3>2. The API checks the cache</h3><p>What happens on a hit and on a miss.</p></div>
      <div class="step"><h3>3. The database answers</h3><p>Where the data lives and how it's kept consistent.</p></div>
    </div>
  </section>

  <section>
    <h2>Trade-offs</h2>
    <div class="compare">
      <div class="pros"><h4>What it buys</h4><ul><li>Low latency for reads</li><li>Survives a region going down</li></ul></div>
      <div class="cons"><h4>What it costs</h4><ul><li>Writes are eventually consistent</li><li>More moving parts to run</li></ul></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Option</th><th>Latency</th><th>Consistency</th></tr></thead>
        <tbody>
          <tr><td>Single region</td><td>Low nearby</td><td>Strong</td></tr>
          <tr class="highlight"><td>Active-active <span class="badge sourced">from the post</span></td><td>Low everywhere</td><td>Eventual</td></tr>
          <tr><td>Read replicas <span class="badge inferred">our guess</span></td><td>Low for reads</td><td>Lagging reads</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Traffic over a day</h2>
    <div class="chart"><canvas id="traffic" aria-label="Requests per hour over a day"></canvas></div>
  </section>

  <section>
    <h2>Go deeper</h2>
    <details><summary>How the cache is kept fresh</summary><p>The detail most readers can skip.</p></details>
    <pre><code class="language-python">def handle(request):
    return cache.get(request.key) or db.read(request.key)</code></pre>
  </section>

  <section>
    <h2>Check yourself</h2>
    <div class="quiz" data-answer="1">
      <p class="question">Why are writes only eventually consistent?</p>
      <div class="options"><button>Because the cache is slow</button><button>Because regions accept writes independently</button><button>Because of the edge proxy</button></div>
      <p class="explain">Each region takes writes on its own and replicates them later.</p>
    </div>
  </section>

  <section>
    <h2>Sources</h2>
    <ol class="sources">
      <li><a href="https://example.com/engineering/post">The original post</a>, the company's engineering blog</li>
    </ol>
  </section>

  <footer class="page-footer">Made by your teammate. Ask about any part of it in the app.</footer>
</main>
<script>
  new Chart(document.getElementById("traffic"), {
    type: "line",
    data: {
      labels: ["00", "04", "08", "12", "16", "20"],
      datasets: [{ label: "Requests (M/s)", data: [0.6, 0.4, 1.2, 1.9, 2.1, 1.4], fill: true, tension: 0.35 }],
    },
  });
</script>
</body>
</html>
`;
