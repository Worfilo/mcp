---
name: worfilo-workflows
description: Plan, build, test, publish, schedule and integrate Worfilo AI workflows into this codebase through the Worfilo MCP server, including PDF parsing, decisions and MCP servers from the official registry. Use when the user wants to automate a task, build an AI agent workflow, run one on a schedule, or call a Worfilo workflow from their code.
---

# Building Worfilo workflows

Worfilo runs AI agent workflows: a trigger, then nodes (agents, app actions, HTTP calls, documents, decisions, logic) joined by edges. You build them through the Worfilo MCP tools, then call them from the user's code through the public API or run them on a schedule.

## Procedure

1. **Understand the goal.** Ask what should start the workflow, what it must produce, and which apps it touches. Read the codebase to see where it will be called from and what input it can send.
2. **Discover.**
   - Call `list_workflows` to see what already exists; to change one, read it with `get_workflow` and revise its draft rather than starting over.
   - Call `list_integrations` for connected apps, credentials, saved models, custom APIs and MCP servers.
   - Call `list_node_types` for every type with its ports and `can_be_tool`, then `get_node_type` for the config schema of each type you plan to use. Never invent node types, ports or config fields.
3. **Plan.**
   - Call `plan_workflow` with a precise description. It drafts a graph from the account's real integrations. For revisions, pass `previous_graph` and an `instruction`.
   - The draft leaves models, connections and credentials out. Fill every entry in `needs` (`model_id`, `connection_id`, `credential_id`) with ids from `list_integrations`.
   - Show the user the `steps` in plain words and agree on changes before saving.
4. **Create.** Call `create_workflow` with the agreed graph. Fix every `error` in `issues` with `update_workflow` (it replaces the whole draft graph). Warnings do not block. `validate_workflow` re-checks the draft at any time.
5. **Test.** Call `run_workflow` on the draft with a realistic `input`. If it is still running when the wait ends, poll `get_run`. If it fails, read `failed_nodes`, fix the graph, and run again. Runs can call real apps and spend tokens, so say what a test run will do first. `list_runs` shows earlier runs.
6. **Publish.** Ask the user, then call `publish_workflow`. It activates the new version by default, which is what the API and schedules run.
7. **Integrate.**
   - Call `create_api_key` scoped to this workflow only, and write the key to an untracked env file as `WORFILO_API_KEY`. Check `.gitignore` covers it, and never print the key back or commit it.
   - Call `get_integration_snippet` in the codebase's language, then adapt it to the project's HTTP client, types, config loading and error handling. If it returns `file_code`, the workflow reads a PDF: use that version.
   - Handle both answers: 200 means finished, and 202 means poll `status_url`.
   - For recurring work, use a schedule instead (see Schedules).
8. **Hand over.** Tell the user the workflow name, the `editor_url`, where the call site or schedule lives, and which env var to set in each deployment.

## The graph

```json
{
  "schema_version": 1,
  "nodes": [
    {"id": "trigger", "type": "manual_trigger", "name": "Trigger", "position": {"x": 0, "y": 0},
     "config": {"test_payload": {"message": "Summarise this"}}},
    {"id": "summarise", "type": "agent", "name": "Summarise", "position": {"x": 260, "y": 0},
     "config": {"model_id": "<a model_id from list_integrations>",
                "user_prompt": "Summarise: {{ trigger.message }}"}},
    {"id": "result", "type": "output", "name": "Result", "position": {"x": 520, "y": 0},
     "config": {"value": "{{ nodes.summarise.output.text }}"}}
  ],
  "edges": [
    {"id": "e1", "source": "trigger", "target": "summarise"},
    {"id": "e2", "source": "summarise", "target": "result"}
  ],
  "settings": {}
}
```

The example shows the shape only. Take each node's exact config fields from `get_node_type`.

## Rules

- **Trigger.** Exactly one trigger node.
  - `manual_trigger` for workflows called from code through the API. Give it a realistic `config.test_payload` with every field later nodes read.
  - `webhook_trigger` when an outside event or incoming HTTP call starts the run.
  - `schedule_trigger` for recurring work; the timing itself is a schedule (see Schedules).
- **Ids and names.** Node ids are unique lowercase slugs matching `^[a-z][a-z0-9_]*$`. Names are short Title Case labels.
- **Config.** Every config must satisfy its node type's `config_schema`, required fields included.
- **Edges.** An edge goes from an output port to an input port. Omit ports for the defaults (`out` to `in`).
- **Branching.**
  - An `if` node fires `true` or `false`; connect each branch with `source_port` set to that name.
  - A `switch` node's `config.cases` each name a port, plus `default`.
  - A node with an `error` port fires it when the node fails; connect it to handle the failure instead of stopping the run.
  - When branches rejoin, route them through a `merge` node. Use `set` to shape values between steps.
- **Flow.** Data flows forward only: no cycles, and every node is reachable from the trigger. End with an `output` node, whose value is what the API returns.
- **Templates.**
  - `{{ trigger.<field> }}` reads the trigger payload, `{{ nodes.<id>.output.<field> }}` reads an upstream node, and `{{ input }}` is what the node's own `in` port received. Only upstream nodes may be referenced.
  - `if` and `switch` expressions are bare, without braces, e.g. `nodes.classify.output.structured.urgency == 'high'`.
- **Size.** Prefer a few well-chosen nodes over many.

## Agents

