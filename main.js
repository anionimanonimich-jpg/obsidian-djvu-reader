const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
const { execFile } = require("child_process");
const zlib = require("zlib");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const VIEW_TYPE = "djvu-reader-view";
const IS_DJVU = (s) => /\.djvu?$/i.test(s || "");
const ZOOM_MIN = 0.3, ZOOM_MAX = 5, ZOOM_STEP = 1.2;
const CACHE_LIMIT = 40;
const RENDER_W = 2000, RENDER_H = 3000;

const DEFAULT_SETTINGS = { djvuBinPath: "", debug: false, bookmarks: {} };

const run = (cmd, args) => new Promise((res) =>
  execFile(cmd, args, { maxBuffer: 96 * 1024 * 1024, windowsHide: true },
    (e, out, err) => res({ code: e ? (e.code || 1) : 0, stdout: out || "", stderr: err || "" })));
const pickPath = (s) => s && (s.file || s.path || s.filePath || null);

// ---------- PPM(P6) -> PNG на чистом Node ----------
function makeCrc32() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
}
const CRC = makeCrc32();
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function ppmToPng(buf) {
  let i = 0;
  const token = () => {
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x23) { while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++; }
      else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    let s = "";
    while (i < buf.length) { const c = buf[i]; if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x23) break; s += String.fromCharCode(c); i++; }
    return s;
  };
  const magic = token();
  if (magic !== "P6") throw new Error("PPM не P6: " + magic);
  const w = parseInt(token(), 10), h = parseInt(token(), 10), maxv = parseInt(token(), 10);
  if (maxv > 255) throw new Error("PPM maxv>255 не поддержан");
  i++;
  const need = w * h * 3;
  if (buf.length - i < need) throw new Error("PPM обрезан");
  const rgb = buf.slice(i, i + need);
  const stride = w * 3;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) { raw[y * (1 + stride)] = 0; rgb.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride); }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- Модалка списка закладок ----------
class BookmarkModal extends Modal {
  constructor(app, view) { super(app); this.view = view; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Закладки: " + (this.view.filePath ? path.basename(this.view.filePath) : "") });
    this.listEl = contentEl.createDiv({ cls: "djvu-bm-list" });
    this.renderList();
  }
  renderList() {
    const fp = this.view.filePath;
    const pages = this.view.plugin.getBookmarks(fp);
    this.listEl.empty();
    if (pages.length === 0) {
      this.listEl.createDiv({ cls: "djvu-bm-empty", text: "Закладок пока нет. Нажмите ★ на нужной странице." });
      return;
    }
    for (const p of pages) {
      const row = this.listEl.createDiv({ cls: "djvu-bm-row" });
      const lbl = row.createEl("span", { cls: "page", text: "Страница " + p });
      lbl.onclick = () => { this.close(); this.view.go(p); };
      row.createEl("button", { cls: "djvu-btn", text: "Перейти" }).onclick = () => { this.close(); this.view.go(p); };
      row.createEl("button", { cls: "djvu-btn djvu-bm-del", text: "Удалить" }).onclick = () => {
        this.view.plugin.toggleBookmark(fp, p);
        this.view.updateBookmarkButton();
        this.renderList();
      };
    }
  }
}

