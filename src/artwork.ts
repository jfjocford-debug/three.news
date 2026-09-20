/**
 * ARTWORK MODULE
 *
 * Takes Draft's artwork PROPOSAL (an era + a prose concept description)
 * and finds a real, specific, public-domain piece from the Met's Open
 * Access API that actually matches it.
 *
 * The Met's API takes short keyword queries, not prose — so this is a
 * three-step pipeline, not a single search:
 *   1. Turn the prose concept into a handful of real search queries.
 *   2. Search the Met, then fetch full details for candidates, keeping
 *      only pieces that are both public domain AND actually have an
 *      image (a lot of the catalog has neither).
 *   3. Have Claude pick the single best real match from the shortlist
 *      and write a rationale grounded in what the piece actually is —
 *      not the abstract proposal.
 *
 * MATCH QUALITY: step 3 requires a genuine, defensible connection
 * (subject, composition, or well-documented symbolism) — not just "same
 * rough era or mood." If nothing in a shortlist actually qualifies, the
 * model can reject the whole batch instead of being forced to force-fit
 * the least-bad option.
 *
 * GUARANTEED FALLBACK (this revision): the rejection path above, once
 * combined with the medium preference below, turned out to be too
 * strict for real operation — a real run failed 6 out of 6 stories in a
 * row, each with well-reasoned but ultimately uncompromising rejections
 * (a concept calling for "a winged-machine emblem" or "an empty
 * general's chair with a helmet on it" genuinely may not exist anywhere
 * in the Met's public-domain, imaged collection). A 0%-publish day is a
 * worse outcome than an imperfect artwork match, so after
 * MAX_SELECTION_ATTEMPTS strict attempts are exhausted, ONE final
 * relaxed attempt runs against the best candidates gathered so far,
 * explicitly allowed to match on era/mood/genre alone rather than exact
 * subject or composition. Only this last-resort attempt is graded on
 * the relaxed standard — every earlier attempt still holds out for a
 * genuine connection first.
 *
 * MEDIUM PREFERENCE: real published output showed a strong bias toward
 * non-painting objects — medals, porcelain services, bronze statuettes,
 * architectural prints, photographs — because nothing in the pipeline
 * ever mentioned medium at all. Both query generation and selection now
 * explicitly prefer paintings, with one deliberate exception: actual
 * Greek panel painting barely survives anywhere, so for the Classical
 * Greek era specifically, vase painting counts as the real painting-
 * equivalent rather than being penalized as "not a painting."
 *
 * Uses /v1.1 of the Met's API — /v1/search is deprecated and retires
 * October 1, 2026.
 */
import { extractJSON } from "./extract-json.js"

import "dotenv/config"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
})

const MET_SEARCH_BASE = "https://collectionapi.metmuseum.org/public/collection/v1.1"
const MET_OBJECT_BASE = "https://collectionapi.metmuseum.org/public/collection/v1"

export interface ArtworkProposal {
    era: "Renaissance" | "Classical Greek" | "Neoclassicism" | "Baroque"
    concept: string
    rationale: string
}

export interface SelectedArtwork {
    title: string
    artist: string
    date: string
    objectURL: string
    imageURL: string
    creditLine: string
    finalRationale: string
}

interface MetSearchResponse {
    total: number
    objectIDs: number[] | null
}

interface MetObjectDetail {
    objectID: number
    title: string
    artistDisplayName: string
    objectDate: string
    isPublicDomain: boolean
    primaryImage: string
    objectURL: string
    department: string
    medium: string
}

/**
 * Turns Draft's prose concept into a handful of real, short search
 * queries the Met's API can actually use. `avoidQueries` lets a retry
 * steer away from phrasing that already produced a rejected shortlist.
 */
