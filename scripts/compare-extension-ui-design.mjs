/** Lossless QA evidence composition, not a design or product asset. */
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import path from "node:path";
const [sourcePath, implementationPath, outputDir] = process.argv.slice(2);
if (!sourcePath || !implementationPath || !outputDir) throw new Error("Pass source SVG/image, captured PNG, and evidence directory");
const runtimeModules = process.env.STARVOICE_QA_NODE_MODULES;
if (!runtimeModules) throw new Error("Set STARVOICE_QA_NODE_MODULES to the workspace bundled node_modules path");
const require = createRequire(path.join(runtimeModules, "qa-entry.cjs"));
const sharp = require("sharp");
const source = await sharp(await readFile(sourcePath)).resize(440, 1000, {fit: "fill"}).png().toBuffer();
const actual = await sharp(await readFile(implementationPath)).resize(440, 1000, {fit: "fill"}).png().toBuffer();
await sharp(source).toFile(path.join(outputDir, "source-normalized.png"));
await sharp({create: {width: 904, height: 1000, channels: 4, background: "#d8e0ea"}})
  .composite([{input: source, left: 0, top: 0}, {input: actual, left: 464, top: 0}]).png().toFile(path.join(outputDir, "comparison-full.png"));
for (const [name, leftY, rightY, height] of [["controls", 106, 106, 365], ["content", 490, 480, 345], ["navigation", 866, 866, 134]]) {
  const left = await sharp(source).extract({left: 0, top: leftY, width: 440, height}).toBuffer();
  const right = await sharp(actual).extract({left: 0, top: rightY, width: 440, height}).toBuffer();
  await sharp({create: {width: 904, height, channels: 4, background: "#d8e0ea"}})
    .composite([{input: left, left: 0, top: 0}, {input: right, left: 464, top: 0}]).png().toFile(path.join(outputDir, `comparison-${name}.png`));
}
console.log("Saved full and focused comparisons; source left, implementation right.");
