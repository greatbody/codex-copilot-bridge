import assert from "node:assert/strict"
import { constants } from "node:fs"
import { access, copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { packageNpm } from "./package-npm"
import { validatePlatform, validateVersion } from "./package-release"

async function smoke() {
  if (Bun.argv.length !== 3) throw new Error("usage: bun run scripts/smoke.ts <platform>")
  const platform = validatePlatform(Bun.argv[2])
  const host = `${process.platform}-${process.arch}`
  assert.equal(platform, host, `Smoke target ${platform} does not match host ${host}`)
  const root = path.resolve(import.meta.dir, "..")
  const version = validateVersion((await Bun.file(path.join(root, "package.json")).json()).version)
  const name = `codex-copilot-bridge-v${version}-${platform}`
  const dist = path.join(root, "dist")
  const archive = path.join(dist, `${name}.tar.gz`)
  const binary = path.join(dist, platform, "codex-copilot-bridge")
  for (const file of [archive, binary]) {
    await access(file, file === binary ? constants.R_OK | constants.X_OK : constants.R_OK).catch(() => {
      throw new Error(`Missing or unreadable release input: ${file}. Smoke consumes existing artifacts; it does not compile them.`)
    })
  }
  const tools = Object.fromEntries(["tar", "gzip", "node", "npm", "npx"].map(name => {
    const executable = Bun.which(name)
    if (!executable) throw new Error(`${name} is required for smoke testing`)
    return [name, executable]
  }))
  const temporary = await mkdtemp(path.join(dist, ".smoke-"))
  try {
    const home = path.join(temporary, "home")
    const emptyBin = path.join(temporary, "empty-bin")
    const fakeBin = path.join(temporary, "fake-bin")
    const extracted = path.join(temporary, "extracted")
    const consumer = path.join(temporary, "consumer")
    for (const directory of [home, emptyBin, fakeBin, extracted, consumer]) await mkdir(directory)
    // An allowlist avoids inheriting credentials, npm config, runtime preloads or proxies.
    const env = {
      HOME: home,
      CODEX_HOME: path.join(home, "codex"),
      OPENCODE_AUTH_FILE: path.join(home, "absent-auth.json"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      TMPDIR: temporary,
      PATH: fakeBin,
      npm_config_cache: path.join(temporary, "npm-cache"),
      npm_config_userconfig: path.join(home, "npmrc"),
      npm_config_globalconfig: path.join(home, "global-npmrc"),
      npm_config_registry: "http://127.0.0.1:1",
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_script_shell: "/bin/sh",
    }
    function run(command: string, args: string[], cwd = temporary, overrides = {}, expectedCode = 0) {
      const result = spawnSync(command, args, {
        cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      if (result.error) throw result.error
      assert.equal(result.status, expectedCode,
        `${command} ${args.join(" ")} failed (${result.signal ?? result.status})\n${result.stdout}\n${result.stderr}`)
      return result.stdout.trim()
    }

    await symlink(tools.gzip, path.join(fakeBin, "gzip"))
    run(tools.tar, ["-xzf", archive, "-C", extracted])
    const archiveBin = path.join(extracted, name, "bin")
    for (const executable of [binary, path.join(archiveBin, "codex-copilot-bridge")]) {
      assert.equal(run(executable, ["--version"], extracted, { PATH: emptyBin }), `codex-copilot-bridge ${version}`)
      assert.match(run(executable, ["--help"], extracted, { PATH: emptyBin }), /Usage: codex-copilot-bridge/)
    }
    console.log("Native help/version passed without credentials or runtimes in PATH")

    await symlink(tools.node, path.join(fakeBin, "node"))
    await writeFile(path.join(fakeBin, "codex"), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(Number(process.env.MOCK_CODEX_EXIT || 0))\n', { mode: 0o755 })
    for (const alias of ["ghcodex", "claudex"]) {
      assert.deepEqual(JSON.parse(run(path.join(archiveBin, alias), ["--version"], extracted)), ["--version"])
      assert.deepEqual(JSON.parse(run(binary, [alias, "--version"], extracted)), ["--version"])
    }
    assert.deepEqual(JSON.parse(run(path.join(archiveBin, "ghcodex"), ["--version", "arg with spaces", ""], extracted,
      { MOCK_CODEX_EXIT: "23" }, 23)), ["--version", "arg with spaces", ""])
    console.log("Archive aliases forwarded to mock Codex, including its exit code")

    // Package the real existing binary in isolation, without replacing dist/npm.
    const packaging = path.join(temporary, "packaging")
    await mkdir(path.join(packaging, "dist", platform), { recursive: true })
    for (const file of ["package.json", "LICENSE"]) await copyFile(path.join(root, file), path.join(packaging, file))
    await cp(path.join(root, "npm"), path.join(packaging, "npm"), { recursive: true })
    await copyFile(binary, path.join(packaging, "dist", platform, "codex-copilot-bridge"))
    const packages = await packageNpm(packaging, [platform])
    const tarballs: string[] = []
    for (const directory of packages) {
      const [packed] = JSON.parse(run(tools.npm, ["pack", directory, "--offline", "--ignore-scripts", "--json", "--pack-destination", temporary]))
      tarballs.push(path.join(temporary, packed.filename))
    }
    await writeFile(path.join(consumer, "package.json"), '{"name":"bridge-smoke-consumer","private":true}\n')
    const installOptions = ["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--include=optional"]
    run(tools.npm, ["install", ...tarballs, ...installOptions], consumer)
    for (const runner of [tools.npm, tools.npx]) {
      const prefix = runner === tools.npm ? ["exec", "--offline", "--no", "--"] : ["--offline", "--no", "--"]
      assert.equal(run(runner, [...prefix, "codex-copilot-bridge", "--version"], consumer), `codex-copilot-bridge ${version}`)
      for (const alias of ["ghcodex", "claudex"]) {
        assert.deepEqual(JSON.parse(run(runner, [...prefix, alias, "--version"], consumer)), ["--version"])
      }
    }
    const prefix = path.join(temporary, "prefix")
    run(tools.npm, ["install", "--global", "--prefix", prefix, ...tarballs, ...installOptions])
    assert.equal(run(path.join(prefix, "bin", "codex-copilot-bridge"), ["--version"]), `codex-copilot-bridge ${version}`)
    for (const alias of ["ghcodex", "claudex"]) {
      assert.deepEqual(JSON.parse(run(path.join(prefix, "bin", alias), ["--version"])), ["--version"])
    }
    console.log(`Offline npm exec, npx --no and isolated global install passed for ${platform}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  smoke().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
