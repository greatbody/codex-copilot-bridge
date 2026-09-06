import path from "node:path"
import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { targets, validatePlatform, validateVersion, type Platform } from "./package-release"

export async function packageNpm(root: string, requestedPlatforms: string[] = []) {
  const platforms = requestedPlatforms.length
    ? [...new Set(requestedPlatforms.map(validatePlatform))]
    : Object.keys(targets) as Platform[]
  const source = await Bun.file(path.join(root, "package.json")).json()
  const version = validateVersion(source.version)
  // Validate all inputs before replacing any previously generated package.
  for (const platform of platforms) {
    const binary = path.join(root, "dist", platform, "codex-copilot-bridge")
    try {
      await access(binary, constants.R_OK | constants.X_OK)
    } catch {
      throw new Error(`Missing or non-executable binary: ${binary}. Run scripts/package-release.ts ${platform} first.`)
    }
  }
  const output = path.join(root, "dist", "npm")
  const metadata = {
    version,
    description: source.description,
    license: "MIT",
    repository: source.repository,
    homepage: source.homepage,
    bugs: source.bugs,
    engines: { node: ">=22.14.0" },
    publishConfig: { access: "public" },
  }
  const main = path.join(output, "codex-copilot-bridge")
  await rm(main, { recursive: true, force: true })
  await mkdir(main, { recursive: true })
  const bins = {
    "codex-copilot-bridge": "bin/codex-copilot-bridge.cjs",
    ghcodex: "bin/ghcodex.cjs",
    claudex: "bin/claudex.cjs",
  }
  await mkdir(path.join(main, "bin"))
  for (const file of [...Object.values(bins), "bin/launcher.cjs"]) {
    await copyFile(path.join(root, "npm", file), path.join(main, file))
    await chmod(path.join(main, file), file === "bin/launcher.cjs" ? 0o644 : 0o755)
  }
  for (const file of ["LICENSE", "README.md"]) {
    await copyFile(path.join(root, file === "README.md" ? "npm" : "", file), path.join(main, file))
  }
  await Bun.write(path.join(main, "package.json"), JSON.stringify({
    ...metadata,
    name: "codex-copilot-bridge",
    bin: bins,
    files: ["bin", "LICENSE", "README.md"],
    optionalDependencies: Object.fromEntries(Object.keys(targets).map(platform => [
      `@greatbody/codex-copilot-bridge-${platform}`, version,
    ])),
  }, null, 2) + "\n")

  for (const platform of platforms) {
    const destination = path.join(output, platform)
    await rm(destination, { recursive: true, force: true })
    await mkdir(path.join(destination, "bin"), { recursive: true })
    const binary = path.join(destination, "bin", "codex-copilot-bridge")
    await copyFile(path.join(root, "dist", platform, "codex-copilot-bridge"), binary)
    await chmod(binary, 0o755)
    for (const file of ["LICENSE", "README.md"]) {
      await copyFile(path.join(root, file === "README.md" ? "npm" : "", file), path.join(destination, file))
    }
    const [os, cpu] = platform.split("-")
    await Bun.write(path.join(destination, "package.json"), JSON.stringify({
      ...metadata,
      name: `@greatbody/codex-copilot-bridge-${platform}`,
      os: [os],
      cpu: [cpu],
      ...(os === "linux" ? { libc: ["glibc"] } : {}),
      files: ["bin/codex-copilot-bridge", "LICENSE", "README.md"],
    }, null, 2) + "\n")
  }
  return [main, ...platforms.map(platform => path.join(output, platform))]
}

if (import.meta.main) {
  try {
    const directories = await packageNpm(path.resolve(import.meta.dir, ".."), Bun.argv.slice(2))
    for (const directory of directories) console.log(directory)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
