import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  rules: {
    "prefer-destructuring": "off",
    "unicorn/no-await-expression-member": "off",
  },
});
