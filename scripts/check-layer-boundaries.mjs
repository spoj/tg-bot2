import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");

function listSourceFiles(directory, relativeDirectory = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(join(directory, entry.name), relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

const sourceFiles = listSourceFiles(sourceRoot);

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

/** Local names (after `as`) in an import/export clause like `type { A as B, C }`. */
function clauseNames(clause) {
  const braceStart = clause.indexOf("{");
  const braceEnd = clause.lastIndexOf("}");
  const inner = braceStart >= 0 && braceEnd > braceStart
    ? clause.slice(braceStart + 1, braceEnd)
    : clause;
  const names = [];
  for (const raw of inner.split(",")) {
    const parts = raw.trim().split(/\s+/).filter((part) => part !== "" && part !== "type" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part));
    if (parts.length === 0) continue;
    let name = parts[parts.length - 1];
    if (name === "as") name = parts[parts.length - 2];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Reads a trailing `from "<specifier>"`, stopping at a statement terminator. */
function readFromClause(source, start) {
  let next = start;
  while (next < source.length && next - start < 16_384) {
    next = skipTrivia(source, next);
    if (source[next] === ";") break;
    if (isIdentifierStart(source[next])) {
      const tokenStart = next;
      next += 1;
      while (isIdentifierPart(source[next])) next += 1;
      if (source.slice(tokenStart, next) === "from") {
        const imported = readQuoted(source, skipTrivia(source, next));
        if (imported) return { value: imported.value, tokenStart, end: imported.end };
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
  return undefined;
}

/** One lexical pass per file collecting every fact the boundary rules inspect. */
function scanFile(source) {
  const imports = [];
  const exportClauses = [];
  let spawnCall = false;
  let processKillCall = false;
  let memberKillCall = false;

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

    const importKeyword = source.startsWith("import", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 6]);
    if (importKeyword) {
      let next = skipTrivia(source, cursor + 6);
      if (source[next] === ".") {
        cursor += 6;
        continue;
      }
      if (source[next] === "(") {
        next = skipTrivia(source, next + 1);
        const imported = readQuoted(source, next);
        if (imported) imports.push({ specifier: imported.value, clause: "", isImport: true });
        cursor = imported?.end ?? next + 1;
        continue;
      }
      const sideEffect = readQuoted(source, next);
      if (sideEffect) {
        imports.push({ specifier: sideEffect.value, clause: "", isImport: true });
        cursor = sideEffect.end;
        continue;
      }
      const declarationStart = next;
      const from = readFromClause(source, next);
      if (from) {
        imports.push({ specifier: from.value, clause: source.slice(declarationStart, from.tokenStart), isImport: true });
        cursor = from.end;
      } else {
        cursor += 6;
      }
      continue;
    }

    const exportKeyword = source.startsWith("export", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 6]);
    if (exportKeyword) {
      let next = skipTrivia(source, cursor + 6);
      if (source.startsWith("type", next) && !isIdentifierPart(source[next + 4])) {
        next = skipTrivia(source, next + 4);
      }
      if (source[next] === "{") {
        let braceEnd = next + 1;
        let depth = 1;
        while (braceEnd < source.length && depth > 0) {
          if (source[braceEnd] === "{") depth += 1;
          else if (source[braceEnd] === "}") depth -= 1;
          braceEnd += 1;
        }
        const names = clauseNames(source.slice(next + 1, braceEnd - 1));
        const from = readFromClause(source, braceEnd);
        if (from) {
          imports.push({ specifier: from.value, clause: source.slice(skipTrivia(source, cursor + 6), from.tokenStart), isImport: false });
          exportClauses.push({ names, fromSpecifier: from.value });
          cursor = from.end;
        } else {
          exportClauses.push({ names, fromSpecifier: undefined });
          cursor = braceEnd;
        }
        continue;
      }
      if (source[next] === "*") {
        const from = readFromClause(source, next + 1);
        if (from) {
          imports.push({ specifier: from.value, clause: source.slice(skipTrivia(source, cursor + 6), from.tokenStart), isImport: false });
          cursor = from.end;
        } else {
          cursor = next + 1;
        }
        continue;
      }
      cursor += 6;
      continue;
    }

    if (source.startsWith("require", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 7])) {
      let next = skipTrivia(source, cursor + 7);
      if (source[next] === "(") {
        next = skipTrivia(source, next + 1);
        const required = readQuoted(source, next);
        if (required) imports.push({ specifier: required.value, clause: "require", isImport: false });
        cursor = required?.end ?? next + 1;
        continue;
      }
    }

    if (source.startsWith("spawn", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 5])) {
      if (source[skipTrivia(source, cursor + 5)] === "(") spawnCall = true;
    } else if (source.startsWith("process.kill", cursor) && !isIdentifierPart(source[cursor - 1]) && !isIdentifierPart(source[cursor + 12])) {
      if (source[skipTrivia(source, cursor + 12)] === "(") processKillCall = true;
    } else if (character === "." || source.startsWith("?.", cursor)) {
      const optional = source.startsWith("?.", cursor);
      const memberStart = cursor + (optional ? 2 : 1);
      if (source.startsWith("kill", memberStart) && !isIdentifierPart(source[memberStart - 1]) && !isIdentifierPart(source[memberStart + 4])) {
        if (source[skipTrivia(source, memberStart + 4)] === "(") {
          let objectEnd = cursor;
          while (objectEnd > 0 && /\s/.test(source[objectEnd - 1])) objectEnd -= 1;
          let objectStart = objectEnd;
          while (objectStart > 0 && isIdentifierPart(source[objectStart - 1])) objectStart -= 1;
          if (source.slice(objectStart, objectEnd) !== "process") memberKillCall = true;
        }
      }
    }

    cursor += 1;
  }

  return { imports, exportClauses, spawnCall, processKillCall, memberKillCall };
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
  const { imports, exportClauses, spawnCall, processKillCall, memberKillCall } = scanFile(source);

  for (const imported of imports) {
    const { specifier, clause } = imported;
    const telegram = isLocalModule(specifier, "telegram") || isPackage(specifier, "grammy");
    const agent = isLocalModule(specifier, "agent");
    const scheduler = isLocalModule(specifier, "scheduler");
    const sandbox = isLocalModule(specifier, "sandbox");
    const childProcess = specifier === "child_process" || specifier === "node:child_process" || specifier.endsWith("/child_process");
    const importedSpawn = /\bspawn\b/.test(clause);
    const importedAgentBoundary = /\bAgent(?:Manager|Worker)\b/.test(clause);

    if (layer === "sandbox" && (telegram || agent || scheduler || isPackage(specifier, "@earendil-works/pi-coding-agent"))) {
      addViolation(violations, file, specifier, "sandbox may not import Telegram, agent, scheduler, or pi-coding-agent modules");
    }
    if (layer === "agent" && (telegram || scheduler)) {
      addViolation(violations, file, specifier, "agent may not import grammY, Telegram, or scheduler modules");
    }
    if (layer === "config" && (isLocalModule(specifier, "agent") || isLocalModule(specifier, "telegram") || isLocalModule(specifier, "sandbox") || isLocalModule(specifier, "scheduler") || isLocalModule(specifier, "queue") || isLocalModule(specifier, "index") || isPackage(specifier, "grammy") || isPackage(specifier, "@earendil-works/pi-coding-agent"))) {
      addViolation(violations, file, specifier, "config may not import runtime or transport modules");
    }
    if (layer === "scheduler" && (telegram || importedAgentBoundary || sandbox)) {
      addViolation(violations, file, specifier, "scheduler may not import grammY, agent, or sandbox modules");
    }
    if (layer !== "sandbox" && childProcess) {
      addViolation(violations, file, specifier, "child_process may only be imported by sandbox.ts");
    }
    if (layer !== "sandbox" && importedSpawn && !childProcess) {
      addViolation(violations, file, specifier, "spawn may only be used by sandbox.ts");
    }
  }

  if (layer !== "sandbox") {
    const sandboxLocalNames = new Set();
    for (const imported of imports) {
      if (imported.isImport && isLocalModule(imported.specifier, "sandbox")) {
        for (const name of clauseNames(imported.clause)) sandboxLocalNames.add(name);
      }
    }
    for (const exported of exportClauses) {
      if (exported.fromSpecifier !== undefined) {
        if (isLocalModule(exported.fromSpecifier, "sandbox")) {
          for (const name of exported.names) {
            addViolation(violations, file, name, "sandbox capability may not be re-exported");
          }
        }
      } else {
        for (const name of exported.names) {
          if (sandboxLocalNames.has(name)) {
            addViolation(violations, file, name, "sandbox capability may not be re-exported");
          }
        }
      }
    }
  }

  if (layer !== "sandbox" && spawnCall) {
    addViolation(violations, file, "spawn", "spawn may only be used by sandbox.ts");
  }
  if (layer !== "sandbox" && processKillCall) {
    addViolation(violations, file, "process.kill", "process-control calls may only be used by sandbox.ts");
  }
  if (layer !== "sandbox" && memberKillCall) {
    addViolation(violations, file, "ChildProcess.kill", "process-control calls may only be used by sandbox.ts");
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
