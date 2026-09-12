/**
 * SELECT MODULE
 *
 * Takes the raw candidate list from Source and narrows it to exactly 3
 * stories per drop, using the actual story-selection-principles.md and
 * voice-and-editorial-guardrails.md as the live source of truth — not a
 * hardcoded summary of the rules. If those docs change, this stage
 * follows without needing a code update.
 *
 * THREE passes now, not two — the third was added after a real test
 * caught a serious gap: a story whose headline/snippet described only
 * a corruption angle, while the full article also contained child-abuse
 * content that never surfaced in the snippet Select was working from.
 *
 *   1. Cheap local dedup — catches near-identical stories covered by
 *      multiple outlets before spending an API call scoring the same
 *      story three times.
 *   2. Claude-scored PRELIMINARY selection, from snippets — applies the
 *      Two-Question Test, the Portfolio Rule, the category fallback
 *      logic, and the US/major-global relevance priority. Register at
 *      this stage is a guess, not a final answer.
 *   3. MANDATORY full-article safety re-check on the 3 finalists only
 *      (not all 60 candidates — that would be slow and expensive for
 *      no real benefit, since dedup/relevance filtering already did
 *      its job by this point). Fetches the real article for each
 *      finalist and re-determines the register from the actual text,
 *      overriding the preliminary guess if it was wrong.
 */
import { extractJSON } from "./extract-json.js"

import "dotenv/config"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"
import { fetchCandidatesForDrop, type CandidateStory, type DropKey } from "./source.js"
import { fetchArticleText } from "./article-fetch.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
})

const DROP_IDENTITY: Record<DropKey, string> = {
    morning: "Morning — Truth & Clarity (global stability, public systems, economic signals)",
    afternoon: "Afternoon — People & Progress (breakthroughs, community wins, innovation, resilience, positive cultural shifts — growth and human wins, NOT wrongdoing or accountability stories)",
    latenight: "Late Night — Discernment & Reflection (culture pulse, ethical tension, long-arc trends)",
}

export interface SelectedStory {
    title: string
    url: string
    reasoning: string
    register: "full" | "tribute" | "plain"
    registerReason: string
    needsMandatoryReview: boolean
    mandatoryReviewReason: string | null
    registerVerifiedAgainstFullText: boolean
    registerWasCorrectedFromPreliminary: boolean
    factCheckNotes: string | null
}

interface PreliminaryStory {
    title: string
    url: string
    reasoning: string
    register: "full" | "tribute" | "plain"
    registerReason: string
    needsMandatoryReview: boolean
    mandatoryReviewReason: string | null
}

function normalizeForDedup(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((word) => word.length > 3)
        .sort()
        .join(" ")
}

function similarity(a: string, b: string): number {
    const setA = new Set(a.split(" "))
    const setB = new Set(b.split(" "))
    const intersection = new Set([...setA].filter((w) => setB.has(w)))
    const union = new Set([...setA, ...setB])
    if (union.size === 0) return 0
    return intersection.size / union.size
}

const DEDUP_THRESHOLD = 0.6

function dedupeCandidates(candidates: CandidateStory[]): CandidateStory[] {
    const kept: CandidateStory[] = []
    const keptNormalized: string[] = []

    for (const candidate of candidates) {
        const normalized = normalizeForDedup(candidate.title)
        const isDuplicate = keptNormalized.some(
            (existing) => similarity(existing, normalized) >= DEDUP_THRESHOLD
        )
        if (!isDuplicate) {
            kept.push(candidate)
            keptNormalized.push(normalized)
        }
    }

    return kept
}

function loadDoc(filename: string): string {
    const docPath = path.join(__dirname, "..", "docs", filename)
    return fs.readFileSync(docPath, "utf-8")
}

/**
 * PASS 2: preliminary selection from snippets only. Register here is
 * a best guess — Pass 3 is what makes it final.
 */
