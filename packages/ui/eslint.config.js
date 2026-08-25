//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  ...tanstackConfig,
  {
    // Every component in `src/components` is copied from the shadcn registry
    // and re-copied whenever a preset is applied. These are `tanstackConfig`
    // opinions that the registry's own output does not share, so leaving them
    // on means hand-patching generated files after every `shadcn add` — and
    // the patch is undone by the next one.
    rules: {
      // Registry components write `import { cva, type VariantProps }`.
      "import/consistent-type-specifier-style": "off",
      "import/no-cycle": "off",
      "import/order": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    ignores: ["eslint.config.js", ".prettierrc"],
  },
]
