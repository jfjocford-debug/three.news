/**
 * SOURCE MODULE
 *
 * Pulls candidate news stories from Currents API, pre-sorted into the
 * three drop categories from the story-selection framework:
 *
 *   Morning   (Truth & Clarity)        -> politics_government, economy_business_finance, society
 *   Afternoon (Justice & Compassion)   -> human_interest, crime_law_justice, society
 *   Late Night (Discernment & Reflection) -> arts_culture_entertainment, science_technology, sport
 *
 * This module does NOT decide which stories make the cut — that's the
 * Select stage. This just gathers real candidates per category so
 * Select has real material to judge against the Two-Question Test.
 */

import "dotenv/config"

const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY
const BASE_URL = "https://api.currentsapi.services/v2/latest-news"

export type DropKey = "morning" | "afternoon" | "latenight"

// Maps each drop to the Currents API v2 categories that fit its identity.
const DROP_CATEGORY_MAP: Record<DropKey, string[]> = {
    morning: ["politics_government", "economy_business_finance", "society"],
    afternoon: ["human_interest", "crime_law_justice", "society"],
    latenight: ["arts_culture_entertainment", "science_technology", "sport"],
}

export interface CandidateStory {
    id: string
    title: string
    description: string
    url: string
    published: string
    category: string[]
    author: string | null
}

interface CurrentsApiArticle {
    id: string
    title: string
    description: string
    url: string
    published: string
    category: string[]
    author: string
}

interface CurrentsApiResponse {
    status: string
    news: CurrentsApiArticle[]
}

/**
 * Fetches candidate stories for a single Currents API category.
 */
async function fetchCategory(category: string): Promise<CandidateStory[]> {
    if (!CURRENTS_API_KEY) {
        throw new Error(
            "CURRENTS_API_KEY is missing. Check your .env file."
        )
    }

    const url = new URL(BASE_URL)
    url.searchParams.set("category", category)
    url.searchParams.set("language", "en")
    url.searchParams.set("apiKey", CURRENTS_API_KEY)

    const response = await fetch(url.toString())

    if (!response.ok) {
        throw new Error(
            `Currents API request failed for category "${category}": ` +
                `${response.status} ${response.statusText}`
        )
    }

    const data = (await response.json()) as CurrentsApiResponse

    if (data.status !== "ok") {
        throw new Error(
            `Currents API returned non-ok status for category "${category}"`
        )
    }

    return data.news.map((article) => ({
        id: article.id,
        title: article.title,
        description: article.description,
        url: article.url,
        published: article.published,
        category: article.category,
        author: article.author || null,
    }))
}

/**
 * Fetches all candidate stories for a given drop, across every category
 * mapped to that drop's identity. Deduplicates by article id in case a
 * story is tagged under more than one category.
 */
export async function fetchCandidatesForDrop(
    drop: DropKey
): Promise<CandidateStory[]> {
    const categories = DROP_CATEGORY_MAP[drop]

    const results = await Promise.all(
        categories.map((category) => fetchCategory(category))
    )

    const seen = new Set<string>()
    const deduped: CandidateStory[] = []

    for (const list of results) {
        for (const story of list) {
            if (!seen.has(story.id)) {
                seen.add(story.id)
                deduped.push(story)
            }
        }
    }

    return deduped
}

// Manual test runner. Run with: npx tsx src/source.ts morning
import { fileURLToPath } from "node:url"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dropArg = process.argv[2]
    const validDrops: DropKey[] = ["morning", "afternoon", "latenight"]

    if (!dropArg || !validDrops.includes(dropArg as DropKey)) {
        console.error(
            "Usage: npx tsx src/source.ts <morning|afternoon|latenight>"
        )
        process.exit(1)
    }

    fetchCandidatesForDrop(dropArg as DropKey)
        .then((candidates) => {
            console.log(
                `Found ${candidates.length} candidate stories for ${dropArg}:\n`
            )
            candidates.forEach((c, i) => {
                console.log(`${i + 1}. [${c.category.join(", ")}] ${c.title}`)
                console.log(`   ${c.url}\n`)
            })
        })
        .catch((err) => {
            console.error("Source fetch failed:", err.message)
            process.exit(1)
        })
}