async function generateSearchQueries(
    proposal: ArtworkProposal,
    avoidQueries: string[] = []
): Promise<string[]> {
    const avoidNote =
        avoidQueries.length > 0
            ? `\n\nThese queries were already tried and did not produce anything with a genuine connection to the concept — try meaningfully different angles this time, not close variants:\n${avoidQueries.map((q) => `- "${q}"`).join("\n")}`
            : ""

    const mediumNote =
        proposal.era === "Classical Greek"
            ? `\n\nMEDIUM: prefer terms associated with Greek vase painting (e.g. "red-figure vase," "black-figure amphora," "painted krater") over sculpture or pottery-shape terms alone — actual Greek panel painting barely survives, so vase painting is the real painting-equivalent for this era, not a fallback.`
            : `\n\nMEDIUM: at least half of the 4 queries should include a word like "painting" or "portrait" to bias results toward actual paintings. Avoid phrasing that mainly surfaces decorative objects, medals, ceramics, or sculpture (e.g. prefer "farewell painting" over just "farewell scene").`

    const prompt = `You are generating search queries for the Metropolitan Museum of Art's Open Access API, based on an artwork concept.

Era: ${proposal.era}
Concept: ${proposal.concept}
Rationale: ${proposal.rationale}

The Met's search is a literal keyword/catalog search, not a semantic or visual search — it matches against actual titles, subjects, and cataloging terms, not poetic descriptions. Abstract phrases like "threshold light composition" or "turning back glance" will not match real museum catalog entries.

Generate 4 short, CONCRETE search queries (2-3 words each) using the kind of literal, plain terms that actually appear in art catalogs: concrete subjects (a person's action, a common mythological or biblical scene, an object type), not moods or compositions. Think "woman reading letter," "man at window," "departure scene," "farewell painting" — not abstract interpretive phrases. Vary the angle across the 4 queries.${mediumNote}${avoidNote}

Respond with ONLY a JSON array of 4 strings, no other text:
["query one", "query two", "query three", "query four"]`

    const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        throw new Error("Search query generation returned no text content")
    }

    try {
        return extractJSON(textBlock.text)
    } catch (err) {
        throw new Error(`Failed to parse search queries as JSON. Raw:\n${textBlock.text}`)
    }
}

/**
 * Searches the Met for a single query, returning candidate object IDs.
 */
async function searchMet(query: string): Promise<number[]> {
    const url = `${MET_SEARCH_BASE}/search?hasImages=true&q=${encodeURIComponent(query)}`
    const response = await fetch(url)

    if (!response.ok) {
        // A single failed query shouldn't kill the whole run — return
        // no candidates from this one, other queries may still work.
        return []
    }

    const data = (await response.json()) as MetSearchResponse
    return data.objectIDs ?? []
}

/**
 * Fetches full details for one object ID.
 */
async function getMetObject(objectID: number): Promise<MetObjectDetail | null> {
    const url = `${MET_OBJECT_BASE}/objects/${objectID}`
    const response = await fetch(url)
    if (!response.ok) {
        console.log(`     Object ${objectID} fetch failed: HTTP ${response.status}`)
        return null
    }
    return (await response.json()) as MetObjectDetail
}

const MAX_QUERIES_TO_TRY = 4
const MAX_OBJECT_IDS_PER_QUERY = 15
const MAX_DETAIL_FETCHES = 40
const MAX_CANDIDATES_FOR_FINAL_SELECTION = 10
const MAX_SELECTION_ATTEMPTS = 2

/**
 * Runs the full search -> filter -> fetch pipeline, returning a
 * shortlist of real, public-domain, image-having candidates.
 */
async function findCandidates(queries: string[]): Promise<MetObjectDetail[]> {
    const allObjectIDs = new Set<number>()

    for (const query of queries.slice(0, MAX_QUERIES_TO_TRY)) {
        const ids = await searchMet(query)
        console.log(`   Query "${query}" → ${ids.length} raw results from the Met`)
        ids.slice(0, MAX_OBJECT_IDS_PER_QUERY).forEach((id) => allObjectIDs.add(id))
    }

    console.log(`   ${allObjectIDs.size} unique object IDs collected, fetching details...`)

    const idsToFetch = Array.from(allObjectIDs).slice(0, MAX_DETAIL_FETCHES)
    const candidates: MetObjectDetail[] = []
    let fetchFailures = 0
    let filteredOutNotPublicDomain = 0
    let filteredOutNoImage = 0

    for (const id of idsToFetch) {
        const detail = await getMetObject(id)
        if (!detail) {
            fetchFailures++
            continue
        }
        if (!detail.isPublicDomain) {
            filteredOutNotPublicDomain++
            continue
        }
        if (!detail.primaryImage) {
            filteredOutNoImage++
            continue
        }
        candidates.push(detail)
        if (candidates.length >= MAX_CANDIDATES_FOR_FINAL_SELECTION) break
    }

    console.log(
        `   Detail fetch results: ${candidates.length} usable, ${filteredOutNotPublicDomain} not public domain, ${filteredOutNoImage} no image, ${fetchFailures} fetch failures`
    )

    return candidates
}

