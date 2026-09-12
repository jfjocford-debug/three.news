/**
 * PUBLISH MODULE
 *
 * Takes a finished, drafted, fact-checked story plus its selected
 * artwork and writes it into Framer's Blog CMS collection, tagged to
 * the right drop category.
 *
 * SAFETY DESIGN: writing a CMS item and actually publishing the live
 * site are kept as two completely separate functions, never bundled.
 * addStoryToCMS() only ever writes a draft item — visible in Framer's
 * CMS panel, not live on the internet. publishLiveSite() is the only
 * function that deploys, and it's never called automatically by
 * anything else in this file. That separation is deliberate: writing
 * a draft is safe to automate, pushing to the public internet is not
 * something this script should ever do silently.
 *
 * Exception-triggered / mandatory-review stories are ALWAYS written
 * as CMS drafts (Framer's own draft flag, separate from "published"),
 * regardless of what the caller passes — matching the pipeline's
 * standing rule that these hold for human review before going live.
 */

import "dotenv/config"
import { fileURLToPath } from "node:url"
import { connect, type Framer } from "framer-api"
import type { DraftedStory } from "./draft.js"
import type { SelectedArtwork } from "./artwork.js"
import type { DropKey } from "./source.js"

const BLOG_COLLECTION_ID = "fKsETXCvz"

const DROP_CATEGORY_ITEM_ID: Record<DropKey, string> = {
    morning: "JfL2Amns3",
    afternoon: "EtF4IFkZB",
    latenight: "kvcd5E4Lp",
}

const FIELD_IDS = {
    title: "vt_lJyMpu",
    displayDate: "yTZJC0uIi",
    timeToRead: "ojPqVyxAe",
    shortIntro: "BzfH2PVym",
    pageLongIntro: "QmpzHSCea",
    categories: "gFfTrznkj",
    image: "skvl5avbM",
    content: "q02CY1A9U",
    metaDescription: "dOQtfwF9t",
    whatHappened: "D3kxfmo7W",
    whyItMatters: "rvURSoCQq",
    whatsNext: "IxHF7AShR",
    takeaway: "Gi7HcnSGQ",
    artworkCredit: "DVnnp2xJ_",
} as const

function slugify(headline: string): string {
    return headline
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
}

function estimateReadTime(story: DraftedStory): string {
    const wordCount = [
        story.headline,
        story.whatHappened,
        story.whyItMatters,
        story.whatsNext,
        story.takeaway,
    ]
        .join(" ")
        .split(/\s+/).length

    const minutes = Math.max(1, Math.round(wordCount / 200))
    return `${minutes} min read`
}

function buildContentMarkdown(story: DraftedStory, artwork: SelectedArtwork): string {
    return `**What Happened**

${story.whatHappened}

**Why It Matters**

${story.whyItMatters}

**What's Next**

${story.whatsNext}

*Artwork: ${artwork.creditLine}*`
}

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

/**
 * Writes a story into the Blog CMS collection as a DRAFT item. Never
 * publishes the live site — see the module-level note above for why
 * that's a deliberately separate function.
 */
