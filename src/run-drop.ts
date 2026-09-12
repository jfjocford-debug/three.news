/**
 * ORCHESTRATOR
 *
 * Runs the full pipeline for one drop: Select once, then for each
 * selected story, Draft -> Artwork -> Publish individually.
 *
 * Per-story failure isolation: if Draft, Artwork, or Publish fails for
 * ONE story, that failure is logged and the run continues with the
 * remaining stories, rather than crashing the whole drop. A partial
 * drop (2/3 stories) is a better outcome than a total failure over
 * one bad source.
 *
 * Auto-publish is real and active here, per explicit confirmation:
 * if at least one story from this run succeeded and wasn't held for
 * mandatory review, the homepage's headline arrays get synced from
 * live CMS data (see sync-homepage.ts) and publishLiveSite() runs
 * automatically at the end. This is the one place in the whole
 * pipeline where live publishing happens — everywhere else, that
 * stays a separate, deliberate action.
 *
 * KNOWN GAP, worth knowing rather than hiding: Draft independently
 * re-verifies REGISTER against the full article text (and has caught
 * real mismatches before), but it does not independently re-verify
 * the mandatory-review flag — that decision is sourced entirely from
 * Select's Pass 3 check. Select's check is itself verified against
 * full article text, so this isn't ungrounded, but it means there's
 * only one layer of verification on mandatory-review specifically,
 * versus two layers on register. Worth watching for whether this
 * ever needs the same double-check Draft already does for register.
 */

import "dotenv/config"
import { fileURLToPath } from "node:url"
import { selectStoriesForDrop } from "./select.js"
import { draftStory } from "./draft.js"
import { findArtwork } from "./artwork.js"
import { addStoryToCMS, publishLiveSite } from "./publish.js"
import { syncHomepage } from "./sync-homepage.js"
import type { DropKey } from "./source.js"

interface StoryResult {
    title: string
    status: "published" | "held_for_review" | "failed"
    slug?: string
    error?: string
}

async function runDrop(drop: DropKey): Promise<void> {
    console.log(`\n=== Running ${drop} drop ===\n`)

    console.log("Stage 1: Selecting stories...")
    const selected = await selectStoriesForDrop(drop)

    if (selected.length === 0) {
        throw new Error(`No stories selected for ${drop} — nothing to publish this run.`)
    }

    console.log(`Selected ${selected.length} stories.\n`)

    const results: StoryResult[] = []

    for (const story of selected) {
        console.log(`Processing: ${story.title}`)
        try {
            console.log("  Drafting...")
            const draft = await draftStory(story)
            if (draft.factCheckNotes) {
                console.log(`  (Fact-check caught and corrected something: ${draft.factCheckNotes})`)
            }

            console.log("  Finding artwork...")
            const artwork = await findArtwork(draft.artworkProposal)

            console.log("  Writing to CMS...")
            const { itemSlug, wasHeldForReview } = await addStoryToCMS(
                draft,
                artwork,
                drop,
                story.needsMandatoryReview
            )

            results.push({
                title: story.title,
                status: wasHeldForReview ? "held_for_review" : "published",
                slug: itemSlug,
            })
            console.log(
                `  Done: ${itemSlug} (${wasHeldForReview ? "HELD FOR REVIEW — not going live" : "ready"})\n`
            )
        } catch (err) {
            results.push({
                title: story.title,
                status: "failed",
                error: (err as Error).message,
            })
            console.log(`  FAILED: ${(err as Error).message}\n`)
        }
    }

    const published = results.filter((r) => r.status === "published")
    const heldForReview = results.filter((r) => r.status === "held_for_review")
    const failed = results.filter((r) => r.status === "failed")

    console.log("=== Summary ===")
    console.log(`${results.length}/${selected.length} stories processed without crashing`)
    console.log(`  Published (ready): ${published.length}`)
    console.log(`  Held for review: ${heldForReview.length}`)
    console.log(`  Failed: ${failed.length}`)

    if (heldForReview.length > 0) {
        console.log("\nHeld for review:")
        heldForReview.forEach((r) => console.log(`  - ${r.title} (${r.slug})`))
    }
    if (failed.length > 0) {
        console.log("\nFailed:")
        failed.forEach((r) => console.log(`  - ${r.title}: ${r.error}`))
    }

    if (published.length > 0) {
        console.log("\nAt least one story is ready — syncing homepage headlines...")
        await syncHomepage()

        console.log("\nPublishing live site...")
        await publishLiveSite()
    } else {
        console.log(
            "\nNothing from this run is ready to go live (all held for review or failed) — skipping live publish."
        )
    }

    console.log("\n=== Drop run complete ===\n")
}

export { runDrop }

// CLI entrypoint. Run with: npx tsx src/run-drop.ts <morning|afternoon|latenight>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dropArg = process.argv[2]
    const validDrops: DropKey[] = ["morning", "afternoon", "latenight"]

    if (!dropArg || !validDrops.includes(dropArg as DropKey)) {
        console.error("Usage: npx tsx src/run-drop.ts <morning|afternoon|latenight>")
        process.exit(1)
    }

    runDrop(dropArg as DropKey).catch((err) => {
        console.error("\nDrop run failed entirely:", err.message)
        process.exit(1)
    })
}
