(() => {
  "use strict";

  /* =========================================================
     Constants & state
     ========================================================= */

  const STORAGE_KEY = "linkverse.library.v1";
  const UI_KEY = "linkverse.ui.v1";
  const MAX_TITLE = 40;

  const COLOR_PALETTE = [
    "#7be8d3", "#9fb8ff", "#c7a7ff", "#ffadba",
    "#f5d18a", "#9ee6a8", "#f5a6ff", "#7fd1ff"
  ];

  const ICON_PALETTE = [
    ["#75e4ce", "#227d74"],
    ["#93b8ff", "#3c5ba8"],
    ["#cbb0ff", "#684aa6"],
    ["#ffb3c0", "#9d485c"],
    ["#f6d491", "#a27433"],
    ["#9fe6a9", "#347a4c"],
    ["#f2aaff", "#8a3d99"],
    ["#8ddbff", "#286e96"],
    ["#ffb592", "#a95635"],
    ["#b9e5ff", "#3d6f91"]
  ];

  const DOMAIN_TITLES = {
    "bilibili.com": "哔哩哔哩",
    "github.com": "GitHub",
    "zhihu.com": "知乎",
    "chatgpt.com": "ChatGPT",
    "figma.com": "Figma",
    "youtube.com": "YouTube",
    "developer.mozilla.org": "MDN Web Docs",
    "xiaohongshu.com": "小红书",
    "baidu.com": "百度",
    "notion.so": "Notion",
    "juejin.cn": "掘金",
    "douyin.com": "抖音",
    "weibo.com": "微博",
    "taobao.com": "淘宝",
    "google.com": "Google"
  };

  let state = { version: 1, categories: [], links: [] };
  let ui = { activeCategory: "all", query: "" };
  let editingLinkId = null;
  let editingCategoryId = null;
  let selectedCategoryColor = COLOR_PALETTE[0];
  let confirmResolver = null;
  let lastFocusedElement = null;
  let draggedId = null;
  let dragJustHappened = false;
  let currentPopoverAnchor = null;
  let storageWarning = "";

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  /* =========================================================
     Utilities
     ========================================================= */

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const makeId = (prefix = "item") => {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  };

  const hashString = (value) => {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
  };

  const isHexColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || ""));

  const clampText = (value, length = MAX_TITLE) => String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, length);

  const getHost = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return "";
    }
  };

  const getDomainBase = (host) => {
    const parts = host.toLowerCase().split(".").filter(Boolean);
    if (parts.length <= 1) return host;
    const secondLevel = new Set(["com", "net", "org", "co", "gov", "edu", "ac"]);
    let index = parts.length - 2;
    if (secondLevel.has(parts[index]) && parts.length >= 3) index -= 1;
    return parts[index] || host;
  };

  const deriveTitle = (url) => {
    const host = getHost(url);
    if (!host) return "未命名网站";
    const known = DOMAIN_TITLES[host] || DOMAIN_TITLES[host.replace(/^www\./, "")];
    if (known) return known;
    const base = getDomainBase(host).replace(/[-_]+/g, " ");
    return base.replace(/\b\w/g, (char) => char.toUpperCase()).slice(0, MAX_TITLE) || host;
  };

  const getInitial = (title) => {
    const chars = Array.from(String(title || "").trim());
    return (chars[0] || "·").toUpperCase();
  };

  const getIconColors = (seed) => ICON_PALETTE[hashString(seed) % ICON_PALETTE.length];

  const coerceUrl = (raw) => {
    let text = String(raw || "").trim();
    if (!text) return null;

    const explicit = text.match(/https?:\/\/[^\s<>"']+/i);
    if (explicit) {
      text = explicit[0];
    } else {
      const loose = text.match(/(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?(?:[/?#][^\s<>"']*)?/i);
      if (loose) text = loose[0];
    }

    text = text.replace(/^[<([【（]+|[>)\]】）.,;，。；]+$/g, "");
    if (!text) return null;

    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
      const looksLikeHost = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?(?:[/?#]|$)/i.test(text)
        || /^localhost(?::\d+)?(?:[/?#]|$)/i.test(text);
      if (!looksLikeHost) return null;
      text = `https://${text}`;
    }

    try {
      const parsed = new URL(text);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      if (!parsed.hostname) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const linkKey = (url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
    } catch {
      return String(url || "").trim();
    }
  };

  const getLink = (id) => state.links.find((link) => link.id === id);
  const getCategory = (id) => state.categories.find((category) => category.id === id);
  const isModalOpen = () => $$(".modal-layer").some((modal) => !modal.hidden);
  const isTypingTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  };

  const formatDate = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  /* =========================================================
     Seed data
     ========================================================= */

  function createSeedState() {
    const categories = [
      { id: "cat-common", name: "常用", color: "#7be8d3" },
      { id: "cat-work", name: "工作", color: "#9fb8ff" },
      { id: "cat-study", name: "学习", color: "#f5d18a" },
      { id: "cat-fun", name: "娱乐", color: "#ffadba" }
    ];

    const samples = [
      ["哔哩哔哩", "https://www.bilibili.com", "cat-fun"],
      ["GitHub", "https://github.com", "cat-work"],
      ["知乎", "https://www.zhihu.com", "cat-common"],
      ["ChatGPT", "https://chatgpt.com", "cat-work"],
      ["Figma", "https://www.figma.com", "cat-work"],
      ["MDN Web Docs", "https://developer.mozilla.org", "cat-study"],
      ["YouTube", "https://www.youtube.com", "cat-fun"],
      ["小红书", "https://www.xiaohongshu.com", "cat-common"]
    ];

    const baseTime = Date.now();
    const links = samples.map(([title, url, categoryId], index) => ({
      id: `seed-${index + 1}`,
      title,
      url,
      categoryId,
      createdAt: new Date(baseTime - index * 36e5).toISOString()
    }));

    return { version: 1, categories, links };
  }

  /* =========================================================
     Persistence
     ========================================================= */

  function normalizeState(raw) {
    if (!raw || !Array.isArray(raw.categories) || !Array.isArray(raw.links)) {
      throw new Error("数据格式不正确");
    }

    const categories = [];
    const categoryMap = new Map();
    const categoryIds = new Set();
    const safeStoredId = (value, prefix, used) => {
      const id = String(value || "");
      return /^[a-z0-9_-]{1,96}$/i.test(id) && !used.has(id) ? id : makeId(prefix);
    };

    raw.categories.forEach((category) => {
      if (!category || typeof category !== "object") return;
      const name = clampText(category.name, 12);
      if (!name) return;
      if (categories.some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
      const id = safeStoredId(category.id, "cat", categoryIds);
      categoryIds.add(id);
      const color = isHexColor(category.color) ? category.color : COLOR_PALETTE[categories.length % COLOR_PALETTE.length];
      if (!categoryMap.has(String(category.id))) categoryMap.set(String(category.id), id);
      categories.push({ id, name, color });
    });

    if (!categories.length) throw new Error("至少需要一个分类");

    const links = [];
    const linkIds = new Set();
    const seen = new Set();

    raw.links.forEach((link) => {
      if (!link || typeof link !== "object") return;
      const parsed = coerceUrl(link.url);
      if (!parsed) return;
      const key = linkKey(parsed.href);
      if (seen.has(key)) return;
      seen.add(key);

      let categoryId = categoryMap.get(String(link.categoryId));
      if (!categoryId) categoryId = categories[0].id;

      const title = clampText(link.title) || deriveTitle(parsed.href);
      const createdAt = Number.isFinite(Date.parse(link.createdAt))
        ? new Date(link.createdAt).toISOString()
        : new Date().toISOString();
      const id = safeStoredId(link.id, "link", linkIds);
      linkIds.add(id);

      links.push({
        id,
        title,
        url: parsed.href,
        categoryId,
        createdAt
      });
    });

    return { version: 1, categories, links };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createSeedState();
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      storageWarning = "本地收藏读取失败，已载入示例数据。";
      return createSeedState();
    }
  }

  function loadUi() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved.activeCategory === "string") {
        ui.activeCategory = saved.activeCategory;
      }
    } catch {
      /* ignore invalid UI state */
    }
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateSavedState(true);
      return true;
    } catch {
      updateSavedState(false);
      showToast("浏览器存储空间不足，本次修改可能无法保存。", { type: "error", duration: 6000 });
      return false;
    }
  }

  function persistUi() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ activeCategory: ui.activeCategory }));
    } catch {
      /* UI preferences are non-critical */
    }
  }

  function updateSavedState(ok) {
    const node = $(".saved-state");
    if (!node) return;
    node.classList.toggle("is-error", !ok);
    node.innerHTML = ok ? "<i></i>已自动保存" : "<i></i>保存失败";
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function renderAll() {
    if (ui.activeCategory !== "all" && !getCategory(ui.activeCategory)) {
      ui.activeCategory = "all";
    }
    renderSidebar();
    renderCategorySelects();
    renderLinks();
    updateStats();
  }

  function renderSidebar() {
    const nav = $("#categoryNav");
    if (!nav) return;

    const allRow = `
      <div class="nav-row ${ui.activeCategory === "all" ? "active" : ""}">
        <button type="button" class="nav-item" data-cat="all" aria-current="${ui.activeCategory === "all" ? "page" : "false"}">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" stroke-width="1.6"/>
              <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" stroke-width="1.6"/>
              <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" stroke-width="1.6"/>
              <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" stroke-width="1.6"/>
            </svg>
          </span>
          <span class="nav-label">全部链接</span>
          <span class="nav-count">${state.links.length}</span>
        </button>
      </div>`;

    const categoryRows = state.categories.map((category) => {
      const count = state.links.filter((link) => link.categoryId === category.id).length;
      const active = ui.activeCategory === category.id;
      return `
        <div class="nav-row ${active ? "active" : ""}">
          <button type="button" class="nav-item" data-cat="${escapeHtml(category.id)}" aria-current="${active ? "page" : "false"}">
            <span class="nav-dot" style="--dot:${escapeHtml(category.color)}"></span>
            <span class="nav-label">${escapeHtml(category.name)}</span>
            <span class="nav-count">${count}</span>
          </button>
          <button type="button" class="cat-menu-btn" data-cat-menu="${escapeHtml(category.id)}" aria-label="${escapeHtml(category.name)}分类操作" title="分类操作">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>
            </svg>
          </button>
        </div>`;
    }).join("");

    nav.innerHTML = allRow + categoryRows;

    if (window.matchMedia("(max-width: 1020px)").matches) {
      window.requestAnimationFrame(() => {
        $(".nav-row.active", nav)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }
  }

  function renderCategorySelects() {
    const select = $("#categorySelect");
    const current = select.value;
    select.replaceChildren();
    state.categories.forEach((category) => {
      select.add(new Option(category.name, category.id));
    });

    const preferred = getCategory(current) ? current
      : (getCategory(ui.activeCategory) ? ui.activeCategory : state.categories[0]?.id);
    if (preferred) select.value = preferred;
  }

  function renderLinks() {
    const grid = $("#grid");
    const empty = $("#emptyState");
    const query = ui.query.trim().toLowerCase();
    const activeCategory = getCategory(ui.activeCategory);

    const filtered = state.links.filter((link) => {
      if (activeCategory && link.categoryId !== activeCategory.id) return false;
      if (!query) return true;
      const category = getCategory(link.categoryId);
      const haystack = [
        link.title,
        link.url,
        getHost(link.url),
        category?.name || ""
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });

    grid.replaceChildren();
    grid.hidden = filtered.length === 0;

    if (filtered.length) {
      const fragment = document.createDocumentFragment();
      filtered.forEach((link, index) => fragment.appendChild(createCard(link, index)));
      grid.appendChild(fragment);
    }

    updateSectionMeta(filtered, activeCategory, query);
    updateEmptyState(filtered, activeCategory, query, empty);
  }

  function createCard(link, index) {
    const template = $("#cardTemplate");
    const card = template.content.firstElementChild.cloneNode(true);
    const category = getCategory(link.categoryId) || state.categories[0];
    const host = getHost(link.url);
    const title = link.title || deriveTitle(link.url);
    const colors = getIconColors(link.url);
    const categoryColor = category?.color || COLOR_PALETTE[0];

    card.dataset.id = link.id;
    card.style.setProperty("--i", String(Math.min(index, 14)));
    card.style.setProperty("--icon-a", colors[0]);
    card.style.setProperty("--icon-b", colors[1]);
    card.setAttribute("aria-label", `打开 ${title}`);
    card.setAttribute("title", `${title}\n${link.url}`);

    const icon = $(".site-initial", card);
    icon.textContent = getInitial(title);

    $(".site-title", card).textContent = title;
    $(".site-domain", card).textContent = host || link.url;

    const chip = $(".cat-chip", card);
    chip.style.setProperty("--chip-color", categoryColor);
    chip.setAttribute("aria-label", `当前分类：${category?.name || "未分类"}，点击更换分类`);
    $(".cat-name", chip).textContent = category?.name || "未分类";

    return card;
  }

  function updateSectionMeta(filtered, activeCategory, query) {
    const title = query
      ? "搜索结果"
      : (activeCategory ? activeCategory.name : "全部链接");
    $("#sectionTitle").textContent = title;
    $("#sectionCount").textContent = query
      ? `找到 ${filtered.length} 个`
      : `${filtered.length} 个收藏`;

    const dragHint = $(".drag-hint");
    if (dragHint) dragHint.hidden = query || filtered.length < 2;
    const sortReset = $("#sortResetBtn");
    if (sortReset) sortReset.hidden = state.links.length === 0;
  }

  function updateEmptyState(filtered, activeCategory, query, empty) {
    const grid = $("#grid");
    if (filtered.length) {
      empty.hidden = true;
      return;
    }

    empty.hidden = false;
    grid.hidden = true;
    const title = $("#emptyTitle");
    const text = $("#emptyText");
    const action = $("#emptyAction");

    if (query) {
      title.textContent = "没有找到相关链接";
      text.textContent = `没有与「${ui.query.trim()}」匹配的收藏，换个关键词试试。`;
      action.textContent = "清空搜索";
      action.dataset.action = "clear-search";
    } else if (activeCategory) {
      title.textContent = `「${activeCategory.name}」还空着`;
      text.textContent = "把喜欢的网站收进这个分类，让它慢慢充实起来。";
      action.textContent = "去收藏一个";
      action.dataset.action = "focus-add";
    } else {
      title.textContent = "收藏馆还是空的";
      text.textContent = "粘贴第一个网址，让你的私人链接宇宙亮起来。";
      action.textContent = "去收藏一个";
      action.dataset.action = "focus-add";
    }
  }

  function updateStats() {
    $("#heroCount").textContent = String(state.links.length);
    $("#statLinks").textContent = String(state.links.length);
    $("#statCats").textContent = String(state.categories.length);
  }

  function refresh() {
    renderAll();
    persistState();
  }

  /* =========================================================
     Toast
     ========================================================= */

  function showToast(message, options = {}) {
    const wrap = $("#toastWrap");
    const toast = document.createElement("div");
    const isError = options.type === "error";
    toast.className = `toast${isError ? " error" : ""}`;
    toast.setAttribute("role", isError ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.innerHTML = isError
      ? `<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16.5v.1M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message;

    toast.append(icon, msg);

    let timer = null;
    const dismiss = () => {
      if (toast.classList.contains("leaving")) return;
      window.clearTimeout(timer);
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 240);
    };

    if (options.actionLabel && typeof options.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "toast-action";
      action.textContent = options.actionLabel;
      action.addEventListener("click", () => {
        dismiss();
        options.onAction();
      });
      toast.appendChild(action);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "关闭提示");
    close.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    close.addEventListener("click", dismiss);
    toast.appendChild(close);

    while (wrap.children.length >= 3) wrap.firstElementChild.remove();
    wrap.appendChild(toast);

    const duration = Number.isFinite(options.duration) ? options.duration : 4200;
    if (duration > 0) timer = window.setTimeout(dismiss, duration);
  }

  /* =========================================================
     Popovers
     ========================================================= */

  function closePopover() {
    const popover = $("#popover");
    if (!popover || popover.hidden) return;
    popover.hidden = true;
    popover.replaceChildren();
    popover.removeAttribute("data-mode");
    if (currentPopoverAnchor) {
      currentPopoverAnchor.setAttribute("aria-expanded", "false");
      currentPopoverAnchor = null;
    }
  }

  function positionPopover(anchor) {
    const popover = $("#popover");
    if (!popover || popover.hidden) return;
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function openPopover(anchor, mode) {
    closePopover();
    const popover = $("#popover");
    popover.dataset.mode = mode;
    popover.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    currentPopoverAnchor = anchor;
    positionPopover(anchor);
  }

  function openCardMenu(anchor, linkId) {
    const link = getLink(linkId);
    if (!link) return;
    const category = getCategory(link.categoryId);
    const popover = $("#popover");

    const moves = state.categories.map((item) => {
      const count = state.links.filter((entry) => entry.categoryId === item.id).length;
      const current = item.id === link.categoryId;
      return `
        <button type="button" class="popover-item" data-move-to="${escapeHtml(item.id)}" role="menuitem">
          <span class="pop-dot" style="--dot:${escapeHtml(item.color)}"></span>
          <span>${escapeHtml(item.name)}</span>
          ${current ? '<span class="check"><svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : `<span class="pop-count">${count}</span>`}
        </button>`;
    }).join("");

    popover.innerHTML = `
      <p class="popover-label">移动到分类 · 当前「${escapeHtml(category?.name || "未分类")}」</p>
      ${moves}
      <div class="popover-sep"></div>
      <button type="button" class="popover-item" data-pop-action="edit" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><path d="m14.5 5.5 4 4M4.5 19.5l1-4.4L16.8 3.8a1.8 1.8 0 0 1 2.5 0l.9.9a1.8 1.8 0 0 1 0 2.5L8.9 18.5l-4.4 1Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        编辑收藏
      </button>
      <button type="button" class="popover-item" data-pop-action="copy" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.6"/></svg>
        复制网址
      </button>
      <button type="button" class="popover-item" data-pop-action="open" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><path d="M8 16 16 8m0 0H9.5M16 8v6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 14.5v4.7H4.8V5.5h4.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        在新标签页打开
      </button>
      <div class="popover-sep"></div>
      <button type="button" class="popover-item danger" data-pop-action="delete" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12h9.4l.8-12M10 11v4.5M14 11v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        删除收藏
      </button>`;

    popover.dataset.linkId = link.id;
    openPopover(anchor, "card");
  }

  function openCategoryMenu(anchor, categoryId) {
    const category = getCategory(categoryId);
    if (!category) return;
    const count = state.links.filter((link) => link.categoryId === category.id).length;
    const popover = $("#popover");

    popover.innerHTML = `
      <p class="popover-label">${escapeHtml(category.name)} · ${count} 个收藏</p>
      <button type="button" class="popover-item" data-cat-action="rename" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><path d="m14.5 5.5 4 4M4.5 19.5l1-4.4L16.8 3.8a1.8 1.8 0 0 1 2.5 0l.9.9a1.8 1.8 0 0 1 0 2.5L8.9 18.5l-4.4 1Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        重命名分类
      </button>
      <div class="popover-sep"></div>
      <button type="button" class="popover-item danger" data-cat-action="delete" role="menuitem">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12h9.4l.8-12M10 11v4.5M14 11v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        删除分类
      </button>`;

    popover.dataset.categoryId = category.id;
    openPopover(anchor, "category");
  }

  /* =========================================================
     Links: add, move, edit, delete, open
     ========================================================= */

  function setComposerUrlInvalid(invalid) {
    const input = $("#urlInput");
    const field = input.closest(".url-field");
    input.classList.toggle("is-invalid", invalid);
    field?.classList.toggle("is-invalid", invalid);
  }

  function focusComposer() {
    const input = $("#urlInput");
    const field = input.closest(".url-field");
    input.focus({ preventScroll: false });
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.classList.add("attention");
    window.setTimeout(() => field?.classList.remove("attention"), 900);
  }

  function handleAdd() {
    const input = $("#urlInput");
    const titleInput = $("#titleInput");
    const parsed = coerceUrl(input.value);

    if (!parsed) {
      setComposerUrlInvalid(true);
      input.focus();
      showToast("请输入有效的网址，例如 https://example.com", { type: "error" });
      return;
    }
    setComposerUrlInvalid(false);

    const duplicate = state.links.find((link) => linkKey(link.url) === linkKey(parsed.href));
    if (duplicate) {
      input.value = "";
      showToast("这个网址已经在收藏馆里了，已为你定位。", { type: "error" });
      revealLink(duplicate.id);
      return;
    }

    const categoryId = getCategory($("#categorySelect").value)
      ? $("#categorySelect").value
      : state.categories[0].id;
    const title = clampText(titleInput.value) || deriveTitle(parsed.href);

    const link = {
      id: makeId("link"),
      title,
      url: parsed.href,
      categoryId,
      createdAt: new Date().toISOString()
    };

    state.links.unshift(link);
    if (ui.activeCategory !== "all") ui.activeCategory = categoryId;
    persistUi();
    input.value = "";
    titleInput.value = "";
    refresh();
    showToast(`「${title}」已收藏`, {
      actionLabel: "打开",
      onAction: () => openLink(link)
    });
    window.setTimeout(() => input.focus(), 40);
  }

  function revealLink(linkId) {
    const link = getLink(linkId);
    if (!link) return;
    ui.query = "";
    const search = $("#searchInput");
    search.value = "";
    syncSearchUi();
    ui.activeCategory = link.categoryId;
    persistUi();
    renderAll();

    window.requestAnimationFrame(() => {
      const card = $(`.link-card[data-id="${CSS.escape(linkId)}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("flash");
      card.focus({ preventScroll: true });
      window.setTimeout(() => card.classList.remove("flash"), 1500);
    });
  }

  function openLink(linkOrId) {
    const link = typeof linkOrId === "string" ? getLink(linkOrId) : linkOrId;
    if (!link) return;
    const parsed = coerceUrl(link.url);
    if (!parsed) {
      showToast("这个网址似乎无效，请编辑后重试。", { type: "error" });
      return;
    }
    const opened = window.open(parsed.href, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }

  function moveLink(linkId, categoryId) {
    const link = getLink(linkId);
    const category = getCategory(categoryId);
    if (!link || !category) return;
    if (link.categoryId === categoryId) {
      closePopover();
      return;
    }

    const previous = link.categoryId;
    link.categoryId = categoryId;
    refresh();
    closePopover();
    showToast(`已移动到「${category.name}」`, {
      actionLabel: "撤销",
      onAction: () => {
        const current = getLink(linkId);
        if (!current) return;
        current.categoryId = previous;
        refresh();
      }
    });
  }

  function deleteLink(linkId) {
    const index = state.links.findIndex((link) => link.id === linkId);
    if (index < 0) return;
    const [removed] = state.links.splice(index, 1);
    refresh();
    showToast(`已删除「${removed.title}」`, {
      actionLabel: "撤销",
      onAction: () => {
        const currentIndex = Math.min(index, state.links.length);
        state.links.splice(currentIndex, 0, removed);
        refresh();
      }
    });
  }

  function copyLink(link) {
    const done = () => {
      closePopover();
      showToast("网址已复制到剪贴板");
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link.url).then(done).catch(() => fallbackCopy(link.url, done));
    } else {
      fallbackCopy(link.url, done);
    }
  }

  function fallbackCopy(text, callback) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      callback();
    } catch {
      showToast("复制失败，请手动复制。", { type: "error" });
    } finally {
      textarea.remove();
    }
  }

  function sortByRecent() {
    state.links.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    refresh();
    showToast("已按最近收藏排序");
  }

  /* =========================================================
     Modals
     ========================================================= */

  function openModal(modal) {
    closePopover();
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(() => {
      const target = modal.querySelector("input, select, .modal-btn.primary, .modal-btn.danger, button:not(.modal-close)");
      if (target) target.focus();
      if (modal.id === "confirmModal") $("#confirmCancel").focus();
    });
  }

  function closeModal(modal) {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.querySelectorAll(".form-error").forEach((error) => {
      error.textContent = "";
    });
    modal.querySelectorAll(".is-invalid").forEach((field) => field.classList.remove("is-invalid"));
    if (!isModalOpen()) {
      document.body.classList.remove("modal-open");
      if (lastFocusedElement && document.contains(lastFocusedElement)) {
        lastFocusedElement.focus({ preventScroll: true });
      }
      lastFocusedElement = null;
    }
  }

  function closeTopModal() {
    if (!$("#confirmModal").hidden) {
      settleConfirm(false);
      return true;
    }
    const open = $$(".modal-layer").find((modal) => !modal.hidden);
    if (open) {
      closeModal(open);
      return true;
    }
    return false;
  }

  function openLinkModal(linkId) {
    const link = getLink(linkId);
    if (!link) return;
    editingLinkId = linkId;
    $("#editTitle").value = link.title;
    $("#editUrl").value = link.url;
    $("#linkFormError").textContent = "";

    const select = $("#editCategory");
    select.replaceChildren();
    state.categories.forEach((category) => select.add(new Option(category.name, category.id)));
    select.value = getCategory(link.categoryId) ? link.categoryId : state.categories[0].id;

    closePopover();
    openModal($("#linkModal"));
  }

  function submitLinkEdit(event) {
    event.preventDefault();
    const link = getLink(editingLinkId);
    if (!link) return;

    const title = clampText($("#editTitle").value);
    const parsed = coerceUrl($("#editUrl").value);
    const categoryId = $("#editCategory").value;
    const error = $("#linkFormError");

    if (!title) {
      error.textContent = "给这个网站起一个名字吧。";
      $("#editTitle").classList.add("is-invalid");
      $("#editTitle").focus();
      return;
    }
    if (!parsed) {
      error.textContent = "网址格式不正确，请检查后重试。";
      $("#editUrl").classList.add("is-invalid");
      $("#editUrl").focus();
      return;
    }
    if (!getCategory(categoryId)) {
      error.textContent = "请选择一个有效分类。";
      return;
    }
    const duplicate = state.links.find((item) => item.id !== link.id && linkKey(item.url) === linkKey(parsed.href));
    if (duplicate) {
      error.textContent = `这个网址已经收藏为「${duplicate.title}」了。`;
      $("#editUrl").classList.add("is-invalid");
      return;
    }

    link.title = title;
    link.url = parsed.href;
    link.categoryId = categoryId;
    refresh();
    closeModal($("#linkModal"));
    showToast("收藏已更新");
  }

  function openCategoryModal(mode, categoryId = null) {
    editingCategoryId = mode === "edit" ? categoryId : null;
    const category = categoryId ? getCategory(categoryId) : null;
    const isEdit = Boolean(category);

    $("#categoryModalTitle").textContent = isEdit ? "编辑分类" : "新建分类";
    $("#categoryForm").querySelector("button[type='submit']").textContent = isEdit ? "保存修改" : "创建分类";
    $("#categoryName").value = category?.name || "";
    $("#categoryFormError").textContent = "";
    selectedCategoryColor = category?.color || COLOR_PALETTE[state.categories.length % COLOR_PALETTE.length];
    renderColorSwatches();

    closePopover();
    openModal($("#categoryModal"));
  }

  function renderColorSwatches() {
    const wrap = $("#colorSwatches");
    wrap.replaceChildren();
    COLOR_PALETTE.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `color-swatch${color === selectedCategoryColor ? " selected" : ""}`;
      button.style.setProperty("--swatch", color);
      button.dataset.color = color;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(color === selectedCategoryColor));
      button.setAttribute("aria-label", `选择颜色 ${color}`);
      wrap.appendChild(button);
    });
  }

  function submitCategory(event) {
    event.preventDefault();
    const name = clampText($("#categoryName").value, 12);
    const error = $("#categoryFormError");
    const editing = editingCategoryId ? getCategory(editingCategoryId) : null;
    const duplicate = state.categories.find((category) =>
      category.id !== editingCategoryId && category.name.toLowerCase() === name.toLowerCase()
    );

    if (!name) {
      error.textContent = "分类名称不能为空。";
      $("#categoryName").classList.add("is-invalid");
      $("#categoryName").focus();
      return;
    }
    if (duplicate) {
      error.textContent = "已经有同名分类了，换一个名字吧。";
      $("#categoryName").classList.add("is-invalid");
      $("#categoryName").focus();
      return;
    }

    if (editing) {
      editing.name = name;
      editing.color = selectedCategoryColor;
      refresh();
      closeModal($("#categoryModal"));
      showToast("分类已更新");
    } else {
      const category = { id: makeId("cat"), name, color: selectedCategoryColor };
      state.categories.push(category);
      ui.activeCategory = category.id;
      persistUi();
      refresh();
      $("#categorySelect").value = category.id;
      closeModal($("#categoryModal"));
      showToast(`分类「${name}」已创建`);
    }
  }

  function requestConfirm({ title, message, confirmText = "确认", danger = true }) {
    return new Promise((resolve) => {
      if (confirmResolver) confirmResolver(false);
      confirmResolver = resolve;

      $("#confirmTitle").textContent = title;
      $("#confirmMessage").textContent = message;
      $("#confirmOk").textContent = confirmText;
      $("#confirmOk").className = `modal-btn ${danger ? "danger" : "primary"}`;
      $("#confirmIcon").hidden = !danger;
      openModal($("#confirmModal"));
    });
  }

  function settleConfirm(value) {
    if (!confirmResolver) {
      closeModal($("#confirmModal"));
      return;
    }
    const resolve = confirmResolver;
    confirmResolver = null;
    closeModal($("#confirmModal"));
    resolve(value);
  }

  async function deleteCategory(categoryId) {
    const category = getCategory(categoryId);
    if (!category) return;
    if (state.categories.length <= 1) {
      showToast("至少需要保留一个分类。", { type: "error" });
      return;
    }

    const count = state.links.filter((link) => link.categoryId === categoryId).length;
    const fallback = state.categories.find((item) => item.id !== categoryId);
    const message = count
      ? `删除后，这 ${count} 个链接会移到「${fallback.name}」。此操作可以撤销一次。`
      : "这个分类里还没有链接，删除后不可恢复。";
    const confirmed = await requestConfirm({
      title: `删除分类「${category.name}」？`,
      message,
      confirmText: "删除分类",
      danger: true
    });
    if (!confirmed) return;

    const lastIndex = state.categories.findIndex((item) => item.id === categoryId);
    const removed = category;
    state.categories = state.categories.filter((item) => item.id !== categoryId);
    const movedLinks = state.links.filter((link) => link.categoryId === categoryId);
    movedLinks.forEach((link) => { link.categoryId = fallback.id; });
    if (ui.activeCategory === categoryId) ui.activeCategory = "all";
    persistUi();
    refresh();
    showToast(`分类「${removed.name}」已删除`, {
      actionLabel: "撤销",
      onAction: () => {
        state.categories.splice(Math.min(lastIndex, state.categories.length), 0, removed);
        movedLinks.forEach((link) => { link.categoryId = removed.id; });
        refresh();
      }
    });
  }

  /* =========================================================
     Import / export
     ========================================================= */

  function exportData() {
    const payload = {
      app: "linkverse",
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: state.categories,
      links: state.links
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `linkverse-backup-${formatDate()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("备份文件已导出");
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const source = payload?.data && Array.isArray(payload.data.categories) ? payload.data : payload;
      const imported = normalizeState(source);
      const confirmed = await requestConfirm({
        title: "导入这份收藏备份？",
        message: `将用备份中的 ${imported.links.length} 个链接和 ${imported.categories.length} 个分类，覆盖当前浏览器里的收藏。`,
        confirmText: "导入并覆盖",
        danger: false
      });
      if (!confirmed) return;

      state = imported;
      ui.activeCategory = "all";
      ui.query = "";
      $("#searchInput").value = "";
      syncSearchUi();
      persistUi();
      refresh();
      showToast("备份已导入");
    } catch {
      showToast("导入失败，请确认选择的是有效的 Linkverse 备份文件。", { type: "error", duration: 6000 });
    }
  }

  /* =========================================================
     Search
     ========================================================= */

  function syncSearchUi() {
    const input = $("#searchInput");
    const clear = $("#searchClear");
    const kbd = $(".search-kbd");
    const hasValue = Boolean(input.value.trim());
    if (clear) clear.hidden = !hasValue;
    if (kbd) kbd.hidden = hasValue;
  }

  function clearSearch() {
    const input = $("#searchInput");
    input.value = "";
    ui.query = "";
    syncSearchUi();
    renderLinks();
  }

  /* =========================================================
     Drag sorting
     ========================================================= */

  function saveVisibleOrder() {
    const grid = $("#grid");
    const visibleIds = $$(".link-card", grid).map((card) => card.dataset.id);
    const visibleSet = new Set(visibleIds);
    const slots = [];

    state.links.forEach((link, index) => {
      if (visibleSet.has(link.id)) slots.push(index);
    });
    const byId = new Map(state.links.map((link) => [link.id, link]));
    const ordered = visibleIds.map((id) => byId.get(id)).filter(Boolean);
    slots.forEach((slot, index) => {
      state.links[slot] = ordered[index];
    });
    persistState();
  }

  function clearDragState() {
    const grid = $("#grid");
    $$(".link-card.dragging, .link-card.drag-over", grid).forEach((card) => {
      card.classList.remove("dragging", "drag-over");
    });
    grid.classList.remove("is-dragging");
    draggedId = null;
  }

  /* =========================================================
     Events
     ========================================================= */

  function bindEvents() {
    const addForm = $("#addForm");
    const urlInput = $("#urlInput");
    const searchInput = $("#searchInput");
    const grid = $("#grid");
    const popover = $("#popover");

    addForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleAdd();
    });

    urlInput.addEventListener("input", () => setComposerUrlInvalid(false));

    $("#searchInput").addEventListener("input", (event) => {
      ui.query = event.target.value;
      syncSearchUi();
      renderLinks();
    });

    $("#searchClear")?.addEventListener("click", () => {
      clearSearch();
      searchInput.focus();
    });

    $("#categoryNav").addEventListener("click", (event) => {
      const menuTrigger = event.target.closest("[data-cat-menu]");
      if (menuTrigger) {
        event.stopPropagation();
        const id = menuTrigger.dataset.catMenu;
        if (popover.dataset.mode === "category" && popover.dataset.categoryId === id && !popover.hidden) {
          closePopover();
        } else {
          openCategoryMenu(menuTrigger, id);
        }
        return;
      }

      const trigger = event.target.closest("[data-cat]");
      if (!trigger) return;
      ui.activeCategory = trigger.dataset.cat;
      persistUi();
      renderSidebar();
      renderLinks();
      if (ui.activeCategory !== "all") $("#categorySelect").value = ui.activeCategory;
      else renderCategorySelects();
    });

    $("#newCategoryBtn").addEventListener("click", () => openCategoryModal("add"));

    $("#sortResetBtn").addEventListener("click", sortByRecent);

    $("#exportBtn").addEventListener("click", exportData);

    $("#importBtn").addEventListener("click", () => $("#importFile").click());

    $("#importFile").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await importData(file);
    });

    $("#emptyAction").addEventListener("click", (event) => {
      const action = event.currentTarget.dataset.action;
      if (action === "clear-search") {
        clearSearch();
        $("#searchInput").focus();
      } else {
        focusComposer();
      }
    });

    grid.addEventListener("click", (event) => {
      const card = event.target.closest(".link-card");
      if (!card) return;
      const menuTrigger = event.target.closest('[data-action="menu"]');
      if (menuTrigger) {
        event.stopPropagation();
        const id = card.dataset.id;
        if (popover.dataset.mode === "card" && popover.dataset.linkId === id && !popover.hidden) {
          closePopover();
        } else {
          openCardMenu(menuTrigger, id);
        }
        return;
      }
      if (dragJustHappened) return;
      openLink(card.dataset.id);
    });

    grid.addEventListener("keydown", (event) => {
      const card = event.target.closest(".link-card");
      if (!card) return;
      if (event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLink(card.dataset.id);
      }
    });

    grid.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".link-card");
      if (!card) return;
      if (event.target.closest("button")) {
        event.preventDefault();
        return;
      }
      draggedId = card.dataset.id;
      dragJustHappened = true;
      card.classList.add("dragging");
      grid.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedId);
      }
    });

    grid.addEventListener("dragover", (event) => {
      if (!draggedId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

      const dragging = $(".link-card.dragging", grid);
      const target = event.target.closest(".link-card:not(.dragging)");
      if (!dragging || !target) {
        if (window.innerHeight - event.clientY < 78) window.scrollBy(0, 14);
        if (event.clientY < 78) window.scrollBy(0, -14);
        return;
      }

      const rect = target.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height * 0.55
        || (Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height * 0.3
          && event.clientX > rect.left + rect.width / 2);

      target.classList.add("drag-over");
      if (after) {
        if (target.nextElementSibling !== dragging) target.after(dragging);
      } else if (target.previousElementSibling !== dragging) {
        target.before(dragging);
      }
      window.setTimeout(() => target.classList.remove("drag-over"), 140);
    });

    grid.addEventListener("drop", (event) => {
      if (draggedId) {
        event.preventDefault();
        saveVisibleOrder();
        clearDragState();
        window.setTimeout(() => { dragJustHappened = false; }, 80);
      }
    });

    grid.addEventListener("dragend", () => {
      if (!draggedId) return;
      saveVisibleOrder();
      clearDragState();
      window.setTimeout(() => { dragJustHappened = false; }, 120);
    });

    popover.addEventListener("click", (event) => {
      const moveTarget = event.target.closest("[data-move-to]");
      if (moveTarget && popover.dataset.mode === "card") {
        moveLink(popover.dataset.linkId, moveTarget.dataset.moveTo);
        return;
      }

      const action = event.target.closest("[data-pop-action]");
      if (action && popover.dataset.mode === "card") {
        const link = getLink(popover.dataset.linkId);
        if (!link) return;
        const type = action.dataset.popAction;
        if (type === "edit") {
          closePopover();
          openLinkModal(link.id);
        } else if (type === "copy") {
          copyLink(link);
        } else if (type === "open") {
          closePopover();
          openLink(link);
        } else if (type === "delete") {
          closePopover();
          deleteLink(link.id);
        }
        return;
      }

      const catAction = event.target.closest("[data-cat-action]");
      if (catAction && popover.dataset.mode === "category") {
        const id = popover.dataset.categoryId;
        if (catAction.dataset.catAction === "rename") {
          closePopover();
          openCategoryModal("edit", id);
        } else if (catAction.dataset.catAction === "delete") {
          closePopover();
          deleteCategory(id);
        }
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (popover.hidden) return;
      if (popover.contains(event.target)) return;
      if (event.target.closest('[data-action="menu"], [data-cat-menu]')) return;
      closePopover();
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-modal]")) {
        const modal = event.target.closest(".modal-layer");
        if (modal && modal.id !== "confirmModal") closeModal(modal);
      }
    });

    $$(".modal-layer").forEach((layer) => {
      layer.addEventListener("mousedown", (event) => {
        if (event.target !== layer) return;
        if (layer.id === "confirmModal") settleConfirm(false);
        else closeModal(layer);
      });
    });

    $("#linkForm").addEventListener("submit", submitLinkEdit);
    $("#categoryForm").addEventListener("submit", submitCategory);

    $("#categoryName").addEventListener("input", () => {
      $("#categoryName").classList.remove("is-invalid");
      $("#categoryFormError").textContent = "";
    });
    $("#editTitle").addEventListener("input", () => $("#editTitle").classList.remove("is-invalid"));
    $("#editUrl").addEventListener("input", () => $("#editUrl").classList.remove("is-invalid"));

    $("#colorSwatches").addEventListener("click", (event) => {
      const swatch = event.target.closest("[data-color]");
      if (!swatch) return;
      selectedCategoryColor = swatch.dataset.color;
      renderColorSwatches();
    });

    $("#confirmCancel").addEventListener("click", () => settleConfirm(false));
    $("#confirmOk").addEventListener("click", () => settleConfirm(true));

    document.addEventListener("keydown", (event) => {
      const openModalNode = $$(".modal-layer").find((modal) => !modal.hidden);

      if (event.key === "Escape") {
        if (!popover.hidden) {
          closePopover();
          event.preventDefault();
          return;
        }
        if (openModalNode) {
          if (openModalNode.id === "confirmModal") settleConfirm(false);
          else closeModal(openModalNode);
          event.preventDefault();
          return;
        }
        if (document.activeElement === searchInput && searchInput.value) {
          clearSearch();
          searchInput.blur();
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Tab" && openModalNode) {
        const focusables = $$("button, input, select, textarea, [tabindex]:not([tabindex='-1'])", openModalNode)
          .filter((el) => !el.disabled && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (isTypingTarget(event.target) || openModalNode || !popover.hidden) return;

      if (event.key === "/") {
        event.preventDefault();
        searchInput.focus();
      }
    });

    document.addEventListener("paste", (event) => {
      if (isTypingTarget(event.target) || isModalOpen()) return;
      const clipboard = event.clipboardData?.getData("text/plain") || "";
      if (!clipboard.trim()) return;
      const parsed = coerceUrl(clipboard);
      if (!parsed) return;

      event.preventDefault();
      const explicit = clipboard.match(/https?:\/\/[^\s<>"']+/i);
      const leftover = explicit ? clipboard.replace(explicit[0], " ").replace(/\s+/g, " ").trim() : "";
      urlInput.value = parsed.href;
      setComposerUrlInvalid(false);
      if (leftover && leftover.length <= MAX_TITLE) $("#titleInput").value = clampText(leftover);
      urlInput.focus();
      showToast("已识别剪贴板网址，点击「一键收藏」即可收入馆中。", {
        duration: 3000,
        actionLabel: "立即收藏",
        onAction: handleAdd
      });
    });

    window.addEventListener("scroll", closePopover, { passive: true });
    window.addEventListener("resize", closePopover);

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      try {
        state = normalizeState(JSON.parse(event.newValue));
        renderAll();
      } catch {
        /* ignore invalid cross-tab writes */
      }
    });
  }

  /* =========================================================
     Init
     ========================================================= */

  function init() {
    loadUi();
    state = loadState();
    if (!getCategory(ui.activeCategory)) ui.activeCategory = "all";

    bindEvents();
    renderAll();
    syncSearchUi();
    persistState();

    if (storageWarning) {
      window.setTimeout(() => showToast(storageWarning, { type: "error", duration: 5500 }), 350);
    }

    if (!state.links.length) {
      window.setTimeout(() => $("#urlInput").focus({ preventScroll: true }), 500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
