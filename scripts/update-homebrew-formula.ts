import path from "node:path"
import { targets, validateVersion, type Platform } from "./package-release"

export function generateFormula(version: string, checksums: string): string {
  validateVersion(version)
  const hashes = new Map<string, string>()
  for (const line of checksums.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line)
    if (!match) throw new Error(`Invalid SHA256SUMS entry: ${line}`)
    const [, hash, filename] = match
    if (hashes.has(filename)) throw new Error(`Duplicate SHA256SUMS entry: ${filename}`)
    hashes.set(filename, hash.toLowerCase())
  }
  const asset = (platform: Platform) => {
    const name = `codex-copilot-bridge-v${version}-${platform}.tar.gz`
    const hash = hashes.get(name)
    if (!hash) throw new Error(`Missing SHA256SUMS entry: ${name}`)
    return `      url "https://github.com/greatbody/codex-copilot-bridge/releases/download/v${version}/${name}"
      sha256 "${hash}"`
  }
  // Check every required asset before producing any formula output.
  for (const platform of Object.keys(targets) as Platform[]) asset(platform)
  return `class CodexCopilotBridge < Formula
  desc "Use GitHub Copilot models from Codex CLI"
  homepage "https://github.com/greatbody/codex-copilot-bridge"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${asset("darwin-arm64")}
    end
    on_intel do
${asset("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${asset("linux-arm64")}
    end
    on_intel do
${asset("linux-x64")}
    end
  end

  def install
    bin.install "bin/codex-copilot-bridge"
    bin.install_symlink "codex-copilot-bridge" => "ghcodex"
    bin.install_symlink "codex-copilot-bridge" => "claudex"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/codex-copilot-bridge --version")
    assert_match "Usage:", shell_output("#{bin}/codex-copilot-bridge --help")
    assert_predicate bin/"ghcodex", :executable?
    assert_predicate bin/"claudex", :executable?
  end
end
`
}

if (import.meta.main) {
  try {
    const [formulaPath, version, checksumsPath, ...extra] = Bun.argv.slice(2)
    if (!formulaPath || !version || !checksumsPath || extra.length) {
      throw new Error("usage: bun run scripts/update-homebrew-formula.ts <formula-path> <version> <checksums-path>")
    }
    const formula = generateFormula(version, await Bun.file(path.resolve(checksumsPath)).text())
    await Bun.write(path.resolve(formulaPath), formula)
    console.log(path.resolve(formulaPath))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
