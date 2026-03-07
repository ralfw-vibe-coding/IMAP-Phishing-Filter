type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = () => Promise<HandlerResponse>;

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PhishingKiller Dashboard</title>
    <style>
      :root {
        --bg: #f4f7fb;
        --card: #ffffff;
        --text: #1b2733;
        --muted: #6a7887;
        --ok: #127a45;
        --warn: #9a5a00;
        --err: #b42318;
        --line: #d8e0ea;
        --btn: #0b63c9;
      }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .wrap {
        max-width: 900px;
        margin: 24px auto;
        padding: 0 16px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 16px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      .muted {
        color: var(--muted);
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      button {
        border: 0;
        border-radius: 8px;
        padding: 10px 14px;
        color: #fff;
        background: var(--btn);
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      pre {
        background: #0f1720;
        color: #d8e6f4;
        border-radius: 10px;
        padding: 12px;
        overflow: auto;
      }
      .status-ok { color: var(--ok); font-weight: 600; }
      .status-warn { color: var(--warn); font-weight: 600; }
      .status-err { color: var(--err); font-weight: 600; }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        border-bottom: 1px solid var(--line);
        padding: 8px 6px;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>PhishingKiller Dashboard</h1>
        <div class="muted">Liest <code>scan-status</code> und kann <code>scan-background</code> starten.</div>
      </div>

      <div class="card">
        <div class="row">
          <button id="refreshBtn">Status laden</button>
          <button id="scanBtn">Scan jetzt starten</button>
          <span id="headline" class="muted">lade...</span>
        </div>
      </div>

      <div class="card">
        <h3>Status</h3>
        <div id="meta" class="muted">-</div>
        <div id="statusLine" class="muted">-</div>
      </div>

      <div class="card">
        <h3>Accounts</h3>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Label</th>
              <th>lastSeenUid</th>
            </tr>
          </thead>
          <tbody id="accountsBody"></tbody>
        </table>
      </div>

      <div class="card">
        <h3>Raw JSON</h3>
        <pre id="raw"></pre>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const refreshBtn = $("refreshBtn");
      const scanBtn = $("scanBtn");
      const headline = $("headline");
      const meta = $("meta");
      const statusLine = $("statusLine");
      const accountsBody = $("accountsBody");
      const raw = $("raw");

      function esc(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function classFor(state) {
        if (state === "ok") return "status-ok";
        if (state === "busy" || state === "running") return "status-warn";
        if (state === "error") return "status-err";
        return "muted";
      }

      async function loadStatus() {
        refreshBtn.disabled = true;
        headline.textContent = "lade status...";
        try {
          const res = await fetch("/.netlify/functions/scan-status", { method: "GET" });
          const data = await res.json();
          const runStatus = data.status?.status ?? "none";

          headline.innerHTML = 'Status: <span class="' + classFor(runStatus) + '">' + esc(runStatus) + "</span>";
          meta.textContent =
            "Version " + (data.version ?? "?") +
            " | store=" + (data.storeKind ?? "?") +
            " | busy=" + String(data.busy ?? false) +
            " | now=" + new Date(data.nowUnixMs ?? Date.now()).toLocaleString();
          statusLine.textContent =
            data.status
              ? "Letztes Ergebnis: " + (data.status.status ?? "?") +
                " @ " + new Date(data.status.updatedAtUnixMs).toLocaleString() +
                (data.status.message ? " | " + data.status.message : "")
              : "Noch kein Laufstatus vorhanden";

          accountsBody.innerHTML = "";
          for (const acc of data.accounts ?? []) {
            const tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" + esc(acc.accountId) + "</td>" +
              "<td>" + esc(acc.label) + "</td>" +
              "<td>" + esc(acc.lastSeenUid ?? "null") + "</td>";
            accountsBody.appendChild(tr);
          }

          raw.textContent = JSON.stringify(data, null, 2);
        } catch (e) {
          headline.innerHTML = '<span class="status-err">Status konnte nicht geladen werden</span>';
          statusLine.textContent = String(e);
          raw.textContent = "";
        } finally {
          refreshBtn.disabled = false;
        }
      }

      async function runScanNow() {
        scanBtn.disabled = true;
        const old = scanBtn.textContent;
        scanBtn.textContent = "starte...";
        try {
          const res = await fetch("/.netlify/functions/scan-background", { method: "POST" });
          if (!res.ok && res.status !== 202) {
            const txt = await res.text();
            throw new Error("HTTP " + res.status + ": " + txt);
          }
          await loadStatus();
        } catch (e) {
          alert("Scan konnte nicht gestartet werden: " + e);
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = old;
        }
      }

      refreshBtn.addEventListener("click", loadStatus);
      scanBtn.addEventListener("click", runScanNow);
      loadStatus();
    </script>
  </body>
</html>`;
}

export const handler: Handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: renderDashboardHtml(),
});
