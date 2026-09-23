import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/ai-gateway.ts", "src/oidc.ts"],
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: true,
  fixedExtension: false,
  exports: true,
})
