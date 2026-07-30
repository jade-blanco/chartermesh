import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const project = process.cwd();
const output = join(project, "dist");
const sourceRoots = ["apps", "packages", "adapters"];

if (sourceRoots.some((root) => !existsSync(join(project, root)))) {
  console.log("Using the prebuilt dependency-free JavaScript package.");
  process.exit(0);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const visit = (root, directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test" && entry.name !== "node_modules") {
        visit(root, path);
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const destination = join(
      output,
      root,
      relative(join(project, root), path),
    ).replace(/\.ts$/u, ".js");
    mkdirSync(dirname(destination), { recursive: true });
    const source = readFileSync(path, "utf8").replace(
      /(?<=["'])((?:\.\.?\/)+[^"']+)\.ts(?=["'])/gu,
      "$1.js",
    );
    writeFileSync(
      destination,
      stripTypeScriptTypes(source, {
        mode: "transform",
        sourceMap: false,
      }),
      "utf8",
    );
  }
};

for (const root of sourceRoots) visit(root, join(project, root));
cpSync(
  join(project, "apps", "dashboard", "public"),
  join(output, "apps", "dashboard", "public"),
  { recursive: true },
);
cpSync(join(project, "schemas"), join(output, "schemas"), {
  recursive: true,
});
cpSync(join(project, "skills"), join(output, "skills"), {
  recursive: true,
});
console.log("Built dependency-free JavaScript package in dist/.");
