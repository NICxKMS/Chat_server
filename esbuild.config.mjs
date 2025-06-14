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
  format: "cjs",
  sourcemap: false,
  metafile: true,
  treeShaking: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  pure: [
    "console.log",
    "console.debug",
    "console.info",
    "console.trace",
    "logger.debug",
    "logger.info"
  ],
  external: [...Object.keys(pkg.dependencies), ...builtinModules],
  outfile: "dist/server.cjs",
}).catch(() => process.exit(1)); 