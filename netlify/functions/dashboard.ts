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
        max-width: 980px;
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
      .muted { color: var(--muted); }
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
      .btn-small {
        padding: 6px 10px;
        font-size: 12px;
      }
      .btn-edit { background: #0b63c9; }
      .btn-delete { background: #b42318; }
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
        vertical-align: middle;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(10, 18, 31, 0.45);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .overlay.open { display: flex; }
      .modal {
        width: 100%;
        max-width: 560px;
        background: #fff;
        border-radius: 12px;
        border: 1px solid var(--line);
        padding: 16px;
      }
      .form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .form-grid .full { grid-column: span 2; }
      label {
        display: block;
        font-size: 13px;
        margin-bottom: 4px;
        color: #334155;
      }
      input, select {
        width: 100%;
        box-sizing: border-box;
        padding: 9px 10px;
        border: 1px solid #c9d5e3;
        border-radius: 8px;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>PhishingKiller Dashboard</h1>
        <div class="muted">Status prüfen, Scan starten und IMAP-Konten verwalten.</div>
      </div>

      <div class="card">
        <div class="row">
          <button id="refreshBtn">Status laden</button>
          <button id="scanBtn">Scan jetzt starten</button>
          <button id="healthBtn">Health-Check jetzt auslösen</button>
          <span id="headline" class="muted">lade...</span>
        </div>
        <div class="row" style="margin-top: 10px;">
          <label for="logLevelSelect" style="margin: 0;">LOG_LEVEL</label>
          <select id="logLevelSelect" style="width: auto;">
            <option value="0">0 (nur Mailzeilen + Phishingwarnungen)</option>
            <option value="1">1 (+ Scan-Rahmen, inkl. Fehler)</option>
            <option value="2">2 (+ Background Orchestrierung)</option>
            <option value="3">3 (+ Debug)</option>
          </select>
          <button id="saveLogLevelBtn" class="btn-small">Log-Level speichern</button>
          <span id="logLevelInfo" class="muted"></span>
        </div>
      </div>

      <div class="card">
        <h3>Status</h3>
        <div id="meta" class="muted">-</div>
        <div id="statusLine" class="muted">-</div>
      </div>

      <div class="card">
        <div class="row" style="justify-content: space-between; margin-bottom: 8px;">
          <h3 style="margin: 0;">IMAP Konten</h3>
          <button id="newAccountBtn">Neu</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Server</th>
              <th>Username</th>
              <th>Folder</th>
              <th>Aktion</th>
            </tr>
          </thead>
          <tbody id="configAccountsBody"></tbody>
        </table>
      </div>

      <div class="card">
        <h3>Scan-Accounts (Status)</h3>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Label</th>
              <th>lastSeenUid</th>
            </tr>
          </thead>
          <tbody id="statusAccountsBody"></tbody>
        </table>
      </div>

      <div class="card">
        <h3>Raw JSON</h3>
        <pre id="raw"></pre>
      </div>
    </div>

    <div id="overlay" class="overlay">
      <div class="modal">
        <h3 id="modalTitle" style="margin-top: 0;">Konto</h3>
        <div class="form-grid">
          <div class="full">
            <label for="fLabel">Label</label>
            <input id="fLabel" />
          </div>
          <div class="full">
            <label for="fServer">Server (z. B. imaps://mail.example.com:993)</label>
            <input id="fServer" />
          </div>
          <div>
            <label for="fUser">Username</label>
            <input id="fUser" />
          </div>
          <div>
            <label for="fPassword">Password</label>
            <input id="fPassword" type="password" />
          </div>
          <div>
            <label for="fFolder">Folder</label>
            <input id="fFolder" value="INBOX" />
          </div>
          <div>
            <label for="fTreatment">Phishing Treatment</label>
            <select id="fTreatment">
              <option value="flag">flag</option>
              <option value="move_to_phishing_folder">move_to_phishing_folder</option>
            </select>
          </div>
          <div class="full">
            <label for="fThreshold">Phishing Threshold (0..1, optional)</label>
            <input id="fThreshold" placeholder="0.5" />
          </div>
        </div>
        <div class="row" style="margin-top: 14px; justify-content: flex-end;">
          <button id="cancelBtn" class="btn-small" style="background:#64748b;">Abbrechen</button>
          <button id="saveBtn" class="btn-small">Speichern</button>
        </div>
      </div>
    </div>

    <div id="authOverlay" class="overlay">
      <div class="modal" style="max-width: 420px;">
        <h3 style="margin-top: 0;">Autorisierung</h3>
        <div class="muted" style="margin-bottom: 10px;">Passwort für Kontoänderungen eingeben</div>
        <label for="authPassword">Dashboard Passwort</label>
        <input id="authPassword" type="password" autocomplete="current-password" />
        <div class="row" style="margin-top: 14px; justify-content: flex-end;">
          <button id="authCancelBtn" class="btn-small" style="background:#64748b;">Abbrechen</button>
          <button id="authConfirmBtn" class="btn-small">Bestätigen</button>
        </div>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const refreshBtn = $("refreshBtn");
      const scanBtn = $("scanBtn");
      const healthBtn = $("healthBtn");
      const logLevelSelect = $("logLevelSelect");
      const saveLogLevelBtn = $("saveLogLevelBtn");
      const logLevelInfo = $("logLevelInfo");
      const newAccountBtn = $("newAccountBtn");
      const headline = $("headline");
      const meta = $("meta");
      const statusLine = $("statusLine");
      const statusAccountsBody = $("statusAccountsBody");
      const configAccountsBody = $("configAccountsBody");
      const raw = $("raw");
      const overlay = $("overlay");
      const authOverlay = $("authOverlay");
      const modalTitle = $("modalTitle");
      const fLabel = $("fLabel");
      const fServer = $("fServer");
      const fUser = $("fUser");
      const fPassword = $("fPassword");
      const fFolder = $("fFolder");
      const fTreatment = $("fTreatment");
      const fThreshold = $("fThreshold");
      const cancelBtn = $("cancelBtn");
      const saveBtn = $("saveBtn");
      const authPassword = $("authPassword");
      const authCancelBtn = $("authCancelBtn");
      const authConfirmBtn = $("authConfirmBtn");

      let currentEditId = null;
      let configAccounts = [];
      let dashboardPassword = null;
      let authPendingResolve = null;
      let authPendingReject = null;

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

      async function api(path, init) {
        const res = await fetch(path, init);
        let data = {};
        try {
          data = await res.json();
        } catch {}
        if (!res.ok) {
          throw new Error((data && data.message) ? data.message : ("HTTP " + res.status));
        }
        return data;
      }

      function closeAuthOverlay() {
        authOverlay.classList.remove("open");
      }

      function openAuthOverlay() {
        authPassword.value = "";
        authOverlay.classList.add("open");
        setTimeout(() => authPassword.focus(), 0);
        return new Promise((resolve, reject) => {
          authPendingResolve = resolve;
          authPendingReject = reject;
        });
      }

      function resolveAuth(value) {
        if (authPendingResolve) authPendingResolve(value);
        authPendingResolve = null;
        authPendingReject = null;
      }

      function rejectAuth(error) {
        if (authPendingReject) authPendingReject(error);
        authPendingResolve = null;
        authPendingReject = null;
      }

      async function ensureDashboardAuth() {
        if (dashboardPassword) return dashboardPassword;
        const entered = await openAuthOverlay();
        if (!entered || entered.trim().length === 0) {
          throw new Error("Autorisierung abgebrochen");
        }
        dashboardPassword = entered.trim();
        return dashboardPassword;
      }

      async function apiWithDashboardAuth(path, init) {
        const pwd = await ensureDashboardAuth();
        const headers = Object.assign({}, init?.headers ?? {}, {
          "x-dashboard-password": pwd,
        });
        try {
          return await api(path, Object.assign({}, init ?? {}, { headers }));
        } catch (error) {
          const message = String(error ?? "");
          if (message.includes("Unauthorized")) {
            dashboardPassword = null;
          }
          throw error;
        }
      }

      function openModal(mode, account) {
        currentEditId = mode === "edit" ? account.id : null;
        modalTitle.textContent = mode === "edit" ? "Konto bearbeiten" : "Neues Konto";
        fLabel.value = account?.label ?? "";
        fServer.value = account?.server ?? "";
        fUser.value = account?.user ?? "";
        fPassword.value = "";
        fFolder.value = account?.folder ?? "INBOX";
        fTreatment.value = account?.phishingTreatment ?? "flag";
        fThreshold.value = account?.phishingThreshold ?? "";
        overlay.classList.add("open");
      }

      function closeModal() {
        overlay.classList.remove("open");
        currentEditId = null;
      }

      function renderConfigAccounts() {
        configAccountsBody.innerHTML = "";
        for (const acc of configAccounts) {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" + esc(acc.label) + "</td>" +
            "<td>" + esc(acc.server) + "</td>" +
            "<td>" + esc(acc.user) + "</td>" +
            "<td>" + esc(acc.folder) + "</td>" +
            "<td>" +
              '<button data-edit="' + esc(acc.id) + '" class="btn-small btn-edit">Bearbeiten</button> ' +
              '<button data-del="' + esc(acc.id) + '" class="btn-small btn-delete">Löschen</button>' +
            "</td>";
          configAccountsBody.appendChild(tr);
        }
      }

      async function loadConfigAccounts() {
        const data = await api("/.netlify/functions/accounts-config", { method: "GET" });
        configAccounts = data.accounts ?? [];
        renderConfigAccounts();
      }

      async function saveAccountFromForm() {
        const payload = {
          label: fLabel.value.trim(),
          server: fServer.value.trim(),
          user: fUser.value.trim(),
          password: fPassword.value.trim(),
          folder: fFolder.value.trim(),
          phishingTreatment: fTreatment.value,
          phishingThreshold: fThreshold.value.trim().length > 0 ? Number(fThreshold.value.trim()) : undefined,
        };

        if (!payload.label || !payload.server || !payload.user || !payload.password || !payload.folder) {
          alert("Bitte alle Pflichtfelder ausfüllen (inkl. Password).");
          return;
        }
        if (payload.phishingThreshold !== undefined && !(payload.phishingThreshold >= 0 && payload.phishingThreshold <= 1)) {
          alert("Phishing Threshold muss zwischen 0 und 1 liegen.");
          return;
        }

        if (currentEditId) {
          await apiWithDashboardAuth("/.netlify/functions/accounts-config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accountId: currentEditId, account: payload }),
          });
        } else {
          await apiWithDashboardAuth("/.netlify/functions/accounts-config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ account: payload }),
          });
        }

        closeModal();
        await loadConfigAccounts();
      }

      async function deleteAccount(accountId) {
        if (!confirm("Konto wirklich löschen?")) return;
        await apiWithDashboardAuth("/.netlify/functions/accounts-config?accountId=" + encodeURIComponent(accountId), {
          method: "DELETE",
        });
        await loadConfigAccounts();
      }

      async function loadStatus() {
        refreshBtn.disabled = true;
        headline.textContent = "lade status...";
        try {
          const data = await api("/.netlify/functions/scan-status", { method: "GET" });
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

          statusAccountsBody.innerHTML = "";
          for (const acc of data.accounts ?? []) {
            const tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" + esc(acc.accountId) + "</td>" +
              "<td>" + esc(acc.label) + "</td>" +
              "<td>" + esc(acc.lastSeenUid ?? "null") + "</td>";
            statusAccountsBody.appendChild(tr);
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

      async function runHealthCheckNow() {
        healthBtn.disabled = true;
        const old = healthBtn.textContent;
        healthBtn.textContent = "starte...";
        try {
          const res = await fetch("/.netlify/functions/health-run", { method: "POST" });
          if (!res.ok) {
            let msg = "";
            try {
              const errData = await res.json();
              msg = errData?.message ? String(errData.message) : JSON.stringify(errData);
            } catch {
              msg = await res.text();
            }
            throw new Error("HTTP " + res.status + ": " + msg);
          }
          const data = await res.json().catch(() => ({}));
          alert("Health-Check ausgeführt: " + (data.state ?? "ok"));
        } catch (e) {
          alert("Health-Check konnte nicht gestartet werden: " + e);
        } finally {
          healthBtn.disabled = false;
          healthBtn.textContent = old;
        }
      }

      async function loadRuntimeConfig() {
        const data = await api("/.netlify/functions/runtime-config", { method: "GET" });
        const level = Number(data?.config?.logLevel ?? 0);
        logLevelSelect.value = String(level);
        logLevelInfo.textContent = "aktuell: " + String(level);
      }

      async function saveRuntimeConfig() {
        const selected = Number(logLevelSelect.value);
        await apiWithDashboardAuth("/.netlify/functions/runtime-config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logLevel: selected }),
        });
        logLevelInfo.textContent = "gespeichert: " + String(selected);
      }

      configAccountsBody.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const editId = target.getAttribute("data-edit");
        const delId = target.getAttribute("data-del");
        if (editId) {
          const found = configAccounts.find((acc) => acc.id === editId);
          if (found) openModal("edit", found);
        }
        if (delId) {
          void deleteAccount(delId);
        }
      });

      refreshBtn.addEventListener("click", () => { void loadStatus(); });
      scanBtn.addEventListener("click", () => { void runScanNow(); });
      healthBtn.addEventListener("click", () => { void runHealthCheckNow(); });
      saveLogLevelBtn.addEventListener("click", () => { void saveRuntimeConfig(); });
      newAccountBtn.addEventListener("click", () => openModal("new"));
      cancelBtn.addEventListener("click", closeModal);
      saveBtn.addEventListener("click", () => { void saveAccountFromForm(); });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
      });
      authCancelBtn.addEventListener("click", () => {
        closeAuthOverlay();
        rejectAuth(new Error("Autorisierung abgebrochen"));
      });
      authConfirmBtn.addEventListener("click", () => {
        const value = authPassword.value.trim();
        if (!value) {
          authPassword.focus();
          return;
        }
        closeAuthOverlay();
        resolveAuth(value);
      });
      authPassword.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          authConfirmBtn.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          authCancelBtn.click();
        }
      });
      authOverlay.addEventListener("click", (event) => {
        if (event.target === authOverlay) authCancelBtn.click();
      });

      Promise.all([loadStatus(), loadConfigAccounts(), loadRuntimeConfig()]).catch((e) => {
        console.error(e);
      });
    </script>
  </body>
</html>`;
}

export const handler: Handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: renderDashboardHtml(),
});
