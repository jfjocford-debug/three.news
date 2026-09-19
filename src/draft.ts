/**
 * DRAFT MODULE
 *
 * Takes a story that already passed Select (with its register already
 * determined) and writes the full six-field story per the voice and
 * editorial guardrails.
 *
 * TWO GENUINELY SEPARATE CALLS, not one call with a self-check bolted
 * on. A real test proved the self-check approach doesn't work: asking
 * a model to fact-check its own output in the same breath it just
 * wrote it is weak — it confirmed a headline calling something Dolly
 * Parton's "final recording" (every source called it her FIRST
 * posthumous song) not once but twice, even with an explicit
 * instruction to check exactly that kind of claim. This mirrors
 * exactly why Select's Pass 3 works: a fresh call with no momentum
 * toward the narrative it just built is a real check. A self-check
 * inside the same generation pass is not.
 *
 *   1. WRITE — generate the six fields, per register.
 *   2. FACT-CHECK — a separate call, given only the draft and the
 *      source text, independently verifies every checkable claim and
 *      rewrites anything unsupported. This call has no investment in
 *      the draft being right.
 *
 * Artwork here is a PROPOSAL only (era + rationale) — the Artwork
 * stage (not yet built) is responsible for actually finding a real,
 * specific piece from the Met's Open Access API matching this
 * proposal.
 *
 * Both passes now run on Sonnet, not Haiku. Haiku was originally chosen
 * for the write pass on the theory that drafting was "template-following,
 * not creative reasoning" — that was wrong specifically for voice. Real
 * published output confirmed it: technically accurate, but reading like
 * a generic newsroom explainer with none of the texture, metaphor, or
 * personality this product is supposed to have. Writing in this voice
 * turned out to be a creative-quality-dependent task after all.
 *
 * VOICE FIX (this revision): real published output over several days
 * of live drops surfaced two concrete, recurring problems — not vague
 * "needs more personality" drift, but two specific, traceable causes:
 *
 *   1. Nearly every "Why It Matters" landed via the same rhetorical
 *      move ("it's not really about X — it's about Y"), in near-
 *      identical three-sentence rhythm, story after story. Root
 *      cause: the prompt specified a rigid three-part structure AND
 *      the only example given demonstrated exactly that shape — the
 *      model was faithfully reproducing the one pattern it was ever
 *      shown, not drifting on its own. Fixed by adding a second,
 *      differently-shaped example (shorter, blunter, no reframe) and
 *      explicit instruction to vary rhythm rather than defaulting to
 *      one structural formula.
 *   2. "What's Next" repeatedly fell back to flat wire-service
 *      boilerplate ("[X] has not responded to requests for comment")
 *      whenever there was genuinely nothing forward-looking to
 *      report. Root cause: no instruction existed for this case at
 *      all, so the model defaulted to trained-in wire-copy phrasing.
 *      Fixed with an explicit instruction against that specific
 *      pattern.
 */
import { extractJSON } from "./extract-json.js"

import "dotenv/config"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"
import { fetchArticleText } from "./article-fetch.js"
import type { SelectedStory } from "./select.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
})

export interface DraftedStory {
    registerVerified: boolean
    registerMismatchWarning: string | null
    factCheckNotes: string | null
    headline: string
    whatHappened: string
    whyItMatters: string
    whatsNext: string
    takeaway: string
    artworkProposal: {
        era: "Renaissance" | "Classical Greek" | "Neoclassicism" | "Baroque"
        concept: string
        rationale: string
    }
}

interface RawDraft {
    sourceContentUsable: boolean
    headline: string | null
    whatHappened: string | null
    whyItMatters: string | null
    whatsNext: string | null
    takeaway: string | null
    artworkProposal: {
        era: "Renaissance" | "Classical Greek" | "Neoclassicism" | "Baroque"
        concept: string
        rationale: string
    } | null
}

function loadDoc(filename: string): string {
    const docPath = path.join(__dirname, "..", "docs", filename)
    return fs.readFileSync(docPath, "utf-8")
}

