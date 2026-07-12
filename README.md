# AdvisorLoop

AI does the first pass. You make the call.

AdvisorLoop is an agentic diagnostic tool for solo AI consultants serving SMEs. Paste in a client's raw, messy operational material (WhatsApp order logs, notes, emails) and AdvisorLoop's agents surface concrete, task-level automation opportunities — not a generic "AI strategy" — each tagged by confidence, with an autonomous clarify loop for anything ambiguous, and a strict human review gate before anything reaches a client-facing report.

## Why this exists

Small businesses in Singapore don't need an enterprise AI readiness framework. They need someone to look at their actual daily mess and say exactly what's worth automating first. A solo consultant doesn't have the bandwidth to do that manual first pass for every prospect — AdvisorLoop does it in seconds, and the consultant keeps the judgment, the pricing call, and the client relationship.

## Design principles

- **Sovereignty** — nothing reaches the final report without explicit consultant approval. The consultant sets what the agent may decide on its own.
- **Judgement** — the agent reports observations and confidence, not verdicts. Subjective or relationship-sensitive calls are explicitly flagged as the consultant's to make.
- **Clarify** — when the agent isn't confident, it asks a specific follow-up question instead of guessing.

## Architecture

A lightweight multi-role agent pipeline, orchestrated without a heavy framework:

1. **Parser + Analyst** (`POST /api/analyze`) — one Gemini call with a forced structured JSON output (`responseSchema`). Reads raw material, extracts concrete recurring tasks, assigns a status: `high_confidence`, `needs_clarification`, or `needs_human_judgment`.
2. **Clarifier** (`POST /api/clarify`) — when a task needs clarification, the consultant answers inline and this endpoint re-invokes the Analyst with the new context. The agent decides autonomously whether the task is now resolved or needs a sharper follow-up.
3. **ROI calculator** (`POST /api/roi`) — deliberately deterministic, not an LLM guess. Computes hours saved x hourly rate so every number on screen is auditable.
4. **Compiler** — the frontend assembles only the consultant-*approved* cards into a one-page, client-facing bilingual (EN/ZH) diagnostic report. The report is deliberately sales-oriented, not a raw dump of the work area:
   - **Headline value** — total hours reclaimed per week and estimated monthly value, each annualized (≈ working days / year and $ / year) since SMEs respond to the bigger number.
   - **Preliminary recommendation** per opportunity — one benefit-oriented sentence on the *direction* of improvement (never the implementation how-to, which is the paid phase).
   - **Automation-flow diagram** — an animated inline SVG per high-confidence opportunity showing, conceptually, how the task flows once automated, with emoji actors (🙋 customer / 🧑‍🍳 owner / 🧑‍🔧 worker / 🤖 system).
   - **Export to PDF** (print-optimized) and a closing call-to-action. It shows *what* is worth automating and roughly what it's worth — the paid engagement is the *how*.

The Analyst's ROI, recommendation, and flow are all gated behind the consultant's Approve/Reject decision — the human review gate (Sovereignty) in practice.

## Tech stack

Node.js + Express backend, vanilla-JS single-page frontend (no build step), Google **Gemini** (`gemini-2.5-flash`) for the Analyst/Clarifier with structured JSON output. No database — each diagnostic is stateless. Deployable to Firebase App Hosting (`apphosting.yaml` included).

## Running locally

```bash
cd advisorloop
npm install
cp .env.example .env   # add your GEMINI_API_KEY (from https://aistudio.google.com/apikey)
npm start
```

Open http://localhost:3000 and try one of the three built-in samples from different industries — **🧁 Bakery (WhatsApp)**, **🛒 Grocery (interview)**, or **🚚 Mover (email)** — then click **Analyze**. Approve a few opportunities and switch EN/中文 to see the bilingual client report, then **Export PDF**.

Config (`.env`): `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-2.5-flash`), `PORT` (default 3000). The `start`/`dev` scripts run Node with `--use-system-ca` so HTTPS to the Gemini API works behind a TLS-inspecting corporate proxy.

## Business model

The report is the pre-sales artifact — a free or low-cost diagnostic that proves concrete value before asking for a paid engagement. It intentionally shows *what* is worth automating and roughly what it's worth, not *how* to build it — the implementation detail is the paid phase. This is also literally how the builder runs their own one-person AI consultancy: AdvisorLoop is the tool, and the business it powers, at the same time.
