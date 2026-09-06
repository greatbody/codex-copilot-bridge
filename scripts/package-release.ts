import path from "node:path"
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"

export const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
} as const

export type Platform = keyof typeof targets

export function validatePlatform(platform: string): Platform {
  if (!Object.hasOwn(targets, platform)) {
    throw new Error(`Unsupported platform: ${platform}. Expected one of: ${Object.keys(targets).join(", ")}`)
  }
  return platform as Platform
}

export function validateVersion(version: unknown): string {
  if (typeof version !== "string" || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable version (major.minor.patch), got: ${version}`)
  }
  return version
}

export async function packageRelease(root: string, platformName = `${process.platform}-${process.arch}`) {
  const platform = validatePlatform(platformName)
  const version = validateVersion((await Bun.file(path.join(root, "package.json")).json()).version)
  const name = `codex-copilot-bridge-v${version}-${platform}`
  const dist = path.join(root, "dist")
  const binary = path.join(dist, platform, "codex-copilot-bridge")
  const archive = path.join(dist, `${name}.tar.gz`)
  await mkdir(path.dirname(binary), { recursive: true })
  const build = Bun.spawn([process.execPath, "build", "src/cli.ts", "--compile", `--target=${targets[platform]}`, "--outfile", binary], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  })
  if (await build.exited !== 0) throw new Error(`Build failed for ${platform}`)
  await chmod(binary, 0o755)

  const temporary = await mkdtemp(path.join(dist, ".release-"))
  try {
    const staging = path.join(temporary, name)
    await mkdir(path.join(staging, "bin"), { recursive: true })
    await copyFile(binary, path.join(staging, "bin", "codex-copilot-bridge"))
    for (const alias of ["ghcodex", "claudex"]) {
      await symlink("codex-copilot-bridge", path.join(staging, "bin", alias))
    }
    for (const file of ["README.md", "LICENSE"]) await copyFile(path.join(root, file), path.join(staging, file))
    const tar = Bun.spawn(["tar", "-czf", path.join(temporary, "release.tar.gz"), "-C", temporary, name], {
      stdout: "inherit", stderr: "inherit",
    })
    if (await tar.exited !== 0) throw new Error(`Archive creation failed for ${platform}`)
    await copyFile(path.join(temporary, "release.tar.gz"), archive)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return archive
}

if (import.meta.main) {
  try {
    if (Bun.argv.length > 3) throw new Error("usage: bun run scripts/package-release.ts [platform]")
    console.log(await packageRelease(path.resolve(import.meta.dir, ".."), Bun.argv[2]))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
