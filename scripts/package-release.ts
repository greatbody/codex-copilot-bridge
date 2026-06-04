import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const version = (await Bun.file(path.join(root, "package.json")).json()).version as string
const target = `codex-copilot-bridge-v${version}-darwin-x64`
const staging = path.join(root, "dist", target)
const archive = path.join(root, "dist", `${target}.tar.gz`)

await Bun.$`rm -rf ${staging} ${archive}`
await Bun.$`bun run build`
await Bun.$`mkdir -p ${staging}/bin`
await Bun.$`cp ${path.join(root, "dist", "codex-copilot-bridge")} ${staging}/bin/codex-copilot-bridge`
await Bun.$`cp ${path.join(root, "bin", "ghcodex")} ${staging}/bin/ghcodex`
await Bun.$`chmod +x ${staging}/bin/codex-copilot-bridge ${staging}/bin/ghcodex`
await Bun.$`tar -C ${path.join(root, "dist")} -czf ${archive} ${target}`

console.log(archive)
