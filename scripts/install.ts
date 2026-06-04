import path from "node:path"

const projectRoot = path.resolve(import.meta.dir, "..")
const binary = path.join(projectRoot, "dist/codex-copilot-bridge")
const link = "/usr/local/bin/codex-copilot-bridge"
const ghcodex = path.join(projectRoot, "bin/ghcodex")
const ghcodexLink = "/usr/local/bin/ghcodex"

await Bun.$`chmod +x ${binary}`
await Bun.$`chmod +x ${ghcodex}`

try {
  await Bun.$`ln -sfn ${binary} ${link}`
  await Bun.$`ln -sfn ${ghcodex} ${ghcodexLink}`
} catch (error) {
  console.error(`failed to link ${link} or ${ghcodexLink}`)
  console.error("If this is a permission issue, run:")
  console.error(`  sudo ln -sfn ${binary} ${link}`)
  console.error(`  sudo ln -sfn ${ghcodex} ${ghcodexLink}`)
  throw error
}

console.log(`installed ${link} -> ${binary}`)
console.log(`installed ${ghcodexLink} -> ${ghcodex}`)