export async function addStoryToCMS(
    story: DraftedStory,
    artwork: SelectedArtwork,
    drop: DropKey,
    needsMandatoryReview: boolean
): Promise<{ itemSlug: string; wasHeldForReview: boolean }> {
    const framer = await connectToFramer()

    try {
        const collection = await framer.getCollection(BLOG_COLLECTION_ID)
        if (!collection) {
            throw new Error(
                `Blog collection (${BLOG_COLLECTION_ID}) not found. Check FRAMER_PROJECT_URL points to the right project.`
            )
        }

        const slug = slugify(story.headline)
        const today = new Date().toISOString()

        await collection.addItems([
            {
                slug,
                // Exception-triggered / mandatory-review stories hold as
                // CMS drafts, excluded from the next publish, until a
                // human reviews and clears them. Everything else writes
                // as ready (draft: false) — but "ready" only takes
                // effect the next time publishLiveSite() is deliberately
                // called; it does not push anything live on its own.
                draft: needsMandatoryReview,
                fieldData: {
                    [FIELD_IDS.title]: { type: "string", value: story.headline },
                    [FIELD_IDS.displayDate]: { type: "date", value: today },
                    [FIELD_IDS.timeToRead]: { type: "string", value: estimateReadTime(story) },
                    [FIELD_IDS.shortIntro]: { type: "string", value: story.takeaway },
                    [FIELD_IDS.pageLongIntro]: { type: "string", value: story.takeaway },
                    [FIELD_IDS.categories]: {
                        type: "multiCollectionReference",
                        value: [DROP_CATEGORY_ITEM_ID[drop]],
                    },
                    [FIELD_IDS.image]: { type: "image", value: artwork.imageURL, alt: artwork.title },
                    // Kept populated since it's still a required field on the
                    // collection, even though the page no longer displays it —
                    // the five fields below are what actually render now.
                    [FIELD_IDS.content]: {
                        type: "formattedText",
                        value: buildContentMarkdown(story, artwork),
                        contentType: "markdown",
                    },
                    [FIELD_IDS.metaDescription]: { type: "string", value: story.takeaway },
                    [FIELD_IDS.whatHappened]: { type: "string", value: story.whatHappened },
                    [FIELD_IDS.whyItMatters]: { type: "string", value: story.whyItMatters },
                    [FIELD_IDS.whatsNext]: { type: "string", value: story.whatsNext },
                    [FIELD_IDS.takeaway]: { type: "string", value: story.takeaway },
                    [FIELD_IDS.artworkCredit]: { type: "string", value: artwork.creditLine },
                },
            },
        ])

        return { itemSlug: slug, wasHeldForReview: needsMandatoryReview }
    } finally {
        await framer.disconnect()
    }
}

/**
 * Actually deploys the live site. This is the ONLY function in the
 * whole pipeline that does this. Never call it automatically from
 * addStoryToCMS or any batch/loop — this should always be a
 * deliberate, separate, human-initiated step.
 */
export async function publishLiveSite(): Promise<void> {
    const framer = await connectToFramer()
    try {
        console.log("⚠ Publishing the LIVE site now — this is a real, public action.")
        const result = await framer.publish()
        console.log("Published. Hostnames:", result.hostnames)
    } finally {
        await framer.disconnect()
    }
}

// Manual test runner. Run with: npx tsx src/publish.ts
// Or, to just trigger a live publish with no test item: npx tsx src/publish.ts publish
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === "publish") {
        publishLiveSite()
            .then(() => {
                console.log("\nLive publish complete.")
            })
            .catch((err) => {
                console.error("Publish failed:", err.message)
                process.exit(1)
            })
    } else {
        const testStory: DraftedStory = {
            registerVerified: true,
            registerMismatchWarning: null,
            factCheckNotes: null,
            headline: "Test Story — Safe To Delete",
            whatHappened: "This is a manual test of the publish pipeline, writing a draft CMS item to confirm the connection and field mapping work correctly.",
            whyItMatters: "If this appears correctly in Framer's CMS panel as a draft item with the right fields populated, the publish module is working as intended.",
            whatsNext: "Delete this test item once confirmed working.",
            takeaway: "This is a test item — safe to delete from the CMS.",
            artworkProposal: {
                era: "Renaissance",
                concept: "test",
                rationale: "test",
            },
        }

        const testArtwork: SelectedArtwork = {
            title: "Test Artwork",
            artist: "Test Artist",
            date: "1900",
            objectURL: "https://example.com",
            imageURL: "https://images.metmuseum.org/CRDImages/dp/original/DP828180.jpg",
            creditLine: "Test Artwork — Test Artist, 1900",
            finalRationale: "test",
        }

        addStoryToCMS(testStory, testArtwork, "morning", false)
            .then((result) => {
                console.log("\n--- WRITTEN TO CMS ---\n")
                console.log("Slug:", result.itemSlug)
                console.log("Held for review:", result.wasHeldForReview)
                console.log(
                    "\nCheck your Framer CMS panel — this should appear as a DRAFT item, NOT live on your published site."
                )
            })
            .catch((err) => {
                console.error("Publish stage failed:", err.message)
                process.exit(1)
            })
    }
}