const REGISTER_INSTRUCTIONS: Record<SelectedStory["register"], string> = {
    full: `Write this in FULL VOICE per the guardrails: deadpan, culturally fluent, internet-native. The Humor Toolkit applies (one real joke max, placed only in Takeaway or the closing beat of What Happened, never announced — OR understatement anywhere). Why It Matters must land real insight — impact, how the story is actually landing, and something worth noticing about the pattern — but NOT through the same rhetorical move every time.

AVOID DEFAULTING TO ONE STRUCTURAL FORMULA. A specific failure pattern to watch for: reaching for "it's not really about X — it's about Y" as the closing move on almost every story. That construction is a fine tool to reach for occasionally, not the required shape of Why It Matters. If you notice yourself building toward that exact reframe, try landing the insight a different way instead — sometimes the blunt fact stated once is stronger than a reframe. Vary sentence rhythm too: not every Why It Matters needs to be exactly three full, similarly-sized sentences. A fragment. A short blunt line after a longer one. Real voice is uneven, not metronomic.

REGISTER SHOULD DIP CASUAL, NOT SIT AT ONE ALTITUDE. Full voice is not "smart newsletter" register held constant the whole time — let contractions in, drop the subject of a sentence the way a text message would, use fragments where they land harder than a complete sentence. Someone relaying this to a friend doesn't maintain one consistent formal register for three sentences straight.

CRITICAL — abstract rules alone are not enough. Vivid, specific, metaphorical language is fully permitted per the "vibe ≠ fabrication" rule (fabricating facts/quotes/events is never permitted; interpreting how a real, verified thing FELT is). Here is what that actually sounds like in practice — study the density, confidence, AND VARIETY of the language, not just the content:

EXAMPLE ONE (the reframe device — fine to use occasionally, NOT the default move):
What Happened: "Two hours of lightning delay. Then LSU ran 23 plays for 140 yards in the first quarter alone and never let Clemson back into the building. 31-3 by halftime."
Why It Matters: "This is the kind of opener that becomes its own storyline before the final whistle — the score, the halftime one-liner, Swinney's face on the sideline, all doing laps online before midnight. Neither reaction is really about Week 1. It's about how fast a feed needs a new storyline, and how little it actually takes to hand it one."
Takeaway: "Clemson came to open a season and left as a cautionary tale before September was even a week old."

EXAMPLE TWO (blunt and uneven, no reframe — equally correct full voice, not a lesser version of Example One):
What Happened: "The Late Show won Outstanding Variety Series at the Emmys — and Colbert didn't spend the speech on himself. Told the room his old writers and staff are looking for work, plug and everything. Also thanked his wife Evelyn, called her laugh 'the laugh I want for the rest of my life.'"
Why It Matters: "A cancelled show just won the category it got cancelled out of. Colbert spent the win recruiting for his old staff instead of taking a lap. The applause is for the show. The rent is due for the staff."

Notice EXAMPLE TWO never reaches for "it's not really about X." It states things plainly, drops the subject on a sentence ("Told the room..."), and lets a short blunt line do the closing work instead of a reframed thesis. Both examples are correct full voice — vary between shapes like these rather than defaulting to Example One's structure every time.`,
    tribute: `Write this in TRIBUTE REGISTER per the guardrails: warmth, not neutrality, is the goal. No jokes, no understatement-as-humor — the Humor Toolkit does not apply here. Why It Matters is explicitly permitted to be more crafted and resonant than the plain register allows — lean toward giving the reader something genuinely moving to carry with them, closer to a eulogy than a news brief. The swap test does not apply the same way — this can be specific to the actual person's life and legacy. CRITICAL: this warmth permission is about HOW real facts are delivered, never permission to invent an emotionally satisfying detail that isn't actually in the source — a moving detail is only usable if the source states it.

EXAMPLE (a real story, tribute register):
Why It Matters: "A recording made in 2022 becomes a goodbye when the person who made it is no longer here. [Subject] spent decades building her legacy in moments just like this one — a small collaboration with musicians she respected, work done quietly and shared later."
Notice: genuinely warm and resonant, a real crafted turn of phrase — but every word traceable to the actual source. Nothing invented about what the subject knew, intended, or would have wanted unless the source states it directly.`,
    plain: "Write this in STRICT PLAIN REGISTER per the guardrails: flat and economical, not dramatic. No fragment-for-rhythm, no aphoristic turns, no jokes, no understatement-as-humor. Why It Matters still carries real insight — but 'insight stays, ornamentation goes.' The insight must read like plain observation, never like a crafted, quotable line, since this involves real harm or tragedy and polish-for-its-own-sake risks reading as using it as material.",
}

