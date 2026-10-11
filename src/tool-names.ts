import { createHash } from "node:crypto"

export type ToolNames = Map<string, { name: string; namespace?: string }>

export function createToolNames(reservedNames: Set<string>) {
  const toolNames: ToolNames = new Map()
  const aliases = new Map<string, string>()
  function name(name: string, namespace?: string) {
    const key = JSON.stringify([namespace ?? null, name])
    const existing = aliases.get(key)
    if (existing !== undefined) return existing
    const preferred = namespace === undefined ? name : `${namespace}__${name}`
    let alias = preferred
    let attempt = 0
    while (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || toolNames.has(alias) ||
      (namespace !== undefined && reservedNames.has(alias))) {
      const hash = createHash("sha256").update(JSON.stringify([key, attempt++])).digest("hex").slice(0, 16)
      alias = `${preferred.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 47)}_${hash}`
    }
    aliases.set(key, alias)
    toolNames.set(alias, { name, ...(namespace === undefined ? {} : { namespace }) })
    return alias
  }
  return { toolNames, name }
}
