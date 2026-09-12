/**
 * SHARED JSON EXTRACTION UTILITY
 *
 * Every stage in this pipeline asks Claude to respond with "ONLY a
 * JSON object/array, no other text" — and every so often, despite
 * that instruction, a response comes back with conversational preamble
 * before the JSON, or wrapped in a code fence, or both. A naive
 * `.replace(/^```json\s*|```$/g, "")` only strips a fence anchored at
 * the very start/end of the string — it does nothing if prose comes
 * first, which is exactly the failure that happened here (a response
 * starting with "Looking at this list, most candidates are...").
 *
 * This tries progressively more forgiving extraction strategies before
 * giving up, and is used everywhere a model response gets parsed as
 * JSON, rather than each call site having its own fragile version.
 */

export function extractJSON<T>(rawText: string): T {
    const trimmed = rawText.trim()

    // Strategy 1: the whole response is already valid JSON.
    try {
        return JSON.parse(trimmed) as T
    } catch {
        // fall through
    }

    // Strategy 2: a ```json ... ``` fenced block anywhere in the text,
    // not just anchored at the start.
    const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/)
    if (jsonFenceMatch) {
        try {
            return JSON.parse(jsonFenceMatch[1].trim()) as T
        } catch {
            // fall through
        }
    }

    // Strategy 3: a plain ``` ... ``` fenced block with no language tag.
    const plainFenceMatch = trimmed.match(/```\s*([\s\S]*?)```/)
    if (plainFenceMatch) {
        try {
            return JSON.parse(plainFenceMatch[1].trim()) as T
        } catch {
            // fall through
        }
    }

    // Strategy 4: find the first opening bracket/brace and the last
    // matching close, and try that substring. Handles preamble text
    // with no code fence at all.
    const firstArray = trimmed.indexOf("[")
    const firstObject = trimmed.indexOf("{")
    const usesArray =
        firstArray !== -1 && (firstObject === -1 || firstArray < firstObject)
    const openChar = usesArray ? "[" : "{"
    const closeChar = usesArray ? "]" : "}"
    const start = usesArray ? firstArray : firstObject

    if (start !== -1) {
        const end = trimmed.lastIndexOf(closeChar)
        if (end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1)) as T
            } catch {
                // fall through
            }
        }
    }

    throw new Error(
        `Could not extract valid JSON from response using any known strategy. Raw response:\n${rawText}`
    )
}