/**
 * PASS 1: register safety check + writing, in one call. The register
 * check here is still useful as a first pass (it worked fine in
 * testing), but factual accuracy is NOT trusted from this call alone
 * anymore — Pass 2 independently re-verifies every claim.
 */
async function writeDraft(
    story: SelectedStory,
    articleText: string,
    voiceGuardrails: string
): Promise<{ draft: RawDraft; registerVerified: boolean; registerMismatchWarning: string | null }> {
    const prompt = `You are writing a story for "Three," a daily news product, using its house voice and editorial guardrails.

Full guardrails doc for reference:
---
${voiceGuardrails}
---

This story was selected upstream and its register was PRELIMINARILY determined as: ${story.register.toUpperCase()}
Preliminary reasoning (may have been based on incomplete information — a headline/snippet, not the full article): ${story.registerReason}

STEP 0 — MANDATORY CONTENT CHECK, BEFORE ANYTHING ELSE:
The text below was fetched from a URL and passed a minimum length check, but that doesn't guarantee it's actually a news article. Sometimes a fetch resolves to a paywall page, a subscription/pricing page, an error page, or other non-article content that happens to be long enough to pass a length check while containing zero actual news content — no event, no names, no quotes, no claims.

If the text below is NOT usable news article content, set "sourceContentUsable" to false and set every other content field to null. Do not attempt to write anything from it, and do not treat this as a reason to invent plausible-sounding content — an empty or unusable source means an empty draft, not a creative writing prompt.

If it IS usable article content, set "sourceContentUsable" to true and proceed to Steps 1-3 below.

STEP 1 — MANDATORY REGISTER SAFETY CHECK, BEFORE WRITING ANYTHING:
Read the full source article text below in its entirety. Independently determine whether it actually contains death, violence, or child harm — regardless of what the preliminary register above says.

Also check: does this involve a named individual acquitted or cleared of charges in a sexual-abuse-adjacent case? That requires mandatory human review regardless of register.

Set "registerVerified" to true whenever your independently-determined register VALUE matches the preliminary register value given above, even if your reasoning is more detailed than the preliminary reasoning. Only set it to false if the actual register is genuinely different. If it IS a genuine mismatch, explain it in "registerMismatchWarning" and use the corrected register for the rest of this draft.

STEP 2 — WRITE THE STORY, using whichever register is actually correct per Step 1:
${REGISTER_INSTRUCTIONS.full}
[TRIBUTE register instructions, if applicable: ${REGISTER_INSTRUCTIONS.tribute}]
[PLAIN register instructions, if applicable: ${REGISTER_INSTRUCTIONS.plain}]

WHAT'S NEXT — AVOID WIRE-SERVICE BOILERPLATE: When there's genuinely no forward-looking development to report, do NOT default to stock wire-service phrases like "[X] has not responded to requests for comment" or "no further details were specified in the report." These read as flat AP-style filler, not this voice, and they've shown up as a repeated pattern across otherwise well-written stories. Instead: look for the one real forward-looking thread the source actually offers, even a small one (a hearing date, a promised follow-up, an open question someone raised) — and if there truly is nothing, say so plainly and specifically in the piece's own voice rather than in press-release language. "Nobody's said what's next" beats "has not responded to requests for comment" every time.

CRITICAL RULE: only use facts, numbers, quotes, and details that actually appear in the source article text below. Never invent a quote, a reaction, a statistic, or an event that isn't in this text. This includes superlatives and exclusivity claims like "first," "last," "final," "only," "never" — these are checkable factual claims, not color.

Source article text:
---
${articleText}
---

Write all six fields per the content structure table in the guardrails doc (Headline, What Happened, What's Next, and Takeaway word counts apply; Why It Matters is 40-80 words, up to 100 only if genuinely needed).

Also propose artwork: pick an era (Renaissance, Classical Greek, Neoclassicism, or Baroque — Baroque only if the metaphor is unusually strong), a brief concept description, and a one-sentence internal rationale.

If sourceContentUsable is true, respond with ONLY a JSON object matching this shape, no other text:
{
  "sourceContentUsable": true,
  "registerVerified": true,
  "registerMismatchWarning": null,
  "headline": "...",
  "whatHappened": "...",
  "whyItMatters": "...",
  "whatsNext": "...",
  "takeaway": "...",
  "artworkProposal": {
    "era": "Renaissance",
    "concept": "...",
    "rationale": "..."
  }
}

If sourceContentUsable is false, respond instead with ONLY:
{
  "sourceContentUsable": false,
  "registerVerified": true,
  "registerMismatchWarning": null,
  "headline": null,
  "whatHappened": null,
  "whyItMatters": null,
  "whatsNext": null,
  "takeaway": null,
  "artworkProposal": null
}`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        console.error("\n--- DEBUG: Write pass unexpected response ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Content block types:", response.content.map((b) => b.type))
        console.error("--- END DEBUG ---\n")
        throw new Error("Write pass returned no text content — see debug output above")
    }

    try {
        const parsed = extractJSON<any>(textBlock.text)
        return {
            draft: {
                sourceContentUsable: parsed.sourceContentUsable,
                headline: parsed.headline,
                whatHappened: parsed.whatHappened,
                whyItMatters: parsed.whyItMatters,
                whatsNext: parsed.whatsNext,
                takeaway: parsed.takeaway,
                artworkProposal: parsed.artworkProposal,
            },
            registerVerified: parsed.registerVerified,
            registerMismatchWarning: parsed.registerMismatchWarning,
        }
    } catch (err) {
        console.error("\n--- DEBUG: Write pass JSON parse failed ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Response length:", textBlock.text.length, "characters")
        console.error("--- END DEBUG ---\n")
        throw new Error(`Failed to parse write pass response as JSON. Raw:\n${textBlock.text}`)
    }
}

