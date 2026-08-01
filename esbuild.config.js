const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");

const opts = {
  entryPoints: ["src/index.js"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2020",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
};

if (watch) {
  esbuild.context(opts).then((ctx) => { ctx.watch(); console.log("watching src/ -> main.js"); });
} else {
  esbuild.build(opts).then(() => console.log("build complete: main.js")).catch(() => process.exit(1));
}