- An `agent` node calls an LLM with a prompt, and optionally tools.
- Set `model_id` to a saved model from `list_integrations`. Reuse one whose provider and settings fit the task.
- If none fits, call `create_model` with a `provider`, the provider's model id, and a `credential_id` whose kind is in that provider's `credential_kinds` (see `model_providers`). Ask the user which provider and model they want first.
- If there is no matching credential, send the user to the Models page to add a key. Never ask for the key itself.
- Thinking (`settings.thinking`, one of the provider's `thinking_levels`) suits multi-step reasoning. Leave it `off` for quick classification and extraction. Temperature is dropped while thinking unless `temperature_with_thinking` is true.
- An agent's output has `.text`, and `.structured` when `config.output_schema` is set. Whenever a later node branches on or reads a field of the answer, set `output_schema` and read `.structured.<field>`.
- Pass the agent its input through templates in `user_prompt`.

## Tools for agents

- Any node type whose `can_be_tool` is true (`list_node_types`) can be given to an agent as a tool: an edge with `kind: "tool"` from it to the agent, `target_port: "tools"`. A tool node has no other edges; the agent calls it when it decides to.
- Attach a tool when the agent should choose whether and how to call it. Use a normal data edge for a step that always runs.
- `http_request` as a tool sets `config.tool_description` and `config.tool_args_schema` (a JSON Schema object), and reads the agent's arguments with `{{ args.<field> }}` in its url, headers or body.
- `connector_action`, `api_request` and `mcp_tool` as tools: inputs left out of `config.args` are chosen by the agent.
- `decision` as a tool: the agent sends the text to judge; set `config.tool_description`.

## Apps, APIs and MCP servers

- **Apps.** For the apps in `available_apps` from `list_integrations`, use a `connector_action` node with `connector_id`, `action` and `args` (templates allowed). Set `connection_id` from `connections`, and prefer it over `http_request`. If the app is not connected, send the user to `connect_more`.
- **The user's APIs.** Use `api_request` with the exact `api_id`, an `endpoint` id and `args`. For a request no endpoint covers, set `endpoint` to `"custom"` with `method`, `path` (relative to the API), and optional `query`, `headers` and `body`.
- **The user's MCP servers.** Use `mcp_tool` with the exact `server_id`, one of its listed `tool` names, and `args`. Never invent server ids or tool names. A server whose `status` is `needs_reconnect` needs the user to reconnect it at its `manage_url` first; one that is `blocked` cannot be used.
- **Finding a new MCP server.**
  1. If no connected server fits, call `search_mcp_catalog` and show the user the best few candidates (name, description, how it signs in).
  2. Ask the user whether they want to connect one. Do not go further without a clear yes.
  3. Only then call `get_mcp_connect_link` with `user_approved: true`, and give the user the `connect_url`. They connect and sign in in the app; you never do it for them.
  4. When they say it is done, call `list_integrations` again for its `server_id` and tools.
- **Secrets.** Never put keys or tokens in a graph. Reference stored credentials, connections, APIs and servers by id.

## Documents and personal data

- `pdf_parse` turns a PDF into Markdown. `source: "file"` reads an attached file (`{{ trigger.file }}`), `"url"` a public link, and `"base64"` data such as an email attachment. Later nodes read `{{ nodes.<id>.output.markdown }}`.
- Files are PDFs only, up to 25 MB, and kept for 24 hours. In production, code sends the PDF as multipart/form-data (`file_code` from `get_integration_snippet`), and it arrives as `{{ trigger.file }}`.
- To test a file workflow, either point `pdf_parse` at a public PDF with `source: "url"`, or ask the user to attach a PDF to the trigger's test inputs in the editor and run it there. You cannot upload files through these tools.
- `pii_mask` outputs `config.text` with personal data replaced by tokens. When customer, patient or other personal data must not reach a model, put `pii_mask` before every agent that reads it, and give those agents `{{ nodes.<mask id>.output }}` instead of the raw text.

## Decisions

- A `decision` node asks TypeSafe Jev typed questions and can branch on the answers. Prefer it over an agent for classification and scoring.
- It needs a `credential_id` of kind `typesafe`. If the account has none, send the user to add one; never ask for the key.
- `config.questions` rows have `key`, `type` (`noul` for yes/no, `choice`, or `score`), `instructions`, and `criteria`: `{"true", "false"}` for noul, `[{"option", "description"}]` for choice, and levels from low to high for score.
- Set `config.state` to the text to judge.
- To branch, set `route_mode` and `route_question`: `"noul"` fires `yes` or `no`, `"choice"` fires the option names, `"bands"` fires the `port` of each `config.bands` row, and `"rules"` fires the `port` of each `config.rules` row plus `default`. Connect from those ports. The `uncertain` port fires when confidence is below `min_confidence`.

## Schedules

- A schedule runs a **published** workflow's active version. Publish first, then call `create_schedule` with a 5-field `cron` (e.g. `0 9 * * 1-5`), an IANA `timezone`, and the `payload` the trigger should receive.
- Use a `schedule_trigger` node in workflows that only ever run on a schedule.
- `list_schedules` shows existing ones and their next run. `update_schedule` changes timing or payload, or pauses with `enabled: false`. `delete_schedule` removes one for good.

## Guardrails

- Confirm the plan before `create_workflow`.
- Ask before `publish_workflow`, `activate_version`, `create_api_key`, `create_schedule`, `update_schedule` and `delete_schedule`.
- Ask before `get_mcp_connect_link`, and call it only after the user agrees to connect that server.
- Edit drafts freely. Published versions change only when you publish again.
- Keep API keys out of source control, logs and chat.
- If a tool says a permission was not granted, ask the user to reconnect Worfilo and allow it.
