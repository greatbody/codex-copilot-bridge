import path from "node:path"

const projectRoot = path.resolve(import.meta.dir, "..")
const binary = path.join(projectRoot, "dist/codex-copilot-bridge")
const link = "/usr/local/bin/codex-copilot-bridge"
const ghcodex = path.join(projectRoot, "bin/ghcodex")
const ghcodexLink = "/usr/local/bin/ghcodex"
const claudexLink = "/usr/local/bin/claudex"

await Bun.$`chmod +x ${binary}`
await Bun.$`chmod +x ${ghcodex}`

try {
  await Bun.$`ln -sfn ${binary} ${link}`
  await Bun.$`ln -sfn ${ghcodex} ${ghcodexLink}`
  await Bun.$`ln -sfn ${ghcodex} ${claudexLink}`
} catch (error) {
  console.error(`failed to link ${link}, ${ghcodexLink}, or ${claudexLink}`)
  console.error("If this is a permission issue, run:")
  console.error(`  sudo ln -sfn ${binary} ${link}`)
  console.error(`  sudo ln -sfn ${ghcodex} ${ghcodexLink}`)
  console.error(`  sudo ln -sfn ${ghcodex} ${claudexLink}`)
  throw error
}

console.log(`installed ${link} -> ${binary}`)
console.log(`installed ${ghcodexLink} -> ${ghcodex}`)
console.log(`installed ${claudexLink} -> ${ghcodex}`)
