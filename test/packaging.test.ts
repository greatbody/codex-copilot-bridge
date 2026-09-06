import { afterEach, expect, test } from "bun:test"
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { packageRelease, targets, validatePlatform, validateVersion } from "../scripts/package-release"
import { generateFormula } from "../scripts/update-homebrew-formula"
import { packageNpm } from "../scripts/package-npm"
import { install } from "../scripts/install"

const root = path.resolve(import.meta.dir, "..")
const host = `${process.platform}-${process.arch}`
const temporary: string[] = []
const { selectPlatform } = createRequire(import.meta.url)("../npm/bin/launcher.cjs")

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  await mkdir(path.join(root, "dist"), { recursive: true })
  const directory = await mkdtemp(path.join(root, "dist", ".packaging-test-"))
  temporary.push(directory)
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: "private-source-repository", private: true, version: "1.2.3", description: "Test bridge",
  }))
  for (const file of ["LICENSE", "README.md"]) await copyFile(path.join(root, file), path.join(directory, file))
  await cp(path.join(root, "npm"), path.join(directory, "npm"), { recursive: true })
  return directory
}

async function fakeBinary(directory: string, platform = host, program = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(23)") {
  const binary = path.join(directory, "dist", platform, "codex-copilot-bridge")
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, `#!/usr/bin/env node\n${program}\n`, { mode: 0o755 })
  return binary
}

async function npmFixture(program?: string) {
  const directory = await fixture()
  await fakeBinary(directory, host, program)
  const [main, platform] = await packageNpm(directory, [host])
  const scope = path.join(main, "node_modules", "@greatbody")
  await mkdir(scope, { recursive: true })
  await symlink(platform, path.join(scope, `codex-copilot-bridge-${host}`))
  return main
}