async function preliminarySelect(
    drop: DropKey,
    candidates: CandidateStory[]
): Promise<PreliminaryStory[]> {
    const selectionPrinciples = loadDoc("story-selection-principles.md")
    const voiceGuardrails = loadDoc("voice-and-editorial-guardrails.md")

    const candidateList = candidates
        .map(
            (c, i) =>
                `${i + 1}. [${c.category.join(", ")}] ${c.title}\n   ${c.description}\n   URL: ${c.url}`
        )
        .join("\n\n")

    const prompt = `You are selecting exactly 3 stories for the "${drop}" drop of a daily news product called Three.

Drop identity: ${DROP_IDENTITY[drop]}

Here is the full story selection framework you must apply:
---
${selectionPrinciples}
---

Here is the voice and editorial guardrails doc, specifically for identifying the exception trigger (death, violence, or child harm):
---
${voiceGuardrails}
---

ADDITIONAL PRIORITY, not in the docs above: Three prioritizes US and major-global-impact news specifically. Deprioritize hyperlocal stories from single small outlets and heavily regional political stories that wouldn't be broadly recognized as US or major-global news, UNLESS a story is otherwise exceptionally strong on the Two-Question Test.

MAJOR STORY OVERRIDE (applies to all drops): if a candidate is significant enough that any serious news outlet would be running it — the bar is genuinely major and unmissable, not routine crime or corruption — it can override normal category fit and be selected for this drop even if it doesn't match the drop's usual identity. This is a rare exception, not a loophole back into routine hard news.

${drop === "afternoon" ? `AFTERNOON-SPECIFIC REQUIREMENT: Afternoon is "People & Progress," not an accountability or wrongdoing category. Every selection needs a real growth, resilience, or human-win angle — something being built, healed, won, or improved — UNLESS the Major Story Override above applies. Do NOT select routine wrongdoing/failure stories with no real resolution just because they're well-written or dramatic; that material belongs in Morning or Late Night if it fits their identity, not here. A partial resolution (e.g., a conviction after a tragedy) does not count as growth — the tragedy is still the dominant feeling. Reject it for this drop unless it clears the Major Story Override bar.` : ""}

IMPORTANT CONTEXT: you are working from headlines and short snippets only, not full articles. A real prior case showed a snippet describing only a corruption angle while the full article also contained serious child-harm content never mentioned in the snippet. Treat your register call here as PRELIMINARY — it will be independently re-checked against the full article text before anything is finalized. Make your best judgment, but don't be overconfident about register specifically.

Here are today's candidate stories for this drop:
---
${candidateList}
---

Select exactly 3 stories. For each one, provide:
- title (copy exactly from the candidate list)
- url (copy exactly from the candidate list)
- reasoning (1-2 sentences: why this passes the Two-Question Test, and how it fits this drop's category identity)
- register: "full", "tribute", or "plain" (best guess from the snippet — will be re-verified)
- registerReason: one sentence explaining the preliminary call
- needsMandatoryReview: true if EITHER (a) this involves a named individual acquitted or cleared of charges in a sexual-abuse-adjacent case, OR (b) this involves disputed/contested violence allegations, especially involving law enforcement or an institutional power imbalance (conflicting accounts, institutional statements vs. video evidence, etc.) — otherwise false
- mandatoryReviewReason: if needsMandatoryReview is true, one sentence identifying which category applies; otherwise null

Also apply the Portfolio Rule: your 3 selections should have real range.

Respond with ONLY a JSON array matching this shape, no other text:
[
  {
    "title": "...",
    "url": "...",
    "reasoning": "...",
    "register": "full",
    "registerReason": "...",
    "needsMandatoryReview": false,
    "mandatoryReviewReason": null
  }
]`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        console.error("\n--- DEBUG: Unexpected response shape ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Content block types:", response.content.map((b) => b.type))
        console.error("--- END DEBUG ---\n")
        throw new Error("Claude response contained no text content — see debug output above")
    }

    try {
        return extractJSON(textBlock.text)
    } catch (err) {
        console.error("\n--- DEBUG: JSON parse failed ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Response length:", textBlock.text.length, "characters")
        console.error("--- END DEBUG ---\n")
        throw new Error(`Failed to parse preliminary selection as JSON. Raw response:\n${textBlock.text}`)
    }
}

/**
 * PASS 3: mandatory full-text safety re-check, one finalist at a time.
 * Fetches the real article and independently re-determines the
 * register from actual content, overriding the preliminary guess
 * whenever the full text disagrees with it.
 */
async function verifyRegisterAgainstFullText(
    preliminary: PreliminaryStory
): Promise<SelectedStory> {
    const voiceGuardrails = loadDoc("voice-and-editorial-guardrails.md")

    let articleText: string
    try {
        articleText = await fetchArticleText(preliminary.url)
    } catch (err) {
        // If we can't fetch the full article, we cannot safely verify
        // register. Fail loudly rather than trust the snippet-based guess.
        throw new Error(
            `Could not fetch full article for safety verification: ${preliminary.url}\n` +
                `${(err as Error).message}\n` +
                `Refusing to finalize this story's register without full-text verification.`
        )
    }

    const prompt = `You are independently verifying a news story pick, using its FULL article text — not the headline or snippet it was originally screened with. Two separate checks, both mandatory.

Voice and editorial guardrails (specifically the exception trigger and mandatory review rules):
---
${voiceGuardrails}
---

Preliminary title: ${preliminary.title}
Preliminary reasoning: ${preliminary.reasoning}
Preliminary register (determined from a snippet, may be wrong): ${preliminary.register.toUpperCase()}
Preliminary register reasoning: ${preliminary.registerReason}
Preliminary mandatory review flag: ${preliminary.needsMandatoryReview}

Full article text:
---
${articleText}
---

CHECK 1 — REGISTER (unchanged from before): Independently determine, from this full text alone, the correct register ("full", "tribute", or "plain" per the exception trigger definition) and whether mandatory human review applies (named individual acquitted/cleared in a sexual-abuse-adjacent case, OR disputed/contested violence allegations involving law enforcement or an institutional power imbalance).

CHECK 2 — FACTUAL ACCURACY (new): Compare every specific, checkable claim in the preliminary title and reasoning against the full article text — numbers, dates, durations ("first time in X years"), names, quantities, quotes. A real prior case caught a story confidently stating "first visit in ten years" when the actual source said "first visit in seven years." Flag ANY such mismatch, however small. If the title itself contains an inaccuracy, provide a corrected title that fixes it while staying factually grounded in the article. If everything checks out, say so plainly rather than inventing a correction that isn't needed.

Respond with ONLY a JSON object, no other text:
{
  "register": "full",
  "registerReason": "...",
  "needsMandatoryReview": false,
  "mandatoryReviewReason": null,
  "correctedTitle": "...",
  "factCheckNotes": null
}

correctedTitle: the title to use going forward — either identical to the preliminary title if it checked out, or a corrected version if it didn't.
factCheckNotes: null if everything checked out; otherwise a clear one-sentence explanation of what was wrong and what was corrected.`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        throw new Error(
            `Register verification returned no text content for ${preliminary.url}`
        )
    }

    let verified: {
        register: "full" | "tribute" | "plain"
        registerReason: string
        needsMandatoryReview: boolean
        mandatoryReviewReason: string | null
        correctedTitle: string
        factCheckNotes: string | null
    }
    try {
        verified = extractJSON(textBlock.text)
    } catch (err) {
        throw new Error(
            `Failed to parse register verification as JSON for ${preliminary.url}. Raw:\n${textBlock.text}`
        )
    }

    const wasCorrected =
        verified.register !== preliminary.register ||
        verified.needsMandatoryReview !== preliminary.needsMandatoryReview

    return {
        title: verified.correctedTitle,
        url: preliminary.url,
        reasoning: preliminary.reasoning,
        register: verified.register,
        registerReason: verified.registerReason,
        needsMandatoryReview: verified.needsMandatoryReview,
        mandatoryReviewReason: verified.mandatoryReviewReason,
        registerVerifiedAgainstFullText: true,
        registerWasCorrectedFromPreliminary: wasCorrected,
        factCheckNotes: verified.factCheckNotes,
    }
}

