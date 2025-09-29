import type { Handler } from "@netlify/functions";
import { z } from "zod";

// ---- Config & helpers ----
const MODE = (process.env.LLM_MODE ?? "mock").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// validation
const Req = z.object({
  profile: z.object({ grade: z.string(), dyslexiaAssist: z.boolean() }),
  subject: z.enum(["reading", "writing", "math", "science", "study"]),
  message: z.string().max(400),
});

// profanity
function isProfane(text: string): boolean {
  const patterns = [/\bhell\b/i, /\bdamn\b/i, /\bshit\b/i, /\bfuck\b/i];
  return patterns.some((re) => re.test(text));
}

// system prompt
function buildSystem(profile: { grade: string; dyslexiaAssist: boolean }, subject: string) {
  return [
    `You are a kind home tutor for a ${profile.grade}-grade student.`,
    profile.dyslexiaAssist
      ? "Use short sentences, plain words, 3–5 bullet steps, **bold** key words, concrete examples, visual language. End with: 'Want me to read this out loud?'"
      : "Keep answers concise and clear.",
    "Always ask one quick check question and offer: hint, example, or simpler explanation.",
    subject === "math" ? "Math: one step at a time. Show a worked example, then 'Your turn.'" : "",
  ].join(" ");
}

// build a JSON response with CORS headers (same-origin calls won’t need them, but harmless)
function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      // No need for Access-Control-Allow-Origin when same-origin,
      // but leaving '*' helps if you test from localhost vite.
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  // Preflight (if any)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  // Health
  if (event.httpMethod === "GET" && event.path.endsWith("/tutor")) {
    return json(200, { ok: true, mode: MODE });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // Parse body
  let bodyObj: unknown;
  try {
    bodyObj = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "bad_json" });
  }

  const parsed = Req.safeParse(bodyObj);
  if (!parsed.success) return json(400, { error: "bad_request" });

  const { profile, subject, message } = parsed.data;
  if (isProfane(message)) return json(400, { error: "language" });

  // ---- mock mode ----
  if (MODE === "mock") {
    const m = message.toLowerCase();

    if (m.includes("please simplify the explanation even more")) {
      const text = `• **Reciprocal** = flip the second fraction.
• Multiply top numbers.
• Multiply bottom numbers.
• **Reduce** if you can.
**Example:** 1/2 ÷ 1/4 → 1/2 × 4/1 = 4/2 = 2.
**Check:** 3/5 ÷ 1/2 = ?
${profile.dyslexiaAssist ? "Want me to read this out loud?" : ""}`;
      return json(200, { text });
    }

    if (m.includes("show numbered steps with one action per line")) {
      const text = `1) Write the **reciprocal** of the second fraction.
2) Multiply numerators.
3) Multiply denominators.
4) **Simplify** the result.
Example: 1/2 ÷ 1/4 = 1/2 × 4/1 = 4/2 = 2.
Check: What is 3/5 ÷ 1/2?
${profile.dyslexiaAssist ? "Want me to read this out loud?" : ""}`;
      return json(200, { text });
    }

    if (m.includes("give me one helpful hint")) {
      const text = `**Hint:** Turn division into multiplication by the **reciprocal** of the second fraction, then multiply across.
Your turn: 3/5 ÷ 1/2 = ?
${profile.dyslexiaAssist ? "Want me to read this out loud?" : ""}`;
      return json(200, { text });
    }

    const text = `• Flip the second fraction (**reciprocal**).
• Multiply the numerators.
• Multiply the denominators.
• Simplify if possible.
**Example:** 1/2 ÷ 1/4 = 1/2 × 4/1 = 4/2 = 2.
**Check:** What is 3/5 ÷ 1/2?
${profile.dyslexiaAssist ? "Want me to read this out loud?" : ""}`;
    return json(200, { text });
  }

// ---- openai mode ----
if (MODE === "openai") {
  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  const MAX_TOKENS = Math.min(
    Number(process.env.OPENAI_MAX_TOKENS ?? 1500),
    4000 // safety cap
  );

  const baseMessages = [
    { role: "system", content: buildSystem(profile, subject) },
    { role: "user", content: `Subject: ${subject}\nStudent: ${message}` },
  ] as const;

  async function getChunk(msgs: any[]) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: msgs,
        max_tokens: MAX_TOKENS,   // ⬅ increase output budget here
        temperature: 0.2,
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return { error: `openai_bad_response`, detail: err } as const;
    }
    const data: any = await r.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const finish = choice?.finish_reason ?? "stop";
    return { text, finish } as const;
  }

  // First chunk
  const first = await getChunk(baseMessages);
  if ("error" in first) return json(502, first);
  let output = first.text;

  // If the model hit the token limit, ask it to continue once
  if (first.finish === "length") {
    const contMsgs = [
      ...baseMessages,
      { role: "assistant", content: first.text },
      { role: "user", content: "Please continue from where you left off." },
    ];
    const second = await getChunk(contMsgs);
    if (!("error" in second)) {
      output += (output && second.text ? "\n" : "") + second.text;
    }
  }

  return json(200, { text: output || "Sorry, try again." });
}


  return json(500, { error: "llm_not_configured" });
};

export default handler;
