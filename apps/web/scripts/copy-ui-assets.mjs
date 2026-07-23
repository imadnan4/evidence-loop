import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const uiSrc = resolve(import.meta.dirname, "..", "..", "packages", "ui", "src");
const publicDir = resolve(import.meta.dirname, "..", "public", "ui");

await mkdir(publicDir, { recursive: true });

const files = ["components.js", "primitives.css", "tokens.css"];
await Promise.all(files.map((file) => copyFile(resolve(uiSrc, file), resolve(publicDir, file))));

console.log("Copied UI assets to public/ui/");