type SelectionResult =
    | { matched: true; artwork: SelectedArtwork }
    | { matched: false; reason: string }

/**
 * Given a real shortlist, asks Claude to pick the single best match — or
 * reject the whole shortlist if nothing genuinely connects. `relaxed`
 * is only ever true on the final, last-resort attempt in findArtwork,
 * once every strict attempt has already been exhausted — it lowers the
 * bar to era/mood/genre alone specifically so a story never fails to
 * publish outright over an imperfect artwork match.
 */
async function selectBestMatch(
    proposal: ArtworkProposal,
    candidates: MetObjectDetail[],
    relaxed: boolean = false
): Promise<SelectionResult> {
    const candidateList = candidates
        .map(
            (c, i) =>
                `${i + 1}. "${c.title}" — ${c.artistDisplayName || "Artist unknown"}, ${c.objectDate}\n   Department: ${c.department}\n   Medium: ${c.medium}\n   objectID: ${c.objectID}`
        )
        .join("\n\n")

    const mediumGuidance =
        proposal.era === "Classical Greek"
            ? `MEDIUM PREFERENCE: for this era, treat Greek vase painting (red-figure, black-figure, painted pottery) as the real "painting" category — actual panel painting from this period doesn't survive in any collection, so vase painting is not a fallback, it's the correct choice. Prefer it over sculpture, coins, or unpainted pottery shapes when the subject match is comparable.`
            : `MEDIUM PREFERENCE: prefer an actual painting (oil, tempera, fresco, panel, or a drawing/print if no painting connects as well) over sculpture, medals, ceramics, metalwork, or other decorative/utilitarian objects. Only choose a non-painting candidate if it connects to the concept meaningfully better than every painting option on the list — a mediocre painting match does not automatically beat a strong sculpture match, but a comparable one should win on medium.`

    const standardInstruction = relaxed
        ? `This is a LAST-RESORT pass — every stricter attempt has already been exhausted and rejected everything. The bar is now: does this piece share the same era, general mood, or genre as the concept (e.g. a Neoclassical piece for a formal/civic concept, a Classical Greek piece for a mythic/heroic one)? A loose, honest, era-appropriate match is REQUIRED to be picked now — do not reject this batch. Pick whichever candidate is the least-forced fit and say so plainly in the rationale (it's fine for the rationale to acknowledge this is an atmospheric rather than literal match). Only return matched:false if the list is completely empty of anything even loosely appropriate to the era.`
        : `Pick the single best match — but ONLY if it has a genuine, defensible connection to the concept: a real match in subject, composition, or well-documented symbolism. Sharing just an era or a loose "mood" is NOT enough on its own. If nothing on this list actually connects, say so — do not force a pick just because the list requires one. A rejected batch leads to a fresh search, which is a normal, expected outcome, not a failure.`

    const prompt = `You proposed this artwork concept for a story:

Era: ${proposal.era}
Concept: ${proposal.concept}
Original rationale: ${proposal.rationale}

Here are REAL candidate pieces from the Met's collection, all confirmed public domain with real images:
---
${candidateList}
---

${standardInstruction}

${mediumGuidance}

If you pick one, write a NEW rationale grounded in what this actual piece is (its real title, artist, subject, composition) — not a restatement of the abstract proposal.

Respond with ONLY a JSON object, no other text. Either:
{
  "matched": true,
  "objectID": 12345,
  "finalRationale": "..."
}
or:
{
  "matched": false,
  "reason": "..."
}`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        throw new Error("Final artwork selection returned no text content")
    }

    let result: { matched: boolean; objectID?: number; finalRationale?: string; reason?: string }
    try {
        result = extractJSON(textBlock.text)
    } catch (err) {
        throw new Error(`Failed to parse final selection as JSON. Raw:\n${textBlock.text}`)
    }

    if (!result.matched) {
        return { matched: false, reason: result.reason || "No candidate had a genuine connection to the concept." }
    }

    const chosen = candidates.find((c) => c.objectID === result.objectID)
    if (!chosen) {
        throw new Error(
            `Model selected objectID ${result.objectID}, which isn't in the candidate list it was given.`
        )
    }

    return {
        matched: true,
        artwork: {
            title: chosen.title,
            artist: chosen.artistDisplayName || "Artist unknown",
            date: chosen.objectDate,
            objectURL: chosen.objectURL,
            imageURL: chosen.primaryImage,
            creditLine: `${chosen.title} — ${chosen.artistDisplayName || "Artist unknown"}, ${chosen.objectDate}`,
            finalRationale: result.finalRationale || "",
        },
    }
}

