import path from "node:path"
import { chmod, lstat, mkdir, symlink, unlink } from "node:fs/promises"

export async function install(projectRoot: string, prefix = process.env.PREFIX || "/usr/local") {
  const binary = path.resolve(projectRoot, "dist/codex-copilot-bridge")
  const bin = path.resolve(prefix, "bin")
  const links = ["codex-copilot-bridge", "ghcodex", "claudex"].map(name => path.join(bin, name))
  await chmod(binary, 0o755)
  // Refuse to replace files or directories belonging to another installation.
  for (const link of links) {
    const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${link}`)
  }
  await mkdir(bin, { recursive: true })
  for (const link of links) {
    await unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await symlink(binary, link)
    console.log(`installed ${link} -> ${binary}`)
  }
}

if (import.meta.main) {
  try {
    await install(path.resolve(import.meta.dir, ".."))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error("Build first; choose a writable PREFIX (default: /usr/local).")
    process.exitCode = 1
  }
}
