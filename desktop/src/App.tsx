import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Component, type ErrorInfo, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type AccountMode = "on_demand" | "continuous";

type OnDemandPolicy =
  | { kind: "all" }
  | { kind: "latest"; n: 10 | 25 | 50 | 100 }
  | { kind: "since_uid"; uid: number };

type ContinuousPolicy =
  | { kind: "poll"; intervalSeconds: 30 | 60 | 120 | 300 }
  | { kind: "idle" };

type AccountStatus = "idle" | "scanning" | "watching" | "error";
type AccountStatusEvent = AccountStatus;

type AccountRecord = {
  id: string;
  label: string;
  server: string;
  user: string;
  folder: string;
  mode: AccountMode;
  onDemand: OnDemandPolicy;
  continuous: ContinuousPolicy;
  lastSeenUid?: number;
};

type AccountView = AccountRecord & { hasPassword: boolean };

type Account = AccountView & { status: AccountStatus };

type LogLevel = "info" | "success" | "warning" | "error";

type LogEntry = {
  id: string;
  at: Date;
  level: LogLevel;
  accountId?: string;
  accountLabel?: string;
  message: string;
};

const KEYCHAIN_SERVICE = "imap-phishing-filter";

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function formatTime(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function statusLabel(status: AccountStatus) {
  switch (status) {
    case "idle":
      return "Idle";
    case "scanning":
      return "Scanning";
    case "watching":
      return "Watching";
    case "error":
      return "Error";
  }
}

function describeOnDemand(p: OnDemandPolicy) {
  switch (p.kind) {
    case "all":
      return "All emails";
    case "latest":
      return `Latest ${p.n}`;
    case "since_uid":
      return `Since UID ${p.uid}`;
  }
}

function describeContinuous(p: ContinuousPolicy) {
  switch (p.kind) {
    case "idle":
      return "IMAP IDLE (notifications)";
    case "poll":
      return `Polling every ${p.intervalSeconds}s`;
  }
}

function relevantSettingsLabel(a: Account) {
  if (a.mode === "continuous") return `Continuous: ${describeContinuous(a.continuous)}`;
  return `On demand: ${describeOnDemand(a.onDemand)}`;
}

function passwordLabel(hasPassword: boolean) {
  return hasPassword ? "Stored (Keychain)" : "Missing";
}

class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { errorMessage: string | null }
> {
  state: { errorMessage: string | null } = { errorMessage: null };

  static getDerivedStateFromError(err: unknown) {
    return { errorMessage: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ui] render error", err, info);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div className="fatal">
          <div className="fatal__title">UI crashed</div>
          <div className="fatal__msg">{this.state.errorMessage}</div>
          <div className="fatal__hint">Check the terminal output for details and reload the app.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [tab, setTab] = useState<"accounts" | "log">("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const accountsRef = useRef<Account[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>(() => [
    { id: randomId("log"), at: new Date(), level: "info", message: "App started." },
  ]);

  const [logFilterAccountId, setLogFilterAccountId] = useState<string>("all");
  const [logSearch, setLogSearch] = useState<string>("");
  const logListRef = useRef<HTMLDivElement | null>(null);

  const scrollLogToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = logListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [isAccountEditorOpen, setIsAccountEditorOpen] = useState(false);

  const editingAccount = useMemo(() => {
    if (!editingAccountId) return null;
    return accounts.find((a) => a.id === editingAccountId) ?? null;
  }, [accounts, editingAccountId]);

  const editorInitial = useMemo(() => {
    if (editingAccount) {
      return {
        record: {
          id: editingAccount.id,
          label: editingAccount.label,
          server: editingAccount.server,
          user: editingAccount.user,
          folder: editingAccount.folder,
          mode: editingAccount.mode,
          onDemand: editingAccount.onDemand,
          continuous: editingAccount.continuous,
          lastSeenUid: editingAccount.lastSeenUid,
        } satisfies AccountRecord,
        hasPassword: editingAccount.hasPassword,
        passwordInput: "",
      };
    }
    return {
      record: {
        id: randomId("acc"),
        label: "",
        server: "",
        user: "",
        folder: "INBOX",
        mode: "on_demand",
        onDemand: { kind: "latest", n: 10 },
        continuous: { kind: "poll", intervalSeconds: 60 },
        lastSeenUid: undefined,
      } satisfies AccountRecord,
      hasPassword: false,
      passwordInput: "",
    };
  }, [editingAccount]);

  const [draft, setDraft] = useState(editorInitial);

  useEffect(() => {
    setDraft(editorInitial);
  }, [editorInitial]);

  const pushLog = (entry: Omit<LogEntry, "id" | "at">) => {
    const next: LogEntry = { id: randomId("log"), at: new Date(), ...entry };
    setLogEntries((prev) => [...prev, next]);
    setTimeout(() => {
      scrollLogToBottom("smooth");
    }, 0);
  };

  const loadAccounts = async () => {
    try {
      const loaded = (await invoke("load_accounts")) as AccountView[];
      setAccounts(loaded.map((a) => ({ ...a, status: "idle" as const })));
      pushLog({ level: "success", message: `Loaded ${loaded.length} account(s).` });

      // Auto-start watchers for accounts configured as continuous.
      for (const a of loaded) {
        if (a.mode === "continuous") {
          // eslint-disable-next-line no-await-in-loop
          await invoke("start_watch", { accountId: a.id });
        }
      }
    } catch (err) {
      pushLog({ level: "error", message: `Failed to load accounts: ${String(err)}` });
    }
  };

  useEffect(() => {
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

    const attach = async (p: Promise<() => void>) => {
      const unsub = await p;
      if (disposed) {
        try {
          unsub();
        } catch {
          // ignore
        }
        return;
      }
      unsubs.push(unsub);
    };

    void attach(listen<{ accountId: string; line: string; stream: string }>("scan_log", (event) => {
      const acc = accountsRef.current.find((a) => a.id === event.payload.accountId);
      const msg = event.payload.line;
      const isPhishing = msg.includes("PHISHING");
      const level: LogLevel =
        event.payload.stream === "stderr"
          ? "error"
          : isPhishing
            ? "warning"
            : msg.includes("Flagged")
              ? "success"
              : "info";
      pushLog({
        level,
        accountId: event.payload.accountId,
        accountLabel: acc?.label ?? event.payload.accountId,
        message: msg,
      });
    }));

    void attach(listen<{ accountId: string; status: string }>("scan_status", (event) => {
      const status = event.payload.status as AccountStatusEvent;
      if (status === "scanning") {
        setAccounts((prev) =>
          prev.map((a) => (a.id === event.payload.accountId ? { ...a, status: "scanning" } : a)),
        );
      } else if (status === "watching") {
        setAccounts((prev) =>
          prev.map((a) => (a.id === event.payload.accountId ? { ...a, status: "watching" } : a)),
        );
      } else if (status === "idle") {
        setAccounts((prev) =>
          prev.map((a) => (a.id === event.payload.accountId ? { ...a, status: "idle" } : a)),
        );
      } else {
        setAccounts((prev) =>
          prev.map((a) => (a.id === event.payload.accountId ? { ...a, status: "error" } : a)),
        );
      }
    }));

    return () => {
      disposed = true;
      for (const u of unsubs) u();
    };
  }, []);

  const openAddAccount = () => {
    setEditingAccountId(null);
    setDraft({
      record: {
        id: randomId("acc"),
        label: "",
        server: "",
        user: "",
        folder: "INBOX",
        mode: "on_demand",
        onDemand: { kind: "latest", n: 10 },
        continuous: { kind: "poll", intervalSeconds: 60 },
        lastSeenUid: undefined,
      },
      hasPassword: false,
      passwordInput: "",
    });
    setIsAccountEditorOpen(true);
  };

  const openEditAccount = (accountId: string) => {
    setEditingAccountId(accountId);
    setIsAccountEditorOpen(true);
  };

  const closeEditor = () => {
    setIsAccountEditorOpen(false);
    setEditingAccountId(null);
  };

  const saveDraft = async () => {
    if (!draft.record.label.trim()) {
      pushLog({ level: "warning", message: "Please set a label before saving." });
      return;
    }
    if (!draft.record.server.trim()) {
      pushLog({ level: "warning", message: "Please set a server before saving." });
      return;
    }
    if (!draft.record.user.trim()) {
      pushLog({ level: "warning", message: "Please set a user before saving." });
      return;
    }

    const record: AccountRecord = {
      ...draft.record,
      label: draft.record.label.trim(),
      server: draft.record.server.trim(),
      user: draft.record.user.trim(),
      folder: draft.record.folder.trim(),
    };

    try {
      await invoke("upsert_account", {
        account: record,
        password: draft.passwordInput.trim().length > 0 ? draft.passwordInput.trim() : null,
      });

      // Start/stop automatic mode based on persisted mode.
      if (record.mode === "continuous") {
        await invoke("start_watch", { accountId: record.id });
      } else {
        await invoke("stop_watch", { accountId: record.id });
      }

      pushLog({
        level: "success",
        accountId: record.id,
        accountLabel: record.label,
        message: editingAccount ? "Account updated." : "Account added.",
      });

      closeEditor();
      await loadAccounts();
    } catch (err) {
      pushLog({ level: "error", message: `Failed to save account: ${String(err)}` });
    }
  };

  const deleteAccount = async (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;

    const ok = window.confirm(`Delete account "${a.label}"?\n\nThis also removes the password from Keychain.`);
    if (!ok) return;

    try {
      await invoke("stop_watch", { accountId });
      await invoke("delete_account", { accountId });
      pushLog({ level: "success", message: `Deleted account "${a.label}".` });
      await loadAccounts();
    } catch (err) {
      pushLog({ level: "error", message: `Failed to delete account: ${String(err)}` });
    }
  };

  const startScan = async (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;

    if (a.onDemand.kind !== "latest") {
      pushLog({
        level: "warning",
        accountId: a.id,
        accountLabel: a.label,
        message: `On-demand policy "${a.onDemand.kind}" not implemented yet. Use "Latest N" for MVP.`,
      });
      return;
    }

    if (!a.hasPassword) {
      pushLog({
        level: "warning",
        accountId: a.id,
        accountLabel: a.label,
        message: `No password stored. Edit the account and set a password (stored in Keychain, service: ${KEYCHAIN_SERVICE}).`,
      });
      return;
    }

    pushLog({
      level: "info",
      accountId: a.id,
      accountLabel: a.label,
      message: `Starting check (${describeOnDemand(a.onDemand)})...`,
    });
    setTab("log");

    try {
      await invoke("start_on_demand_scan", { accountId: a.id });
    } catch (err) {
      pushLog({
        level: "error",
        accountId: a.id,
        accountLabel: a.label,
        message: `Failed to start scan: ${String(err)}`,
      });
      setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: "error" } : x)));
    }
  };

  const cancelScan = async (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;
    if (a.status !== "scanning") return;

    try {
      await invoke("cancel_scan", { accountId: a.id });
    } catch (err) {
      pushLog({
        level: "error",
        accountId: a.id,
        accountLabel: a.label,
        message: `Failed to stop scan: ${String(err)}`,
      });
    }
  };

  const startScanAll = async () => {
    pushLog({ level: "info", message: `Starting check for ${accounts.length} account(s)...` });
    setTab("log");
    for (const a of accounts) {
      // eslint-disable-next-line no-await-in-loop
      await startScan(a.id);
    }
  };

  const filteredLog = useMemo(() => {
    const query = logSearch.trim().toLowerCase();
    return logEntries.filter((e) => {
      if (logFilterAccountId !== "all" && e.accountId !== logFilterAccountId) return false;
      if (!query) return true;
      return (
        e.message.toLowerCase().includes(query) ||
        (e.accountLabel ?? "").toLowerCase().includes(query)
      );
    });
  }, [logEntries, logFilterAccountId, logSearch]);

  useEffect(() => {
    if (tab !== "log") return;
    setTimeout(() => scrollLogToBottom("auto"), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand__title">IMAP Phishing Filter</div>
          <div className="brand__subtitle">MVP (accounts + on-demand scan)</div>
        </div>

        <nav className="tabs" aria-label="Tabs">
          <button
            className={`tab ${tab === "accounts" ? "tab--active" : ""}`}
            onClick={() => setTab("accounts")}
            type="button"
          >
            Accounts
          </button>
          <button
            className={`tab ${tab === "log" ? "tab--active" : ""}`}
            onClick={() => setTab("log")}
            type="button"
          >
            Log
          </button>
        </nav>
      </header>

      <main className="content">
        {tab === "accounts" ? (
          <section className="pane">
            <div className="pane__header">
              <div className="pane__title">Accounts</div>
              <div className="pane__actions">
                <button type="button" className="btn" onClick={openAddAccount}>
                  Add account
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void startScanAll()}
                  disabled={accounts.length === 0}
                >
                  Check all now
                </button>
              </div>
            </div>

            <div className="cards">
              {accounts.length === 0 ? (
                <div className="log__empty">
                  No accounts yet. Click <strong>Add account</strong> to get started.
                </div>
              ) : null}

              {accounts.map((a) => (
                <article key={a.id} className="card">
                  <div className="card__head">
                    <div className="card__titleRow">
                      <div className="card__title">{a.label}</div>
                      <span className={`badge badge--${a.status}`} title={statusLabel(a.status)}>
                        {statusLabel(a.status)}
                      </span>
                    </div>

                    <div className="card__meta">
                      <div className="metaLine">
                        <span className="metaKey">Folder</span>
                        <span className="metaVal">{a.folder}</span>
                      </div>
                      <div className="metaLine">
                        <span className="metaKey">Server</span>
                        <span className="metaVal">{a.server}</span>
                      </div>
                      <div className="metaLine">
                        <span className="metaKey">User</span>
                        <span className="metaVal">{a.user}</span>
                      </div>
                      <div className="metaLine">
                        <span className="metaKey">Password</span>
                        <span className="metaVal">{passwordLabel(a.hasPassword)}</span>
                      </div>
                      <div className="metaLine">
                        <span className="metaKey">Last UID</span>
                        <span className="metaVal">{a.lastSeenUid ?? "—"}</span>
                      </div>
                    </div>
                  </div>

                  <div className="card__body">
                    <div className="sectionTitle">Phishing filter settings</div>
                    <div className="pillRow">
                      <span className="pill">
                        Mode: <strong>{a.mode === "on_demand" ? "On demand" : "Continuous"}</strong>
                      </span>
                      <span className="pill">
                        <strong>{relevantSettingsLabel(a)}</strong>
                      </span>
                    </div>
                  </div>

                  <div className="card__actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void startScan(a.id)}
                      disabled={a.status === "scanning"}
                    >
                      Check now
                    </button>
                    {a.status === "scanning" ? (
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => void cancelScan(a.id)}
                      >
                        Stop!
                      </button>
                    ) : null}
                    <button type="button" className="btn btn--ghost" onClick={() => openEditAccount(a.id)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => void deleteAccount(a.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="pane">
            <div className="pane__header">
              <div className="pane__title">Log</div>
              <div className="pane__actions">
                <div className="fieldRow">
                  <label className="label" htmlFor="log-account">
                    Account
                  </label>
                  <select
                    id="log-account"
                    className="select"
                    value={logFilterAccountId}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setLogFilterAccountId(value);
                    }}
                  >
                    <option value="all">All</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="fieldRow">
                  <label className="label" htmlFor="log-search">
                    Search
                  </label>
                  <input
                    id="log-search"
                    className="input"
                    placeholder="filter logs…"
                    value={logSearch}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setLogSearch(value);
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const entry: LogEntry = {
                      id: randomId("log"),
                      at: new Date(),
                      level: "info",
                      message: "Log cleared.",
                    };
                    setLogEntries([entry]);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="log" ref={logListRef}>
              {filteredLog.length === 0 ? (
                <div className="log__empty">No entries.</div>
              ) : (
                filteredLog.map((e) => (
                  <div key={e.id} className={`log__row log__row--${e.level}`}>
                    <div className="log__time">{formatTime(e.at)}</div>
                    <div className="log__tag">{e.accountLabel ?? "app"}</div>
                    <div className="log__msg">{e.message}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </main>

      {isAccountEditorOpen ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal__header">
              <div className="modal__title">{editingAccount ? "Edit account" : "Add account"}</div>
              <button type="button" className="iconBtn" aria-label="Close" onClick={closeEditor}>
                ✕
              </button>
            </div>

            <div className="modal__body">
              <div className="formGrid">
                <div className="field">
                  <label className="label" htmlFor="label">
                    Label
                  </label>
                  <input
                    id="label"
                    className="input"
                    value={draft.record.label}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((p) => ({ ...p, record: { ...p.record, label: value } }));
                    }}
                    placeholder="e.g. ralfw.de"
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="folder">
                    Folder
                  </label>
                  <input
                    id="folder"
                    className="input"
                    value={draft.record.folder}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((p) => ({ ...p, record: { ...p.record, folder: value } }));
                    }}
                    placeholder="INBOX"
                  />
                </div>

                <div className="field field--wide">
                  <label className="label" htmlFor="server">
                    Server
                  </label>
                  <input
                    id="server"
                    className="input"
                    value={draft.record.server}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((p) => ({ ...p, record: { ...p.record, server: value } }));
                    }}
                    placeholder="mail.example.com:993"
                  />
                </div>

                <div className="field field--wide">
                  <label className="label" htmlFor="user">
                    User
                  </label>
                  <input
                    id="user"
                    className="input"
                    value={draft.record.user}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((p) => ({ ...p, record: { ...p.record, user: value } }));
                    }}
                    placeholder="user@example.com"
                  />
                </div>

                <div className="field field--wide">
                  <label className="label" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    className="input"
                    value={draft.passwordInput}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((p) => ({ ...p, passwordInput: value }));
                    }}
                    placeholder={draft.hasPassword ? "Leave blank to keep existing" : "Enter password to store in Keychain"}
                    type="password"
                  />
                  <div className="hint">
                    Stored in macOS Keychain (service: <code>{KEYCHAIN_SERVICE}</code>).
                  </div>
                </div>
              </div>

              <div className="divider" />

              <div className="sectionTitle">Check behavior</div>
              <div className="twoCols">
                <div className="field">
                  <label className="label">Mode</label>
                  <div className="segmented">
                    <button
                      type="button"
                      className={`segBtn ${draft.record.mode === "on_demand" ? "segBtn--active" : ""}`}
                      onClick={() => setDraft((p) => ({ ...p, record: { ...p.record, mode: "on_demand" } }))}
                    >
                      On demand
                    </button>
                    <button
                      type="button"
                      className={`segBtn ${draft.record.mode === "continuous" ? "segBtn--active" : ""}`}
                      onClick={() => setDraft((p) => ({ ...p, record: { ...p.record, mode: "continuous" } }))}
                    >
                      Continuous
                    </button>
                  </div>
                  <div className="hint">Continuous mode runs polling every 60s while the app is running.</div>
                </div>

                <div className="field">
                  <label className="label">On demand policy</label>
                  <select
                    className="select"
                    value={draft.record.onDemand.kind}
                    onChange={(e) => {
                      const kind = e.currentTarget.value as OnDemandPolicy["kind"];
                      setDraft((p) => {
                        if (kind === "all") return { ...p, record: { ...p.record, onDemand: { kind: "all" } } };
                        if (kind === "latest")
                          return { ...p, record: { ...p.record, onDemand: { kind: "latest", n: 10 } } };
                        return { ...p, record: { ...p.record, onDemand: { kind: "since_uid", uid: 1 } } };
                      });
                    }}
                  >
                    <option value="latest">Latest N</option>
                    <option value="since_uid">Since UID</option>
                    <option value="all">All</option>
                  </select>

                  {draft.record.onDemand.kind === "latest" ? (
                    <div className="inlineRow">
                      <span className="hint">N</span>
                      <select
                        className="select"
                        value={draft.record.onDemand.n}
                        onChange={(e) =>
                          (() => {
                            const value = e.currentTarget.value;
                            setDraft((p) => ({
                              ...p,
                              record: {
                                ...p.record,
                                onDemand: { kind: "latest", n: Number(value) as 10 | 25 | 50 | 100 },
                              },
                            }));
                          })()
                        }
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                    </div>
                  ) : draft.record.onDemand.kind === "since_uid" ? (
                    <div className="inlineRow">
                      <span className="hint">UID</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={draft.record.onDemand.uid}
                        onChange={(e) =>
                          (() => {
                            const value = e.currentTarget.value;
                            setDraft((p) => ({
                              ...p,
                              record: {
                                ...p.record,
                                onDemand: { kind: "since_uid", uid: Number(value || "0") },
                              },
                            }));
                          })()
                        }
                      />
                    </div>
                  ) : (
                    <div className="hint">Not recommended with AI (cost/latency). Included for later.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="modal__footer">
              <button type="button" className="btn btn--ghost" onClick={closeEditor}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void saveDraft()}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
