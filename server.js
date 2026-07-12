import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ---- Structured output schema: Parser + Analyst combined pass ----
const diagnosticSchema = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'short slug id, e.g. task_1' },
          title_en: { type: Type.STRING },
          title_zh: { type: Type.STRING },
          status: {
            type: Type.STRING,
            enum: ['high_confidence', 'needs_clarification', 'needs_human_judgment']
          },
          observation_en: { type: Type.STRING, description: 'One to two honest sentences on what was observed and why this status.' },
          observation_zh: { type: Type.STRING, description: 'Natural Chinese, not a literal translation.' },
          current_hours_per_week: { type: Type.NUMBER },
          after_hours_per_week: { type: Type.NUMBER },
          clarifying_question_en: { type: Type.STRING },
          clarifying_question_zh: { type: Type.STRING },
          recommendation_en: { type: Type.STRING, description: 'Short client-facing benefit-oriented recommendation. Empty for needs_clarification.' },
          recommendation_zh: { type: Type.STRING, description: 'Natural Chinese client-facing recommendation.' },
          automation_flow: {
            type: Type.ARRAY,
            description: 'Ordered 3-5 conceptual steps of how this task flows once automated. Only for high_confidence; empty otherwise.',
            items: {
              type: Type.OBJECT,
              properties: {
                label_en: { type: Type.STRING, description: '2-5 word step label' },
                label_zh: { type: Type.STRING, description: 'natural Chinese, similar length' },
                actor: { type: Type.STRING, enum: ['customer', 'owner', 'worker', 'system'], description: 'Who is at this step. Use "system" for an automated step done by software.' },
                emotion: { type: Type.STRING, enum: ['happy', 'relieved', 'neutral', 'stressed'], description: 'How that actor feels at this step.' }
              },
              required: ['label_en', 'label_zh', 'actor', 'emotion']
            }
          }
        },
        required: [
          'id', 'title_en', 'title_zh', 'status',
          'observation_en', 'observation_zh',
          'current_hours_per_week', 'after_hours_per_week'
        ]
      }
    }
  },
  required: ['tasks']
};

const SYSTEM_PROMPT = `You are the Analyst inside AdvisorLoop, an agentic AI tool that helps a solo AI consultant give SME (small business) clients a fast, honest diagnostic of what is worth automating.

You will be given raw, messy material from a small business (chat logs, notes, emails). Your job:

1. Identify distinct, recurring, concrete tasks or patterns in the material, not abstract strategic themes. Think: what specific repeated action is this person doing over and over.
2. For each task, decide a status:
   - "high_confidence": a clear, repeatable, low-ambiguity task where you can reasonably estimate current vs automated time.
   - "needs_clarification": you do not have enough information to judge frequency, scope, or feasibility. Write ONE specific clarifying question you would ask the consultant.
   - "needs_human_judgment": the task involves relationship, pricing strategy, or subjective judgment that should not be automated away from the business owner. Do not invent a confident recommendation here, say plainly that this needs the consultant's own judgment.
3. Estimate current_hours_per_week and after_hours_per_week as realistic rough numbers for high_confidence tasks. For needs_clarification and needs_human_judgment tasks, still provide a rough current_hours_per_week estimate if inferable, and set after_hours_per_week equal to current_hours_per_week since no automation is claimed yet.
4. Never overstate confidence. If you are not sure, say so. Do not fabricate precision.
5. Write observation_en and observation_zh as one to two honest, plain sentences describing what you observed and why you assigned that status. observation_zh should read as natural Chinese, not a literal translation.
6. Provide 3 to 6 tasks. Quality over quantity.
7. Only include clarifying_question_en / clarifying_question_zh when status is needs_clarification. Otherwise leave them as empty strings.
8. Write a short, client-facing recommendation (recommendation_en / recommendation_zh) as ONE benefit-oriented sentence:
   - high_confidence: the direction of improvement and the payoff (what could be automated or streamlined, and what the owner gets back — e.g. time, fewer mistakes). Speak to the business owner, not the consultant.
   - needs_human_judgment: note plainly that this is a strategic or relationship decision best kept in the owner's own hands, not automated.
   - needs_clarification: leave both empty.
   Do NOT include implementation steps, specific tools, vendors, or technical how-to — that detail is reserved for the paid engagement. recommendation_zh must read as natural Chinese, not a literal translation.
9. For high_confidence tasks only, provide automation_flow: an ordered list of 3 to 5 short steps showing conceptually HOW the task would flow once automated, from the trigger to the final outcome (for example: incoming message -> details captured automatically -> recorded in one place -> owner notified to confirm). Each label_en is 2 to 5 words; label_zh is natural Chinese of similar length. Keep it conceptual — describe the flow of information, NOT specific tools, apps, vendors, code, or setup steps. For each step also set actor (customer, owner, worker, or system — use "system" for a step performed automatically by software) and emotion (happy, relieved, neutral, or stressed) reflecting a believable human arc, e.g. the owner is relieved once a tedious manual step is automated, a customer is happy to get a fast reply. Leave automation_flow empty for needs_clarification and needs_human_judgment tasks.

Respond ONLY with a JSON object matching the required schema (a "tasks" array). Do not include any prose, markdown, or code fences.`;

