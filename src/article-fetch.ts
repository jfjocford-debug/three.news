/**
 * SHARED ARTICLE FETCH UTILITY
 *
 * Used by both select.ts (to verify register against full text before
 * finalizing a story) and draft.ts (to draft from real content). One
 * implementation, so both stages trust the same extraction behavior.
 */

import { JSDOM, VirtualConsole } from "jsdom"
import { Readability } from "@mozilla/readability"

const MIN_USABLE_LENGTH = 300

// JSDOM tries to parse page CSS it doesn't fully understand and logs
// harmless warnings about it. This doesn't affect article text
// extraction at all — silencing it so real errors aren't buried in noise.
const silentConsole = new VirtualConsole()

/**
 * Fetches a URL and extracts clean article text using the same
 * readability approach browsers use for "reader mode." Throws if
 * the page can't be fetched or if extraction yields too little
 * text to safely rely on.
 */
export async function fetchArticleText(url: string): Promise<string> {
    const response = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
    })

    if (!response.ok) {
        throw new Error(
            `Failed to fetch article at ${url}: ${response.status} ${response.statusText}`
        )
    }

    const html = await response.text()
    const dom = new JSDOM(html, { url, virtualConsole: silentConsole })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()

    if (!article || !article.textContent) {
        throw new Error(
            `Could not extract readable article content from ${url}. ` +
                `The page may block scraping or use a format Readability can't parse.`
        )
    }

    const text = article.textContent.trim()

    if (text.length < MIN_USABLE_LENGTH) {
        throw new Error(
            `Extracted article text from ${url} is too short (${text.length} chars) ` +
                `to safely rely on.`
        )
    }

    return text
}
