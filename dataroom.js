/* ============================================================
   Eli Hive — Data Room Browser
   Live Google Drive listing via Google Identity Services (GIS).
   Falls back to branded demo data when no OAuth CLIENT_ID is set.
   ============================================================ */

(function () {
  "use strict";

  // ---- Config -----------------------------------------------------------
  const DRIVE_ID = "0AIubYFgsJvn_Uk9PVA";
  const DRIVE_ROOT_URL = "https://drive.google.com/drive/folders/0AIubYFgsJvn_Uk9PVA";
  // Set a Google OAuth Web Client ID to enable LIVE listing.
  // Leave "" to render branded demo data (no Drive data is exposed publicly).
  const CLIENT_ID = "784973075726-pt9t0dcgembmg4icd6a2fva05bu4o0n8.apps.googleusercontent.com";
  const SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
  const API_BASE = "https://www.googleapis.com/drive/v3/files";

  const LIVE = Boolean(CLIENT_ID);

  // ---- DOM --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const crumbsEl = $("crumbs");
  const countEl = $("count");
  const filterEl = $("filter");
  const openDrive = $("open-drive");
  const refreshBtn = $("refresh-btn");
  const backBtn = $("back-btn");
  const authBtn = $("auth-btn");
  const signoutBtn = $("signout-btn");
  const previewModal = $("preview-modal");
  const previewIframe = $("preview-iframe");
  const previewTitle = $("preview-title");
  const previewBadge = $("preview-badge");
  const previewOpen = $("preview-open");
  const previewClose = $("preview-close");
  const stateLoading = $("state-loading");
  const stateEmpty = $("state-empty");
  const stateError = $("state-error");
  const stateSignin = $("state-signin");
  const lastRefreshEl = $("last-refresh");

  // ---- State ------------------------------------------------------------
  let token = null;
  let tokenClient = null;
  let gisReady = false;
  let crumbStack = [{ name: "Eli Hive Data Room", id: DRIVE_ID, link: DRIVE_ROOT_URL }];
  let currentFolder = { name: "Eli Hive Data Room", id: DRIVE_ID, link: DRIVE_ROOT_URL };
  let currentItems = [];
  let inFlight = null;

  // ---- Branded SVG icons ------------------------------------------------
  const ICON = {
    folder: `<svg class="folder-icon" viewBox="0 0 64 64" aria-hidden="true"><polygon points="32,6 56,19 56,45 32,58 8,45 8,19" fill="#e8a820" stroke="#2a2620" stroke-width="3" stroke-linejoin="round"/><polygon points="32,18 44,25 44,39 32,46 20,39 20,25" fill="#2a2620"/><circle cx="32" cy="32" r="4.5" fill="#e8a820"/></svg>`,
    pdf: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M12 4h18l10 10v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/><path d="M30 4v10h10" fill="none" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/><text x="24" y="36" font-family="monospace" font-size="11" font-weight="700" text-anchor="middle" fill="#E8A33D">PDF</text></svg>`,
    deck: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="8" width="32" height="24" rx="2" fill="#fff" stroke="#1C1611" stroke-width="2"/><path d="M14 16h14M14 21h20M14 26h10" stroke="#E8A33D" stroke-width="2" stroke-linecap="round"/><path d="M16 36l8 4 8-4" fill="none" stroke="#1C1611" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    doc: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M12 4h18l10 10v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/><path d="M30 4v10h10" fill="none" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/><path d="M15 24h18M15 29h18M15 34h12" stroke="#4FB3A9" stroke-width="2" stroke-linecap="round"/></svg>`,
    sheet: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="8" width="32" height="32" rx="2" fill="#fff" stroke="#1C1611" stroke-width="2"/><path d="M8 18h32M8 28h32M18 8v32M28 8v32" stroke="#E8A33D" stroke-width="1.6"/></svg>`,
    image: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="8" width="36" height="32" rx="2" fill="#fff" stroke="#1C1611" stroke-width="2"/><circle cx="17" cy="19" r="3.5" fill="#E8A33D"/><path d="M6 34l9-8 7 6 8-9 12 11v3a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="#4FB3A9" opacity=".55"/></svg>`,
    video: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="10" width="36" height="28" rx="3" fill="#fff" stroke="#1C1611" stroke-width="2"/><path d="M21 19l9 5-9 5z" fill="#E8A33D"/></svg>`,
    file: `<svg class="filetype-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M12 4h18l10 10v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/><path d="M30 4v10h10" fill="none" stroke="#1C1611" stroke-width="2" stroke-linejoin="round"/></svg>`,
  };

  function iconFor(item) {
    if (item.isFolder) return ICON.folder;
    const mt = item.mimeType || "";
    if (mt.includes("pdf")) return ICON.pdf;
    if (mt.includes("presentation") || /\.(pptx?|key)$/i.test(item.name || "")) return ICON.deck;
    if (mt.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(item.name || "")) return ICON.sheet;
    if (mt.includes("document") || /\.(docx?|md|txt)$/i.test(item.name || "")) return ICON.doc;
    if (mt.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(item.name || "")) return ICON.image;
    if (mt.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(item.name || "")) return ICON.video;
    return ICON.file;
  }

  function kindLabel(item) {
    if (item.isFolder) return "Folder";
    const mt = item.mimeType || "";
    const n = item.name || "";
    if (mt.includes("pdf")) return "PDF";
    if (mt.includes("presentation") || /\.(pptx?|key)$/i.test(n)) return "Deck";
    if (mt.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(n)) return "Sheet";
    if (mt.includes("document") || /\.(docx?|md|txt)$/i.test(n)) return "Doc";
    if (mt.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(n)) return "Image";
    if (mt.startsWith("video/")) return "Video";
    return "File";
  }

  function kindOf(item) {
    if (item.isFolder) return "folder";
    const mt = item.mimeType || "";
    const n = item.name || "";
    if (mt.includes("pdf")) return "pdf";
    if (mt.includes("presentation") || /\.(pptx?|key)$/i.test(n)) return "deck";
    if (mt.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(n)) return "sheet";
    if (mt.includes("document") || /\.(docx?|md|txt)$/i.test(n)) return "doc";
    if (mt.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(n)) return "image";
    if (mt.startsWith("video/")) return "video";
    return "file";
  }
  function svgEl(kind) {
    const t = document.createElement("template");
    t.innerHTML = (ICON[kind] || ICON.file).trim();
    return t.content.firstChild;
  }

  // ---- Demo data (sanitized — never exposes real Drive contents) --------
  const DEMO_ROOT = [
    { id: "d1", name: "Business plan & projections", isFolder: true, modified: "Jul 15, 2026", size: null },
    { id: "d2", name: "Terms & docs", isFolder: true, modified: "Jul 15, 2026", size: null },
    { id: "d3", name: "Technical information", isFolder: true, modified: "Jul 15, 2026", size: null },
    { id: "f1", name: "Eli_Hive_Seed_Deck.pdf", isFolder: false, mimeType: "application/pdf", modified: "Jul 13, 2026", size: "2.1 MB" },
    { id: "f2", name: "Reshoring_White_Paper.pdf", isFolder: false, mimeType: "application/pdf", modified: "Jul 17, 2026", size: "3.8 MB" },
    { id: "f3", name: "Product_BOM.xlsx", isFolder: false, mimeType: "spreadsheet", modified: "Jul 10, 2026", size: "640 KB" },
    { id: "f4", name: "Alpha_Demo.gif", isFolder: false, mimeType: "image/gif", modified: "Jul 02, 2026", size: "858 KB" },
    { id: "f5", name: "Founder_Bios.docx", isFolder: false, mimeType: "document", modified: "Jul 09, 2026", size: "188 KB" },
  ];
  const DEMO_CHILDREN = {
    d1: [
      { id: "d1a", name: "Revenue_model_v3.xlsx", isFolder: false, mimeType: "spreadsheet", modified: "Jul 14, 2026", size: "120 KB" },
      { id: "d1b", name: "18_month_projections.pdf", isFolder: false, mimeType: "application/pdf", modified: "Jul 14, 2026", size: "1.0 MB" },
    ],
    d2: [
      { id: "d2a", name: "SAFE_template.pdf", isFolder: false, mimeType: "application/pdf", modified: "Jul 12, 2026", size: "210 KB" },
      { id: "d2b", name: "Cap_table.xlsx", isFolder: false, mimeType: "spreadsheet", modified: "Jul 12, 2026", size: "88 KB" },
    ],
    d3: [
      { id: "d3a", name: "Hive_Cell_schematic.pdf", isFolder: false, mimeType: "application/pdf", modified: "Jul 11, 2026", size: "2.4 MB" },
      { id: "d3b", name: "System_architecture.png", isFolder: false, mimeType: "image/png", modified: "Jul 11, 2026", size: "1.1 MB" },
    ],
  };

  // ---- Helpers ----------------------------------------------------------
  function fmtSize(bytes) {
    if (!bytes) return null;
    const n = Number(bytes);
    if (!isFinite(n)) return null;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function showState(which) {
    [stateLoading, stateEmpty, stateError, stateSignin].forEach((s) => (s.hidden = true));
    if (which) which.hidden = false;
  }
  function showEmpty(title, msg) {
    stateEmpty.querySelector("h3").textContent = title;
    stateEmpty.querySelector("p").textContent = msg;
    showState(stateEmpty);
  }

  // ---- Rendering --------------------------------------------------------
  function renderSkeleton(n) {
    const sk = $("skeleton");
    let h = "";
    for (let i = 0; i < n; i++) {
      h += `<div class="sk-card"><div class="sk-thumb"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`;
    }
    sk.innerHTML = h;
  }

  function renderCrumbs() {
    crumbsEl.innerHTML = crumbStack
      .map((c, i) => {
        const last = i === crumbStack.length - 1;
        const btn = last
          ? `<span class="crumb is-current">${escapeHtml(c.name)}</span>`
          : `<button class="crumb" data-i="${i}">${escapeHtml(c.name)}</button>`;
        return i === 0 ? btn : `<span class="crumb-sep">/</span>` + btn;
      })
      .join("");
    crumbsEl.querySelectorAll(".crumb[data-i]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.i);
        crumbStack = crumbStack.slice(0, i + 1);
        currentFolder = crumbStack[crumbStack.length - 1];
        load();
      });
    });
    openDrive.href = (currentFolder.link || DRIVE_ROOT_URL);
    if (backBtn) backBtn.disabled = crumbStack.length <= 1;
  }

  function goBack() {
    if (crumbStack.length <= 1) return;
    crumbStack.pop();
    currentFolder = crumbStack[crumbStack.length - 1];
    load();
  }

  function renderItems(items) {
    currentItems = items;
    const q = (filterEl.value || "").trim().toLowerCase();
    const filtered = q ? items.filter((it) => (it.name || "").toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => (a.isFolder === b.isFolder ? (a.name || "").localeCompare(b.name || "") : a.isFolder ? -1 : 1));

    countEl.textContent = filtered.length ? `${filtered.length} item${filtered.length > 1 ? "s" : ""}` : "";

    if (!filtered.length) {
      grid.innerHTML = "";
      if (q) showEmpty("No results", `No files match \u201c${escapeHtml(q)}\u201d in this folder.`);
      else showEmpty("This folder is empty", "There are no files or subfolders here yet.");
      return;
    }
    showState(null);

    grid.innerHTML = filtered
      .map((it) => {
        const href = it.webViewLink || (it.isFolder ? "#" : DRIVE_ROOT_URL);
        const thumb = it.thumbnailLink
          ? `<img class="thumb-img" loading="lazy" alt="" src="${it.thumbnailLink}" data-icon="${escapeHtml(it.iconLink || "")}" data-kind="${kindOf(it)}">`
          : iconFor(it);
        const badge = it.isFolder ? `<span class="card__badge">Folder</span>` : `<span class="card__badge">${kindLabel(it)}</span>`;
        const meta = [it.modified || (it.modifiedTime ? fmtDate(it.modifiedTime) : ""), it.sizeLabel || (it.size ? fmtSize(it.size) : null)].filter(Boolean);
        const metaHtml = meta.length ? `<div class="card__meta">${meta.map((m, i) => i === 0 ? `<span>${escapeHtml(m)}</span>` : `<span class="mv"><span class="dot">·</span> ${escapeHtml(m)}</span>`).join("")}</div>` : "";
        return `<a class="card ${it.isFolder ? "is-folder" : ""}" href="${href}" ${it.isFolder ? "" : 'target="_blank" rel="noopener"'} data-id="${escapeHtml(it.id)}" data-folder="${it.isFolder ? "1" : "0"}">
          <div class="card__thumb">${badge}${thumb}</div>
          <div class="card__body">
            <div class="card__name">${wrapName(it.name)}</div>
            ${metaHtml}
          </div>
        </a>`;
      })
      .join("");

    // file clicks open in-app preview (falls back to Drive if no preview possible)
    grid.querySelectorAll(".card[data-folder='0']").forEach((el) => {
      el.addEventListener("click", (e) => {
        const id = el.dataset.id;
        const item = items.find((x) => x.id === id);
        if (!item) return;
        const url = previewUrlFor(item);
        if (!url) return; // let anchor navigate to Drive
        e.preventDefault();
        openPreview(item, url);
      });
    });

    // folder clicks navigate client-side (demo + live)
    grid.querySelectorAll(".card[data-folder='1']").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (el.getAttribute("href") === "#") e.preventDefault();
        const id = el.dataset.id;
        const item = items.find((x) => x.id === id);
        if (!item) return;
        e.preventDefault();
        const link = item.webViewLink && item.webViewLink !== "#" ? item.webViewLink : DRIVE_ROOT_URL;
        crumbStack.push({ name: item.name, id: item.id, link });
        currentFolder = crumbStack[crumbStack.length - 1];
        load();
      });
    });

    // thumbnail fallback: thumbnailLink -> iconLink -> branded SVG
    grid.querySelectorAll("img.thumb-img").forEach((img) => {
      let stage = 0;
      img.addEventListener("error", () => {
        const icon = img.dataset.icon;
        if (stage === 0 && icon) { stage = 1; img.src = icon; return; }
        stage = 2;
        const el = svgEl(img.dataset.kind);
        if (el) img.replaceWith(el);
        else img.remove();
      });
    });
  }

  // Build a Drive preview URL. Returns null in demo mode (no real Drive file to embed).
  function previewUrlFor(item) {
    if (!LIVE) return null;
    if (!item || !item.id) return null;
    const mt = item.mimeType || "";
    if (mt.startsWith("application/vnd.google-apps.")) {
      const wv = item.webViewLink || "";
      // Google-native docs: swap /edit or /view for /preview
      const swapped = wv.replace(/\/(edit|view)(\?[^#]*)?(#.*)?$/, "/preview");
      if (swapped && swapped !== wv) return swapped;
      if (mt.includes("document")) return `https://docs.google.com/document/d/${item.id}/preview`;
      if (mt.includes("spreadsheet")) return `https://docs.google.com/spreadsheets/d/${item.id}/preview`;
      if (mt.includes("presentation")) return `https://docs.google.com/presentation/d/${item.id}/preview`;
      return `https://drive.google.com/file/d/${item.id}/preview`;
    }
    return `https://drive.google.com/file/d/${item.id}/preview`;
  }

  function openPreview(item, url) {
    previewIframe.src = url;
    previewTitle.textContent = item.name || "Preview";
    previewBadge.textContent = kindLabel(item);
    previewOpen.href = item.webViewLink || `https://drive.google.com/file/d/${item.id}/view`;
    previewModal.hidden = false;
    previewModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closePreview() {
    previewModal.hidden = true;
    previewModal.setAttribute("aria-hidden", "true");
    previewIframe.src = "about:blank";
    document.body.style.overflow = "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function wrapName(name) {
    return escapeHtml(name).replace(/([_.\-/])/g, "$1<wbr>");
  }

  // ---- Data sources -----------------------------------------------------
  async function loadDriveFolder(parentId) {
    const fields = "files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,hasThumbnail,thumbnailLink,parents),nextPageToken";
    let pageToken = null;
    const all = [];
    do {
      const params = new URLSearchParams({
        driveId: DRIVE_ID,
        corpora: "drive",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        q: `'${parentId}' in parents and trashed=false`,
        pageSize: "200",
        fields,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${API_BASE}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { token = null; await ensureToken(); return loadDriveFolder(parentId); }
      if (res.status === 403) { throw { accessDenied: true }; }
      if (!res.ok) { throw new Error(`Drive API ${res.status}`); }
      const data = await res.json();
      (data.files || []).forEach((f) => all.push({ ...f, isFolder: f.mimeType === "application/vnd.google-apps.folder" }));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return all;
  }

  function loadDemo(parentId) {
    const items = parentId === DRIVE_ID ? DEMO_ROOT : (DEMO_CHILDREN[parentId] || []);
    return Promise.resolve(
      items.map((it) => ({
        ...it,
        isFolder: !!it.isFolder,
        webViewLink: it.isFolder ? "#" : DRIVE_ROOT_URL,
        modified: it.modified,
        sizeLabel: it.size,
      }))
    );
  }

  async function load() {
    renderCrumbs();

    // Live mode requires a token. If the user hasn't signed in yet, show a
    // sign-in prompt instead of auto-prompting (which can fire before GIS is ready).
    if (LIVE && !token) {
      grid.innerHTML = "";
      countEl.textContent = "";
      lastRefreshEl.hidden = true;
      showState(stateSignin);
      return;
    }

    renderSkeleton(6);
    showState(stateLoading);
    grid.innerHTML = "";
    refreshBtn.classList.add("is-loading");
    refreshBtn.disabled = true;

    try {
      let items;
      if (LIVE) {
        items = await loadDriveFolder(currentFolder.id);
      } else {
        items = await loadDemo(currentFolder.id);
      }
      renderItems(items);
      markRefreshed();
    } catch (err) {
      handleError(err);
    } finally {
      refreshBtn.classList.remove("is-loading");
      refreshBtn.disabled = false;
    }
  }

  function markRefreshed() {
    const now = new Date();
    const hh = String(now.getHours() % 12 || 12).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ap = now.getHours() >= 12 ? "pm" : "am";
    lastRefreshEl.textContent = `Updated ${hh}:${mm} ${ap}`;
    lastRefreshEl.hidden = false;
  }

  function handleError(err) {
    showState(stateError);
    const title = $("error-title");
    const msg = $("error-msg");
    if (err && err.accessDenied) {
      title.textContent = "You don’t have access to this data room";
      msg.textContent = "Access is granted per investor email. If you believe this is a mistake, request access and we’ll add you to the shared drive.";
    } else {
      title.textContent = "Couldn’t load the data room";
      msg.textContent = (err && err.message) ? err.message : "Something went wrong while listing the shared drive. Try refreshing, or open it directly in Google Drive.";
    }
  }

  // ---- Google Identity Services ----------------------------------------
  function initGIS() {
    if (!LIVE) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.access_token) {
            token = resp.access_token;
            updateAuthUI();
            const cont = inFlight; inFlight = null;
            if (cont) cont();      // mid-session 401 re-auth → continue the running load
            else load();           // fresh sign-in → populate the grid
          } else if (resp.error) {
            handleError(new Error("Google sign-in was not completed."));
          }
        },
      });
      gisReady = true;
      updateAuthUI();
      load();
    };
    document.head.appendChild(s);
  }

  function ensureToken() {
    return new Promise((resolve, reject) => {
      if (token) return resolve();
      if (!gisReady) return reject(new Error("Google sign-in is not ready yet. Try again in a moment."));
      inFlight = resolve;
      tokenClient.requestAccessToken({ prompt: "consent" });
    });
  }

  function updateAuthUI() {
    if (!LIVE) { authBtn.hidden = true; signoutBtn.hidden = true; return; }
    authBtn.hidden = Boolean(token);
    signoutBtn.hidden = !token;
  }

  function signIn() { if (gisReady) tokenClient.requestAccessToken({ prompt: "consent" }); }
  authBtn.addEventListener("click", signIn);
  const signinCta = $("signin-cta");
  if (signinCta) signinCta.addEventListener("click", signIn);
  signoutBtn.addEventListener("click", () => {
    if (token && google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(token, () => {});
    }
    token = null;
    updateAuthUI();
    load();
  });

  // ---- Events -----------------------------------------------------------
  refreshBtn.addEventListener("click", load);
  if (backBtn) backBtn.addEventListener("click", goBack);
  filterEl.addEventListener("input", () => renderItems(currentItems));

  previewClose.addEventListener("click", closePreview);
  previewModal.addEventListener("click", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.close === "1") closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !previewModal.hidden) closePreview();
  });

  // Auto-refresh the live listing every 3 minutes while signed in and the tab is visible.
  if (LIVE) {
    setInterval(() => {
      if (token && document.visibilityState === "visible") load();
    }, 3 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && token) load();
    });
  }

  // ---- Boot -------------------------------------------------------------
  if (!LIVE) {
    const banner = document.createElement("div");
    banner.className = "demo-banner";
    banner.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Preview showing sample data — add a Google OAuth Client ID in dataroom.js to list the live shared drive.`;
    document.querySelector(".wrap--browser").insertBefore(banner, document.querySelector(".dr-toolbar"));
  }
  initGIS();
  load();
})();
