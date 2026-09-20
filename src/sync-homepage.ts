/**
 * HOMEPAGE SYNC MODULE
 *
 * DropStack.tsx (the home screen accordion) and DropTransition.tsx (the
 * per-article Previous/Next component) both carry the same headline data,
 * because Framer's code components can't import shared data from one
 * another — each compiles as an independent module. Rather than leave
 * that duplication for a human to keep in sync by hand, this module
 * fetches the latest published items once and writes the same result
 * into both files, mechanically.
 *
 * SAFETY: fetches the ACTUAL CURRENT source of each target file from
 * Framer first and does a targeted replacement of just the headline
 * arrays, rather than regenerating the whole file from a locally-held
 * template. Both files are directly editable in Framer, so a local copy
 * could easily have drifted from what's actually live — patching the
 * real thing is safer than overwriting it blind.
 *
 * "Latest 3 published items per category" is the definition of
 * what a drop shows — not "items published today specifically."
 * On a normal day these are the same thing; on a day where a story
 * failed and only 2 published, this naturally falls back to showing
 * a slightly older third item rather than a broken or incomplete
 * drop. Worth knowing that's the deliberate tradeoff.
 *
 * STALENESS DATE (this revision): DropStack.tsx now carries a
 * `syncedDate` per drop, used to show a "not updated" state if a drop's
 * time has passed but this sync never actually ran for it that day (a
 * missed cron firing, a failed pipeline run — both have happened for
 * real). This date is computed in America/Chicago wall-clock time
 * specifically, NOT the pipeline server's own local time — GitHub
 * Actions runners run in UTC, and the frontend's staleness check runs
 * in the visitor's browser using Chicago-cycle logic. Using the
 * server's raw local time here would make every drop appear falsely
 * stale for most of the day, since UTC and Chicago dates disagree
 * except for a few overlapping hours. DropTransition.tsx has no
 * staleness UI and doesn't carry this field, so it's patched only into
 * DropStack.tsx, not looped across both target files like headlines are.
 *
 * Like everything else that writes content, this only updates the
 * PROJECT's code files — it does not go live until publishLiveSite()
 * is deliberately called, same deferred-until-published model as
 * every CMS write in this pipeline.
 */

import "dotenv/config"
import { connect, type Framer } from "framer-api"
import type { DropKey } from "./source.js"

const BLOG_COLLECTION_ID = "fKsETXCvz"

// Both files carry an identical `drops` array literal and get patched
// the same way for headlines. Add a filename here if a future component
// also needs this same headline data.
const TARGET_CODE_FILES = ["DropStack.tsx", "DropTransition.tsx"] as const

// Only DropStack.tsx has a syncedDate field to patch — see the
// STALENESS DATE note above for why this isn't just added to
// TARGET_CODE_FILES generically.
const STALENESS_TARGET_FILE = "DropStack.tsx"

const CYCLE_START_HOUR = 7

// Same cycle-date logic as DropStack.tsx's own cycleDateKey (hour < 7
// belongs to the previous day's cycle), but computed here against
// America/Chicago wall-clock time specifically rather than the
// pipeline server's local time. See the module comment above for why
// that distinction matters.
function currentCycleDateKey(): string {
    const chicagoNow = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    )
    const d = new Date(chicagoNow)
    if (chicagoNow.getHours() < CYCLE_START_HOUR) {
        d.setDate(d.getDate() - 1)
    }
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate()
}

// Reading a Blog item's Categories field back via framer-api returns the
// referenced Category item's SLUG, not its ID — confirmed by testing
// against real data. Writing by ID still works correctly (that's what
// publish.ts does, and it's been tagging articles correctly all along);
// this mapping is specifically for matching what comes back on READ.
const DROP_CATEGORY_SLUG: Record<DropKey, string> = {
    morning: "morning",
    afternoon: "afternoon",
    latenight: "late-night",
}

const TITLE_FIELD_ID = "vt_lJyMpu"
const CATEGORIES_FIELD_ID = "gFfTrznkj"
const DISPLAY_DATE_FIELD_ID = "yTZJC0uIi"

async function connectToFramer(): Promise<Framer> {
    const projectUrl = process.env.FRAMER_PROJECT_URL
    const apiKey = process.env.FRAMER_API_KEY

    if (!projectUrl) {
        throw new Error("FRAMER_PROJECT_URL is missing. Check your .env file.")
    }
    if (!apiKey) {
        throw new Error("FRAMER_API_KEY is missing. Check your .env file.")
    }

    return connect(projectUrl, apiKey)
}

interface HeadlineData {
    title: string
    slug: string
}

/**
 * Fetches the 3 most recently published (non-draft) headlines,
 * each with its title and slug, for a single drop category.
 */