/**
 * Asks for exactly one replacement candidate when a finalist can't be
 * safety-verified. Excludes anything already selected or already tried
 * and failed, and gives the model the already-selected stories for
 * Portfolio Rule context so the replacement doesn't duplicate a register
 * or topic that's already covered.
 */
async function selectReplacement(
    drop: DropKey,
    candidates: CandidateStory[],
    excludeUrls: Set<string>,
    alreadySelected: SelectedStory[]
): Promise<PreliminaryStory | null> {
    const selectionPrinciples = loadDoc("story-selection-principles.md")
    const voiceGuardrails = loadDoc("voice-and-editorial-guardrails.md")

    const remaining = candidates.filter((c) => !excludeUrls.has(c.url))
    if (remaining.length === 0) return null

    const candidateList = remaining
        .map(
            (c, i) =>
                `${i + 1}. [${c.category.join(", ")}] ${c.title}\n   ${c.description}\n   URL: ${c.url}`
        )
        .join("\n\n")

    const alreadySelectedSummary = alreadySelected
        .map((s) => `- ${s.title} (register: ${s.register})`)
        .join("\n")

    const prompt = `You are picking ONE replacement story for the "${drop}" drop of a daily news product called Three. A previously selected finalist could not be safety-verified (its article couldn't be fetched) and was dropped — you're filling that single gap.

Drop identity: ${DROP_IDENTITY[drop]}

Story selection framework:
---
${selectionPrinciples}
---

Voice and editorial guardrails (for the preliminary register guess):
---
${voiceGuardrails}
---

${drop === "afternoon" ? `AFTERNOON-SPECIFIC REQUIREMENT: Afternoon is "People & Progress." The replacement needs a real growth, resilience, or human-win angle, UNLESS it clears the Major Story Override bar (genuinely major, unmissable news any serious outlet would run).` : ""}

Stories already selected for this drop (pick a replacement that keeps real Portfolio Rule range — don't duplicate register or topic):
${alreadySelectedSummary}

Remaining candidates to choose from:
---
${candidateList}
---

Pick exactly ONE replacement. Respond with ONLY a JSON object, no other text:
{
  "title": "...",
  "url": "...",
  "reasoning": "...",
  "register": "full",
  "registerReason": "...",
  "needsMandatoryReview": false,
  "mandatoryReviewReason": null
}`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        console.error("\n--- DEBUG: Replacement selection unexpected response ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Content block types:", response.content.map((b) => b.type))
        console.error("--- END DEBUG ---\n")
        throw new Error("Replacement selection returned no text content — see debug output above")
    }

    try {
        return extractJSON(textBlock.text)
    } catch (err) {
        console.error("\n--- DEBUG: Replacement selection JSON parse failed ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Response length:", textBlock.text.length, "characters")
        console.error("--- END DEBUG ---\n")
        throw new Error(`Failed to parse replacement selection as JSON. Raw:\n${textBlock.text}`)
    }
}

