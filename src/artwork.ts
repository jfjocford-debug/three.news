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
 * queries the Met's API can actually use.
 */
async function generateSearchQueries(proposal: ArtworkProposal): Promise<string[]> {
    const prompt = `You are generating search queries for the Metropolitan Museum of Art's Open Access API, based on an artwork concept.

Era: ${proposal.era}
Concept: ${proposal.concept}
Rationale: ${proposal.rationale}

The Met's search is a literal keyword/catalog search, not a semantic or visual search — it matches against actual titles, subjects, and cataloging terms, not poetic descriptions. Abstract phrases like "threshold light composition" or "turning back glance" will not match real museum catalog entries.

Generate 4 short, CONCRETE search queries (2-3 words each) using the kind of literal, plain terms that actually appear in art catalogs: concrete subjects (a person's action, a common mythological or biblical scene, an object type), not moods or compositions. Think "woman reading letter," "man at window," "departure scene," "farewell painting" — not abstract interpretive phrases. Vary the angle across the 4 queries.

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

/**
 * Given a real shortlist, asks Claude to pick the single best match
 * and write a rationale grounded in what the piece actually is.
 */
async function selectBestMatch(
    proposal: ArtworkProposal,
    candidates: MetObjectDetail[]
): Promise<SelectedArtwork> {
    const candidateList = candidates
        .map(
            (c, i) =>
                `${i + 1}. "${c.title}" — ${c.artistDisplayName || "Artist unknown"}, ${c.objectDate}\n   Department: ${c.department}\n   Medium: ${c.medium}\n   objectID: ${c.objectID}`
        )
        .join("\n\n")

    const prompt = `You proposed this artwork concept for a story:

Era: ${proposal.era}
Concept: ${proposal.concept}
Original rationale: ${proposal.rationale}

Here are REAL candidate pieces from the Met's collection, all confirmed public domain with real images:
---
${candidateList}
---

Pick the single best match. It doesn't need to be a perfect literal match — pick whichever real piece best captures the spirit of the concept. Write a NEW rationale grounded in what this actual piece is (its real title, artist, subject, composition) — not a restatement of the abstract proposal.

Respond with ONLY a JSON object, no other text:
{
  "objectID": 12345,
  "finalRationale": "..."
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

    let result: { objectID: number; finalRationale: string }
    try {
        result = extractJSON(textBlock.text)
    } catch (err) {
        throw new Error(`Failed to parse final selection as JSON. Raw:\n${textBlock.text}`)
    }

    const chosen = candidates.find((c) => c.objectID === result.objectID)
    if (!chosen) {
        throw new Error(
            `Model selected objectID ${result.objectID}, which isn't in the candidate list it was given.`
        )
    }

    return {
        title: chosen.title,
        artist: chosen.artistDisplayName || "Artist unknown",
        date: chosen.objectDate,
        objectURL: chosen.objectURL,
        imageURL: chosen.primaryImage,
        creditLine: `${chosen.title} — ${chosen.artistDisplayName || "Artist unknown"}, ${chosen.objectDate}`,
        finalRationale: result.finalRationale,
    }
}

export async function findArtwork(proposal: ArtworkProposal): Promise<SelectedArtwork> {
    const queries = await generateSearchQueries(proposal)
    const candidates = await findCandidates(queries)

    if (candidates.length === 0) {
        throw new Error(
            `No public-domain, image-having candidates found for era "${proposal.era}" with queries: ${queries.join(", ")}. ` +
                `Try again — the Met's collection is large but keyword search can miss on a given attempt.`
        )
    }

    return selectBestMatch(proposal, candidates)
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
