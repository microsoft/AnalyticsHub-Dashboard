import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const output = resolve(import.meta.dirname, "..", "dist-demo");
await copyFile(resolve(output, "demo.html"), resolve(output, "index.html"));
await copyFile(resolve(import.meta.dirname, "..", "LICENSE"), resolve(output, "LICENSE.txt"));
await writeFile(
    resolve(output, "README.txt"),
    [
        "Analytics Hub interactive browser demo",
        "",
        "Static, self-contained app bundle. Uses synthetic sample data only.",
        "No sign-in, model, tenant, or app backend is required.",
        "Keep all assets, LICENSE.txt, THIRD_PARTY_NOTICES.txt, and SHA256SUMS.txt alongside index.html.",
        "",
    ].join("\n"),
);

async function collectFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...await collectFiles(path));
        else files.push(path);
    }
    return files;
}

const files = (await collectFiles(output))
    .filter((path) => path !== resolve(output, "SHA256SUMS.txt"))
    .sort();
const checksums = await Promise.all(files.map(async (path) => {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    return `${digest}  ${relative(output, path).replaceAll("\\", "/")}`;
}));
await writeFile(resolve(output, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
