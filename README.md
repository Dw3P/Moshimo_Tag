# Moshimo Tag

**Add a what-if layer to any plan.**

[Open the live app](https://moshimo-tag.kazuomi-kuguiya.chatgpt.site)

![Moshimo Tag](public/og.png)

Moshimo Tag is a local-first planning workspace for the [WebMCP Challenge](https://webmcp.devpost.com/). A person creates an expected Plan, while a browser agent can attach realistic What-ifs, Situations, and concrete countermeasures to the exact moments where they matter.

The agent prepares useful options. The person decides what to accept, edit, or dismiss.

## Why WebMCP

Ordinary AI risk lists are detached from the plan and disappear after the conversation. Moshimo Tag exposes the live planning model as page tools so an agent can read and update the same structured state the person sees.

This makes it possible to:

- create or open a Project without reproducing the UI through clicks;
- add ordered Plan items and anchor What-ifs to specific moments;
- add Situations and their editable main countermeasures;
- add, edit, or remove real Plan B fallback countermeasures beneath any Situation;
- preserve every human decision in the page's local state;
- read a clean final projection for a summary, spreadsheet, or runbook.

## Human decision boundary

WebMCP tools may create and edit candidate content, including Plan B countermeasures. These changes appear on the page immediately, but the tools cannot choose **Already covered**, **Accept risk**, **Prepare**, or **Dismiss**, or save a human response. Every main or Plan B countermeasure remains undecided until the person reviews it in the page UI.

Unless the user explicitly names other participants, tool guidance requires every proposed action to be something the Project owner can carry out alone. The agent must not invent co-owners, collaborators, assignees, teams, or helpers.

This boundary is enforced by the shared application command path used by both the UI and WebMCP mutations.

## Try it

1. Open the [live app](https://moshimo-tag.kazuomi-kuguiya.chatgpt.site) in ChatGPT's in-app browser or a browser with WebMCP enabled.
2. Send the browser agent a request such as:

   > On this open Moshimo Tag page, use WebMCP to create a Project for [what you want to plan — e.g. baking a baguette]. Add the expected Plan, likely What ifs, Situations, main countermeasures, and useful Plan B countermeasures. Unless I name other people, write every action for the Project owner to carry out alone. Leave every decision undecided for me to review.

3. Review the agent-prepared candidates in Moshimo Tag.
4. Edit each countermeasure and choose **Already covered**, **Accept risk**, **Prepare**, or **Dismiss** yourself.
5. Select **View final plan** to see only the selected Situation-specific countermeasures.

No sample Project is injected into the production path. A new browser starts with the onboarding screen and an empty local workspace.

## WebMCP tools

Moshimo Tag registers its tools through `document.modelContext.registerTool()` in [`src/webmcp.ts`](src/webmcp.ts).

| Tool | Purpose |
| --- | --- |
| `list_projects` | Read workspace status and saved Project summaries. |
| `get_project` | Read a bounded Project, Plan, What-if, Situation, or final projection. (`case` remains the compatibility API value.) |
| `create_project` | Create a Project with an optional atomic initial Plan bundle. |
| `open_project` | Open a locally saved Project. |
| `update_project` | Update Project title and description. |
| `set_project_view` | Switch between editing and final view. |
| `edit_plan` | Add, update, move, or delete one Plan item. |
| `edit_what_if` | Add, update, delete, rank, or sort What-ifs. |
| `edit_case` | Add, update, or delete a Situation and its main countermeasure. |
| `edit_plan_b_options` | Immediately add, replace, edit, or delete Plan B fallback countermeasures for any Situation. |
| `get_export_projection` | Read structured human-summary, timeline, Situation-matrix, or runbook output. (`case_matrix` remains the compatibility API value.) |

All mutation tools validate IDs, entity versions, operation bounds, and idempotency keys before they use the shared dispatcher. Read tools expose bounded projections rather than raw browser storage.

## Local development

Requirements:

- Node.js 22.13 or newer
- npm
- a WebMCP-capable browser for agent-tool testing

Install and start the app:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Run the verification suite:

```bash
npm run test:state
npm run lint
npx tsc --noEmit
npm run build
```

The app does not require an API key or backend. Project data is stored in browser `localStorage`. Environment-specific values belong in an ignored `.env` file; [`.env.example`](.env.example) contains the safe public template.

## Project structure

- [`app/page.tsx`](app/page.tsx) — product UI and WebMCP registration lifecycle
- [`src/app-state.ts`](src/app-state.ts) — validated state, commands, persistence, undo, and redo
- [`src/webmcp.ts`](src/webmcp.ts) — WebMCP schemas, reads, mutations, and tool registration
- [`src/*.test.ts`](src) — state, persistence, human-decision, stale-data, and WebMCP contract tests
- [`public/`](public) — icons, onboarding images, and public assets

## License

Released under the [MIT License](LICENSE).
