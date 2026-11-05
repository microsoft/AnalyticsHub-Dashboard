import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const analytics = process.argv[2] === "analytics";
const output = resolve(import.meta.dirname, "..", analytics ? "dist-demo-analytics" : "dist-demo");
const root = resolve(import.meta.dirname, "..", "..");
const data = JSON.parse(await readFile(resolve(root, "app", "src", "demo", "sample-data.generated.json"), "utf8"));
const generated = analytics
    ? JSON.parse(await readFile(resolve(root, "app", "src", "demo", "analytics-meta-data.generated.json"), "utf8"))
    : undefined;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
await writeFile(resolve(output, "SOURCE_PROVENANCE.json"), `${JSON.stringify({
    repository: "https://github.com/microsoft/DataHub",
    sourceRevision: git("rev-parse", "HEAD"),
    sourceDirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    sampleTree: git("rev-parse", "HEAD:samples"),
    node: process.version,
    ...data.provenance,
    ...(analytics ? { variant: "analytics-only", generatedSyntheticSources: generated } : {}),
}, null, 2)}\n`);
await copyFile(resolve(output, analytics ? "demo-analytics.html" : "demo.html"), resolve(output, "index.html"));
if (analytics) {
    await copyFile(resolve(root, "app", "src", "demo", "analytics-coverage.json"), resolve(output, "COVERAGE.json"));
}
await copyFile(resolve(import.meta.dirname, "..", "LICENSE"), resolve(output, "LICENSE.txt"));
await writeFile(
    resolve(output, "README.txt"),
    [
        "DataHub App interactive browser demo",
        "",
        "Static, self-contained app bundle. Uses synthetic sample data only.",
        "No sign-in, model, tenant, or app backend is required.",
        "Core pages derive from the repository's published synthetic CSVs, with original dates.",
        "Unfiltered activity: 13,337 tasks, 170 inventory people; template-rule typical hours: 2,476.65.",
        "Dated tenant exports: Cowork 44,750.8531 + Studio 117,472 = 162,222.8531 credits.",
        "User and agent exports are separate snapshots, not dated tenant totals.",
        ...(analytics ? [
            "M365 activity, agent evaluations, Defender findings and Resource Graph configuration are generated synthetic scenarios.",
            "These simulations match the published 170-person inventory and June-August 2026 dates, not any real tenant.",
            "Budget runway starts with editable demo-only budget assumptions; Ask is an offline example.",
            "Azure-billed Copilot is a separate generated scenario, not a reconciliation to published exports.",
            "COVERAGE.json maps the remaining stages to their published or generated synthetic sources.",
        ] : [
            "No Microsoft 365 telemetry, evaluation conversations, Defender or Resource Graph export is included.",
            "The cross-vendor comparison retains its separately labelled seeded scenario.",
        ]),
        "SOURCE_PROVENANCE.json records build revision, source hashes and classification settings.",
        "Keep all assets, SOURCE_PROVENANCE.json, LICENSE.txt, THIRD_PARTY_NOTICES.txt, and SHA256SUMS.txt alongside index.html.",
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