test("release targets use explicit baseline x64 and reject unknown/path traversal inputs", () => {
  expect(targets).toEqual({
    "darwin-arm64": "bun-darwin-arm64", "darwin-x64": "bun-darwin-x64-baseline",
    "linux-x64": "bun-linux-x64-baseline", "linux-arm64": "bun-linux-arm64",
  })
  for (const value of ["windows-x64", "linux-x64-musl", "../darwin-x64", "constructor", ""]) {
    expect(() => validatePlatform(value)).toThrow("Unsupported platform")
  }
  for (const version of ["v1.2.3", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.3\n", "../1.2.3", 123]) {
    expect(() => validateVersion(version)).toThrow("stable version")
  }
  expect(validateVersion("0.10.123")).toBe("0.10.123")
})

test("invalid release platform fails before attempting a build", async () => {
  await expect(packageRelease("/nonexistent-packaging-fixture", "windows-x64")).rejects.toThrow("Unsupported platform")
})

test("release archive contains one root, executable unified CLI, relative aliases and legal files", async () => {
  const directory = await fixture()
  await mkdir(path.join(directory, "src"))
  await writeFile(path.join(directory, "src", "cli.ts"), 'console.log("fixture CLI 1.2.3")\n')
  const archive = await packageRelease(directory)
  const expectedName = `codex-copilot-bridge-v1.2.3-${host}`
  expect(archive).toBe(path.join(directory, "dist", `${expectedName}.tar.gz`))
  const extracted = path.join(directory, "extracted")
  await mkdir(extracted)
  const tar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" })
  expect(tar.status).toBe(0)
  const staging = path.join(extracted, expectedName)
  for (const alias of ["ghcodex", "claudex"]) {
    expect(await readlink(path.join(staging, "bin", alias))).toBe("codex-copilot-bridge")
  }
  for (const file of ["LICENSE", "README.md"]) expect(await Bun.file(path.join(staging, file)).exists()).toBe(true)
  expect((await lstat(path.join(staging, "bin", "codex-copilot-bridge"))).mode & 0o111).toBe(0o111)
  const result = spawnSync(path.join(directory, "dist", host, "codex-copilot-bridge"), ["--version"], { encoding: "utf8" })
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe("fixture CLI 1.2.3")
}, 60_000)

const checksums = Object.keys(targets).map((platform, index) =>
  `${String(index + 1).repeat(64)}  codex-copilot-bridge-v1.2.3-${platform}.tar.gz`).join("\n")

test("Homebrew formula maps all four checksums and uses credential-free smoke tests", () => {
  const formula = generateFormula("1.2.3", checksums)
  expect(formula).toContain("class CodexCopilotBridge < Formula")
  expect(formula).toContain("on_macos do")
  expect(formula).toContain("on_linux do")
  for (const [index, platform] of Object.keys(targets).entries()) {
    expect(formula).toContain(`codex-copilot-bridge-v1.2.3-${platform}.tar.gz"\n      sha256 "${String(index + 1).repeat(64)}"`)
  }
  expect(formula).toContain('bin.install_symlink "codex-copilot-bridge" => "ghcodex"')
  expect(formula).toContain('bin.install_symlink "codex-copilot-bridge" => "claudex"')
  expect(formula).toContain("codex-copilot-bridge --version")
  expect(formula).toContain("codex-copilot-bridge --help")
  expect(formula).not.toContain("codex-copilot-bridge doctor")
  expect(formula).not.toContain("codex-copilot-bridge models")
  expect(generateFormula("1.2.3", checksums.replaceAll("  codex", " *codex"))).toBe(formula)
})

test("Homebrew rejects invalid versions, hashes, missing and duplicate assets", () => {
  expect(() => generateFormula("1.2.3-rc.1", checksums)).toThrow("stable version")
  expect(() => generateFormula("1.2.3", checksums.replace("1".repeat(64), "z".repeat(64)))).toThrow("Invalid SHA256SUMS")
  expect(() => generateFormula("1.2.3", checksums.split("\n").slice(1).join("\n"))).toThrow("Missing SHA256SUMS")
  expect(() => generateFormula("1.2.3", checksums + "\n" + checksums.split("\n")[0])).toThrow("Duplicate SHA256SUMS")
  expect(() => generateFormula("1.2.3", checksums.replaceAll("v1.2.3", "v1.2.4"))).toThrow("Missing SHA256SUMS")
})

test("npm packages have public metadata, exact optional dependencies and platform restrictions", async () => {
  const directory = await fixture()
  for (const platform of Object.keys(targets)) await fakeBinary(directory, platform)
  const [main, ...platforms] = await packageNpm(directory)
  expect(platforms).toHaveLength(4)
  const manifest = await Bun.file(path.join(main, "package.json")).json()
  expect(manifest.name).toBe("codex-copilot-bridge")
  expect(manifest.private).toBeUndefined()
  expect(manifest.scripts).toBeUndefined()
  expect(manifest.publishConfig.access).toBe("public")
  expect(manifest.engines.node).toBe(">=22.14.0")
  expect(Object.keys(manifest.bin)).toEqual(["codex-copilot-bridge", "ghcodex", "claudex"])
  expect(manifest.optionalDependencies).toEqual(Object.fromEntries(Object.keys(targets).map(platform => [
    `@greatbody/codex-copilot-bridge-${platform}`, "1.2.3",
  ])))
  expect(manifest.files).toEqual(["bin", "LICENSE", "README.md"])
  for (const destination of platforms) {
    const platform = path.basename(destination)
    const [os, cpu] = platform.split("-")
    const payload = await Bun.file(path.join(destination, "package.json")).json()
    expect(payload.name).toBe(`@greatbody/codex-copilot-bridge-${platform}`)
    expect(payload.version).toBe(manifest.version)
    expect(payload.os).toEqual([os])
    expect(payload.cpu).toEqual([cpu])
    expect(payload.libc).toEqual(os === "linux" ? ["glibc"] : undefined)
    expect(payload.files).toEqual(["bin/codex-copilot-bridge", "LICENSE", "README.md"])
    expect(await Bun.file(path.join(destination, "bin", "codex-copilot-bridge")).text()).toBe(
      await Bun.file(path.join(directory, "dist", platform, "codex-copilot-bridge")).text())
  }
})

test("npm rejects invalid targets and missing binaries before writing output", async () => {
  const directory = await fixture()
  await expect(packageNpm(directory, ["../escape"])).rejects.toThrow("Unsupported platform")
  await expect(packageNpm(directory, [host])).rejects.toThrow("Missing or non-executable binary")
  const binary = await fakeBinary(directory)
  await chmod(binary, 0o644)
  await expect(packageNpm(directory, [host])).rejects.toThrow("Missing or non-executable binary")
  expect(await Bun.file(path.join(directory, "dist", "npm", "codex-copilot-bridge", "package.json")).exists()).toBe(false)
})

test("npm tarballs install offline and expose all three executable commands", async () => {
  const directory = await fixture()
  await fakeBinary(directory)
  const [main, platform] = await packageNpm(directory, [host])
  const archives: string[] = []
  const npmOptions = ["--offline", "--cache", path.join(directory, "cache"), "--ignore-scripts"]
  for (const source of [platform, main]) {
    const packed = spawnSync("npm", ["pack", source, "--json", "--pack-destination", directory, ...npmOptions], {
      cwd: directory, encoding: "utf8",
    })
    expect(packed.status).toBe(0)
    const [info] = JSON.parse(packed.stdout)
    const filenames = info.files.map((file: { path: string }) => file.path)
    expect(filenames).toContain("LICENSE")
    expect(filenames).toContain("README.md")
    expect(filenames).toContain("package.json")
    expect(filenames.every((file: string) => ["LICENSE", "README.md", "package.json"].includes(file) || file.startsWith("bin/"))).toBe(true)
    expect(filenames).toHaveLength(source === main ? 7 : 4)
    archives.push(path.join(directory, info.filename))
  }
  const consumer = path.join(directory, "consumer")
  await mkdir(consumer)
  await writeFile(path.join(consumer, "package.json"), '{"name":"offline-smoke","private":true}')
  const installed = spawnSync("npm", ["install", ...archives, "--include=optional", "--no-audit", "--no-fund", ...npmOptions], {
    cwd: consumer, encoding: "utf8",
  })
  expect(installed.status).toBe(0)
  for (const [name, args] of [["codex-copilot-bridge", []], ["ghcodex", ["ghcodex"]], ["claudex", ["claudex"]]] as const) {
    const result = spawnSync(path.join(consumer, "node_modules", ".bin", name), ["--test-arg"], { encoding: "utf8" })
    expect(result.status).toBe(23)
    expect(JSON.parse(result.stdout)).toEqual([...args, "--test-arg"])
  }
  const npx = spawnSync("npm", ["exec", "--offline", "--cache", path.join(directory, "cache"), "--no", "--", "ghcodex", "--test-npx"], {
    cwd: consumer, encoding: "utf8",
  })
  expect(npx.status).toBe(23)
  expect(JSON.parse(npx.stdout)).toEqual(["ghcodex", "--test-npx"])
}, 30_000)

test("Node launcher rejects unsupported architectures and Linux musl", () => {
  expect(selectPlatform("darwin", "arm64")).toBe("darwin-arm64")
  expect(selectPlatform("linux", "x64", "2.31")).toBe("linux-x64")
  expect(() => selectPlatform("linux", "arm64")).toThrow("glibc")
  expect(() => selectPlatform("win32", "x64")).toThrow("Unsupported platform")
  expect(() => selectPlatform("linux", "ia32", "2.31")).toThrow("Unsupported platform")
})

test("Node launchers explicitly dispatch wrapper modes, preserve args and propagate exit code", async () => {
  const main = await npmFixture()
  for (const [name, mode] of [["codex-copilot-bridge", []], ["ghcodex", ["ghcodex"]], ["claudex", ["claudex"]]] as const) {
    const args = ["--flag", "arg with spaces", "", "$(not-a-shell)"]
    const result = spawnSync("node", [path.join(main, "bin", `${name}.cjs`), ...args], { encoding: "utf8" })
    expect(result.status).toBe(23)
    expect(JSON.parse(result.stdout)).toEqual([...mode, ...args])
    expect(result.stderr).toBe("")
  }
  const noArgs = spawnSync("node", [path.join(main, "bin", "codex-copilot-bridge.cjs")], { encoding: "utf8" })
  expect(JSON.parse(noArgs.stdout)).toEqual([])
})

test("Node launcher reports missing optional dependency without downloading", async () => {
  const directory = await fixture()
  const result = spawnSync("node", [path.join(directory, "npm", "bin", "codex-copilot-bridge.cjs")], { encoding: "utf8" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("optional dependencies enabled")
})

test("Node launcher reports executable spawn errors", async () => {
  const main = await npmFixture()
  await chmod(path.join(main, "node_modules", "@greatbody", `codex-copilot-bridge-${host}`, "bin", "codex-copilot-bridge"), 0o644)
  const result = spawnSync("node", [path.join(main, "bin", "codex-copilot-bridge.cjs")], { encoding: "utf8" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("Cannot start")
})

test("Node launcher mirrors a child's terminating signal", async () => {
  const main = await npmFixture('process.kill(process.pid, "SIGTERM")')
  const result = spawnSync("node", [path.join(main, "bin", "codex-copilot-bridge.cjs")], { encoding: "utf8" })
  expect(result.signal).toBe("SIGTERM")
})

test("Node launcher forwards termination to its child", async () => {
  const main = await npmFixture('process.on("SIGTERM", () => process.exit(42)); console.log("READY"); setInterval(() => {}, 1000)')
  const child = spawn("node", [path.join(main, "bin", "codex-copilot-bridge.cjs")], { stdio: ["ignore", "pipe", "pipe"] })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 3000)
  try {
    child.stdout.on("data", chunk => {
      if (chunk.toString().includes("READY")) child.kill("SIGTERM")
    })
    const result = await new Promise<{ code: number | null, signal: string | null }>((resolve, reject) => {
      child.on("error", reject)
      child.on("exit", (code, signal) => resolve({ code, signal }))
    })
    expect(result).toEqual({ code: 42, signal: null })
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
}, 5000)

test("source installer links all commands to one binary within an isolated PREFIX", async () => {
  const directory = await fixture()
  await mkdir(path.join(directory, "dist"))
  await writeFile(path.join(directory, "dist", "codex-copilot-bridge"), "fixture binary")
  const prefix = path.join(directory, "prefix")
  await install(directory, prefix)
  await install(directory, prefix)
  for (const name of ["codex-copilot-bridge", "ghcodex", "claudex"]) {
    expect(await readlink(path.join(prefix, "bin", name))).toBe(path.join(directory, "dist", "codex-copilot-bridge"))
  }
})

test("source installer refuses to overwrite another application's regular file", async () => {
  const directory = await fixture()
  await mkdir(path.join(directory, "dist"))
  await writeFile(path.join(directory, "dist", "codex-copilot-bridge"), "fixture binary")
  const prefix = path.join(directory, "prefix")
  await mkdir(path.join(prefix, "bin"), { recursive: true })
  await writeFile(path.join(prefix, "bin", "ghcodex"), "existing application")
  await expect(install(directory, prefix)).rejects.toThrow("Refusing to replace non-symlink")
  expect(await Bun.file(path.join(prefix, "bin", "ghcodex")).text()).toBe("existing application")
})