/**
 * PASS 2: genuinely separate fact-check call. This call has never
 * seen itself write the draft — it's handed the finished draft and
 * the source text cold, and asked to independently verify every
 * checkable claim. No momentum toward confirming what it just wrote,
 * because it didn't just write anything.
 */
async function factCheckDraft(
    draft: RawDraft,
    articleText: string
): Promise<{ finalDraft: RawDraft; factCheckNotes: string | null }> {
    const draftText = `Headline: ${draft.headline}
What Happened: ${draft.whatHappened}
Why It Matters: ${draft.whyItMatters}
What's Next: ${draft.whatsNext}
Takeaway: ${draft.takeaway}`

    const prompt = `You are an independent fact-checker. You did NOT write the draft below — someone else did. Your only job is to verify it against the source text and correct anything wrong. You have no investment in the draft being right.

DRAFT TO CHECK:
---
${draftText}
---

SOURCE ARTICLE TEXT (the only source of truth):
---
${articleText}
---

Check every specific, checkable claim in the draft against the source: numbers, dates, names, quotes, and ESPECIALLY any claim of exclusivity or sequence — "first," "last," "final," "only," "never," "still," or any claim about what someone did or didn't know/intend. These are common places for a draft to state something that sounds right but isn't actually confirmed by the source, or that the source directly contradicts.

Known failure pattern to watch for specifically: a draft calling something someone's "final" or "last" X when the source only says it's their most recent, or their "first" of a planned series — these are opposite claims and get confused easily. Also watch for invented interiority — claims about what someone "didn't know," "would have wanted," or "never got to" that aren't actually stated in the source.

If you find any unsupported or contradicted claim, rewrite the specific field(s) needed to fix it — keep everything else in the draft unchanged. Explain what you changed and why in "factCheckNotes." If the draft is fully accurate as written, return it unchanged and set "factCheckNotes" to null — do not invent a correction that isn't needed, but do not rubber-stamp something wrong either.

Respond with ONLY a JSON object, no other text:
{
  "headline": "...",
  "whatHappened": "...",
  "whyItMatters": "...",
  "whatsNext": "...",
  "takeaway": "...",
  "factCheckNotes": null
}`

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
    })

    const textBlock = response.content.find((block) => block.type === "text")
    if (!textBlock || textBlock.type !== "text") {
        console.error("\n--- DEBUG: Fact-check pass unexpected response ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Content block types:", response.content.map((b) => b.type))
        console.error("--- END DEBUG ---\n")
        throw new Error("Fact-check pass returned no text content — see debug output above")
    }

    let result: {
        headline: string
        whatHappened: string
        whyItMatters: string
        whatsNext: string
        takeaway: string
        factCheckNotes: string | null
    }
    try {
        result = extractJSON(textBlock.text)
    } catch (err) {
        console.error("\n--- DEBUG: Fact-check pass JSON parse failed ---")
        console.error("Stop reason:", response.stop_reason)
        console.error("Response length:", textBlock.text.length, "characters")
        console.error("--- END DEBUG ---\n")
        throw new Error(`Failed to parse fact-check pass response as JSON. Raw:\n${textBlock.text}`)
    }

    return {
        finalDraft: {
            sourceContentUsable: true,
            headline: result.headline,
            whatHappened: result.whatHappened,
            whyItMatters: result.whyItMatters,
            whatsNext: result.whatsNext,
            takeaway: result.takeaway,
            artworkProposal: draft.artworkProposal,
        },
        factCheckNotes: result.factCheckNotes,
    }
}

