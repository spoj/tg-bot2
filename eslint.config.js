import tseslint from "typescript-eslint";

// The sandbox is the only place process spawning and killing may happen:
// agent-influenced code must only ever run inside bwrap, and bwrap is built
// in exactly one module. Confinement is enforced for src/ only — tests build
// fake children and assert on kill() calls.
const CHILD_PROCESS = {
  name: "node:child_process",
  message: "Process spawning is confined to src/sandbox.ts.",
};

export default tseslint.config(
  { ignores: ["dist/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      complexity: ["error", 20],
      "no-restricted-imports": ["error", { paths: [CHILD_PROCESS] }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='spawn']",
          message: "Process spawning is confined to src/sandbox.ts.",
        },
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='kill']",
          message: "Process control is confined to src/sandbox.ts.",
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='kill']:not([callee.object.name='process'])",
          message: "Child-process control is confined to src/sandbox.ts.",
        },
      ],
    },
  },
  {
    files: ["src/sandbox.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
  {
    rules: {
      // Underscore-prefixed names are the project convention for deliberately
      // unused mock parameters.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Test fakes stub foreign interfaces (FileHandle, grammY Bot) where any[]
    // is the honest signature; the src/ hygiene bar does not apply here.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
