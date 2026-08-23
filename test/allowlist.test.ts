import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAllowedFile } from "../src/allowlist.js";

describe("allowlist", () => {
  it("parses a bare array of chat IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, ".allowed.json"), JSON.stringify([875253145, 829096380, -5578614334]));

      const result = await readAllowedFile(workspace);
      expect(result).toEqual({
        status: "ready",
        chats: [-5578614334, 829096380, 875253145],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parses object with chats array and deduplicates IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, ".allowed.json"), JSON.stringify({
        version: 1,
        chats: [100, 200, 100, { chat_id: 300 }],
      }));

      const result = await readAllowedFile(workspace);
      expect(result).toEqual({
        status: "ready",
        chats: [100, 200, 300],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns status missing when file does not exist", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const result = await readAllowedFile(workspace);
    expect(result).toEqual({ status: "missing" });
  });

  it("returns status malformed on invalid JSON or invalid IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, ".allowed.json"), "[123, 'not-an-id']");
      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });

      await writeFile(path.join(workspace, ".allowed.json"), "{ invalid json");
      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });


  it("fails closed as malformed on a FIFO at allowed.json without blocking", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      execFileSync("mkfifo", [path.join(workspace, ".allowed.json")]);

      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed as malformed on a symlinked allowed.json without following it", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      await symlink("/etc/passwd", path.join(workspace, ".allowed.json"));

      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed as malformed on an oversized allowed.json", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(workspace, { recursive: true });
      const filePath = path.join(workspace, ".allowed.json");
      await writeFile(filePath, JSON.stringify([10]));
      await truncate(filePath, 1024 * 1024 + 1);

      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
