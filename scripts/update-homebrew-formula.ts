import path from "node:path"

const [formulaPath, version, sha256] = Bun.argv.slice(2)

if (!formulaPath || !version || !sha256) {
  console.error("usage: bun run scripts/update-homebrew-formula.ts <formula-path> <version> <sha256>")
  process.exit(1)
}

const file = path.resolve(formulaPath)
const asset = `codex-copilot-bridge-v${version}-darwin-x64.tar.gz`
const url = `https://github.com/greatbody/codex-copilot-bridge/releases/download/v${version}/${asset}`
const current = await Bun.file(file).text()
const next = current
  .replace(/^  url ".*"$/m, `  url "${url}"`)
  .replace(/^  version ".*"$/m, `  version "${version}"`)
  .replace(/^  sha256 ".*"$/m, `  sha256 "${sha256}"`)

if (next === current) {
  console.error(`formula did not change: ${file}`)
  process.exit(1)
}

await Bun.write(file, next)
