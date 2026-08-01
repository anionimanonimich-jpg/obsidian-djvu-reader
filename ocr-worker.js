// src/ocr-worker-src.js
var fs = require("fs");
var path = require("path");
var Tesseract = require("tesseract.js");
var log = (...a) => process.stderr.write("[ocr-worker] " + a.join(" ") + "\n");
var [, , imagePath, langs] = process.argv;
var dir = __dirname;
(async () => {
  log("start image=", imagePath, "langs=", langs, "dir=", dir);
  if (!imagePath || !fs.existsSync(imagePath)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "no image: " + imagePath }));
    process.exit(1);
  }
  const tdir = path.join(dir, "tesseract");
  const workerPath = path.join(tdir, "worker.min.js");
  const coreFile = (fs.existsSync(tdir) ? fs.readdirSync(tdir) : []).filter((f) => /\.wasm\.js$/.test(f)).find((f) => !/simd/.test(f)) || "";
  const corePath = coreFile ? path.join(tdir, coreFile) : "";
  const langPath = path.join(dir, "tessdata") + path.sep;
  log("workerPath exists:", fs.existsSync(workerPath));
  log("coreFile:", coreFile, "corePath exists:", corePath ? fs.existsSync(corePath) : "n/a");
  log("tessdata exists:", fs.existsSync(path.join(dir, "tessdata")));
  const worker = await Tesseract.createWorker({
    langPath,
    gzip: false,
    cacheMethod: "none",
    logger: (m) => log("tess", m.status, Math.round((m.progress || 0) * 100) + "%")
  });
  log("createWorker ok -> loadLanguage");
  await worker.loadLanguage(langs);
  log("loadLanguage ok -> initialize");
  await worker.initialize(langs);
  log("initialize ok -> recognize");
  const { data: { text } } = await worker.recognize(imagePath);
  log("recognize ok, len=", (text || "").length);
  await worker.terminate();
  process.stdout.write(JSON.stringify({ ok: true, text: text || "" }));
})().catch((e) => {
  log("ERROR", e && e.stack || e);
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
