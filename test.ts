import assert from "node:assert/strict"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import plugin, { parseEvery, parseFeed, wanted } from "./index.ts"

// Parsing
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example &amp; Co</title><link>https://example.com</link>
<item><title><![CDATA[Release 1.2 <beta>]]></title><link>https://example.com/1.2</link><guid isPermaLink="false">r12</guid>
<pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Fixes &amp;amp; things&lt;/p&gt;</description></item>
<item><title>Release 1.1</title><link>https://example.com/1.1</link></item></channel></rss>`
const parsed = parseFeed(rss)
assert.equal(parsed.title, "Example & Co")
assert.equal(parsed.items.length, 2)
assert.deepEqual(parsed.items[0], { key: "r12", title: "Release 1.2 <beta>", link: "https://example.com/1.2", date: "Fri, 23 Oct 2026 10:00:00 GMT", summary: "Fixes & things" })
assert.equal(parsed.items[1].key, "https://example.com/1.1")

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Atom feed</title>
<link rel="self" href="https://example.com/feed.atom"/>
<entry><id>tag:example.com,2026:1</id><title>v2.0.0</title><link rel="alternate" type="text/html" href="https://example.com/v2"/>
<updated>2026-10-23T10:00:00Z</updated><content type="html">&lt;h1&gt;Breaking&lt;/h1&gt;</content></entry></feed>`
const parsedAtom = parseFeed(atom)
assert.equal(parsedAtom.title, "Atom feed")
assert.deepEqual(parsedAtom.items[0], { key: "tag:example.com,2026:1", title: "v2.0.0", link: "https://example.com/v2", date: "2026-10-23T10:00:00Z", summary: "Breaking" })
assert.throws(() => parseFeed("<html><body>nope</body></html>"))

assert.equal(parseEvery("30m"), 30 * 60_000)
assert.equal(parseEvery("1d2h"), 26 * 3600_000)
assert.throws(() => parseEvery("1m"))
assert.throws(() => parseEvery("soon"))

assert.equal(wanted({}, { key: "a", title: "v1.0-beta" }), true)
assert.equal(wanted({ include: "^v1\\." }, { key: "a", title: "V1.0" }), true)
assert.equal(wanted({ include: "^v1\\." }, { key: "a", title: "v2.0" }), false)
assert.equal(wanted({ exclude: "beta|rc" }, { key: "a", title: "v1.0-BETA" }), false)

// Plugin, with a mock context and fetch
let body = rss
let lastHeaders: Record<string, string> = {}
globalThis.fetch = (async (_url: string, init: any) => {
  lastHeaders = init.headers
  if (init.headers["if-none-match"] === `"${body.length}"`) return new Response(null, { status: 304 })
  return new Response(body, { status: 200, headers: { etag: `"${body.length}"` } })
}) as any

const store = new Map<string, unknown>()
const synthetic: any[] = []
const tools = new Map<string, any>()
const ctx = {
  options: {},
  storage: {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
    remove: async (key: string) => void store.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  },
  session: {
    get: async ({ sessionID }: { sessionID: string }) => (sessionID.startsWith("ses_ok") ? { id: sessionID } : Promise.reject(new Error("not found"))),
    synthetic: async (input: any) => {
      if (!input.sessionID.startsWith("ses_ok")) throw new Error("not found")
      synthetic.push(input)
    },
  },
  tool: { transform: async (callback: any) => callback({ add: (tool: any) => tools.set(tool.name, tool) }) },
  event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
}
const dispose = await plugin.setup(ctx)
const call = async (name: string, input: any, sessionID = "ses_ok1") => JSON.parse((await tools.get(name).execute(input, { sessionID })).content)

const sub = await call("feed_subscribe", { url: "https://example.com/feed", title: "Example releases" })
assert.equal(sub.title, "Example releases")
assert.equal(sub.feedTitle, "Example & Co")
assert.equal(sub.items, 2)
await assert.rejects(call("feed_subscribe", { url: "https://example.com/feed" }), /already subscribed/)
await assert.rejects(call("feed_subscribe", { url: "ftp://x" }))
await assert.rejects(call("feed_subscribe", { url: "relative/feed.xml" }))
await assert.rejects(call("feed_subscribe", { url: "https://example.com/feed", every: "1m" }, "ses_ok2"))
await assert.rejects(call("feed_subscribe", { url: "https://example.com/feed", exclude: "(" }, "ses_ok2"), /Invalid `exclude` pattern/)
const other = await call("feed_subscribe", { url: "https://example.com/feed" }, "ses_ok2") // another session may subscribe too
assert.equal((await call("feed_list", {})).length, 1)
assert.equal((await call("feed_list", { all: true })).length, 2)
await call("feed_unsubscribe", { id: other.id })

const due = async () => {
  for (const [key, value] of store) store.set(key, { ...(value as any), next: Date.now() - 1000 })
  dispose2?.()
  dispose2 = await plugin.setup(ctx) // setup ticks immediately
  await new Promise((resolve) => setTimeout(resolve, 50))
}
let dispose2: any
dispose()

// Unchanged feed: conditional GET, no delivery.
await due()
assert.equal(lastHeaders["if-none-match"], `"${rss.length}"`)
assert.equal(synthetic.length, 0)

// Two new items, delivered oldest first in one message.
body = rss.replace("<item>", `<item><title>Release 1.4</title><guid>r14</guid></item><item><title>Release 1.3</title><guid>r13</guid></item><item>`)
await due()
assert.equal(synthetic.length, 1)
const text = synthetic[0].text
assert.ok(text.startsWith(`[Feed ${sub.id}] 2 new items in "Example & Co"`))
assert.ok(text.indexOf("Release 1.3") < text.indexOf("Release 1.4"))
assert.ok(text.includes("Subscription title: Example releases"))
assert.ok(synthetic[0].resume === true && /^msg_[0-9a-f]{32}$/.test(synthetic[0].id))

// Same items again: nothing new.
body = body + " "
await due()
assert.equal(synthetic.length, 1)

// Filters: only matching items are delivered; the others are marked as seen.
const filtered = await call("feed_subscribe", { url: "https://example.com/feed", include: "^release", exclude: "-rc" }, "ses_ok3")
assert.equal(filtered.include, "^release")
assert.equal(filtered.exclude, "-rc")
body = body.replace("<item>", `<item><title>Release 1.6-rc1</title><guid>r16rc1</guid></item><item><title>Other 2.0</title><guid>o20</guid></item><item><title>Release 1.5</title><guid>r15</guid></item><item>`)
await due()
const forFiltered = synthetic.filter((input) => input.sessionID === "ses_ok3")
assert.equal(forFiltered.length, 1)
assert.ok(forFiltered[0].text.includes("1 new item in"))
assert.ok(forFiltered[0].text.includes("Release 1.5"))
assert.ok(!forFiltered[0].text.includes("Release 1.6-rc1") && !forFiltered[0].text.includes("Other 2.0"))
assert.equal(synthetic.length, 3) // ses_ok1 got all three
body = body + " "
await due()
assert.equal(synthetic.length, 3)
await call("feed_unsubscribe", { id: filtered.id })

// Local files: read again only when the modification time changes.
const dir = await mkdtemp(join(tmpdir(), "opencode-feeds-"))
const path = join(dir, "feed.xml")
await writeFile(path, rss)
const local = await call("feed_subscribe", { url: path }, "ses_ok4")
assert.equal(local.url, pathToFileURL(path).href)
assert.equal(local.items, 2)
await due()
assert.equal(synthetic.length, 3)
await writeFile(path, rss.replace("<item>", `<item><title>Local 1.0</title><guid>l10</guid></item><item>`))
const later = new Date(Date.now() + 60_000)
await utimes(path, later, later)
await due()
const forLocal = synthetic.filter((input) => input.sessionID === "ses_ok4")
assert.equal(forLocal.length, 1)
assert.ok(forLocal[0].text.includes("Local 1.0"))
await due()
assert.equal(synthetic.length, 4)

// A missing file is an empty feed: no error, and everything in it is new once it is created.
await rm(path)
await due()
assert.equal((await call("feed_list", {}, "ses_ok4"))[0].error, undefined)
assert.equal(synthetic.length, 4)
await writeFile(path, rss.replace("<item>", `<item><title>Local 2.0</title><guid>l20</guid></item><item>`))
await due()
assert.equal(synthetic.length, 5)
assert.ok(synthetic[4].text.includes("1 new item in") && synthetic[4].text.includes("Local 2.0"))
await call("feed_unsubscribe", { id: local.id })

// Subscribing to a file that doesn't exist yet, by a path under ~/.
const home = process.env.HOME
process.env.HOME = dir
const pending = await call("feed_subscribe", { url: "~/later.xml" }, "ses_ok5")
process.env.HOME = home
assert.equal(pending.url, pathToFileURL(join(dir, "later.xml")).href)
assert.equal(pending.items, 0)
await due()
assert.equal(synthetic.length, 5)
await writeFile(join(dir, "later.xml"), rss)
await due()
const forPending = synthetic.filter((input) => input.sessionID === "ses_ok5")
assert.equal(forPending.length, 1)
assert.ok(forPending[0].text.includes("2 new items in"))
await call("feed_unsubscribe", { id: pending.id })
await rm(dir, { recursive: true })

// Fetch error is recorded and cleared by a later success.
const okFetch = globalThis.fetch
globalThis.fetch = (async () => new Response("down", { status: 503, statusText: "Service Unavailable" })) as any
await due()
assert.equal((await call("feed_list", {}))[0].error, "HTTP 503 Service Unavailable")
globalThis.fetch = okFetch
await due()
assert.equal((await call("feed_list", {}))[0].error, undefined)

// Deleted session: dropped on the next delivery attempt.
store.set("feed:feed_orphan", { ...(store.get(`feed:${sub.id}`) as any), id: "feed_orphan", sessionID: "ses_gone", seen: [], etag: undefined })
await due()
assert.equal(store.has("feed:feed_orphan"), false)

await call("feed_unsubscribe", { id: sub.id })
assert.equal(store.size, 0)
dispose2()
console.log("ok")
