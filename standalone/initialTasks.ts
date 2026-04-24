/**
 * Initial-task strings handed to agents when they're dispatched.
 *
 * These are the per-launch counterpart to the system prompts in
 * `systemPrompts.ts`. Separated out so the template literals (which get long)
 * don't bloat the orchestration handlers in `clickupHandlers.ts`.
 *
 * Convention: every builder returns a string WITHOUT the EXIT_REMINDER
 * appended — the caller adds it via `launchHelpers.EXIT_REMINDER`. Keeping
 * the reminder at the call site makes it easy to spot if a handler forgets
 * it.
 */

import {
	DARRYL_ESCALATION_USERNAME,
	SERVER_PORT,
	AI_REVIEW_AUTO_ESCALATE,
} from './constants.js';

// ── Darryl workers (dev tickets) ─────────────────────────────

export function buildWorkerAiReviewInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	briefBlock: string,
): string {
	return `Ticket ${ticketId}: "${ticketName}" is in **AI Review**. Copilot reviewed the PR — you process the feedback.
Ticket URL: ${ticketUrl}

${briefBlock}## Steps
1. Move ticket to "in progress".
2. Find the PR (branch \`feature/CU-${ticketId}-*\`). Read Copilot's review + inline comments via \`mcp__github__pull_request_read\`.
3. Triage: actionable (real bug / security / broken convention) vs not (style opinions you disagree with, already-addressed).
4a. Actionable: check out the branch, fix, commit with \`CU-${ticketId}\` ref, push, comment what you addressed + what you deliberately skipped (and why), then move ticket to "qa test".
4b. Nothing actionable: comment confirming review, move ticket to "qa test".

**HARD RULE:** You MUST NOT move the ticket back to "ai review". Only humans flip tickets into "ai review". After you\'ve addressed Copilot, always land on "qa test" so a human can decide whether another Copilot pass is warranted. Commit+push before flipping to "qa test".`;
}

export function buildWorkerStandardInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	briefBlock: string,
): string {
	return `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}).

${briefBlock}## Steps
1. Move ticket to "in progress".
2. Check out or create branch \`feature/CU-${ticketId}-<short-desc>\` from develop.
3. Do the work. Rely on the Brief above — only re-read the ticket if the Brief is missing something specific.
4. Open a PR. Commit messages must include \`CU-${ticketId}\`.
5. Move ticket to **"qa test"**. A human reviews from there.

**HARD RULE:** Never move the ticket to "ai review" — that status is human-only. Only humans flip tickets into "ai review"; you always land on "qa test".`;
}

// ── Darryl (foreman) ──────────────────────────────────────────

export function buildDarrylBatchInitialTask(
	batch: Array<{ id: string; name: string; url: string; status: 'to do' | 'ai review' }>,
): string {
	const ticketLines = batch.map((t, i) =>
		`${i + 1}. **[${t.status.toUpperCase()}]** ${t.id}: "${t.name}" (${t.url})`,
	).join('\n');

	return `You have ${batch.length} ticket${batch.length === 1 ? '' : 's'} to dispatch. Work through them in order — do NOT stop after the first one. You are a pure orchestrator: you ASSESS and DISPATCH, you never implement yourself.

${ticketLines}

## For each ticket above:

### If status is **"to do"**
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once.
2. Is the ticket complete enough to dispatch?
   - **No** → comment with specific questions, unassign yourself, assign "${DARRYL_ESCALATION_USERNAME}", leave the ticket in "to do", move on to the next ticket.
   - **Yes** → pick the right free agent from \`GET http://localhost:${SERVER_PORT}/api/roster\` (offline=free) whose \`workspacePath\` matches the ticket's project, then dispatch them with a Brief:
     \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-agent -d '{"agentId":"...","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"<Brief>","useTeam":<bool>}'\`
3. On \`success:true\` move the ticket to "in progress". On \`success:false\` leave it alone and move on — the next pickup cycle will retry.

### If status is **"ai review"**
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Find the original implementer via the "Assigned to worker: <name>" comment. Count prior AI Review rounds.
2. Pick that implementer (best context) or, if they're busy/retired, another free agent in the same workspace.
3. Dispatch with \`aiReviewMode:true\` and a short Brief summarising Copilot's feedback:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-agent -d '{"agentId":"...","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","aiReviewMode":true,"additionalPrompt":"<Brief>"}'\`
4. Comment naming who you reassigned. Do NOT change the ticket status — the reassigned agent will.
5. 3+ prior rounds → tell them in the Brief to be conservative and forward to "qa test" unless there's a real bug.

## When you're done
After dispatching (or skipping) every ticket above, you are DONE. Do not wait for workers to finish — they run in parallel on their own timelines. Exit cleanly.

The Brief should summarise the ticket in 2–6 bullets so the worker doesn't re-read everything. Use the briefing template from your system prompt.`;
}

