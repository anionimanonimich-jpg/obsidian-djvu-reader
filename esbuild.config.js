const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");

const common = { bundle: true, format: "cjs", platform: "node", target: "es2020", logLevel: "info" };
const builds = [
  { ...common, entryPoints: ["src/index.js"], outfile: "main.js",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"] },
  { ...common, entryPoints: ["src/ocr-worker-src.js"], outfile: "ocr-worker.js",
    external: ["tesseract.js"] },   // tesseract.js не бандлим, требуем из node_modules в рантайме
];
if (watch) {
  Promise.all(builds.map((o) => esbuild.context(o).then((c) => c.watch())))
    .then(() => console.log("watching src/ -> main.js + ocr-worker.js"));
} else {
  Promise.all(builds.map((o) => esbuild.build(o)))
    .then(() => console.log("build complete: main.js + ocr-worker.js"))
    .catch(() => process.exit(1));
}