async function getLatestHeadlines(framer: Framer, drop: DropKey): Promise<HeadlineData[]> {
    const collection = await framer.getCollection(BLOG_COLLECTION_ID)
    if (!collection) {
        throw new Error(`Blog collection (${BLOG_COLLECTION_ID}) not found.`)
    }

    const items = await collection.getItems()
    const categorySlug = DROP_CATEGORY_SLUG[drop]

    const matching = items
        .filter((item) => {
            if (item.draft) return false
            const categories = item.fieldData[CATEGORIES_FIELD_ID]
            if (!categories || categories.type !== "multiCollectionReference") return false
            return (categories.value as readonly string[]).includes(categorySlug)
        })
        .sort((a, b) => {
            const dateA = a.fieldData[DISPLAY_DATE_FIELD_ID]
            const dateB = b.fieldData[DISPLAY_DATE_FIELD_ID]
            const timeA = dateA?.type === "date" ? new Date(dateA.value as string).getTime() : 0
            const timeB = dateB?.type === "date" ? new Date(dateB.value as string).getTime() : 0
            return timeB - timeA
        })
        .slice(0, 3)

    return matching.map((item) => {
        const titleField = item.fieldData[TITLE_FIELD_ID]
        const title = titleField?.type === "string" ? (titleField.value as string) : "(untitled)"
        return { title, slug: item.slug }
    })
}

/**
 * Replaces just the headlines array for one drop key within the
 * source text, leaving everything else in the file untouched. Both
 * target files share the same `drops` array shape, so this same
 * targeted replacement applies unchanged to either one.
 */
function replaceHeadlinesInSource(
    sourceCode: string,
    dropKey: DropKey,
    newHeadlines: HeadlineData[]
): string {
    const pattern = new RegExp(
        `(key:\\s*"${dropKey}"[\\s\\S]*?headlines:\\s*\\[)([\\s\\S]*?)(\\],)`
    )

    if (!pattern.test(sourceCode)) {
        throw new Error(
            `Could not find the headlines array for drop "${dropKey}" in the current source. ` +
                `The file may have been restructured in Framer since this sync logic was written — ` +
                `check the file's actual current structure before re-running.`
        )
    }

    const formattedHeadlines = newHeadlines
        .map(
            (h) =>
                `            { title: ${JSON.stringify(h.title)}, slug: ${JSON.stringify(h.slug)} },`
        )
        .join("\n")

    return sourceCode.replace(pattern, `$1\n${formattedHeadlines}\n        $3`)
}

/**
 * Replaces just the syncedDate value for one drop key within the
 * source text. Only meaningful for DropStack.tsx, which is the only
 * file with a staleness UI to drive.
 */
function replaceSyncedDateInSource(sourceCode: string, dropKey: DropKey, dateKey: string): string {
    const pattern = new RegExp(`(key:\\s*"${dropKey}"[\\s\\S]*?syncedDate:\\s*")[^"]*(")`)

    if (!pattern.test(sourceCode)) {
        throw new Error(
            `Could not find syncedDate for drop "${dropKey}" in the current source. ` +
                `If DropStack.tsx's Drop type no longer has this field, this function is stale ` +
                `and should be removed along with the staleness feature itself.`
        )
    }

    return sourceCode.replace(pattern, `$1${dateKey}$2`)
}

export async function syncHomepage(): Promise<void> {
    const framer = await connectToFramer()

    try {
        const drops: DropKey[] = ["morning", "afternoon", "latenight"]

        // Fetch each drop's headlines once, up front, and reuse the same
        // result for every target file — no need to hit the CMS twice for
        // data that's identical either way.
        const headlinesByDrop = new Map<DropKey, HeadlineData[]>()
        for (const drop of drops) {
            const headlines = await getLatestHeadlines(framer, drop)
            headlinesByDrop.set(drop, headlines)
            if (headlines.length === 0) {
                console.log(`  (No published items found for ${drop} — leaving its headlines unchanged everywhere)`)
            } else {
                console.log(`  Fetched ${drop}: ${headlines.map((h) => h.title).join(" | ")}`)
            }
        }

        const todayKey = currentCycleDateKey()

        for (const fileName of TARGET_CODE_FILES) {
            const codeFile = await framer.getCodeFile(fileName)
            if (!codeFile) {
                console.log(`  Could not find code file "${fileName}" — skipping it.`)
                continue
            }

            let currentSource = codeFile.content
            for (const drop of drops) {
                const headlines = headlinesByDrop.get(drop) ?? []
                if (headlines.length === 0) continue

                currentSource = replaceHeadlinesInSource(currentSource, drop, headlines)

                // Only stamp today's date on drops that actually got
                // fresh headlines just now, and only in the one file
                // that has a staleness UI to drive. A drop with no
                // published items this run keeps its OLD syncedDate on
                // purpose — that's exactly what should make it show as
                // "not updated" once its hour passes.
                if (fileName === STALENESS_TARGET_FILE) {
                    currentSource = replaceSyncedDateInSource(currentSource, drop, todayKey)
                }
            }

            await codeFile.setFileContent(currentSource)
            console.log(`  Synced ${fileName}`)
        }
    } finally {
        await framer.disconnect()
    }
}

// Manual test runner. Run with: npx tsx src/sync-homepage.ts
import { fileURLToPath } from "node:url"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log("Syncing homepage + article-nav headlines from live CMS data...\n")
    syncHomepage()
        .then(() => {
            console.log("\nCode files updated. This does NOT go live until publishLiveSite() runs.")
        })
        .catch((err) => {
            console.error("Homepage sync failed:", err.message)
            process.exit(1)
        })
}