// ── Jan (Art Director) ────────────────────────────────────────

export function buildJanRefineInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
): string {
	return `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}) — status **"to refine"** → Phase 1 UX Exploration.

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. If the brief is unclear, comment with questions and leave the status as "to refine". Stop.
2. Move ticket to "in progress". Capture: the parent list id, the project workspace (e.g. \`~/Projects/brightmind\`).
3. **Write 5 UX briefing sub-tickets** (follow the "UX briefing creation" section of your system prompt — one direction per sub-ticket, FULL scope each, different axes).
4. **Dispatch one designer per sub-ticket** in quick succession (fleet runs them in parallel). For EACH sub-ticket:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-designer -d '{"workspacePath":"<project>","ticketId":"<sub-id>","ticketName":"UX Direction N: ...","ticketUrl":"<sub-url>","additionalPrompt":"<Brief>"}'\`
   The Brief (template in your system prompt) tells the designer what to build without needing to re-read everything.
5. Only \`success:true\` counts as dispatched. On \`success:false\`, leave sub-ticket status alone, wait ~60s, retry.
6. Poll ticket statuses instead of blocking. When all 5 are in "qa test", review them and comment with art-direction feedback.`;
}

export function buildJanSingleTodoInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
): string {
	return `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}) — status **"to do"** → Phase 2 Visual Design.

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Try to find an approved UX direction (a sub-ticket tagged \`UX-prototype-briefing\`, or a Figma node URL posted as a comment, or an explicit "approved UX:" line).
   - **If you find approved UX** → your Brief cites that Figma node URL + any DS notes.
   - **If there is NO UX sub-ticket and NO UX Figma URL in the comments** → treat this as a greenfield visual task. Do NOT go hunting for UX, do NOT stall, do NOT ask questions. Write a Brief from the ticket description alone and dispatch. Mention in the Brief that there is no prior UX so the designer knows they're defining the layout themselves.
2. Dispatch ONE Visual Designer with the Brief:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"<project>","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","additionalPrompt":"<Brief>"}'\`
   Brief template is in your system prompt — fill what you have, flag what's missing.
3. Only \`success:true\` counts. On \`success:false\`, leave ticket alone, wait ~60s, retry.
4. ${AI_REVIEW_AUTO_ESCALATE
		? 'That\'s it for you — Visual QA AI Review runs automatically when the designer finishes. PASS → "qa test", FAIL → revision auto-pickup.'
		: 'That\'s it for you — the designer will move the ticket to "qa test" when finished, and a human reviews from there.'}`;
}

// ── UX Designer ──────────────────────────────────────────────

export function buildUxDesignerInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	briefBlock: string,
	revisionMode: boolean,
): string {
	const revisionLine = revisionMode
		? 'REVISION: read the LATEST Jan review comment on the ticket for required changes. Preserve what was approved.\n\n'
		: '';
	return `Ticket ${ticketId}: "${ticketName}" (${ticketUrl})

${revisionLine}${briefBlock}## Steps
1. Move ticket to "in progress".
2. Open a new Figma page: \`${ticketId} — ${ticketName}\`.
3. Design based on the Brief above. Only pull the sub-ticket if you need a detail the Brief doesn't cover.
4. Screenshot + post Figma page URL as a ClickUp comment.
5. Move ticket to "qa test".`;
}

// ── Visual Designer ──────────────────────────────────────────

