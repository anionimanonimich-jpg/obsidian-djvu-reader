// src/index.js
var { Plugin, ItemView, PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
var { execFile } = require("child_process");
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");
var os = require("os");
var VIEW_TYPE = "djvu-reader-view";
var IS_DJVU = (s) => /\.djvu?$/i.test(s || "");
var ZOOM_MIN = 0.3;
var ZOOM_MAX = 5;
var ZOOM_STEP = 1.2;
var CACHE_LIMIT = 40;
var RENDER_W = 2e3;
var RENDER_H = 3e3;
var WHEEL_LOCK_MS = 200;
var DEFAULT_SETTINGS = {
  djvuBinPath: "",
  tesseractBinPath: "",
  ocrLangs: "rus+eng",
  ocrShadowFolder: "_djvu_text",
  debug: false,
  bookmarks: {}
};
var run = (cmd, args, opts) => new Promise((res) => execFile(
  cmd,
  args,
  Object.assign({ maxBuffer: 96 * 1024 * 1024, windowsHide: true }, opts || {}),
  (e, out, err) => res({ code: e ? e.code || 1 : 0, stdout: out || "", stderr: err || "" })
));
var pickPath = (s) => s && (s.file || s.path || s.filePath || null);
function makeCrc32() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 4294967295;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ c >>> 8;
    return (c ^ 4294967295) >>> 0;
  };
}
var CRC = makeCrc32();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function ppmToPng(buf) {
  let i = 0;
  const token = () => {
    while (i < buf.length) {
      const c = buf[i];
      if (c === 35) {
        while (i < buf.length && buf[i] !== 10 && buf[i] !== 13) i++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
    let s = "";
    while (i < buf.length) {
      const c = buf[i];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 35) break;
      s += String.fromCharCode(c);
      i++;
    }
    return s;
  };
  const magic = token();
  if (magic !== "P6") throw new Error("PPM \u043D\u0435 P6: " + magic);
  const w = parseInt(token(), 10), h = parseInt(token(), 10), maxv = parseInt(token(), 10);
  if (maxv > 255) throw new Error("PPM maxv>255 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0430\u043D");
  i++;
  const need = w * h * 3;
  if (buf.length - i < need) throw new Error("PPM \u043E\u0431\u0440\u0435\u0437\u0430\u043D");
  const rgb = buf.slice(i, i + need);
  const stride = w * 3;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0;
    rgb.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
var BookmarkModal = class extends Modal {
  constructor(app, view) {
    super(app);
    this.view = view;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0438: " + (this.view.filePath ? path.basename(this.view.filePath) : "") });
    this.listEl = contentEl.createDiv({ cls: "djvu-bm-list" });
    this.renderList();
  }
  renderList() {
    const fp = this.view.filePath;
    const pages = this.view.plugin.getBookmarks(fp);
    this.listEl.empty();
    if (pages.length === 0) {
      this.listEl.createDiv({ cls: "djvu-bm-empty", text: "\u0417\u0430\u043A\u043B\u0430\u0434\u043E\u043A \u043F\u043E\u043A\u0430 \u043D\u0435\u0442. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u2605 \u043D\u0430 \u043D\u0443\u0436\u043D\u043E\u0439 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435." });
      return;
    }
    for (const p of pages) {
      const row = this.listEl.createDiv({ cls: "djvu-bm-row" });
      const lbl = row.createEl("span", { cls: "page", text: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 " + p });
      lbl.onclick = () => {
        this.close();
        this.view.go(p);
      };
      row.createEl("button", { cls: "djvu-btn", text: "\u041F\u0435\u0440\u0435\u0439\u0442\u0438" }).onclick = () => {
        this.close();
        this.view.go(p);
      };
      row.createEl("button", { cls: "djvu-btn djvu-bm-del", text: "\u0423\u0434\u0430\u043B\u0438\u0442\u044C" }).onclick = () => {
        this.view.plugin.toggleBookmark(fp, p);
        this.view.updateBookmarkButton();
        this.renderList();
      };
    }
  }
};
var DjvuView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.page = 1;
    this.total = 0;
    this.cache = /* @__PURE__ */ new Map();
    this.filePath = "";
    this.absPath = "";
    this.domReady = false;
    this._timer = null;
    this.zoom = 1;
    this.imgEl = null;
    this.zoomLbl = null;
    this.stage = null;
    this.lbl = null;
    this.pageInput = null;
    this.bmBtn = null;
    this.slider = null;
    this._wheelLock = false;
    this._rendering = false;
    this._pendingRender = false;
    this._ocrRunning = false;
    this._ocrCancelled = false;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.filePath ? path.basename(this.filePath) : "DjVu";
  }
  getIcon() {
    return "book-open";
  }
  cacheGet(p) {
    if (!this.cache.has(p)) return null;
    const v = this.cache.get(p);
    this.cache.delete(p);
    this.cache.set(p, v);
    return v;
  }
  cacheSet(p, url) {
    if (this.cache.has(p)) this.cache.delete(p);
    this.cache.set(p, url);
    while (this.cache.size > CACHE_LIMIT) {
      const k = this.cache.keys().next().value;
      this.cache.delete(k);
    }
  }
  setZoom(z) {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (this.zoomLbl) this.zoomLbl.setText(Math.round(this.zoom * 100) + "%");
    this.applyZoom();
  }
  applyZoom() {
    if (!this.imgEl) return;
    this.imgEl.style.width = this.zoom * 100 + "%";
    this.imgEl.style.maxWidth = "none";
    if (this.stage) this.stage.style.textAlign = this.zoom > 1.001 ? "left" : "center";
  }
  canScrollUp() {
    const s = this.stage;
    return s && s.scrollTop > 1;
  }
  canScrollDown() {
    const s = this.stage;
    return s && s.scrollTop + s.clientHeight < s.scrollHeight - 1;
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
  updateBookmarkButton() {
    if (!this.bmBtn || !this.filePath) return;
    const on = this.plugin.hasBookmark(this.filePath, this.page);
    this.bmBtn.setText(on ? "\u2605" : "\u2606");
    this.bmBtn.toggleClass("djvu-bm-active", on);
    this.bmBtn.setAttribute("title", on ? "\u0423\u0431\u0440\u0430\u0442\u044C \u0437\u0430\u043A\u043B\u0430\u0434\u043A\u0443 (\u0441\u0442\u0440. " + this.page + ")" : "\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0437\u0430\u043A\u043B\u0430\u0434\u043A\u0443 (\u0441\u0442\u0440. " + this.page + ")");
  }
  toggleCurrentBookmark() {
    if (!this.filePath) return;
    const added = this.plugin.toggleBookmark(this.filePath, this.page);
    this.updateBookmarkButton();
    new Notice(added ? "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0430 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430: \u0441\u0442\u0440. " + this.page : "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0430: \u0441\u0442\u0440. " + this.page);
  }
  openBookmarkList() {
    if (this.filePath) new BookmarkModal(this.app, this).open();
  }
  _onKey(e) {
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || ae && ae.isContentEditable) return;
    if (this.plugin.activeDjvuView() !== this) return;
    const k = e.key;
    const up = () => {
      if (this.canScrollUp()) return;
      e.preventDefault();
      this.go(this.page - 1);
    };
    const dn = () => {
      if (this.canScrollDown()) return;
      e.preventDefault();
      this.go(this.page + 1);
    };
    if (k === "ArrowLeft") {
      e.preventDefault();
      this.go(this.page - 1);
    } else if (k === "ArrowRight") {
      e.preventDefault();
      this.go(this.page + 1);
    } else if (k === "Home") {
      e.preventDefault();
      this.go(1);
    } else if (k === "End") {
      e.preventDefault();
      this.go(this.total);
    } else if (k === "ArrowUp" || k === "PageUp" || k === " " && e.shiftKey) up();
    else if (k === "ArrowDown" || k === "PageDown" || k === " " && !e.shiftKey) dn();
  }
  showInstallGuide() {
    this.stage.empty();
    const box = this.stage.createDiv({ cls: "djvu-err" });
    box.createEl("p", { text: "\u0414\u0435\u043A\u043E\u0434\u0435\u0440 DjVuLibre \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D." });
    box.createEl("p", { text: "\u0412\u043D\u0435\u0448\u043D\u0438\u0439 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442 (\u043E\u0444\u0444\u043B\u0430\u0439\u043D). \u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 \u0438 \u043F\u0440\u0438 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043F\u0443\u0442\u044C \u0432 Settings \u2192 DjVu Reader." });
    box.createEl("p").createEl("a", { text: "\u0421\u043A\u0430\u0447\u0430\u0442\u044C DjVuLibre (SourceForge)", href: "https://djvu.sourceforge.net/" });
    box.createEl("p", { cls: "djvu-hint", text: "\u041F\u043E\u0441\u043B\u0435 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xABDetect now\xBB \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 Obsidian." });
  }
  async onOpen() {
    const c = this.containerEl;
    c.empty();
    c.createDiv({ cls: "djvu-view" }, (wrap) => {
      this.wrap = wrap;
      const bar = wrap.createDiv({ cls: "djvu-bar" });
      this.lbl = bar.createEl("span", { text: "\u2026", cls: "djvu-page", attr: { title: "\u041A\u043B\u0438\u043A \u2014 \u043F\u0435\u0440\u0435\u0439\u0442\u0438 \u043A \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435" } });
      this.pageInput = bar.createEl("input", { type: "number", cls: "djvu-page-input" });
      this.pageInput.style.display = "none";
      this.slider = bar.createEl("input", { type: "range", cls: "djvu-slider", attr: { min: "1", max: "1", value: "1", title: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 1" } });
      bar.createEl("span", { cls: "djvu-sep" });
      const zOut = bar.createEl("button", { text: "\u2212", cls: "djvu-btn", attr: { title: "\u0423\u043C\u0435\u043D\u044C\u0448\u0438\u0442\u044C" } });
      this.zoomLbl = bar.createEl("span", { text: "100%", cls: "djvu-zoom" });
      const zIn = bar.createEl("button", { text: "+", cls: "djvu-btn", attr: { title: "\u0423\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C" } });
      const zFit = bar.createEl("button", { text: "Fit", cls: "djvu-btn", attr: { title: "\u0412\u043F\u0438\u0441\u0430\u0442\u044C \u043F\u043E \u0448\u0438\u0440\u0438\u043D\u0435" } });
      bar.createEl("span", { cls: "djvu-sep" });
      this.bmBtn = bar.createEl("button", { text: "\u2606", cls: "djvu-btn djvu-bm-btn", attr: { title: "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0430" } });
      const bmList = bar.createEl("button", { text: "\u2630", cls: "djvu-btn", attr: { title: "\u0421\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u043A\u043B\u0430\u0434\u043E\u043A" } });
      const ocrBtn = bar.createEl("button", { text: "\u{1F50D}", cls: "djvu-btn", attr: { title: "OCR \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B (tesseract.js)" } });
      this.stage = wrap.createDiv({ cls: "djvu-stage" });
      this.lbl.onclick = () => this.askPage();
      this.pageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitPageInput();
        } else if (e.key === "Escape") {
          this.pageInput.style.display = "none";
          this.lbl.style.display = "";
        }
      });
      this.pageInput.addEventListener("blur", () => {
        this.pageInput.style.display = "none";
        this.lbl.style.display = "";
      });
      this.slider.addEventListener("input", () => {
        const v = +this.slider.value;
        this.lbl.setText(v + " / " + this.total);
        this.slider.setAttribute("title", "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 " + v);
      });
      this.slider.addEventListener("change", () => {
        this.go(+this.slider.value);
      });
      zOut.onclick = () => this.setZoom(this.zoom / ZOOM_STEP);
      zIn.onclick = () => this.setZoom(this.zoom * ZOOM_STEP);
      zFit.onclick = () => this.setZoom(1);
      this.bmBtn.onclick = () => this.toggleCurrentBookmark();
      bmList.onclick = () => this.openBookmarkList();
      ocrBtn.onclick = () => this.ocrCurrentPageJs();
      this.stage.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
          return;
        }
        if (e.deltaY === 0) return;
        const up = e.deltaY < 0;
        if (up ? this.canScrollUp() : this.canScrollDown()) return;
        e.preventDefault();
        if (this._wheelLock) return;
        this._wheelLock = true;
        setTimeout(() => {
          this._wheelLock = false;
        }, WHEEL_LOCK_MS);
        this.go(this.page + (up ? -1 : 1));
      }, { passive: false });
    });
    this.registerDomEvent(window, "keydown", (e) => this._onKey(e));
    this.domReady = true;
    this.stage.setText("\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u044E \u0444\u0430\u0439\u043B\u2026");
    const p = pickPath(this.leaf.getViewState().state) || null;
    if (p) this.loadFile(p);
    else {
      this._timer = setTimeout(() => {
        if (!this.filePath) {
          this.stage.empty();
          this.stage.createDiv({ cls: "djvu-err", text: "\u041F\u0443\u0442\u044C \u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D." });
        }
      }, 1500);
    }
  }
  async setState(state, result) {
    const p = pickPath(state);
    if (p && this.domReady && p !== this.filePath) this.loadFile(p);
    try {
      return await super.setState(state, result);
    } catch (_) {
    }
  }
  getState() {
    return this.filePath ? { file: this.filePath } : {};
  }
  async loadFile(p) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const adapter = this.app.vault.adapter;
    const abs = path.isAbsolute(p) ? p : adapter.getFullPath ? adapter.getFullPath(p) : p;
    this.filePath = p;
    this.absPath = abs;
    this.cache.clear();
    this.page = 1;
    this.stage.empty();
    this.lbl.setText("\u2026");
    if (this.slider) {
      this.slider.max = String(1);
      this.slider.value = "1";
    }
    const ddjvu = this.plugin.getExe("ddjvu");
    if (path.isAbsolute(ddjvu) && !fs.existsSync(ddjvu)) {
      this.plugin.log("[djvu] \u043F\u0443\u0442\u044C \u043D\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442:", ddjvu);
      this.showInstallGuide();
      return;
    }
    const r = await run(this.plugin.getExe("djvused"), ["-e", "n", abs]);
    if (r.code === "ENOENT") {
      this.plugin.log("[djvu] djvused ENOENT");
      this.showInstallGuide();
      return;
    }
    this.total = parseInt((r.stdout || "").trim(), 10) || 0;
    if (this.slider) this.slider.max = String(Math.max(1, this.total));
    if (!this.total) {
      this.stage.createDiv({ cls: "djvu-err", text: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0447\u0438\u0441\u043B\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446 \u2014 \u043A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D \u0438\u043B\u0438 \u043D\u0435 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F." });
      return;
    }
    await this.render();
  }
  async go(p) {
    if (p < 1 || p > this.total) return;
    this.page = p;
    await this.render();
  }
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
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
    }
    return { ok: false, r };
  }
  async render() {
    if (this._rendering) {
      this._pendingRender = true;
      return;
    }
    this._rendering = true;
    try {
      this.lbl.setText(`${this.page} / ${this.total}`);
      if (this.slider) {
        this.slider.value = String(this.page);
        this.slider.setAttribute("title", "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 " + this.page);
      }
      this.updateBookmarkButton();
      this.stage.empty();
      this.imgEl = null;
      const cached = this.cacheGet(this.page);
      if (cached) {
        this.imgEl = this.stage.createEl("img", { attr: { src: cached } });
        this.applyZoom();
        return;
      }
      let res = await this.tryRender(null);
      if (res.enoent) {
        this.showInstallGuide();
        return;
      }
      let fallback = false;
      if (!res.ok) {
        const bg = await this.tryRender("background");
        if (bg.enoent) {
          this.showInstallGuide();
          return;
        }
        if (bg.ok) {
          res = bg;
          fallback = true;
        }
      }
      if (res.ok) {
        try {
          const png = ppmToPng(fs.readFileSync(res.tmp));
          const url = "data:image/png;base64," + png.toString("base64");
          try {
            fs.unlinkSync(res.tmp);
          } catch (_) {
          }
          this.cacheSet(this.page, url);
          if (fallback) this.stage.createDiv({ cls: "djvu-fallback", text: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0435\u043D\u0430: \u043F\u043E\u043A\u0430\u0437\u0430\u043D \u0444\u043E\u043D \u0431\u0435\u0437 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u043E\u0433\u043E/\u0431\u0438-\u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0441\u043B\u043E\u044F." });
          this.imgEl = this.stage.createEl("img", { attr: { src: url } });
          this.applyZoom();
        } catch (e) {
          try {
            fs.unlinkSync(res.tmp);
          } catch (_) {
          }
          this.stage.createDiv({ cls: "djvu-err", text: `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${this.page}: \u043E\u0448\u0438\u0431\u043A\u0430 PPM\u2192PNG: ${e && e.message}` });
        }
      } else {
        this.stage.createDiv({ cls: "djvu-err", text: `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${this.page} \u043D\u0435 \u043E\u0442\u0440\u0435\u043D\u0434\u0435\u0440\u0438\u043B\u0430\u0441\u044C (code=${res.r.code}). ${(res.r.stderr || "").slice(0, 160) || "\u041F\u043E\u0432\u0440\u0435\u0436\u0434\u0435\u043D\u044B \u0438 \u0442\u0435\u043A\u0441\u0442, \u0438 \u0444\u043E\u043D \u2014 \u0441\u0432\u043E\u0439\u0441\u0442\u0432\u043E \u0444\u0430\u0439\u043B\u0430."}` });
      }
    } finally {
      this._rendering = false;
      if (this._pendingRender) {
        this._pendingRender = false;
        this.render();
      }
    }
  }
  _clean(...files) {
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch (_) {
      }
    }
  }
  // рендер страницы в PNG-файл на диске (для передачи в ocr-worker)
  async renderPageToPngFile(page) {
    const res = await this.tryRenderForOcr(page);
    if (!res.ok) return null;
    let pngBuf;
    try {
      pngBuf = ppmToPng(fs.readFileSync(res.tmp));
    } catch (e) {
      console.log("[ocr-js] ppm->png fail", e && e.message);
      this._clean(res.tmp);
      return null;
    }
    this._clean(res.tmp);
    const tmpPng = path.join(os.tmpdir(), `djvu_ocrjs_${Date.now()}_${page}.png`);
    fs.writeFileSync(tmpPng, pngBuf);
    return tmpPng;
  }
  async tryRenderForOcr(page) {
    const tmp = path.join(os.tmpdir(), `djvu_ocr_${Date.now()}_${page}.ppm`);
    const r = await run(this.plugin.getExe("ddjvu"), ["-format=ppm", `-page=${page}`, `-size=${RENDER_W}x${RENDER_H}`, this.absPath, tmp]);
    if (r.code !== 0 || !fs.existsSync(tmp)) {
      console.log("[ocr-js] ddjvu fail page", page, r.code);
      this._clean(tmp);
      return { ok: false };
    }
    return { ok: true, tmp };
  }
  // OCR одной страницы через отдельный node-процесс (Obsidian.exe как node)
  async runOcrJs(page) {
    const pngPath = await this.renderPageToPngFile(page);
    if (!pngPath) return null;
    const langs = this.plugin.settings.ocrLangs || "rus+eng";
    const workerScript = this.plugin.getOcrWorkerPath();
    const nodeBin = await this.plugin.findNode();
    console.log("[ocr-js] node bin:", nodeBin, "| spawn page", page, "| langs", langs, "| worker", workerScript, "exists", fs.existsSync(workerScript));
    const r = await run(nodeBin, [workerScript, pngPath, langs]);
    this._clean(pngPath);
    console.log("[ocr-js] child code=", r.code, "| stderr=", (r.stderr || "").slice(0, 800), "| stdout head=", (r.stdout || "").slice(0, 160));
    if (r.code !== 0) {
      console.log("[ocr-js] child process failed");
      return null;
    }
    try {
      const s = r.stdout || "";
      const a = s.indexOf("{");
      const b = s.lastIndexOf("}");
      const jsonStr = a >= 0 && b > a ? s.slice(a, b + 1) : s;
      const j = JSON.parse(jsonStr);
      if (j.ok) return j.text || "";
      console.log("[ocr-js] worker reported error:", j.error);
      return null;
    } catch (e) {
      console.log("[ocr-js] stdout parse fail:", e && e.message, "| stdout=", r.stdout);
      return null;
    }
  }
  async ocrCurrentPageJs() {
    if (!this.filePath) return;
    if (this._ocrRunning) {
      new Notice("\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0432\u0430\u043D\u0438\u0435 \u0443\u0436\u0435 \u0438\u0434\u0451\u0442");
      return;
    }
    this._ocrRunning = true;
    new Notice(`\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u044E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 ${this.page} (tesseract.js)\u2026`);
    try {
      const text = await this.runOcrJs(this.page);
      if (text && text.trim() !== "") {
        await this.saveOcrText(this.page, text);
        new Notice(`\u0421\u0442\u0440. ${this.page} \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u0430 \u2192 ${this.plugin.settings.ocrShadowFolder || "_djvu_text"}/`);
      } else new Notice(`\u0421\u0442\u0440. ${this.page}: \u043F\u0443\u0441\u0442\u043E \u0438\u043B\u0438 \u043E\u0448\u0438\u0431\u043A\u0430 (\u0441\u043C. \u043A\u043E\u043D\u0441\u043E\u043B\u044C [ocr-js])`);
    } catch (e) {
      console.log("[ocr-js] ERROR:", e && e.stack || e);
      new Notice("OCR (js) \u043E\u0448\u0438\u0431\u043A\u0430 \u2014 \u0441\u043C. \u043A\u043E\u043D\u0441\u043E\u043B\u044C [ocr-js]");
    } finally {
      this._ocrRunning = false;
    }
  }
  // Наивно: процесс на страницу (медленно для толстых книг; батч-оптимизация — следующий шаг)
  async ocrWholeBookJs() {
    if (!this.filePath) return;
    if (this._ocrRunning) {
      new Notice("\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0432\u0430\u043D\u0438\u0435 \u0443\u0436\u0435 \u0438\u0434\u0451\u0442");
      return;
    }
    this._ocrRunning = true;
    this._ocrCancelled = false;
    const notice = new Notice("\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u044E \u043A\u043D\u0438\u0433\u0443 (tesseract.js, \u043F\u043E\u0441\u0442\u0440\u0430\u043D\u0438\u0447\u043D\u043E)\u2026", 0);
    try {
      for (let p = 1; p <= this.total; p++) {
        if (this._ocrCancelled) {
          notice.setMessage(`\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E \u043D\u0430 \u0441\u0442\u0440. ${p}`);
          setTimeout(() => notice.hide(), 3e3);
          break;
        }
        notice.setMessage(`\u0421\u0442\u0440. ${p} / ${this.total} (tesseract.js)\u2026`);
        const text = await this.runOcrJs(p);
        if (text && text.trim() !== "") await this.saveOcrText(p, text);
      }
      if (!this._ocrCancelled) {
        notice.setMessage(`\u0413\u043E\u0442\u043E\u0432\u043E: ${this.total} \u0441\u0442\u0440.`);
        setTimeout(() => notice.hide(), 3e3);
      }
    } catch (e) {
      console.log("[ocr-js] ERROR:", e && e.stack || e);
      notice.setMessage("OCR (js) \u043E\u0448\u0438\u0431\u043A\u0430 \u2014 \u0441\u043C. \u043A\u043E\u043D\u0441\u043E\u043B\u044C [ocr-js]");
      setTimeout(() => notice.hide(), 3e3);
    } finally {
      this._ocrRunning = false;
    }
  }
  async saveOcrText(page, text) {
    const folder = (this.plugin.settings.ocrShadowFolder || "_djvu_text").replace(/^\/+|\/+$/g, "");
    const fileName = path.basename(this.filePath, path.extname(this.filePath)) + ".md";
    const filePath = folder + "/" + fileName;
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(folder)) await adapter.mkdir(folder);
    let content = await adapter.exists(filePath) ? await adapter.read(filePath) : `# ${path.basename(this.filePath, path.extname(this.filePath))}

> OCR-\u0442\u0435\u043A\u0441\u0442 \u0438\u0437 DjVu (tesseract.js). \u0421\u043E\u0437\u0434\u0430\u043D\u043E \u043F\u043B\u0430\u0433\u0438\u043D\u043E\u043C DjVu Reader.
`;
    const header = `## \u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${page}`;
    const block = `
${header}

${text.trim()}
`;
    const re = new RegExp(`\\n## \u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${page}\\b[\\s\\S]*?(?=\\n## \u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \\d+|$)`);
    content = re.test(content) ? content.replace(re, block) : content + block;
    await adapter.write(filePath, content);
  }
  cancelOcr() {
    if (this._ocrRunning) {
      this._ocrCancelled = true;
      new Notice("\u041E\u0442\u043C\u0435\u043D\u044E \u043F\u043E\u0441\u043B\u0435 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B");
    }
  }
  async onClose() {
    this.cache.clear();
    if (this._timer) clearTimeout(this._timer);
  }
};
var DjvuSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DjVu Reader" });
    new Setting(containerEl).setName("\u041F\u0430\u043F\u043A\u0430 DjVuLibre").setDesc("\u041F\u0443\u0442\u044C \u043A ddjvu/djvused. \u041F\u0443\u0441\u0442\u043E = \u0430\u0432\u0442\u043E/PATH. \u041E\u0444\u0444\u043B\u0430\u0439\u043D.").addText((t) => t.setPlaceholder("\u0430\u0432\u0442\u043E / PATH").setValue(this.plugin.settings.djvuBinPath).onChange(async (v) => {
      this.plugin.settings.djvuBinPath = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("\u041D\u0430\u0439\u0442\u0438 DjVuLibre").setDesc("\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u043F\u0443\u0442\u0438 \u0441\u0435\u0439\u0447\u0430\u0441.").addButton((b) => b.setButtonText("Detect now").onClick(async () => {
      const d = await this.plugin.detectBin();
      this.plugin.resolvedBin = d;
      new Notice(d ? "DjVuLibre: " + d : "DjVuLibre \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }));
    new Setting(containerEl).setName("\u042F\u0437\u044B\u043A\u0438 OCR").setDesc("\u0427\u0435\u0440\u0435\u0437 +. \u041F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E rus+eng.").addText((t) => t.setPlaceholder("rus+eng").setValue(this.plugin.settings.ocrLangs).onChange(async (v) => {
      this.plugin.settings.ocrLangs = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("\u041F\u0430\u043F\u043A\u0430 \u0442\u0435\u043D\u0435\u0439 OCR").setDesc("\u041F\u0430\u043F\u043A\u0430 \u0432 vault \u0434\u043B\u044F \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u043E\u0433\u043E \u0442\u0435\u043A\u0441\u0442\u0430. \u041F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E _djvu_text.").addText((t) => t.setPlaceholder("_djvu_text").setValue(this.plugin.settings.ocrShadowFolder).onChange(async (v) => {
      this.plugin.settings.ocrShadowFolder = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("\u041E\u0442\u043B\u0430\u0434\u043E\u0447\u043D\u044B\u0439 \u043B\u043E\u0433").setDesc("[djvu]/[ocr-js] \u0432 \u043A\u043E\u043D\u0441\u043E\u043B\u044C. \u0422\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0438.").addToggle((t) => t.setValue(this.plugin.settings.debug).onChange(async (v) => {
      this.plugin.settings.debug = v;
      await this.plugin.saveSettings();
    }));
  }
};
var _origOpenFile = null;
var _wrappedProto = null;
module.exports = class DjvuReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.resolvedBin = "";
    this.addSettingTab(new DjvuSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new DjvuView(leaf, this));
    this.registerExtensions(["djvu", "djv"], VIEW_TYPE);
    this.addCommand({
      id: "djvu-toggle-bookmark",
      name: "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0430: \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C/\u0443\u0431\u0440\u0430\u0442\u044C \u043D\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435",
      checkCallback: (c) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!c) v.toggleCurrentBookmark();
        return true;
      }
    });
    this.addCommand({
      id: "djvu-open-bookmarks",
      name: "\u0417\u0430\u043A\u043B\u0430\u0434\u043A\u0438: \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u043A\u043D\u0438\u0433\u0438",
      checkCallback: (c) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!c) v.openBookmarkList();
        return true;
      }
    });
    this.addCommand({
      id: "djvu-ocr-page",
      name: "OCR: \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 (tesseract.js)",
      checkCallback: (c) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!c) v.ocrCurrentPageJs();
        return true;
      }
    });
    this.addCommand({
      id: "djvu-ocr-book",
      name: "OCR: \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0442\u044C \u0432\u0441\u044E \u043A\u043D\u0438\u0433\u0443 (tesseract.js, \u043F\u043E\u0441\u0442\u0440\u0430\u043D\u0438\u0447\u043D\u043E)",
      checkCallback: (c) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!c) v.ocrWholeBookJs();
        return true;
      }
    });
    this.addCommand({
      id: "djvu-ocr-cancel",
      name: "OCR: \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0432\u0430\u043D\u0438\u0435",
      checkCallback: (c) => {
        const v = this.activeDjvuView();
        if (!v || !v.filePath) return false;
        if (!c) v.cancelOcr();
        return true;
      }
    });
    this.ensureWrap();
    try {
      this.app.workspace.onLayoutReady(() => this.ensureWrap());
    } catch (_) {
      setTimeout(() => this.ensureWrap(), 400);
    }
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.ensureWrap();
      const v = leaf && leaf.view;
      if (v instanceof DjvuView && !v.filePath) {
        const p = pickPath(leaf.getViewState().state);
        if (p) v.loadFile(p);
      }
    }));
    this.detectBin().then((d) => {
      this.resolvedBin = d;
      this.log("[djvu] detected bin dir=", d || "(none)");
    });
    this.log("[djvu] onload ok v1.3-js");
  }
  onunload() {
    if (_wrappedProto) {
      if (_origOpenFile) _wrappedProto.openFile = _origOpenFile;
      _wrappedProto = null;
    }
  }
  log(...a) {
    if (this.settings && this.settings.debug) console.log(...a);
  }
  activeDjvuView() {
    try {
      return this.app.workspace.getActiveViewOfType(DjvuView) || null;
    } catch (_) {
      return null;
    }
  }
  getPluginDir() {
    const md = this.manifest.dir || "";
    if (path.isAbsolute(md)) return md;
    try {
      const base = this.app.vault.adapter.getBasePath && this.app.vault.adapter.getBasePath();
      if (base) return path.join(base, md);
    } catch (_) {
    }
    return path.resolve(md);
  }
  getOcrWorkerPath() {
    return path.join(this.getPluginDir(), "ocr-worker.js");
  }
  async findNode() {
    if (this._nodePath) return this._nodePath;
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    const appdata = process.env.APPDATA || "";
    const cands = [
      path.join(pf, "nodejs", "node.exe"),
      path.join(pf86, "nodejs", "node.exe")
    ];
    if (local) cands.push(path.join(local, "Programs", "nodejs", "node.exe"));
    if (appdata) cands.push(path.join(appdata, "npm", "node.exe"));
    for (const c of cands) {
      try {
        if (fs.existsSync(c)) {
          this._nodePath = c;
          return c;
        }
      } catch (_) {
      }
    }
    try {
      const r = await run(os.platform() === "win32" ? "where" : "which", ["node"]);
      if (r.code === 0) {
        const f = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (f) {
          this._nodePath = f;
          return f;
        }
      }
    } catch (_) {
    }
    this._nodePath = "node";
    return this._nodePath;
  }
  getBookmarks(fp) {
    const a = this.settings.bookmarks[fp];
    return a ? [...a] : [];
  }
  hasBookmark(fp, page) {
    const a = this.settings.bookmarks[fp];
    return !!(a && a.includes(page));
  }
  toggleBookmark(fp, page) {
    const b = this.settings.bookmarks;
    if (!b[fp]) b[fp] = [];
    const i = b[fp].indexOf(page);
    let added;
    if (i >= 0) {
      b[fp].splice(i, 1);
      added = false;
      if (b[fp].length === 0) delete b[fp];
    } else {
      b[fp].push(page);
      b[fp].sort((x, y) => x - y);
      added = true;
    }
    this.saveSettings();
    return added;
  }
  getExe(name) {
    const dir = (this.settings.djvuBinPath || "").trim() || this.resolvedBin || "";
    const base = dir ? path.join(dir, name) : name;
    return os.platform() === "win32" && !path.extname(base) ? base + ".exe" : base;
  }
  async detectBin() {
    const cands = [];
    const cfg = (this.settings.djvuBinPath || "").trim();
    if (cfg) cands.push(cfg);
    if (os.platform() === "win32") cands.push("C:/Program Files/DjVuLibre", "C:/Program Files (x86)/DjVuLibre");
    const bin = os.platform() === "win32" ? "ddjvu.exe" : "ddjvu";
    for (const d of cands) if (fs.existsSync(path.join(d, bin))) return d.replace(/\\/g, "/");
    try {
      const r = await run(os.platform() === "win32" ? "where" : "which", ["ddjvu"]);
      if (r.code === 0) {
        const f = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (f) return path.dirname(f).replace(/\\/g, "/");
      }
    } catch (_) {
    }
    return "";
  }
  ensureWrap() {
    if (_wrappedProto) return true;
    try {
      const l = this.app.workspace.getLeavesOfType("markdown")[0] || this.app.workspace.getMostRecentLeaf();
      const proto = l ? Object.getPrototypeOf(l) : null;
      if (!proto || typeof proto.openFile !== "function") return false;
      _wrappedProto = proto;
      _origOpenFile = proto.openFile;
      proto.openFile = async function(file, openState) {
        if (file && IS_DJVU(file.path)) {
          try {
            await this.setViewState({ type: VIEW_TYPE, state: { file: file.path }, eState: openState });
            return;
          } catch (e) {
          }
        }
        return _origOpenFile.call(this, file, openState);
      };
      return true;
    } catch (e) {
      return false;
    }
  }
  async loadSettings() {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.bookmarks = Object.assign({}, data.bookmarks || {});
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