// ---------- View ----------
class DjvuView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.page = 1; this.total = 0; this.cache = new Map();
    this.filePath = ""; this.absPath = ""; this.domReady = false; this._timer = null;
    this.zoom = 1; this.imgEl = null; this.zoomLbl = null; this.stage = null;
    this.lbl = null; this.pageInput = null; this.bmBtn = null;
  }
  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return this.filePath ? path.basename(this.filePath) : "DjVu"; }
  getIcon()        { return "book-open"; }

  cacheGet(p) { if (!this.cache.has(p)) return null; const v = this.cache.get(p); this.cache.delete(p); this.cache.set(p, v); return v; }
  cacheSet(p, url) { if (this.cache.has(p)) this.cache.delete(p); this.cache.set(p, url); while (this.cache.size > CACHE_LIMIT) { const k = this.cache.keys().next().value; this.cache.delete(k); } }

  setZoom(z) { this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)); if (this.zoomLbl) this.zoomLbl.setText(Math.round(this.zoom * 100) + "%"); this.applyZoom(); }
  applyZoom() {
    if (!this.imgEl) return;
    this.imgEl.style.width = (this.zoom * 100) + "%";
    this.imgEl.style.maxWidth = "none";
    if (this.stage) this.stage.style.textAlign = this.zoom > 1.001 ? "left" : "center";
  }

  askPage() {
    if (!this.pageInput) return;
    this.pageInput.value = String(this.page);
    this.lbl.style.display = "none";
    this.pageInput.style.display = "";
    this.pageInput.focus();
    this.pageInput.select();
  }
  commitPageInput() {
    const n = parseInt(this.pageInput.value, 10);
    this.pageInput.style.display = "none";
    this.lbl.style.display = "";
    if (n) this.go(n);
  }

  // закладки
  updateBookmarkButton() {
    if (!this.bmBtn || !this.filePath) return;
    const on = this.plugin.hasBookmark(this.filePath, this.page);
    this.bmBtn.setText(on ? "★" : "☆");
    this.bmBtn.toggleClass("djvu-bm-active", on);
    this.bmBtn.setAttribute("title", on ? "Убрать закладку (стр. " + this.page + ")" : "Добавить закладку (стр. " + this.page + ")");
  }
  toggleCurrentBookmark() {
    if (!this.filePath) return;
    const added = this.plugin.toggleBookmark(this.filePath, this.page);
    this.updateBookmarkButton();
    new Notice(added ? ("Закладка добавлена: стр. " + this.page) : ("Закладка удалена: стр. " + this.page));
  }
  openBookmarkList() { if (this.filePath) new BookmarkModal(this.app, this).open(); }

  showInstallGuide() {
    this.stage.empty();
    const box = this.stage.createDiv({ cls: "djvu-err" });
    box.createEl("p", { text: "Декодер DjVuLibre не найден." });
    box.createEl("p", { text: "Это внешний локальный инструмент (полностью оффлайн). Установите его и при необходимости укажите путь в Settings → DjVu Reader." });
    box.createEl("p").createEl("a", { text: "Скачать DjVuLibre (SourceForge)", href: "https://djvu.sourceforge.net/" });
    box.createEl("p", { cls: "djvu-hint", text: "После установки нажмите «Detect now» в настройках или перезагрузите Obsidian." });
  }

  async onOpen() {
    const c = this.containerEl; c.empty();
    c.createDiv({ cls: "djvu-view" }, (wrap) => {
      this.wrap = wrap;
      const bar = wrap.createDiv({ cls: "djvu-bar" });
      this.btnPrev = bar.createEl("button", { text: "◀", cls: "djvu-btn" });
      this.lbl     = bar.createEl("span",  { text: "…", cls: "djvu-page", attr: { title: "Клик — перейти к странице" } });
      this.pageInput = bar.createEl("input", { type: "number", cls: "djvu-page-input" });
      this.pageInput.style.display = "none";
      this.btnNext = bar.createEl("button", { text: "▶", cls: "djvu-btn" });
      bar.createEl("span", { cls: "djvu-sep" });
      const zOut = bar.createEl("button", { text: "−", cls: "djvu-btn", attr: { title: "Уменьшить" } });
      this.zoomLbl = bar.createEl("span", { text: "100%", cls: "djvu-zoom" });
      const zIn  = bar.createEl("button", { text: "+", cls: "djvu-btn", attr: { title: "Увеличить" } });
      const zFit = bar.createEl("button", { text: "Fit", cls: "djvu-btn", attr: { title: "Вписать по ширине" } });
      bar.createEl("span", { cls: "djvu-sep" });
      this.bmBtn   = bar.createEl("button", { text: "☆", cls: "djvu-btn djvu-bm-btn", attr: { title: "Закладка" } });
      const bmList = bar.createEl("button", { text: "☰", cls: "djvu-btn", attr: { title: "Список закладок" } });
      this.stage = wrap.createDiv({ cls: "djvu-stage" });

      this.btnPrev.onclick = () => this.go(this.page - 1);
      this.btnNext.onclick = () => this.go(this.page + 1);
      this.lbl.onclick = () => this.askPage();
      this.pageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.commitPageInput(); }
        else if (e.key === "Escape") { this.pageInput.style.display = "none"; this.lbl.style.display = ""; }
      });
      this.pageInput.addEventListener("blur", () => { this.pageInput.style.display = "none"; this.lbl.style.display = ""; });
      zOut.onclick = () => this.setZoom(this.zoom / ZOOM_STEP);
      zIn.onclick  = () => this.setZoom(this.zoom * ZOOM_STEP);
      zFit.onclick = () => this.setZoom(1);
      this.bmBtn.onclick   = () => this.toggleCurrentBookmark();
      bmList.onclick = () => this.openBookmarkList();
      this.stage.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      }, { passive: false });
    });
    this.domReady = true;
    this.stage.setText("Определяю файл…");
    const p = pickPath(this.leaf.getViewState().state) || null;
    if (p) this.loadFile(p);
    else { this._timer = setTimeout(() => { if (!this.filePath) { this.stage.empty(); this.stage.createDiv({ cls: "djvu-err", text: "Путь не получен." }); } }, 1500); }
  }

  async setState(state, result) {
    const p = pickPath(state);
    if (p && this.domReady && p !== this.filePath) this.loadFile(p);
    try { return await super.setState(state, result); } catch (_) {}
  }
  getState() { return this.filePath ? { file: this.filePath } : {}; }

  async loadFile(p) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const adapter = this.app.vault.adapter;
    const abs = path.isAbsolute(p) ? p : (adapter.getFullPath ? adapter.getFullPath(p) : p);
    this.filePath = p; this.absPath = abs;
    this.cache.clear(); this.page = 1;
    this.stage.empty(); this.lbl.setText("…");

    const ddjvu = this.plugin.getExe("ddjvu");
    if (path.isAbsolute(ddjvu) && !fs.existsSync(ddjvu)) { this.plugin.log("[djvu] заданный путь не существует:", ddjvu); this.showInstallGuide(); return; }

    const r = await run(this.plugin.getExe("djvused"), ["-e", "n", abs]);
    if (r.code === "ENOENT") { this.plugin.log("[djvu] djvused ENOENT"); this.showInstallGuide(); return; }
    this.total = parseInt((r.stdout || "").trim(), 10) || 0;
    if (!this.total) { this.stage.createDiv({ cls: "djvu-err", text: "Не удалось прочитать число страниц — контейнер повреждён или не читается." }); return; }
    await this.render();
  }

  async go(p) { if (p < 1 || p > this.total) return; this.page = p; await this.render(); }

  async tryRender(mode) {
    const tmp = path.join(os.tmpdir(), `djvu_${Date.now()}_${this.page}_${mode || "full"}.ppm`);
    const args = ["-format=ppm", `-page=${this.page}`, `-size=${RENDER_W}x${RENDER_H}`];
    if (mode) args.push(`-mode=${mode}`);
    args.push(this.absPath, tmp);
    const r = await run(this.plugin.getExe("ddjvu"), args);
    if (r.code === "ENOENT") return { enoent: true };
    const exists = fs.existsSync(tmp);
    const size = exists ? fs.statSync(tmp).size : 0;
    this.plugin.log("[djvu] page", this.page, "mode=", mode || "full", "code=", r.code, "size=", size);
    if (exists && size > 0) return { ok: true, tmp, r };
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, r };
  }

  async render() {
    this.lbl.setText(`${this.page} / ${this.total}`);
    this.updateBookmarkButton();
    this.stage.empty(); this.imgEl = null;
    const cached = this.cacheGet(this.page);
    if (cached) { this.imgEl = this.stage.createEl("img", { attr: { src: cached } }); this.applyZoom(); return; }

    let res = await this.tryRender(null);
    if (res.enoent) { this.showInstallGuide(); return; }
    let fallback = false;
    if (!res.ok) {
      const bg = await this.tryRender("background");
      if (bg.enoent) { this.showInstallGuide(); return; }
      if (bg.ok) { res = bg; fallback = true; }
    }

    if (res.ok) {
      try {
        const png = ppmToPng(fs.readFileSync(res.tmp));
        const url = "data:image/png;base64," + png.toString("base64");
        try { fs.unlinkSync(res.tmp); } catch (_) {}
        this.cacheSet(this.page, url);
        if (fallback) this.stage.createDiv({ cls: "djvu-fallback", text: "Страница повреждена: показан фон без текстового/би-тонального слоя." });
        this.imgEl = this.stage.createEl("img", { attr: { src: url } });
        this.applyZoom();
      } catch (e) {
        try { fs.unlinkSync(res.tmp); } catch (_) {}
        this.stage.createDiv({ cls: "djvu-err", text: `Страница ${this.page}: ошибка PPM→PNG: ${e && e.message}` });
      }
    } else {
      this.stage.createDiv({ cls: "djvu-err", text: `Страница ${this.page} не отрендерилась (code=${res.r.code}). ${(res.r.stderr || "").slice(0, 160) || "Повреждены и текст, и фон — свойство файла."}` });
    }
  }

  async onClose() { this.cache.clear(); if (this._timer) clearTimeout(this._timer); }
}

