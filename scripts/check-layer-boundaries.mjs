import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");
const sourceFiles = readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name)
  .sort();

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipTrivia(source, position) {
  let cursor = position;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function readQuoted(source, position) {
  const quote = source[position];
  if (quote !== "\"" && quote !== "'") return undefined;
  let cursor = position + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) return { value, end: cursor + 1 };
    value += character;
    cursor += 1;
  }
  return undefined;
}

/**
 * Collect static, dynamic, and CommonJS module specifiers without evaluating code.
 * The small scanner skips comments and strings, avoiding broad framework parsing.
 */
function collectImports(source) {
  const imports = [];
  let cursor = 0;
  let quote;

  while (cursor < source.length) {
    const character = source[cursor];
    if (quote) {
      if (character === "\\") {
        cursor += 2;
      } else if (character === quote) {
        quote = undefined;
        cursor += 1;
      } else {
        cursor += 1;
      }
      continue;
    }
    if (character === "`" || character === "\"" || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }

    if (source.startsWith("import", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 6])) {
      let next = skipTrivia(source, cursor + 6);
      if (source[next] === ".") {
        cursor += 6;
        continue;
      }
      if (source[next] === "(") {
        next = skipTrivia(source, next + 1);
        const imported = readQuoted(source, next);
        if (imported) imports.push({ specifier: imported.value, clause: "", index: cursor });
        cursor = imported?.end ?? next + 1;
        continue;
      }

      const declarationStart = next;
      const sideEffect = readQuoted(source, next);
      if (sideEffect) {
        imports.push({ specifier: sideEffect.value, clause: "", index: cursor });
        cursor = sideEffect.end;
        continue;
      }

      let foundFrom;
      while (next < source.length && next - declarationStart < 16_384) {
        next = skipTrivia(source, next);
        if (source[next] === ";") break;
        if (isIdentifierStart(source[next])) {
          const tokenStart = next;
          next += 1;
          while (isIdentifierPart(source[next])) next += 1;
          if (source.slice(tokenStart, next) === "from") {
            const moduleStart = skipTrivia(source, next);
            const imported = readQuoted(source, moduleStart);
            if (imported) {
              foundFrom = {
                specifier: imported.value,
                clause: source.slice(declarationStart, tokenStart),
                index: cursor,
              };
              next = imported.end;
            }
            break;
          }
          continue;
        }
        if (source[next] === "\"" || source[next] === "'") {
          const string = readQuoted(source, next);
          next = string?.end ?? source.length;
          continue;
        }
        next += 1;
      }
      if (foundFrom) imports.push(foundFrom);
      cursor = Math.max(next, cursor + 6);
      continue;
    }

    if (source.startsWith("require", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 7])) {
      let next = skipTrivia(source, cursor + 7);
      if (source[next] === "(") {
        next = skipTrivia(source, next + 1);
        const required = readQuoted(source, next);
        if (required) imports.push({ specifier: required.value, clause: "require", index: cursor });
        cursor = required?.end ?? next + 1;
        continue;
      }
    }

    cursor += 1;
  }
  return imports;
}

function hasCall(source, name) {
  let cursor = 0;
  let quote;
  while (cursor < source.length) {
    const character = source[cursor];
    if (quote) {
      if (character === "\\") cursor += 2;
      else if (character === quote) {
        quote = undefined;
        cursor += 1;
      } else cursor += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith(name, cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + name.length])) {
      const next = skipTrivia(source, cursor + name.length);
      if (source[next] === "(") return true;
      cursor += name.length;
      continue;
    }
    cursor += 1;
  }
  return false;
}

function moduleBase(specifier) {
  const withoutQuery = specifier.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  const finalPart = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return finalPart.replace(/\.(?:[cm]?js|[cm]?ts|tsx?)$/i, "").toLowerCase();
}

function isLocalModule(specifier, name) {
  return moduleBase(specifier) === name;
}

function isPackage(specifier, name) {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function isModelSpecifier(specifier) {
  return /(?:^|[/_.-])model(?:[/_.-]|$)/i.test(specifier);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addViolation(violations, file, specifier, reason) {
  const key = `${file}\u0000${specifier}\u0000${reason}`;
  if (!violations.some((violation) => violation.key === key)) {
    violations.push({ key, file, specifier, reason });
  }
}

const violations = [];
for (const file of sourceFiles) {
  const source = readFileSync(join(sourceRoot, file), "utf8");
  const layer = basename(file, ".ts").toLowerCase();
  const imports = collectImports(source);

  for (const imported of imports) {
    const { specifier, clause } = imported;
    const telegram = isLocalModule(specifier, "telegram") || isPackage(specifier, "grammy");
    const agent = isLocalModule(specifier, "agent");
    const scheduler = isLocalModule(specifier, "scheduler");
    const sandbox = isLocalModule(specifier, "sandbox");
    const tools = isLocalModule(specifier, "tools");
    const childProcess = specifier === "child_process" || specifier === "node:child_process" || specifier.endsWith("/child_process");
    const importedSpawn = /\bspawn\b/.test(clause);
    const importedAgentSession = /\bAgentSession\b/.test(clause);

    if (layer === "sandbox" && (telegram || agent || scheduler || isModelSpecifier(specifier) || isPackage(specifier, "@earendil-works/pi-coding-agent"))) {
      addViolation(violations, file, specifier, "sandbox may not import Telegram, agent, scheduler, or model modules");
    }
    if (layer === "tools" && (telegram || agent || scheduler)) {
      addViolation(violations, file, specifier, "tools may not import Telegram, agent, or scheduler modules");
    }
    if (layer === "tools" && childProcess) {
      addViolation(violations, file, specifier, "tools may not import child_process");
    }
    if (layer === "agent" && (telegram || scheduler)) {
      addViolation(violations, file, specifier, "agent may not import grammY, Telegram, or scheduler modules");
    }
    if (layer === "config" && (isLocalModule(specifier, "agent") || isLocalModule(specifier, "telegram") || isLocalModule(specifier, "sandbox") || isLocalModule(specifier, "tools") || isLocalModule(specifier, "scheduler") || isLocalModule(specifier, "queue") || isLocalModule(specifier, "index") || isPackage(specifier, "grammy") || isPackage(specifier, "@earendil-works/pi-coding-agent"))) {
      addViolation(violations, file, specifier, "config may not import runtime or transport modules");
    }
    if (layer === "scheduler" && (telegram || importedAgentSession || sandbox || tools)) {
      addViolation(violations, file, specifier, "scheduler may not import grammY, AgentSession, sandbox, or tools");
    }
    if (layer !== "sandbox" && childProcess && layer !== "tools") {
      addViolation(violations, file, specifier, "child_process may only be imported by sandbox.ts");
    }
    if (layer !== "sandbox" && importedSpawn && !childProcess) {
      addViolation(violations, file, specifier, "spawn may only be used by sandbox.ts");
    }
  }

  if (layer !== "sandbox" && hasCall(source, "spawn")) {
    addViolation(violations, file, "spawn", "spawn may only be used by sandbox.ts");
  }
}

violations.sort((left, right) => compareText(left.file, right.file) || compareText(left.specifier, right.specifier) || compareText(left.reason, right.reason));

if (violations.length > 0) {
  console.error("Layer boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${JSON.stringify(violation.specifier)} — ${violation.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Layer boundary check passed (${sourceFiles.length} TypeScript files).`);
}