export function buildVisualDesignerInitialTask(
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	briefBlock: string,
	revisionMode: boolean,
): string {
	const revisionLine = revisionMode
		? 'REVISION: read the LATEST Jan/QA review comment on the ticket and address it. Preserve what was approved.\n\n'
		: '';
	return `Ticket ${ticketId}: "${ticketName}" (${ticketUrl})

${revisionLine}${briefBlock}## Steps
1. Move ticket to "in progress".
2. Run the Component discipline protocol from your system prompt: family scan (A) + shopping list (B) from the approved UX Figma node in the Brief. Keep the summary short — do NOT dump the whole library into context.
3. Create the page \`${ticketId} — Visual Design — {short descriptor}\` — the descriptor is 2–4 words you pick to describe what's on the page (e.g. \`Dashboard Overview\`, \`Onboarding Flow\`), so humans can tell pages apart. If the shopping list includes candidates, also create \`__Candidates — ${ticketId}\` in the same file.
4. Build the screens using just-in-time lookup (C). New components go on the candidates page, NOT the canonical DS.
5. Final audit (F). Screenshot + post Figma page URL as a ClickUp comment (include a "Candidates for promotion" list if any, and note any checklist items you flag N/A).
6. Move ticket to "qa test". A human reviews from there.

**HARD RULE:** Never move the ticket to "ai review" — that status is human-only. Only humans flip tickets into "ai review"; you always land on "qa test".`;
}

export function buildJanBatchInitialTask(
	batch: Array<{ id: string; name: string; url: string; status: 'to do' | 'ai review' | 'revision needed' }>,
): string {
	const ticketLines = batch.map((t, i) =>
		`${i + 1}. **[${t.status.toUpperCase()}]** ${t.id}: "${t.name}" (${t.url})`,
	).join('\n');

	return `You have ${batch.length} ticket${batch.length === 1 ? '' : 's'} to dispatch. Work through them in order — do NOT stop after the first one. You never open Figma — you are an orchestrator.

${ticketLines}

## For each ticket above:

### If status is **"to do"** (Phase 2 Visual Design)
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Find an approved UX direction (sub-ticket tagged \`UX-prototype-briefing\`, a Figma node URL in comments, or an explicit "approved UX:" line).
   - If found → cite that Figma node URL + any DS notes in your Brief.
   - If none → greenfield. Do NOT stall or ask questions. Write a Brief from the ticket description alone and note the missing UX.
2. Dispatch ONE Visual Designer:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"~/Projects/<project>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"<Brief>"}'\`
3. Only \`success:true\` counts. On \`success:false\`, skip this one and move on — it'll be retried on the next pickup cycle.

### If status is **"ai review"** — DELEGATE ONLY. Your sole action is the curl call.
1. Fire the dispatch:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-qa -d '{"ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>"}'\`
2. FORBIDDEN in this mode: \`clickup_get_task\`, \`clickup_get_task_comments\`, any \`figma_*\` tool, any \`clickup_update_task\` (status), any comment. Visual QA handles reading the ticket, inspecting the design, counting FRAME vs INSTANCE, writing the verdict, and moving the ticket (\`in progress\` → \`qa test\` or \`to do\`). You MUST NOT do any of these steps.
3. Only \`success:true\` counts. On \`success:false\`, skip and move on to the next ticket in the batch.

### If status is **"revision needed"**
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Identify:
   - Is this a UX ticket or a Visual ticket? (Look at the ticket tags / parent / description. UX tickets are usually sub-tickets tagged \`UX-prototype-briefing\`.)
   - What did the reviewer want changed? (Top-most review comment with required changes.)
   - The workspace path (from the original dispatch or the project context).
2. Write a tight Brief summarising the required changes — the designer should NOT need to re-read every comment.
3. Dispatch the appropriate designer with \`revisionMode:true\`:
   - UX: \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-designer -d '{"workspacePath":"~/Projects/<project>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"<Brief>","revisionMode":true}'\`
   - Visual: \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"~/Projects/<project>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"<Brief>","revisionMode":true}'\`
4. The hub auto-routes across the fleet — you don't pick a machine. If the original designer is free, they'll get it. Otherwise another free designer picks it up. Don't try to route manually.
5. Only \`success:true\` counts. On \`success:false\`, skip and move on — the next pickup cycle retries.

## When you're done
After dispatching (or skipping) every ticket above, you are DONE. Do not wait for designers or QA to finish — they run in parallel on their own timelines. You never open Figma.`;
}
