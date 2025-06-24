import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { builtinModules } from "module";

// Read package.json for external dependencies
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));

// Bundle and minify the server, targeting Node 20
build({
  entryPoints: ["src/server.js"],
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "esm",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  },
  minify: true,
  pure: ["console.log", "logger.info", "logger.debug"],
  external: [...Object.keys(pkg.dependencies), ...builtinModules],
  outfile: "dist/server.js",
}).catch(() => process.exit(1)); 