async function draftStory(story: SelectedStory): Promise<DraftedStory> {
    const articleText = await fetchArticleText(story.url)
    const voiceGuardrails = loadDoc("voice-and-editorial-guardrails.md")

    const { draft, registerVerified, registerMismatchWarning } = await writeDraft(
        story,
        articleText,
        voiceGuardrails
    )

    if (!draft.sourceContentUsable) {
        throw new Error(
            `The fetched content at ${story.url} was not usable news article content ` +
                `(likely a paywall, subscription page, or similar non-article page that happened ` +
                `to pass the minimum-length check). Refusing to draft — this is a content problem ` +
                `with the source, not a failure to fix by retrying the same URL.`
        )
    }

    const { finalDraft, factCheckNotes } = await factCheckDraft(draft, articleText)

    return {
        registerVerified,
        registerMismatchWarning,
        factCheckNotes,
        headline: finalDraft.headline as string,
        whatHappened: finalDraft.whatHappened as string,
        whyItMatters: finalDraft.whyItMatters as string,
        whatsNext: finalDraft.whatsNext as string,
        takeaway: finalDraft.takeaway as string,
        artworkProposal: finalDraft.artworkProposal as NonNullable<RawDraft["artworkProposal"]>,
    }
}

export { draftStory }

// Manual test runner. Run with: npx tsx src/draft.ts <url> <register>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const url = process.argv[2]
    const register = process.argv[3] as SelectedStory["register"] | undefined

    if (!url || !register || !["full", "tribute", "plain"].includes(register)) {
        console.error("Usage: npx tsx src/draft.ts <article-url> <full|tribute|plain>")
        process.exit(1)
    }

    const testStory: SelectedStory = {
        title: "(manual test — title not used in prompt, only article text)",
        url,
        reasoning: "",
        register,
        registerReason: "manually specified for testing",
        needsMandatoryReview: false,
        mandatoryReviewReason: null,
        registerVerifiedAgainstFullText: false,
        registerWasCorrectedFromPreliminary: false,
        factCheckNotes: null,
    }

    draftStory(testStory)
        .then((draft) => {
            if (!draft.registerVerified) {
                console.log("\n🚨🚨🚨 REGISTER MISMATCH DETECTED 🚨🚨🚨")
                console.log("The preliminary register was WRONG. Draft corrected it.")
                console.log("Warning:", draft.registerMismatchWarning)
                console.log("🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n")
            }
            if (draft.factCheckNotes) {
                console.log("\n🚨🚨🚨 INDEPENDENT FACT-CHECK CAUGHT AND CORRECTED SOMETHING 🚨🚨🚨")
                console.log(draft.factCheckNotes)
                console.log("🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n")
            }
            console.log("\n--- DRAFT (post fact-check) ---\n")
            console.log("Headline:", draft.headline)
            console.log("\nWhat Happened:", draft.whatHappened)
            console.log("\nWhy It Matters:", draft.whyItMatters)
            console.log("\nWhat's Next:", draft.whatsNext)
            console.log("\nTakeaway:", draft.takeaway)
            console.log("\nArtwork proposal:")
            console.log("  Era:", draft.artworkProposal.era)
            console.log("  Concept:", draft.artworkProposal.concept)
            console.log("  Rationale:", draft.artworkProposal.rationale)
        })
        .catch((err) => {
            console.error("Draft stage failed:", err.message)
            process.exit(1)
        })
}
