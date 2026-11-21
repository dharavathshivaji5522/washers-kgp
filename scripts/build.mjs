import { readFile, mkdir, readdir, writeFile, copyFile } from "node:fs/promises";
import { extname, join } from "node:path";

const publicFiles = await readdir("public");
const types = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};
const files = await Promise.all(publicFiles.map(async name => {
  const binary = extname(name) === ".woff2";
  const data = await readFile(join("public", name), binary ? "base64" : "utf8");
  return [`/${name}`, { type: types[extname(name)], encoding: binary ? "base64" : "text", data }];
}));
const catalog = await readFile("src/catalog.js", "utf8");
const model = await readFile("src/model.js", "utf8");
const worker = await readFile("src/worker.js", "utf8");
const assets = Object.fromEntries(files);
assets["/catalog.js"] = { type: types[".js"], data: catalog };
await Promise.all([mkdir("dist/server", { recursive: true }), mkdir("dist/.openai", { recursive: true })]);
await Promise.all([
  writeFile("dist/server/index.js", `const ASSETS = ${JSON.stringify(assets)};\n${catalog}\n${model}\n${worker}`),
  copyFile(".openai/hosting.json", "dist/.openai/hosting.json")
]);
console.log("Built Cloudflare Worker and embedded frontend.");