export async function findArtwork(proposal: ArtworkProposal): Promise<SelectedArtwork> {
    const triedQueries: string[] = []
    let lastCandidates: MetObjectDetail[] = []

    for (let attempt = 1; attempt <= MAX_SELECTION_ATTEMPTS; attempt++) {
        const queries = await generateSearchQueries(proposal, triedQueries)
        triedQueries.push(...queries)

        const candidates = await findCandidates(queries)

        if (candidates.length === 0) {
            console.log(`   Attempt ${attempt}: no candidates found at all, ${attempt < MAX_SELECTION_ATTEMPTS ? "retrying with fresh queries..." : "moving to last-resort pass."}`)
            continue
        }

        lastCandidates = candidates
        const result = await selectBestMatch(proposal, candidates)

        if (result.matched) {
            return result.artwork
        }

        console.log(`   Attempt ${attempt}: shortlist rejected — ${result.reason}${attempt < MAX_SELECTION_ATTEMPTS ? " Retrying with fresh queries..." : " Moving to last-resort pass."}`)
    }

    // GUARANTEED FALLBACK: every strict attempt is exhausted. Rather than
    // fail the story outright — the actual problem this fixes, since a
    // real run failed 6/6 stories this way — make one final relaxed pass
    // against whatever the last real shortlist was, explicitly allowed
    // to match on era/mood alone. If even that comes back completely
    // empty (no candidates were ever found across every attempt), only
    // then does this genuinely fail.
    if (lastCandidates.length > 0) {
        console.log(`   Last-resort pass: relaxing to era/mood match against the most recent shortlist...`)
        const relaxedResult = await selectBestMatch(proposal, lastCandidates, true)
        if (relaxedResult.matched) {
            return relaxedResult.artwork
        }
        console.log(`   Last-resort pass also came back empty: ${relaxedResult.reason}`)
    }

    throw new Error(
        `No candidate found for era "${proposal.era}" even after a relaxed last-resort pass. ` +
            `Queries tried: ${triedQueries.join(", ")}.`
    )
}

// Manual test runner. Run with: npx tsx src/artwork.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const testProposal: ArtworkProposal = {
        era: "Neoclassicism",
        concept:
            "A figure at a threshold or doorway, turning back to acknowledge someone — the composition suggests both arrival and departure held in the same moment, with light spilling across the boundary between them.",
        rationale:
            "Captures the duality of a recording made before death but heard after it — a voice crossing a boundary it didn't anticipate, still present in the room where it's being played.",
    }

    findArtwork(testProposal)
        .then((artwork) => {
            console.log("\n--- SELECTED ARTWORK ---\n")
            console.log("Title:", artwork.title)
            console.log("Artist:", artwork.artist)
            console.log("Date:", artwork.date)
            console.log("Object page:", artwork.objectURL)
            console.log("Image:", artwork.imageURL)
            console.log("Credit line:", artwork.creditLine)
            console.log("\nRationale:", artwork.finalRationale)
        })
        .catch((err) => {
            console.error("Artwork stage failed:", err.message)
            process.exit(1)
        })
}