app.post('/api/analyze', async (req, res) => {
  try {
    const { raw_material } = req.body;
    if (!raw_material || !raw_material.trim()) {
      return res.status(400).json({ error: 'raw_material is required' });
    }
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `Raw client material:\n\n${raw_material}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: diagnosticSchema,
        maxOutputTokens: 8000,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const parsed = parseJsonResponse(response);
    if (!parsed) return res.status(502).json({ error: 'Model did not return valid structured output' });

    res.json({ tasks: parsed.tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Structured output schema: Clarifier re-evaluation pass ----
const clarifySchema = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING, enum: ['high_confidence', 'needs_human_judgment', 'needs_clarification'] },
    observation_en: { type: Type.STRING },
    observation_zh: { type: Type.STRING },
    current_hours_per_week: { type: Type.NUMBER },
    after_hours_per_week: { type: Type.NUMBER },
    clarifying_question_en: { type: Type.STRING },
    clarifying_question_zh: { type: Type.STRING },
    recommendation_en: { type: Type.STRING },
    recommendation_zh: { type: Type.STRING },
    automation_flow: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label_en: { type: Type.STRING },
          label_zh: { type: Type.STRING },
          actor: { type: Type.STRING, enum: ['customer', 'owner', 'worker', 'system'] },
          emotion: { type: Type.STRING, enum: ['happy', 'relieved', 'neutral', 'stressed'] }
        },
        required: ['label_en', 'label_zh', 'actor', 'emotion']
      }
    }
  },
  required: ['status', 'observation_en', 'observation_zh', 'current_hours_per_week', 'after_hours_per_week']
};

app.post('/api/clarify', async (req, res) => {
  try {
    const { title_en, previous_observation_en, question_en, answer } = req.body;
    if (!answer || !answer.trim()) {
      return res.status(400).json({ error: 'answer is required' });
    }
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `Task: ${title_en}\nPrevious observation: ${previous_observation_en}\nClarifying question asked: ${question_en}\nConsultant's answer: ${answer}`,
      config: {
        systemInstruction: `You are the Analyst inside AdvisorLoop. You previously flagged a task as needing clarification. The consultant has now answered your question. Re-evaluate the task with this new information. If it is now clear, mark it high_confidence or needs_human_judgment as appropriate. Only mark needs_clarification again if the answer genuinely did not resolve your concern, and in that case ask a sharper, different follow-up question. When the task resolves to high_confidence or needs_human_judgment, also fill recommendation_en / recommendation_zh with ONE short, client-facing, benefit-oriented sentence (no implementation steps, tools, or technical how-to — that is reserved for the paid engagement); recommendation_zh must read as natural Chinese. When it resolves to high_confidence, also fill automation_flow with 3 to 5 short conceptual steps (label_en 2-5 words, label_zh natural Chinese, plus actor of customer/owner/worker/system and emotion of happy/relieved/neutral/stressed for each) showing how the task flows once automated, from trigger to outcome — conceptual information flow only, no tools or setup steps. Respond ONLY with a JSON object matching the required schema. Do not include any prose, markdown, or code fences.`,
        responseMimeType: 'application/json',
        responseSchema: clarifySchema,
        maxOutputTokens: 2000,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    const parsed = parseJsonResponse(response);
    if (!parsed) return res.status(502).json({ error: 'Model did not return valid structured output' });
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Deterministic ROI calculator (not an LLM call, on purpose) ----
app.post('/api/roi', (req, res) => {
  const { current_hours_per_week, after_hours_per_week, hourly_rate } = req.body;
  const rate = Number(hourly_rate) || 20;
  const hoursSaved = Math.max(0, Number(current_hours_per_week) - Number(after_hours_per_week));
  const weeklyValue = hoursSaved * rate;
  const monthlyValue = weeklyValue * 4.33;
  res.json({
    hours_saved_per_week: Math.round(hoursSaved * 10) / 10,
    monthly_value: Math.round(monthlyValue)
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, model: MODEL }));

// Gemini returns the JSON payload as text when responseMimeType is application/json.
function parseJsonResponse(response) {
  const text = response.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdvisorLoop running on http://localhost:${PORT}`));