const MAX_REPLACEMENT_ATTEMPTS = 3

export async function selectStoriesForDrop(drop: DropKey): Promise<SelectedStory[]> {
    const rawCandidates = await fetchCandidatesForDrop(drop)
    const deduped = dedupeCandidates(rawCandidates)

    console.log(`Deduped ${rawCandidates.length} candidates down to ${deduped.length} for ${drop}.`)

    const preliminary = await preliminarySelect(drop, deduped)

    console.log(`\nRunning mandatory full-text safety verification on ${preliminary.length} finalists...`)

    const verified: SelectedStory[] = []
    const triedUrls = new Set<string>(preliminary.map((p) => p.url))
    const permanentlySkipped: { title: string; url: string; reason: string }[] = []

    // Queue starts with the preliminary picks; failed ones get a
    // replacement pushed onto the end, up to the attempt cap.
    let queue = [...preliminary]
    let replacementAttempts = 0

    while (queue.length > 0) {
        const story = queue.shift()!
        try {
            const result = await verifyRegisterAgainstFullText(story)
            verified.push(result)
        } catch (err) {
            if (replacementAttempts >= MAX_REPLACEMENT_ATTEMPTS) {
                permanentlySkipped.push({
                    title: story.title,
                    url: story.url,
                    reason:
                        (err as Error).message +
                        ` (replacement attempt cap of ${MAX_REPLACEMENT_ATTEMPTS} reached — no further retries this run)`,
                })
                continue
            }

            console.log(
                `\n⚠ Could not verify "${story.title}" — finding a replacement (attempt ${replacementAttempts + 1}/${MAX_REPLACEMENT_ATTEMPTS})...`
            )

            replacementAttempts++
            const replacement = await selectReplacement(drop, deduped, triedUrls, verified)

            if (!replacement) {
                permanentlySkipped.push({
                    title: story.title,
                    url: story.url,
                    reason: (err as Error).message + " (no remaining candidates for a replacement)",
                })
                continue
            }

            triedUrls.add(replacement.url)
            queue.push(replacement)
        }
    }

    if (permanentlySkipped.length > 0) {
        console.log(
            `\n⚠ ${permanentlySkipped.length} slot(s) could not be filled even after replacement attempts:`
        )
        permanentlySkipped.forEach((s) => {
            console.log(`   - ${s.title}`)
            console.log(`     ${s.reason}`)
        })
        console.log(`\nThis drop has ${verified.length}/3 verified stories. Manual pick needed for the rest.\n`)
    }

    return verified
}

// Manual test runner. Run with: npx tsx src/select.ts morning
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dropArg = process.argv[2]
    const validDrops: DropKey[] = ["morning", "afternoon", "latenight"]

    if (!dropArg || !validDrops.includes(dropArg as DropKey)) {
        console.error("Usage: npx tsx src/select.ts <morning|afternoon|latenight>")
        process.exit(1)
    }

    selectStoriesForDrop(dropArg as DropKey)
        .then((selected) => {
            console.log(`\nSelected ${selected.length} stories for ${dropArg}:\n`)
            selected.forEach((s, i) => {
                console.log(`${i + 1}. ${s.title}`)
                console.log(`   ${s.url}`)
                console.log(`   Reasoning: ${s.reasoning}`)
                console.log(`   Register (verified against full text): ${s.register.toUpperCase()} — ${s.registerReason}`)
                if (s.registerWasCorrectedFromPreliminary) {
                    console.log(`   🚨 REGISTER CORRECTED from the snippet-based preliminary guess — full-text check caught something the snippet missed.`)
                }
                if (s.factCheckNotes) {
                    console.log(`   🚨 FACT-CHECKED AND CORRECTED: ${s.factCheckNotes}`)
                }
                if (s.needsMandatoryReview) {
                    console.log(`   ⚠ MANDATORY HUMAN REVIEW: ${s.mandatoryReviewReason}`)
                }
                console.log("")
            })
        })
        .catch((err) => {
            console.error("Select stage failed:", err.message)
            process.exit(1)
        })
}
