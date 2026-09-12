/**
 * HOMEPAGE SYNC MODULE
 *
 * DropStack.tsx (the home screen accordion) has always used a
 * hardcoded array of headlines, going back to when it was first
 * built — this was a known, explicitly-flagged limitation, not a new
 * discovery. This module closes that gap: it fetches the latest
 * published items for all three drop categories and rewrites the
 * component's headline arrays with real content.
 *
 * SAFETY: fetches the ACTUAL CURRENT source from Framer first and
 * does a targeted replacement of just the headline arrays, rather
 * than regenerating the whole file from a locally-held template.
 * The file has been directly editable in Framer this whole time, so
 * a local copy could easily have drifted from what's actually live —
 * patching the real thing is safer than overwriting it blind.
 *
 * "Latest 3 published items per category" is the definition of
 * what a drop shows — not "items published today specifically."
 * On a normal day these are the same thing; on a day where a story
 * failed and only 2 published, this naturally falls back to showing
 * a slightly older third item rather than a broken or incomplete
 * drop. Worth knowing that's the deliberate tradeoff.
 *
 * Like everything else that writes content, this only updates the
 * PROJECT's code file — it does not go live until publishLiveSite()
 * is deliberately called, same deferred-until-published model as
 * every CMS write in this pipeline.
 */

import "dotenv/config"
import { connect, type Framer } from "framer-api"
import type { DropKey } from "./source.js"

const BLOG_COLLECTION_ID = "fKsETXCvz"
const DROP_STACK_CODE_FILE = "DropStack.tsx"

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
 * source text, leaving everything else in the file untouched.
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
                `check DropStack.tsx's actual current structure before re-running.`
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

export async function syncHomepage(): Promise<void> {
    const framer = await connectToFramer()

    try {
        const codeFile = await framer.getCodeFile(DROP_STACK_CODE_FILE)
        if (!codeFile) {
            throw new Error(`Could not find code file "${DROP_STACK_CODE_FILE}" in this project.`)
        }

        let currentSource = codeFile.content

        const drops: DropKey[] = ["morning", "afternoon", "latenight"]
        for (const drop of drops) {
            const headlines = await getLatestHeadlines(framer, drop)
            if (headlines.length === 0) {
                console.log(`  (No published items found for ${drop} — leaving its headlines unchanged)`)
                continue
            }
            currentSource = replaceHeadlinesInSource(currentSource, drop, headlines)
            console.log(`  Synced ${drop}: ${headlines.map((h) => h.title).join(" | ")}`)
        }

        await codeFile.setFileContent(currentSource)
    } finally {
        await framer.disconnect()
    }
}

// Manual test runner. Run with: npx tsx src/sync-homepage.ts
import { fileURLToPath } from "node:url"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log("Syncing homepage headlines from live CMS data...\n")
    syncHomepage()
        .then(() => {
            console.log("\nHomepage code updated. This does NOT go live until publishLiveSite() runs.")
        })
        .catch((err) => {
            console.error("Homepage sync failed:", err.message)
            process.exit(1)
        })
}