// ---------- Settings tab ----------
class DjvuSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DjVu Reader" });
    new Setting(containerEl)
      .setName("Папка DjVuLibre")
      .setDesc("Путь к папке с ddjvu/djvused. Оставьте пустым — плагин найдёт сам. Полностью оффлайн.")
      .addText((t) => t.setPlaceholder("авто / PATH").setValue(this.plugin.settings.djvuBinPath)
        .onChange(async (v) => { this.plugin.settings.djvuBinPath = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("Найти декодер")
      .setDesc("Проверить стандартные пути и PATH прямо сейчас.")
      .addButton((b) => b.setButtonText("Detect now").onClick(async () => {
        const d = await this.plugin.detectBin();
        this.plugin.resolvedBin = d;
        new Notice(d ? ("DjVuLibre найден: " + d) : "DjVuLibre не найден — укажите путь вручную.");
      }));
    new Setting(containerEl)
      .setName("Отладочный лог")
      .setDesc("Писать [djvu] … в консоль разработчика. Только для диагностики.")
      .addToggle((t) => t.setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
  }
}

// ---------- Plugin ----------
let _origOpenFile = null, _wrappedProto = null;

module.exports = class DjvuReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.resolvedBin = "";
    this.addSettingTab(new DjvuSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new DjvuView(leaf, this));
    this.registerExtensions(["djvu", "djv"], VIEW_TYPE);

    this.addCommand({
      id: "djvu-toggle-bookmark",
      name: "Закладка: добавить/убрать на текущей странице",
      checkCallback: (checking) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!checking) v.toggleCurrentBookmark();
        return true;
      },
    });
    this.addCommand({
      id: "djvu-open-bookmarks",
      name: "Закладки: показать список текущей книги",
      checkCallback: (checking) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!checking) v.openBookmarkList();
        return true;
      },
    });

    this.ensureWrap();
    try { this.app.workspace.onLayoutReady(() => this.ensureWrap()); }
    catch (_) { setTimeout(() => this.ensureWrap(), 400); }
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.ensureWrap();
      const v = leaf && leaf.view;
      if (v instanceof DjvuView && !v.filePath) { const p = pickPath(leaf.getViewState().state); if (p) v.loadFile(p); }
    }));
    this.detectBin().then((d) => { this.resolvedBin = d; this.log("[djvu] detected bin dir=", d || "(none)"); });
    this.log("[djvu] onload ok v1.2");
  }

  onunload() { if (_wrappedProto) { if (_origOpenFile) _wrappedProto.openFile = _origOpenFile; _wrappedProto = null; } }
  log(...a) { if (this.settings && this.settings.debug) console.log(...a); }
  activeDjvuView() { try { return this.app.workspace.getActiveViewOfType(DjvuView) || null; } catch (_) { return null; } }

  // закладки
  getBookmarks(fp) { const a = this.settings.bookmarks[fp]; return a ? [...a] : []; }
  hasBookmark(fp, page) { const a = this.settings.bookmarks[fp]; return !!(a && a.includes(page)); }
  toggleBookmark(fp, page) {
    const b = this.settings.bookmarks;
    if (!b[fp]) b[fp] = [];
    const i = b[fp].indexOf(page);
    let added;
    if (i >= 0) { b[fp].splice(i, 1); added = false; if (b[fp].length === 0) delete b[fp]; }
    else { b[fp].push(page); b[fp].sort((x, y) => x - y); added = true; }
    this.saveSettings();
    return added;
  }

  getExe(name) {
    const cfg = (this.settings.djvuBinPath || "").trim();
    const dir = cfg || this.resolvedBin || "";
    const base = dir ? path.join(dir, name) : name;
    return (os.platform() === "win32" && !path.extname(base)) ? base + ".exe" : base;
  }

  async detectBin() {
    const cands = [];
    const cfg = (this.settings.djvuBinPath || "").trim();
    if (cfg) cands.push(cfg);
    if (os.platform() === "win32") cands.push("C:/Program Files/DjVuLibre", "C:/Program Files (x86)/DjVuLibre");
    const binName = os.platform() === "win32" ? "ddjvu.exe" : "ddjvu";
    for (const d of cands) { if (fs.existsSync(path.join(d, binName))) return d.replace(/\\/g, "/"); }
    try {
      const r = await run(os.platform() === "win32" ? "where" : "which", ["ddjvu"]);
      if (r.code === 0) { const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]; if (first) return path.dirname(first).replace(/\\/g, "/"); }
    } catch (_) {}
    return "";
  }

  ensureWrap() {
    if (_wrappedProto) return true;
    try {
      const l = (this.app.workspace.getLeavesOfType("markdown")[0]) || this.app.workspace.getMostRecentLeaf();
      const proto = l ? Object.getPrototypeOf(l) : null;
      if (!proto || typeof proto.openFile !== "function") return false;
      _wrappedProto = proto;
      _origOpenFile = proto.openFile;
      proto.openFile = async function (file, openState) {
        if (file && IS_DJVU(file.path)) {
          try { await this.setViewState({ type: VIEW_TYPE, state: { file: file.path }, eState: openState }); return; }
          catch (e) { /* fallthrough */ }
        }
        return _origOpenFile.call(this, file, openState);
      };
      return true;
    } catch (e) { return false; }
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.bookmarks = Object.assign({}, data.bookmarks || {});   // свежий объект, без мутации дефолта
  }
  async saveSettings() { await this.saveData(this.settings); }
};